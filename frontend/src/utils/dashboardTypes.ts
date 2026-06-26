/**
 * Frontend domain types for the Agent Dashboard.
 *
 * These mirror the backend domain types (`backend/src/domain/types.ts`)
 * without introducing a cross-package import dependency.
 *
 * _Requirements: 9.1, 9.2, 9.3_
 */

// ── Value unions ──────────────────────────────────────────────────────────────

export type Sentiment = 'negative' | 'neutral' | 'positive';

export type ConversationStatus = 'active' | 'resolved';

export type IntentCategory =
  | 'order_status'
  | 'refund_request'
  | 'replacement_request'
  | 'shipping_inquiry'
  | 'policy_question'
  | 'complaint'
  | 'escalation_request'
  | 'general_inquiry';

export type ResolutionPath = 'refund' | 'replacement' | 'escalation' | 'informational';

// ── Core entities ─────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  customerId?: string;
  orderId?: string;
  status: ConversationStatus;
  latestIntent?: IntentCategory;
  /** Most recently recorded sentiment (Req 9.4). */
  latestSentiment: Sentiment;
  /** Higher = more urgent (used for escalation queue ordering). */
  escalationPriority: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface Escalation {
  id: string;
  conversationId: string;
  /** Queue ordering — higher value appears first (Req 9.2). */
  priority: number;
  /** AI-generated summary; may be absent when summary generation failed. */
  summary?: string;
  createdAtMs: number;
}

// ── Action-log types ──────────────────────────────────────────────────────────

export type ActionLogPayload =
  | { kind: 'intent'; intent: IntentCategory; classificationConfidence: number }
  | { kind: 'sentiment'; sentiment: Sentiment; failed?: boolean }
  | { kind: 'retrieval'; passageIds: string[]; failed?: boolean }
  | { kind: 'decision'; path: ResolutionPath; confidence: number; sentimentUsed: Sentiment }
  | {
      kind: 'gate';
      gate: 'threshold' | 'high_value' | 'no_policy';
      threshold?: number;
      confidence?: number;
      result: 'pass' | 'escalate';
    }
  | { kind: 'tool_call'; tool: string; params: unknown; result: unknown; outcome: 'success' | 'failure' }
  | { kind: 'escalation'; escalationId: string; summaryPresent: boolean }
  | { kind: 'failure'; component: string; condition: string };

export interface ActionLogEntry {
  id: string;
  conversationId: string;
  /** Monotonic sequence number per conversation (Req 8.4). */
  seq: number;
  timestampMs: number;
  type:
    | 'intent'
    | 'sentiment'
    | 'retrieval'
    | 'decision'
    | 'tool_call'
    | 'gate'
    | 'escalation'
    | 'failure';
  payload: ActionLogPayload;
}

// ── Dashboard action entry (from GET /api/dashboard/actions) ──────────────────

export interface ActionEntry {
  conversationId: string;
  tool: string;
  params: unknown;
  result: unknown;
  outcome: 'success' | 'failure';
  timestampMs: number;
}
