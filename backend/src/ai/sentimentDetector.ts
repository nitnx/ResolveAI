/**
 * Sentiment_Detector — classifies customer message sentiment and records it
 * on the conversation (Requirements 4.1, 4.2, 4.3).
 *
 * Responsibilities:
 *  1. Call `aiProvider.detectSentiment(text)` with a 2-second timeout guard.
 *  2. On success: update `conversation.latestSentiment` via the conversation
 *     repository (Req 4.2).
 *  3. On failure OR timeout (>2 s): record `neutral` and set a
 *     `classificationFailed: true` flag on the conversation (Req 4.3).
 *  4. Append an action-log entry of type `'sentiment'` with payload
 *     `{ kind: 'sentiment', sentiment, failed?: true }`.
 *
 * _Requirements: 4.1, 4.2, 4.3_
 */

import { randomUUID } from 'node:crypto';
import type { AiProvider } from './aiProvider.js';
import type { ConversationRepository } from '../repositories/conversationRepository.js';
import type { ActionLogRepository } from '../repositories/actionLogRepository.js';
import type { Sentiment } from '../domain/types.js';

// ── Timeout helper ────────────────────────────────────────────────────────────

/** Milliseconds before sentiment detection is considered failed (Req 4.1, 4.3). */
const SENTIMENT_TIMEOUT_MS = 2_000;

/**
 * Race a promise against a timeout. Rejects with an `Error` whose message is
 * `'timeout'` when the time limit is exceeded.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timeout')),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── SentimentDetector interface ───────────────────────────────────────────────

/**
 * Public interface for the Sentiment_Detector component (Req 4.1).
 *
 * `detect` classifies the sentiment of `text` as exactly one of
 * `'negative' | 'neutral' | 'positive'` and records it on the conversation
 * identified by `conversationId`.
 */
export interface SentimentDetector {
  detect(
    text: string,
    conversationId: string,
  ): Promise<{ sentiment: 'negative' | 'neutral' | 'positive' }>;
}

// ── SentimentDetectorImpl ─────────────────────────────────────────────────────

/**
 * Concrete implementation of `SentimentDetector`.
 *
 * Constructed via dependency injection so any collaborator can be stubbed in
 * tests.
 */
export class SentimentDetectorImpl implements SentimentDetector {
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
   * Detect sentiment for `text`, record it on `conversationId`, and append an
   * action-log entry.
   *
   * - On success within 2 s: records the detected sentiment (Req 4.2).
   * - On timeout or any error: records `'neutral'` with a
   *   `classificationFailed: true` flag (Req 4.3).
   *
   * Always returns the recorded sentiment so callers can use it immediately.
   */
  async detect(
    text: string,
    conversationId: string,
  ): Promise<{ sentiment: Sentiment }> {
    let sentiment: Sentiment;
    let failed = false;

    try {
      const result = await withTimeout(
        this.aiProvider.detectSentiment(text),
        SENTIMENT_TIMEOUT_MS,
      );
      sentiment = result.sentiment;
    } catch {
      // Timeout or provider error → default to neutral and flag the failure
      // (Req 4.3).
      sentiment = 'neutral';
      failed = true;
    }

    // Record the sentiment on the conversation (Req 4.2).
    this.conversationRepo.updateLatestSentiment(conversationId, sentiment);

    // If classification failed, also mark the conversation flag via the
    // action-log payload (the domain `Conversation` type does not have a
    // `classificationFailed` column; the flag lives only in the action log
    // payload as `failed: true`, which is the documented approach in the
    // design's ActionLogPayload discriminated union).
    const payload = failed
      ? ({ kind: 'sentiment', sentiment, failed: true } as const)
      : ({ kind: 'sentiment', sentiment } as const);

    this.actionLogRepo.appendActionLog({
      id: randomUUID(),
      conversationId,
      timestampMs: Date.now(),
      type: 'sentiment',
      payload,
    });

    return { sentiment };
  }
}
