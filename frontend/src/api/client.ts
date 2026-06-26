/**
 * API client base for the ResolveAI backend.
 *
 * The base URL is configurable via the `VITE_API_BASE_URL` environment
 * variable (see `.env` / Vite env handling). When unset it defaults to the
 * relative `/api` prefix, which the Vite dev server proxies to the backend
 * (see `vite.config.ts`) and which works in production when the frontend is
 * served from the same origin as the backend.
 */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  '/api';

export interface ApiError {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.code = error.code;
    this.status = status;
  }
}

/**
 * Perform a JSON request against the backend API.
 *
 * Prepends {@link API_BASE_URL} to the given path, sets JSON headers, and
 * parses structured `{ error: { code, message } }` responses into an
 * {@link ApiRequestError}.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  const isJson = response.headers
    .get('content-type')
    ?.includes('application/json');
  const body = isJson ? await response.json() : undefined;

  if (!response.ok) {
    const error: ApiError = body?.error ?? {
      code: 'unknown_error',
      message: `Request failed with status ${response.status}`,
    };
    throw new ApiRequestError(response.status, error);
  }

  return body as T;
}

// ── Domain types mirrored from the backend (no external import needed) ────────

export interface PolicyPassage {
  id: string;
  category: string;
  title: string;
  text: string;
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  role: 'customer' | 'assistant';
  text: string;
  timestampMs: number;
  seq: number;
}

export interface ApiConversation {
  id: string;
  customerId?: string;
  orderId?: string;
  status: 'active' | 'resolved';
  latestIntent?: string;
  latestSentiment: 'negative' | 'neutral' | 'positive';
  escalationPriority: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ApiEscalation {
  id: string;
  conversationId: string;
  priority: number;
  summary?: string;
  createdAtMs: number;
}

export interface ApiActionEntry {
  conversationId: string;
  tool: string;
  params: unknown;
  result: unknown;
  outcome: 'success' | 'failure';
  timestampMs: number;
}

export type ApiActionLogPayload =
  | { kind: 'intent'; intent: string; classificationConfidence: number }
  | { kind: 'sentiment'; sentiment: string; failed?: boolean }
  | { kind: 'retrieval'; passageIds: string[]; failed?: boolean }
  | { kind: 'decision'; path: string; confidence: number; sentimentUsed: string }
  | { kind: 'gate'; gate: string; threshold?: number; confidence?: number; result: 'pass' | 'escalate' }
  | { kind: 'tool_call'; tool: string; params: unknown; result: unknown; outcome: 'success' | 'failure' }
  | { kind: 'escalation'; escalationId: string; summaryPresent: boolean }
  | { kind: 'failure'; component: string; condition: string };

export interface ApiActionLogEntry {
  id: string;
  conversationId: string;
  seq: number;
  timestampMs: number;
  type: 'intent' | 'sentiment' | 'retrieval' | 'decision' | 'tool_call' | 'gate' | 'escalation' | 'failure';
  payload: ApiActionLogPayload;
}

export interface CreateConversationBody {
  customerId?: string;
  orderId?: string;
}

export interface SendMessageBody {
  text: string;
  orderId?: string;
}

export interface SendMessageResponse {
  message: ApiMessage;
  response: ApiMessage | null;
  passages: PolicyPassage[];
  resolutionPath: string;
  confidence: number;
  escalationId?: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface Order {
  id: string;
  customerId: string;
  amount: number;
  status: string;
  orderedAt: string;
  promisedDeliveryAt: string;
  deliveredAt?: string;
  refunded: boolean;
  replaced: boolean;
  hasValidComplaint: boolean;
  items: Array<{ sku: string; name: string; quantity: number }>;
}

export interface SeedCustomer extends Customer {
  orders: Order[];
}

export const api = {
  /** Liveness check against the backend `/health` endpoint. */
  health: () =>
    apiFetch<{ status: string; timestamp: string }>('/health'),

  /**
   * Create a new conversation, optionally bound to a customer and/or order.
   * POST /api/conversations
   */
  createConversation: (body: CreateConversationBody) =>
    apiFetch<{ conversation: ApiConversation }>('/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Fetch an existing conversation with its ordered messages.
   * GET /api/conversations/:id
   */
  getConversation: (id: string) =>
    apiFetch<{ conversation: ApiConversation; messages: ApiMessage[] }>(
      `/conversations/${encodeURIComponent(id)}`,
    ),

  /**
   * Submit a customer message and receive the assistant response.
   * POST /api/conversations/:id/messages
   */
  sendMessage: (conversationId: string, body: SendMessageBody) =>
    apiFetch<SendMessageResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

  /**
   * Fetch seeded customers (with their orders) for the order selector.
   * GET /api/seed/customers
   */
  getSeedCustomers: () =>
    apiFetch<{ customers: SeedCustomer[] }>('/seed/customers'),

  /**
   * Reset the demo to a clean slate: clears all prior conversations, messages,
   * action logs, and escalations, restores the demo order (and an optional
   * extra order) to a pristine un-refunded/un-replaced state, and starts one
   * fresh conversation bound to the demo order.
   * POST /api/seed/reset-demo
   */
  resetDemo: (orderId?: string) =>
    apiFetch<{ reset: string[]; conversation: ApiConversation }>('/seed/reset-demo', {
      method: 'POST',
      body: JSON.stringify(orderId ? { orderId } : {}),
    }),

  // ── Dashboard endpoints (Req 9.1, 9.2, 9.3) ────────────────────────────────

  /**
   * Fetch all conversations partitioned into live (active) and resolved.
   * GET /api/dashboard/conversations
   */
  getDashboardConversations: () =>
    apiFetch<{ live: ApiConversation[]; resolved: ApiConversation[] }>(
      '/dashboard/conversations',
    ),

  /**
   * Fetch the escalation queue sorted by priority descending.
   * GET /api/dashboard/escalations
   */
  getDashboardEscalations: () =>
    apiFetch<{ escalations: ApiEscalation[] }>('/dashboard/escalations'),

  /**
   * Fetch all refund/replacement action entries across all conversations.
   * GET /api/dashboard/actions
   */
  getDashboardActions: () =>
    apiFetch<{ actions: ApiActionEntry[] }>('/dashboard/actions'),

  /**
   * Fetch the chronological action log for a specific conversation.
   * GET /api/conversations/:id/actions
   */
  getConversationActions: (conversationId: string) =>
    apiFetch<{ actions: ApiActionLogEntry[] }>(
      `/conversations/${encodeURIComponent(conversationId)}/actions`,
    ),
};
