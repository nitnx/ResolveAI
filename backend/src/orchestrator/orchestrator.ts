/**
 * Orchestrator — the central resolution pipeline coordinator for ResolveAI.
 *
 * Implements the full 10-step pipeline defined in design.md:
 *  1. Classify intent (IntentClassifier)          Req 2.1, 3.1-3.4
 *  2. Detect sentiment (SentimentDetectorImpl)    Req 2.2, 4.1-4.2
 *  3. Log intent + sentiment                       Req 3.7, 4.5
 *  4. RAG retrieve                                 Req 2.3, 5.2; log passage IDs Req 5.4
 *  5. Select exactly one ResolutionPath            Req 2.4, 2.5
 *  6. Log decision                                 Req 2.6, 8.3
 *  7. Apply gates via decideExecution              Req 7.1-7.3
 *  8. Execute or escalate                          Req 7.4-7.7, 11.2-11.4
 *  9. Generate response and persist               Req 1.3
 * 10. Return result with attached passages        Req 5.3
 *
 * All pipeline steps are wrapped with a 10-second component-failure guard
 * (Req 11.9). Business-tool calls are wrapped with a 5-second guard (Req 7.7).
 *
 * Order-lookup retry-then-escalate flow (Req 11.1, 11.7):
 *  - On first miss: respond asking for a valid order ID, track attempt count.
 *  - Up to 2 attempts: if both fail, escalate.
 *
 * Sentiment-driven escalation priority (Req 4.4):
 *  - Handled in BusinessTools._deriveEscalationPriority: negative → priority+1.
 *  - The Orchestrator passes the Conversation object with its current
 *    latestSentiment when calling escalateTicket.
 *
 * _Requirements: 2.1-2.9, 3.6-3.7, 4.4, 4.5, 5.3-5.4, 7.1-7.7, 8.3,
 *                11.1-11.4, 11.7, 11.9_
 */

import { randomUUID } from 'node:crypto';
import type { AiProvider, ResponseContext } from '../ai/aiProvider.js';
import { IntentClassifier } from '../ai/intentClassifier.js';
import { SentimentDetectorImpl } from '../ai/sentimentDetector.js';
import type { RagRetriever } from '../rag/ragRetriever.js';
import { BusinessTools, createBusinessTools } from '../business/businessTools.js';
import type { ActionLogRepository } from '../repositories/actionLogRepository.js';
import type { ConversationRepository } from '../repositories/conversationRepository.js';
import type { MessageRepository } from '../repositories/messageRepository.js';
import type { EscalationRepository } from '../business/businessTools.js';
import type { OrderRepository } from '../business/businessTools.js';
import {
  decideExecution,
} from './gate.js';
import {
  getConfidenceThreshold,
  getRefundHighValueLimit,
} from '../config.js';
import type {
  Message,
  PolicyPassage,
  ResolutionPath,
  IntentCategory,
  Sentiment,
  Conversation,
} from '../domain/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrchestrationInput {
  conversationId: string;
  message: Message;
  orderId?: string;
}

export interface OrchestrationResult {
  responseText: string;
  resolutionPath: ResolutionPath;
  confidence: number;
  attachedPassages: PolicyPassage[];
  escalationId?: string;
}

/** Build an OrchestrationResult, only setting escalationId when defined. */
function makeResult(
  base: Omit<OrchestrationResult, 'escalationId'>,
  escalationId: string | undefined,
): OrchestrationResult {
  if (escalationId !== undefined) {
    return { ...base, escalationId };
  }
  return { ...base };
}

/** All dependencies the Orchestrator needs, injected at construction. */
export interface OrchestratorDeps {
  aiProvider: AiProvider;
  intentClassifier: IntentClassifier;
  sentimentDetector: SentimentDetectorImpl;
  ragRetriever: RagRetriever;
  actionLogRepo: ActionLogRepository;
  conversationRepo: ConversationRepository;
  messageRepo: MessageRepository;
  orderRepo: OrderRepository;
  escalationRepo: EscalationRepository;
}

// ── Timeout helpers ───────────────────────────────────────────────────────────

/** Wrap a promise with a timeout; rejects with an Error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

const COMPONENT_TIMEOUT_MS = 10_000;
const BUSINESS_TOOL_TIMEOUT_MS = 5_000;

// ── Path selection ────────────────────────────────────────────────────────────

/**
 * Select exactly one ResolutionPath based on the classified intent (Req 2.4).
 * Confidence = the classification confidence (already in [0,1]).
 */
function selectPath(intent: IntentCategory): ResolutionPath {
  switch (intent) {
    case 'refund_request':
      return 'refund';
    case 'replacement_request':
      return 'replacement';
    case 'escalation_request':
    case 'complaint':
      return 'escalation';
    case 'order_status':
    case 'shipping_inquiry':
    case 'policy_question':
    case 'general_inquiry':
    default:
      return 'informational';
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class Orchestrator {
  private readonly aiProvider: AiProvider;
  private readonly intentClassifier: IntentClassifier;
  private readonly sentimentDetector: SentimentDetectorImpl;
  private readonly ragRetriever: RagRetriever;
  private readonly actionLogRepo: ActionLogRepository;
  private readonly conversationRepo: ConversationRepository;
  private readonly messageRepo: MessageRepository;
  private readonly orderRepo: OrderRepository;
  private readonly escalationRepo: EscalationRepository;

  constructor(deps: OrchestratorDeps) {
    this.aiProvider = deps.aiProvider;
    this.intentClassifier = deps.intentClassifier;
    this.sentimentDetector = deps.sentimentDetector;
    this.ragRetriever = deps.ragRetriever;
    this.actionLogRepo = deps.actionLogRepo;
    this.conversationRepo = deps.conversationRepo;
    this.messageRepo = deps.messageRepo;
    this.orderRepo = deps.orderRepo;
    this.escalationRepo = deps.escalationRepo;
  }

  // ── Log helpers ─────────────────────────────────────────────────────────────

  private log(
    conversationId: string,
    type: import('../domain/types.js').ActionLogEntry['type'],
    payload: import('../domain/types.js').ActionLogPayload,
  ): void {
    try {
      this.actionLogRepo.appendActionLog({
        id: randomUUID(),
        conversationId,
        timestampMs: Date.now(),
        type,
        payload,
      });
    } catch (e) {
      // Log write failures are non-fatal — record in stderr but do not halt.
      console.error('[Orchestrator] action log write failed:', e);
    }
  }

  private logFailure(conversationId: string, component: string, condition: string): void {
    this.log(conversationId, 'failure', { kind: 'failure', component, condition });
  }

  // ── Escalation helper ───────────────────────────────────────────────────────

  /**
   * Build a BusinessTools instance bound to this conversation and escalate.
   * Generates an AI summary; on summary failure, escalates without summary
   * (Req 7.4, 7.5). Always logs an 'escalation' action-log entry.
   *
   * Note: the Conversation object is fetched fresh so latestSentiment is
   * up-to-date when _deriveEscalationPriority runs (Req 4.4 / Task 11.8).
   */
  private async doEscalate(
    conversationId: string,
    messages: Message[],
  ): Promise<string | undefined> {
    // Fetch the latest conversation state (latestSentiment may have changed).
    const conv = this.conversationRepo.getConversationById(conversationId);
    if (conv === null) {
      this.logFailure(conversationId, 'Orchestrator', 'conversation_not_found_during_escalation');
      return undefined;
    }

    // Generate conversation summary for the escalation (Req 7.4).
    let summary: string | undefined;
    try {
      summary = await withTimeout(
        this.aiProvider.summarizeConversation(messages),
        COMPONENT_TIMEOUT_MS,
        'summarizeConversation',
      );
    } catch (e) {
      // Summary-generation failure: escalate without summary, log the failure
      // (Req 7.5).
      this.logFailure(
        conversationId,
        'summarizeConversation',
        e instanceof Error ? e.message : String(e),
      );
      summary = undefined;
    }

    // Create escalation via businessTools (Req 6.10, 6.11).
    const tools = createBusinessTools({
      actionLogRepo: this.actionLogRepo,
      orderRepo: this.orderRepo,
      escalationRepo: this.escalationRepo,
      conversationId,
    });

    let escalationId: string | undefined;
    try {
      const escalation = await withTimeout(
        tools.escalateTicket(conv, summary),
        BUSINESS_TOOL_TIMEOUT_MS,
        'escalateTicket',
      );
      escalationId = escalation.id;
    } catch (e) {
      this.logFailure(
        conversationId,
        'escalateTicket',
        e instanceof Error ? e.message : String(e),
      );
    }

    // Log the escalation entry (Req 8.1).
    this.log(conversationId, 'escalation', {
      kind: 'escalation',
      escalationId: escalationId ?? 'unknown',
      summaryPresent: summary !== undefined,
    });

    return escalationId;
  }

  // ── Main pipeline ───────────────────────────────────────────────────────────

  async orchestrate(input: OrchestrationInput): Promise<OrchestrationResult> {
    const { conversationId, message, orderId } = input;

    // Fetch the conversation (needed for order lookup attempt tracking, etc.).
    let conv = this.conversationRepo.getConversationById(conversationId);
    if (conv === null) {
      throw new Error(`Orchestrator: conversation not found: ${conversationId}`);
    }

    // ── Step 1: Classify intent ──────────────────────────────────────────────
    // 10-second component-failure guard (Req 11.9).
    let intent: IntentCategory;
    let intentConfidence: number;

    try {
      const classifyResult = await withTimeout(
        this.intentClassifier.classify(message.text, message.id, conversationId),
        COMPONENT_TIMEOUT_MS,
        'IntentClassifier',
      );

      if (!classifyResult.ok) {
        // Persistence failed — treat as component failure (Req 2.7, 11.3).
        this.logFailure(conversationId, 'IntentClassifier', 'persistence_failed');
        const messages = this.messageRepo.getMessagesByConversationId(conversationId);
        const escalationId = await this.doEscalate(conversationId, messages);
        const responseText = await this.generateFallbackResponse(conversationId, messages);
        return makeResult({ responseText, resolutionPath: 'escalation', confidence: 0, attachedPassages: [] }, escalationId);
      }

      intent = classifyResult.intent;
      intentConfidence = classifyResult.confidence;
    } catch (e) {
      // Component failure/timeout (Req 2.7, 11.3).
      this.logFailure(
        conversationId,
        'IntentClassifier',
        e instanceof Error ? e.message : String(e),
      );
      const messages = this.messageRepo.getMessagesByConversationId(conversationId);
      const escalationId = await this.doEscalate(conversationId, messages);
      const responseText = await this.generateFallbackResponse(conversationId, messages);
      return makeResult({ responseText, resolutionPath: 'escalation', confidence: 0, attachedPassages: [] }, escalationId);
    }

    // ── Step 2: Detect sentiment ─────────────────────────────────────────────
    // SentimentDetectorImpl has its own 2s timeout + neutral fallback (Req 4.3).
    // We still wrap with the 10s outer guard (Req 11.9).
    let sentiment: Sentiment;

    try {
      const sentResult = await withTimeout(
        this.sentimentDetector.detect(message.text, conversationId),
        COMPONENT_TIMEOUT_MS,
        'SentimentDetector',
      );
      sentiment = sentResult.sentiment;
    } catch (e) {
      // On timeout at the outer guard, log failure and use neutral (Req 4.3).
      this.logFailure(
        conversationId,
        'SentimentDetector',
        e instanceof Error ? e.message : String(e),
      );
      sentiment = 'neutral';
      // Record the neutral sentiment on the conversation.
      this.conversationRepo.updateLatestSentiment(conversationId, 'neutral');
    }

    // Refresh conv after sentiment update so latestSentiment is current.
    conv = this.conversationRepo.getConversationById(conversationId) ?? conv;

    // ── Step 4: RAG retrieve ──────────────────────────────────────────────────
    // (Step 3 — intent+sentiment log — is handled inside IntentClassifier and
    //  SentimentDetectorImpl respectively per design.md §Pipeline steps.)
    let passages: PolicyPassage[];

    try {
      passages = await withTimeout(
        this.ragRetriever.retrieve(message.text),
        COMPONENT_TIMEOUT_MS,
        'RagRetriever',
      );
    } catch (e) {
      // Retrieval failure/timeout → escalate + log failure (Req 2.7, 5.6, 11.4).
      this.logFailure(
        conversationId,
        'RagRetriever',
        e instanceof Error ? e.message : String(e),
      );
      const messages = this.messageRepo.getMessagesByConversationId(conversationId);
      const escalationId = await this.doEscalate(conversationId, messages);
      const responseText = await this.generateFallbackResponse(conversationId, messages);
      return makeResult({ responseText, resolutionPath: 'escalation', confidence: 0, attachedPassages: [] }, escalationId);
    }

    // Log retrieved passage IDs (Req 5.4).
    this.log(conversationId, 'retrieval', {
      kind: 'retrieval',
      passageIds: passages.map((p) => p.id),
    });

    // No relevant policy → escalate (Req 2.9, 5.5).
    if (passages.length === 0) {
      this.log(conversationId, 'gate', {
        kind: 'gate',
        gate: 'no_policy',
        result: 'escalate',
      });
      const messages = this.messageRepo.getMessagesByConversationId(conversationId);
      const escalationId = await this.doEscalate(conversationId, messages);
      const responseText = 'No matching policy was found for your request. Your case has been escalated to our support team.';
      await this.persistAssistantMessage(conversationId, responseText);
      return makeResult({ responseText, resolutionPath: 'escalation', confidence: 0, attachedPassages: [] }, escalationId);
    }

    // ── Step 5: Select path + compute confidence ─────────────────────────────
    const selectedPath: ResolutionPath = selectPath(intent);
    // Confidence = intent classification confidence (Req 2.5).
    const confidence: number = Math.min(1, Math.max(0, intentConfidence));

    // ── Step 6: Log decision ─────────────────────────────────────────────────
    // Log path, confidence, passages, and sentiment-used (Req 2.6, 8.3).
    this.log(conversationId, 'decision', {
      kind: 'decision',
      path: selectedPath,
      confidence,
      sentimentUsed: sentiment,
    });

    // ── Step 7: Apply gates via decideExecution ──────────────────────────────
    const threshold = getConfidenceThreshold();
    const highValueLimit = getRefundHighValueLimit();

    // For refund/replacement paths we may need to look up the order first.
    // This is done as part of step 8 (execute), but we need the order amount
    // for the high-value gate. Handle it here via the order lookup flow.

    const needsOrder = selectedPath === 'refund' || selectedPath === 'replacement';

    let currentOrderId = orderId ?? conv.orderId;

    // ── Order-lookup retry-then-escalate flow (Req 11.1, 11.7 — Task 11.17) ──
    // If path needs an order but no orderId is available, check conversation
    // metadata for attempt count.
    if (needsOrder && (currentOrderId === undefined || currentOrderId === null || currentOrderId === '')) {
      // Read attempt count from conversation metadata via escalationPriority
      // (we use a separate approach: check action log for prior 'unresolved_order' entries).
      const existingLog = this.actionLogRepo.getActionLogByConversationId(conversationId);
      const orderLookupAttempts = existingLog.filter(
        (e) =>
          e.type === 'failure' &&
          (e.payload as import('../domain/types.js').ActionLogPayload & { kind: 'failure' }).kind === 'failure' &&
          (e.payload as { kind: 'failure'; component: string; condition: string }).component === 'order_lookup_not_found',
      ).length;

      if (orderLookupAttempts >= 2) {
        // Two failed attempts — escalate (Req 11.7).
        this.log(conversationId, 'failure', {
          kind: 'failure',
          component: 'order_lookup',
          condition: 'unresolved_order_lookup',
        });
        const messages = this.messageRepo.getMessagesByConversationId(conversationId);
        const escalationId = await this.doEscalate(conversationId, messages);
        const responseText = "I wasn't able to locate your order after multiple attempts. I've escalated your case to our support team who will assist you shortly.";
        await this.persistAssistantMessage(conversationId, responseText);
        return makeResult({ responseText, resolutionPath: 'escalation', confidence, attachedPassages: passages }, escalationId);
      }

      // Ask for order ID (first or second attempt).
      this.log(conversationId, 'failure', {
        kind: 'failure',
        component: 'order_lookup_not_found',
        condition: `attempt_${orderLookupAttempts + 1}_no_order_id_provided`,
      });
      const responseText = "I'd be happy to help with your request. Could you please provide your order ID so I can look up the details?";
      await this.persistAssistantMessage(conversationId, responseText);
      return {
        responseText,
        resolutionPath: selectedPath,
        confidence,
        attachedPassages: passages,
      };
    }

    // Perform order lookup if needed.
    let order: import('../domain/types.js').Order | undefined;
    if (needsOrder && currentOrderId !== undefined && currentOrderId !== null && currentOrderId !== '') {
      const tools = createBusinessTools({
        actionLogRepo: this.actionLogRepo,
        orderRepo: this.orderRepo,
        escalationRepo: this.escalationRepo,
        conversationId,
      });

      let lookupResult: import('../business/businessTools.js').OrderLookupResult;
      try {
        lookupResult = await withTimeout(
          tools.orderLookup(currentOrderId),
          BUSINESS_TOOL_TIMEOUT_MS,
          'orderLookup',
        );
      } catch (e) {
        // Business-tool failure/timeout → escalate without retry (Req 7.7, 11.2).
        this.logFailure(conversationId, 'orderLookup', e instanceof Error ? e.message : String(e));
        const messages = this.messageRepo.getMessagesByConversationId(conversationId);
        const escalationId = await this.doEscalate(conversationId, messages);
        const responseText = await this.generateFallbackResponse(conversationId, messages);
        return makeResult({ responseText, resolutionPath: 'escalation', confidence, attachedPassages: passages }, escalationId);
      }

      if (!lookupResult.found) {
        // Order not found — track attempts and respond asking for a valid ID (Req 11.1).
        const existingLog = this.actionLogRepo.getActionLogByConversationId(conversationId);
        const priorMisses = existingLog.filter(
          (e) =>
            e.type === 'failure' &&
            (e.payload as { kind: string; component?: string }).kind === 'failure' &&
            (e.payload as { kind: string; component: string }).component === 'order_lookup_not_found',
        ).length;

        if (priorMisses >= 2) {
          // Two failed attempts — escalate (Req 11.7).
          this.log(conversationId, 'failure', {
            kind: 'failure',
            component: 'order_lookup',
            condition: 'unresolved_order_lookup',
          });
          const messages = this.messageRepo.getMessagesByConversationId(conversationId);
          const escalationId = await this.doEscalate(conversationId, messages);
          const responseText = "I wasn't able to locate your order after multiple attempts. I've escalated your case to our support team who will assist you shortly.";
          await this.persistAssistantMessage(conversationId, responseText);
          return makeResult({ responseText, resolutionPath: 'escalation', confidence, attachedPassages: passages }, escalationId);
        }

        // First or second miss — ask for a valid order ID.
        this.log(conversationId, 'failure', {
          kind: 'failure',
          component: 'order_lookup_not_found',
          condition: `order_id_${currentOrderId}_not_found_attempt_${priorMisses + 1}`,
        });
        const responseText = `I couldn't find an order with ID "${currentOrderId}". Could you please double-check and provide a valid order ID? (Attempt ${priorMisses + 1} of 2)`;
        await this.persistAssistantMessage(conversationId, responseText);
        return {
          responseText,
          resolutionPath: selectedPath,
          confidence,
          attachedPassages: passages,
        };
      }

      order = lookupResult.order;
    }

    // Evaluate the gate with the order amount (if a refund path).
    const gateResult = decideExecution({
      confidence,
      threshold,
      path: selectedPath,
      ...(order?.amount !== undefined ? { refundAmount: order.amount } : {}),
      highValueLimit,
    });

    // Log the gate decision (Req 7.1, 7.2, 7.3).
    if (gateResult.action === 'escalate') {
      const gateKind: 'threshold' | 'high_value' | 'no_policy' =
        gateResult.reason === 'high_value_refund' ? 'high_value' : 'threshold';
      this.log(conversationId, 'gate', {
        kind: 'gate',
        gate: gateKind,
        threshold,
        confidence,
        result: 'escalate',
      });
    }

    // ── Step 8: Execute or escalate ──────────────────────────────────────────
    const finalPath: ResolutionPath = gateResult.action === 'escalate' ? 'escalation' : gateResult.path;

    const tools = createBusinessTools({
      actionLogRepo: this.actionLogRepo,
      orderRepo: this.orderRepo,
      escalationRepo: this.escalationRepo,
      conversationId,
    });

    const policyCtx = { passages };
    let refundOutcome: ResponseContext['refundOutcome'];
    let replacementOutcome: ResponseContext['replacementOutcome'];
    let escalationId: string | undefined;
    let executionSuccess = false;

    if (gateResult.action === 'escalate') {
      // Escalation path.
      const messages = this.messageRepo.getMessagesByConversationId(conversationId);
      escalationId = await this.doEscalate(conversationId, messages);
    } else if (finalPath === 'refund' && order !== undefined) {
      // Auto-execute refund (Req 7.1).
      const eligibility = tools.checkRefundEligibility(order, policyCtx);

      if (eligibility.status === 'indeterminate') {
        // Indeterminate eligibility → escalate (Req 6.4).
        this.logFailure(conversationId, 'checkRefundEligibility', eligibility.reason);
        const messages = this.messageRepo.getMessagesByConversationId(conversationId);
        escalationId = await this.doEscalate(conversationId, messages);
        refundOutcome = 'not_processed';
      } else if (eligibility.status === 'ineligible') {
        refundOutcome = 'rejected';
      } else {
        // Eligible — process refund.
        try {
          const refundResult = await withTimeout(
            tools.processRefund(order, eligibility),
            BUSINESS_TOOL_TIMEOUT_MS,
            'processRefund',
          );
          if (refundResult.processed) {
            refundOutcome = 'processed';
            executionSuccess = true;
          } else {
            refundOutcome = 'rejected';
          }
        } catch (e) {
          // Business-tool failure/timeout — escalate without retry (Req 7.7, 11.2).
          this.logFailure(conversationId, 'processRefund', e instanceof Error ? e.message : String(e));
          const messages = this.messageRepo.getMessagesByConversationId(conversationId);
          escalationId = await this.doEscalate(conversationId, messages);
          refundOutcome = 'not_processed';
        }
      }
    } else if (finalPath === 'replacement' && order !== undefined) {
      // Auto-execute replacement.
      const eligibility = tools.checkReplacementEligibility(order, policyCtx);

      if (eligibility.status === 'indeterminate') {
        this.logFailure(conversationId, 'checkReplacementEligibility', eligibility.reason);
        const messages = this.messageRepo.getMessagesByConversationId(conversationId);
        escalationId = await this.doEscalate(conversationId, messages);
        replacementOutcome = 'not_processed';
      } else if (eligibility.status === 'ineligible') {
        replacementOutcome = 'rejected';
      } else {
        try {
          const replResult = await withTimeout(
            tools.processReplacement(order, eligibility),
            BUSINESS_TOOL_TIMEOUT_MS,
            'processReplacement',
          );
          if (replResult.processed) {
            replacementOutcome = 'processed';
            executionSuccess = true;
          } else {
            replacementOutcome = 'rejected';
          }
        } catch (e) {
          this.logFailure(conversationId, 'processReplacement', e instanceof Error ? e.message : String(e));
          const messages = this.messageRepo.getMessagesByConversationId(conversationId);
          escalationId = await this.doEscalate(conversationId, messages);
          replacementOutcome = 'not_processed';
        }
      }
    }
    // For 'informational' path: no business tool call needed.

    // Log confidence + threshold + outcome after auto-execution (Req 7.6).
    if (gateResult.action === 'execute' && (finalPath === 'refund' || finalPath === 'replacement')) {
      this.log(conversationId, 'gate', {
        kind: 'gate',
        gate: 'threshold',
        threshold,
        confidence,
        result: executionSuccess ? 'pass' : 'escalate',
      });
    }

    // ── Step 9: Generate response and persist ─────────────────────────────────
    const effectivePath: ResolutionPath = escalationId !== undefined ? 'escalation' : finalPath;

    const allMessages = this.messageRepo.getMessagesByConversationId(conversationId);

    const responseCtx: ResponseContext = {
      conversationId,
      messages: allMessages,
      intent,
      sentiment,
      passages,
      resolutionPath: effectivePath,
      ...(order !== undefined
        ? { orderInfo: { orderId: order.id, status: order.status, amount: order.amount } }
        : {}),
      ...(refundOutcome !== undefined ? { refundOutcome } : {}),
      ...(replacementOutcome !== undefined ? { replacementOutcome } : {}),
      escalated: escalationId !== undefined,
    };

    let responseText: string;
    try {
      responseText = await withTimeout(
        this.aiProvider.generateResponse(responseCtx),
        COMPONENT_TIMEOUT_MS,
        'generateResponse',
      );
    } catch (e) {
      // Response generation failure (Req 11.3).
      this.logFailure(conversationId, 'generateResponse', e instanceof Error ? e.message : String(e));
      responseText = escalationId !== undefined
        ? "I've escalated your case to our support team. They will be in touch with you shortly."
        : 'Thank you for contacting support. How can I assist you today?';
    }

    await this.persistAssistantMessage(conversationId, responseText);

    // ── Step 10: Return result with attached passages ─────────────────────────
    return makeResult({ responseText, resolutionPath: effectivePath, confidence, attachedPassages: passages }, escalationId);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Persist an assistant message to the conversation. */
  private async persistAssistantMessage(conversationId: string, text: string): Promise<void> {
    try {
      this.messageRepo.appendMessage({
        id: randomUUID(),
        conversationId,
        role: 'assistant',
        text,
        timestampMs: Date.now(),
      });
    } catch (e) {
      console.error('[Orchestrator] failed to persist assistant message:', e);
    }
  }

  /** Generate a generic fallback response when the normal path fails. */
  private async generateFallbackResponse(
    conversationId: string,
    messages: Message[],
  ): Promise<string> {
    try {
      return await withTimeout(
        this.aiProvider.generateResponse({
          conversationId,
          messages,
          intent: 'general_inquiry',
          sentiment: 'neutral',
          passages: [],
          resolutionPath: 'escalation',
          escalated: true,
        }),
        COMPONENT_TIMEOUT_MS,
        'generateResponse_fallback',
      );
    } catch {
      return "I've escalated your case to our support team. They will be in touch with you shortly.";
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an Orchestrator instance with all dependencies injected.
 *
 * Usage:
 * ```ts
 * const orchestrator = createOrchestrator({ aiProvider, ... });
 * const result = await orchestrator.orchestrate({ conversationId, message, orderId });
 * ```
 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  return new Orchestrator(deps);
}
