/**
 * AiProvider interface — the seam for hybrid AI (Req 2.10, 2.11, 12.7).
 *
 * Two implementations exist:
 *   - `LlmProvider`: calls a real LLM API when `LLM_API_KEY` is configured.
 *   - `MockProvider`: deterministic rule-based fallback; runs end-to-end with
 *     no external keys or integrations.
 *
 * The Orchestrator depends only on this interface, never on a concrete class.
 */

import type { IntentCategory, Sentiment, Message, PolicyPassage, ResolutionPath } from '../domain/types.js';

// ── ResponseContext ───────────────────────────────────────────────────────────

/**
 * All information the Orchestrator has assembled when it asks the provider to
 * generate a customer-facing response.
 */
export interface ResponseContext {
  conversationId: string;
  messages: Message[];
  intent: IntentCategory;
  sentiment: Sentiment;
  /** Policy passages retrieved by the RAG retriever. */
  passages: PolicyPassage[];
  resolutionPath: ResolutionPath;
  orderInfo?: { orderId: string; status: string; amount: number };
  refundOutcome?: 'processed' | 'rejected' | 'not_processed';
  replacementOutcome?: 'processed' | 'rejected' | 'not_processed';
  escalated?: boolean;
}

// ── AiProvider interface ──────────────────────────────────────────────────────

/**
 * Hybrid AI provider interface.
 *
 * - `classifyIntent`: assigns one of the eight intent categories plus a
 *   confidence score in [0, 1] (Req 3.1, 3.2).
 * - `detectSentiment`: classifies the customer message as negative, neutral,
 *   or positive (Req 4.1).
 * - `generateResponse`: produces a customer-facing response string given the
 *   full resolution context (Req 1.3).
 * - `summarizeConversation`: produces an AI-generated summary attached to an
 *   escalation (Req 7.4).
 */
export interface AiProvider {
  classifyIntent(text: string): Promise<{ intent: IntentCategory; confidence: number }>;
  detectSentiment(text: string): Promise<{ sentiment: Sentiment }>;
  generateResponse(ctx: ResponseContext): Promise<string>;
  summarizeConversation(messages: Message[]): Promise<string>;
}
