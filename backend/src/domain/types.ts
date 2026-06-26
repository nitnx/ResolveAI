/**
 * Shared domain types for ResolveAI.
 *
 * These types model the core entities and value unions used across the
 * backend (orchestration, business tools, data store) and mirror the
 * "TypeScript Domain Types" section of the design document.
 *
 * Conventions: strict mode, exactOptionalPropertyTypes, NodeNext module
 * resolution (consumers import with a `.js` extension).
 *
 * _Requirements: 12.4_
 */

// ── Value unions ───────────────────────────────────────────────────────────────

/** The eight intent categories a customer message can be classified into. */
export type IntentCategory =
  | 'order_status'
  | 'refund_request'
  | 'replacement_request'
  | 'shipping_inquiry'
  | 'policy_question'
  | 'complaint'
  | 'escalation_request'
  | 'general_inquiry';

/** Detected sentiment of a customer message. */
export type Sentiment = 'negative' | 'neutral' | 'positive';

/** The single resolution path selected by the Orchestrator per turn. */
export type ResolutionPath = 'refund' | 'replacement' | 'escalation' | 'informational';

/** Lifecycle status of an order. */
export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'delayed' | 'lost';

/** Category of a seeded policy document. */
export type PolicyCategory = 'shipping' | 'refund' | 'replacement' | 'support';

/** Whether a conversation is active or has been resolved. */
export type ConversationStatus = 'active' | 'resolved';

// ── Entity interfaces ────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface Order {
  id: string;
  customerId: string;
  items: Array<{ sku: string; name: string; quantity: number }>;
  amount: number; // monetary total, used for high-value gate
  status: OrderStatus;
  orderedAt: string; // ISO timestamp
  promisedDeliveryAt: string; // ISO; "past due" basis for delayed orders
  deliveredAt?: string; // ISO; basis for 30-day delivered window
  refunded: boolean;
  replaced: boolean;
  hasValidComplaint: boolean;
}

export interface PolicyPassage {
  id: string;
  category: PolicyCategory;
  title: string;
  text: string; // indexed for TF-IDF
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'customer' | 'assistant';
  text: string;
  timestampMs: number; // millisecond precision
  seq: number; // monotonic tiebreaker within conversation
}

export interface Conversation {
  id: string;
  customerId?: string;
  orderId?: string;
  status: ConversationStatus;
  latestIntent?: IntentCategory;
  latestSentiment: Sentiment; // most recently recorded (Req 9.4)
  escalationPriority: number; // higher = more urgent
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ActionLogEntry {
  id: string;
  conversationId: string;
  seq: number; // monotonic per conversation (Req 8.4)
  timestampMs: number; // millisecond precision
  type:
    | 'intent'
    | 'sentiment'
    | 'retrieval'
    | 'decision'
    | 'tool_call'
    | 'gate'
    | 'escalation'
    | 'failure';
  // Discriminated payload (stored as JSON):
  payload: ActionLogPayload;
}

/** Discriminated union of action-log payload variants, keyed by `kind`. */
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

export interface Escalation {
  id: string;
  conversationId: string;
  priority: number; // queue ordering (Req 9.2)
  summary?: string; // AI-generated; may be absent on summary failure (Req 7.5)
  createdAtMs: number;
}

export interface Ticket {
  id: string;
  customerId: string;
  subject: string;
  status: 'open' | 'closed';
  createdAtMs: number;
}
