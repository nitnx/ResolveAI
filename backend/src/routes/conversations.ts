/**
 * Conversation and message REST endpoints.
 *
 * Routes:
 *   POST /api/conversations              — create a new conversation
 *   GET  /api/conversations/:id          — fetch conversation + ordered messages
 *   POST /api/conversations/:id/messages — submit a customer message → orchestration
 *   GET  /api/conversations/:id/actions  — chronological action log (Req 8.6, 8.7)
 *
 * Requirements: 1.2, 2.1, 8.6, 8.7, 11.9
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';

import { getDb } from '../data/db.js';
import { ConversationRepository } from '../repositories/conversationRepository.js';
import { MessageRepository } from '../repositories/messageRepository.js';
import { createActionLogRepository } from '../repositories/actionLogRepository.js';
import { createOrderRepository } from '../repositories/index.js';
import { createEscalation } from '../repositories/escalationRepository.js';
import { createAiProvider } from '../ai/index.js';
import { IntentClassifier } from '../ai/intentClassifier.js';
import { SentimentDetectorImpl } from '../ai/sentimentDetector.js';
import { KnowledgeBase } from '../rag/knowledgeBase.js';
import { RagRetriever } from '../rag/ragRetriever.js';
import { policyRepository } from '../repositories/index.js';
import { createOrchestrator } from '../orchestrator/orchestrator.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { PolicyPassage } from '../domain/types.js';

// ── Max message length (Req 1.2) ───────────────────────────────────────────────
const MAX_MESSAGE_LENGTH = 2000;

// ── Singleton orchestrator — built once per process ───────────────────────────
let orchestratorInstance: ReturnType<typeof createOrchestrator> | undefined;

function getOrchestrator() {
  if (orchestratorInstance !== undefined) {
    return orchestratorInstance;
  }

  const db = getDb();
  const aiProvider = createAiProvider();
  const kb = new KnowledgeBase(policyRepository.getAllPolicies());
  const ragRetriever = new RagRetriever(kb);
  const actionLogRepo = createActionLogRepository(db);
  const conversationRepo = new ConversationRepository(db);
  const messageRepo = new MessageRepository(db);
  const orderRepo = createOrderRepository(db);

  // EscalationRepository only requires createEscalation (see businessTools.ts)
  const escalationRepo = {
    createEscalation: (data: Parameters<typeof createEscalation>[0]) =>
      createEscalation(data, db),
  };

  const intentClassifier = new IntentClassifier(
    aiProvider,
    conversationRepo,
    actionLogRepo,
  );

  const sentimentDetector = new SentimentDetectorImpl(
    aiProvider,
    conversationRepo,
    actionLogRepo,
  );

  orchestratorInstance = createOrchestrator({
    aiProvider,
    intentClassifier,
    sentimentDetector,
    ragRetriever,
    actionLogRepo,
    conversationRepo,
    messageRepo,
    orderRepo,
    escalationRepo,
  });

  return orchestratorInstance;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const conversationsRouter = Router();

// ── POST /api/conversations ────────────────────────────────────────────────────
// Body: { customerId?: string, orderId?: string }
// Returns: { conversation } with 201
conversationsRouter.post(
  '/',
  (req: Request<Record<string, never>, unknown, { customerId?: string; orderId?: string }>, res: Response): void => {
    const { customerId, orderId } = req.body;

    const db = getDb();
    const conversationRepo = new ConversationRepository(db);

    const conversation = conversationRepo.createConversation({
      id: randomUUID(),
      ...(customerId ? { customerId } : {}),
      ...(orderId ? { orderId } : {}),
    });

    res.status(201).json({ conversation });
  },
);

// ── GET /api/conversations/:id ─────────────────────────────────────────────────
// Returns: { conversation, messages } ordered by (timestampMs ASC, seq ASC)
// 404 if not found
conversationsRouter.get(
  '/:id',
  (req: Request<{ id: string }>, res: Response): void => {
    const conversationId = req.params['id'];

    const db = getDb();
    const conversationRepo = new ConversationRepository(db);
    const messageRepo = new MessageRepository(db);

    const conversation = conversationRepo.getConversationById(conversationId);
    if (conversation === null) {
      throw new NotFoundError(`Conversation not found: ${conversationId}`);
    }

    // Already ordered by (timestamp_ms ASC, seq ASC) by the repository
    const messages = messageRepo.getMessagesByConversationId(conversationId);

    res.json({ conversation, messages });
  },
);

// ── POST /api/conversations/:id/messages ──────────────────────────────────────
// Body: { text: string, orderId?: string }
// Returns: { message, response, passages, resolutionPath, confidence, escalationId? }
// On orchestration error: { error: { code, message } }
conversationsRouter.post(
  '/:id/messages',
  async (
    req: Request<{ id: string }, unknown, { text?: string; orderId?: string }>,
    res: Response,
  ): Promise<void> => {
    const conversationId = req.params['id'];
    const { text, orderId } = req.body;

    // ── Server-side validation (defense in depth, Req 1.2) ───────────────────

    // Reject empty / whitespace-only messages
    if (text === undefined || text === null || text.trim().length === 0) {
      throw new ValidationError(
        'Message text must contain at least one non-whitespace character',
      );
    }

    // Reject messages exceeding 2000 characters
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new ValidationError(
        `Message text must not exceed ${MAX_MESSAGE_LENGTH} characters`,
      );
    }

    const db = getDb();
    const conversationRepo = new ConversationRepository(db);
    const messageRepo = new MessageRepository(db);

    // Verify conversation exists
    const conversation = conversationRepo.getConversationById(conversationId);
    if (conversation === null) {
      throw new NotFoundError(`Conversation not found: ${conversationId}`);
    }

    // Persist the customer message
    const customerMessage = messageRepo.appendMessage({
      id: randomUUID(),
      conversationId,
      role: 'customer',
      text: text.trim(),
      timestampMs: Date.now(),
    });

    // ── Orchestration with 10-second component timeout (Req 11.9) ────────────
    const ORCHESTRATION_TIMEOUT_MS = 10_000;

    interface OrchResult {
      responseText: string;
      resolutionPath: string;
      confidence: number;
      attachedPassages: PolicyPassage[];
      escalationId?: string;
    }

    let result: OrchResult;

    try {
      const orchestrator = getOrchestrator();

      result = await Promise.race<OrchResult>([
        orchestrator.orchestrate({
          conversationId,
          message: customerMessage,
          ...(orderId ? { orderId } : {}),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Orchestration timed out after 10 seconds')),
            ORCHESTRATION_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      // Orchestration failed or timed out — return structured error (Req 11.9)
      const errMessage =
        err instanceof Error ? err.message : 'Orchestration failed';

      console.error('[ConversationsRoute] Orchestration error:', err);

      res.status(500).json({
        error: {
          code: 'ORCHESTRATION_ERROR',
          message: errMessage,
        },
      });
      return;
    }

    // Fetch the latest assistant message persisted by the orchestrator
    const allMessages = messageRepo.getMessagesByConversationId(conversationId);
    const responseMessage = allMessages
      .filter((m) => m.role === 'assistant')
      .at(-1);

    const responsePayload: Record<string, unknown> = {
      message: customerMessage,
      response: responseMessage ?? null,
      passages: result.attachedPassages,
      resolutionPath: result.resolutionPath,
      confidence: result.confidence,
    };

    if (result.escalationId !== undefined) {
      responsePayload['escalationId'] = result.escalationId;
    }

    res.json(responsePayload);
  },
);

// ── GET /api/conversations/:id/actions ────────────────────────────────────────
// Returns all action-log entries for the conversation sorted chronologically
// by (timestampMs ASC, seq ASC).
//
// Success:  200  { actions: ActionLogEntry[] }
// Failure:  503  { error: { code: 'LOG_UNAVAILABLE', message: string } }
//
// Any retrieval throw produces the 503 error response — a partial or empty log
// is NEVER presented as a complete record (Req 8.7).
//
// _Requirements: 8.6, 8.7_
conversationsRouter.get(
  '/:id/actions',
  (req: Request<{ id: string }>, res: Response): void => {
    const conversationId = req.params['id'];

    const db = getDb();
    const conversationRepo = new ConversationRepository(db);

    // 404 when the conversation does not exist
    const conversation = conversationRepo.getConversationById(conversationId);
    if (conversation === null) {
      throw new NotFoundError(`Conversation not found: ${conversationId}`);
    }

    // Retrieve the action log — any throw maps to LOG_UNAVAILABLE (Req 8.7)
    let actions: import('../domain/types.js').ActionLogEntry[];
    try {
      const actionLogRepo = createActionLogRepository(db);
      actions = actionLogRepo.getActionLogByConversationId(conversationId);
    } catch (err) {
      console.error('[ConversationsRoute] Failed to retrieve action log:', err);
      res.status(503).json({
        error: {
          code: 'LOG_UNAVAILABLE',
          message:
            'The action log for this conversation is currently unavailable. Please try again later.',
        },
      });
      return;
    }

    res.json({ actions });
  },
);
