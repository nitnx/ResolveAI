/**
 * Intent_Classifier (Req 3.1–3.5, 3.7).
 *
 * Classifies the intent of a customer message by delegating to the `AiProvider`,
 * applies the 0.70 confidence floor → `general_inquiry`, persists the assigned
 * intent on the conversation record, and appends an 'intent' entry to the
 * action log.
 *
 * Persistence contract (Req 3.4, 3.5):
 *   - On success: returns `{ ok: true, intent, confidence }`.
 *   - On persistence failure: returns `{ ok: false, error: 'persistence_failed' }`
 *     and leaves the conversation's `latestIntent` unchanged (unclassified).
 *
 * Action log (Req 3.7): always appended after a successful classification,
 * regardless of any subsequent persistence outcome, recording the intent that
 * *would* have been assigned.
 *
 * _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_
 */

import { randomUUID } from 'crypto';
import type { AiProvider } from './aiProvider.js';
import type { IntentCategory } from '../domain/types.js';
import type { ConversationRepository } from '../repositories/conversationRepository.js';
import type { ActionLogRepository } from '../repositories/actionLogRepository.js';
import { getIntentConfidenceFloor } from '../config.js';

// ── Result types ─────────────────────────────────────────────────────────────

/** Successful classification result. */
export interface ClassifySuccess {
  ok: true;
  intent: IntentCategory;
  confidence: number;
}

/** Result returned when persistence of the classified intent fails (Req 3.5). */
export interface ClassifyPersistenceFailure {
  ok: false;
  error: 'persistence_failed';
}

/** Union of all possible classify results. */
export type ClassifyResult = ClassifySuccess | ClassifyPersistenceFailure;

// ── IntentClassifier ──────────────────────────────────────────────────────────

/**
 * Classifies customer message intent and records the result durably.
 *
 * Constructor dependencies are injected for testability (design.md §Layered
 * Separation). The classifier itself never reads configuration at construction
 * time — the confidence floor is read per call via `getIntentConfidenceFloor()`
 * so it can be changed through the environment without restart.
 */
export class IntentClassifier {
  private readonly aiProvider: AiProvider;
  private readonly conversationRepo: ConversationRepository;
  private readonly actionLogRepo: ActionLogRepository;

  constructor(
    aiProvider: AiProvider,
    conversationRepo: ConversationRepository,
    actionLogRepo: ActionLogRepository,
  ) {
    this.aiProvider = aiProvider;
    this.conversationRepo = conversationRepo;
    this.actionLogRepo = actionLogRepo;
  }

  /**
   * Classify the intent of `text` for the given message / conversation.
   *
   * Steps:
   * 1. Delegate to `AiProvider.classifyIntent` to get the raw intent and
   *    confidence (Req 3.1, 3.2).
   * 2. Apply the 0.70 confidence floor: if `rawConfidence < floor`, override
   *    the intent to `general_inquiry` (Req 3.3). The confidence value stored
   *    in the action log is always the raw confidence returned by the provider
   *    so the exact numeric value is preserved (Req 8.3).
   * 3. Append an action log entry of type `'intent'` with the assigned intent
   *    and raw classification confidence (Req 3.7, 8.1).
   * 4. Persist the assigned intent to the conversation's `latestIntent` field
   *    (Req 3.4). On any persistence error, return
   *    `{ ok: false, error: 'persistence_failed' }` and leave the conversation
   *    record unchanged (Req 3.5).
   *
   * @param text           The customer message text to classify.
   * @param messageId      The ID of the persisted customer message (used for
   *                       the action log entry id uniqueness).
   * @param conversationId The conversation the message belongs to.
   * @returns              A `ClassifyResult` indicating success or persistence
   *                       failure.
   */
  async classify(
    text: string,
    messageId: string,
    conversationId: string,
  ): Promise<ClassifyResult> {
    // Step 1: delegate to the AI provider.
    const raw = await this.aiProvider.classifyIntent(text);

    // Step 2: apply the confidence floor.
    const floor = getIntentConfidenceFloor();
    const assignedIntent: IntentCategory =
      raw.confidence < floor ? 'general_inquiry' : raw.intent;

    // Step 3: record the intent in the action log (Req 3.7).
    // We record even if subsequent persistence fails — the log captures
    // what the classifier *determined*, independently of write success.
    try {
      this.actionLogRepo.appendActionLog({
        id: randomUUID(),
        conversationId,
        timestampMs: Date.now(),
        type: 'intent',
        payload: {
          kind: 'intent',
          intent: assignedIntent,
          classificationConfidence: raw.confidence,
        },
      });
    } catch {
      // Action log write failure is treated as a persistence failure (Req 3.5).
      return { ok: false, error: 'persistence_failed' };
    }

    // Step 4: persist the assigned intent to the conversation record (Req 3.4).
    try {
      this.conversationRepo.updateLatestIntent(conversationId, assignedIntent);
    } catch {
      // Persistence failed — leave the message unclassified (Req 3.5).
      return { ok: false, error: 'persistence_failed' };
    }

    return { ok: true, intent: assignedIntent, confidence: raw.confidence };
  }
}
