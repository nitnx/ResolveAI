/**
 * Customer-facing support chat page.
 *
 * Implements the full Chat_Widget per Requirements 1.1–1.10, 11.6, plus demo
 * polish: a Reset Demo control, suggested prompt chips, a compact Resolution
 * Trace timeline, and a clearer selected-order context banner.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  api,
  type ApiActionLogEntry,
  type ApiMessage,
  type PolicyPassage,
  type SeedCustomer,
  type Order,
} from '../api/client';
import {
  orderMessages,
  validateMessage,
  type Message,
} from '../utils/messageHelpers';

// ── Constants ─────────────────────────────────────────────────────────────────

const CONVERSATION_ID_KEY = 'resolveai_conversation_id';
const DEMO_ORDER_ID = 'ORD-1001'; // matches backend DEMO_ORDER_ID

/** Suggested demo prompts surfaced as one-tap chips above the input. */
const DEMO_PROMPTS: string[] = [
  "My order is late and I'm angry. I want a refund.",
  'Where is my order?',
  'I want a replacement.',
];

// ── Local types ───────────────────────────────────────────────────────────────

/** A message as stored in local state, extended with optional passages. */
interface ChatMessage extends Message {
  passages?: PolicyPassage[];
  sentiment?: 'negative' | 'neutral' | 'positive';
}

/** Compact, demo-friendly view of the latest orchestration turn. */
interface ResolutionTrace {
  intent?: string;
  intentConfidence?: number;
  sentiment?: 'negative' | 'neutral' | 'positive';
  policyTitles: string[];
  eligibility?: 'eligible' | 'ineligible' | 'indeterminate';
  decisionPath?: string;
  confidence?: number;
  gateResult?: 'pass' | 'escalate';
  action?: string;
  actionOutcome?: 'success' | 'failure';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiMessageToChatMessage(m: ApiMessage): ChatMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    text: m.text,
    timestampMs: m.timestampMs,
    seq: m.seq,
  };
}

function sentimentColor(s: 'negative' | 'neutral' | 'positive') {
  if (s === 'negative') return 'bg-rose-100 text-rose-700 ring-rose-200';
  if (s === 'positive') return 'bg-emerald-100 text-emerald-700 ring-emerald-200';
  return 'bg-slate-100 text-slate-600 ring-slate-200';
}

function eligibilityColor(e: 'eligible' | 'ineligible' | 'indeterminate') {
  if (e === 'eligible') return 'bg-emerald-100 text-emerald-700 ring-emerald-200';
  if (e === 'ineligible') return 'bg-rose-100 text-rose-700 ring-rose-200';
  return 'bg-amber-100 text-amber-700 ring-amber-200';
}

function actionColor(outcome?: 'success' | 'failure') {
  if (outcome === 'success') return 'bg-emerald-100 text-emerald-700 ring-emerald-200';
  if (outcome === 'failure') return 'bg-rose-100 text-rose-700 ring-rose-200';
  return 'bg-indigo-100 text-indigo-700 ring-indigo-200';
}

function prettyPath(path?: string) {
  if (!path) return '—';
  return path.charAt(0).toUpperCase() + path.slice(1);
}

/**
 * Build a Resolution Trace from the conversation's action log by taking the
 * most recent entry of each relevant type — that is the current turn's trace.
 */
function buildTrace(
  actions: ApiActionLogEntry[],
  passages: PolicyPassage[],
): ResolutionTrace {
  const trace: ResolutionTrace = { policyTitles: passages.map((p) => p.title) };

  const lastOf = (type: ApiActionLogEntry['type']) =>
    [...actions].reverse().find((a) => a.type === type);

  const intentEntry = lastOf('intent');
  if (intentEntry && intentEntry.payload.kind === 'intent') {
    trace.intent = intentEntry.payload.intent;
    trace.intentConfidence = intentEntry.payload.classificationConfidence;
  }

  const sentimentEntry = lastOf('sentiment');
  if (sentimentEntry && sentimentEntry.payload.kind === 'sentiment') {
    trace.sentiment = sentimentEntry.payload.sentiment as 'negative' | 'neutral' | 'positive';
  }

  const decisionEntry = lastOf('decision');
  if (decisionEntry && decisionEntry.payload.kind === 'decision') {
    trace.decisionPath = decisionEntry.payload.path;
    trace.confidence = decisionEntry.payload.confidence;
  }

  const gateEntry = lastOf('gate');
  if (gateEntry && gateEntry.payload.kind === 'gate') {
    trace.gateResult = gateEntry.payload.result;
  }

  // Eligibility comes from the most recent eligibility tool_call result.
  const eligibilityEntry = [...actions]
    .reverse()
    .find(
      (a) =>
        a.type === 'tool_call' &&
        a.payload.kind === 'tool_call' &&
        (a.payload.tool === 'checkRefundEligibility' ||
          a.payload.tool === 'checkReplacementEligibility'),
    );
  if (eligibilityEntry && eligibilityEntry.payload.kind === 'tool_call') {
    const result = eligibilityEntry.payload.result as { status?: string } | null;
    if (result?.status) {
      trace.eligibility = result.status as 'eligible' | 'ineligible' | 'indeterminate';
    }
  }

  // Action taken: prefer a processRefund/processReplacement tool_call, else escalation.
  const processEntry = [...actions]
    .reverse()
    .find(
      (a) =>
        a.type === 'tool_call' &&
        a.payload.kind === 'tool_call' &&
        (a.payload.tool === 'processRefund' || a.payload.tool === 'processReplacement'),
    );
  const escalationEntry = lastOf('escalation');

  if (processEntry && processEntry.payload.kind === 'tool_call') {
    const tool = processEntry.payload.tool;
    trace.action = tool === 'processRefund' ? 'Refund processed' : 'Replacement processed';
    trace.actionOutcome = processEntry.payload.outcome;
    if (processEntry.payload.outcome === 'failure') {
      trace.action = tool === 'processRefund' ? 'Refund not processed' : 'Replacement not processed';
    }
  } else if (escalationEntry) {
    trace.action = 'Escalated to human agent';
    trace.actionOutcome = 'success';
  } else if (trace.decisionPath === 'informational') {
    trace.action = 'Informational response';
  }

  return trace;
}

// ── PolicyCard ────────────────────────────────────────────────────────────────

function PolicyCard({ passage }: { passage: PolicyPassage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/70 text-xs">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 text-left font-medium text-indigo-700 hover:bg-indigo-100 transition-colors rounded-lg"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-indigo-100 px-1.5 py-0.5 uppercase tracking-wide text-[10px] font-semibold text-indigo-600">
            {passage.category}
          </span>
          <span>{passage.title}</span>
        </span>
        <span aria-hidden className="ml-2 text-indigo-400 select-none">
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <p className="px-3 pb-3 pt-1 text-gray-700 leading-relaxed whitespace-pre-wrap">
          {passage.text}
        </p>
      )}
    </div>
  );
}

// ── ResolutionTracePanel ──────────────────────────────────────────────────────

function TraceStep({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${className}`}
    >
      {children}
    </span>
  );
}

function ResolutionTracePanel({ trace }: { trace: ResolutionTrace }) {
  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white/90 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-indigo-600 text-[11px] font-bold text-white">
          AI
        </span>
        <h3 className="text-sm font-semibold text-slate-800">Resolution Trace</h3>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-slate-400">
          how this was decided
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
        {/* Intent */}
        <TraceStep label="Intent">
          {trace.intent ? (
            <Pill className="bg-indigo-100 text-indigo-700 ring-indigo-200">
              {trace.intent}
            </Pill>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </TraceStep>

        {/* Sentiment */}
        <TraceStep label="Sentiment">
          {trace.sentiment ? (
            <Pill className={sentimentColor(trace.sentiment)}>{trace.sentiment}</Pill>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </TraceStep>

        {/* Policy retrieved */}
        <TraceStep label="Policy">
          {trace.policyTitles.length > 0 ? (
            <span className="text-xs font-medium text-slate-700" title={trace.policyTitles.join(', ')}>
              {trace.policyTitles.length} passage{trace.policyTitles.length !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="text-xs text-slate-400">none</span>
          )}
        </TraceStep>

        {/* Eligibility */}
        <TraceStep label="Eligibility">
          {trace.eligibility ? (
            <Pill className={eligibilityColor(trace.eligibility)}>{trace.eligibility}</Pill>
          ) : (
            <span className="text-xs text-slate-400">n/a</span>
          )}
        </TraceStep>

        {/* Confidence */}
        <TraceStep label="Confidence">
          {typeof trace.confidence === 'number' ? (
            <span className="text-xs font-semibold text-slate-700">
              {(trace.confidence * 100).toFixed(0)}%
            </span>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </TraceStep>

        {/* Action taken */}
        <TraceStep label="Action">
          {trace.action ? (
            <Pill className={actionColor(trace.actionOutcome)}>{trace.action}</Pill>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </TraceStep>
      </div>
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isCustomer = msg.role === 'customer';
  return (
    <div className={`flex ${isCustomer ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${isCustomer ? 'order-2' : ''}`}>
        {/* Bubble */}
        <div
          className={
            isCustomer
              ? 'rounded-2xl rounded-tr-sm bg-indigo-600 text-white px-4 py-3 text-sm shadow-sm'
              : 'rounded-2xl rounded-tl-sm bg-white border border-slate-200 text-slate-800 px-4 py-3 text-sm shadow-sm'
          }
        >
          <p className="whitespace-pre-wrap break-words leading-relaxed">{msg.text}</p>
        </div>

        {/* Sentiment badge (assistant only) */}
        {!isCustomer && msg.sentiment && (
          <span
            className={`inline-block mt-1.5 ml-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ring-1 ${sentimentColor(msg.sentiment)}`}
          >
            {msg.sentiment}
          </span>
        )}

        {/* Timestamp */}
        <p
          className={`mt-1 text-[10px] text-slate-400 ${isCustomer ? 'text-right' : 'text-left ml-1'}`}
        >
          {new Date(msg.timestampMs).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>

        {/* Policy passages (assistant only) */}
        {!isCustomer && msg.passages && msg.passages.length > 0 && (
          <div className="mt-1">
            {msg.passages.map((p) => (
              <PolicyCard key={p.id} passage={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── LoadingBubble ─────────────────────────────────────────────────────────────

function LoadingBubble({ extendedWait }: { extendedWait: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
        <span className="flex items-center gap-2" aria-label="Loading response">
          <span className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="block h-2 w-2 rounded-full bg-indigo-400 animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
          {extendedWait && (
            <span className="text-xs text-slate-400 ml-1">Still processing…</span>
          )}
        </span>
      </div>
    </div>
  );
}

// ── OrderSelector ─────────────────────────────────────────────────────────────

interface OrderSelectorProps {
  customers: SeedCustomer[];
  selectedOrderId: string;
  onChangeOrderId: (id: string) => void;
  disabled: boolean;
}

function OrderSelector({
  customers,
  selectedOrderId,
  onChangeOrderId,
  disabled,
}: OrderSelectorProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="order-selector" className="text-xs font-medium text-slate-600">
        Order
      </label>
      <select
        id="order-selector"
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        value={selectedOrderId}
        onChange={(e) => onChangeOrderId(e.target.value)}
        disabled={disabled}
      >
        <option value="">— select an order —</option>
        {customers.map((cust) =>
          cust.orders.map((order: Order) => (
            <option key={order.id} value={order.id}>
              {cust.name} · {order.id} · {order.status}
              {order.id === DEMO_ORDER_ID ? ' ★ Demo' : ''}
            </option>
          )),
        )}
      </select>

      {/* Freeform override input */}
      <div className="flex items-center gap-2 mt-1">
        <label htmlFor="order-text" className="text-xs text-slate-500 whitespace-nowrap">
          Or enter ID:
        </label>
        <input
          id="order-text"
          type="text"
          placeholder="e.g. ORD-1001"
          value={selectedOrderId}
          onChange={(e) => onChangeOrderId(e.target.value.trim())}
          disabled={disabled}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  );
}

// ── ChatPage ──────────────────────────────────────────────────────────────────

export default function ChatPage() {
  // ── Order / customer state ──
  const [customers, setCustomers] = useState<SeedCustomer[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string>(DEMO_ORDER_ID);
  const [customersLoading, setCustomersLoading] = useState(true);

  // ── Conversation state ──
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CONVERSATION_ID_KEY);
    } catch {
      return null;
    }
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Input state ──
  const [inputText, setInputText] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // ── Async op state ──
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [extendedWait, setExtendedWait] = useState(false);
  const pendingRetryText = useRef<string | null>(null);

  // ── Resolution trace (latest turn) ──
  const [trace, setTrace] = useState<ResolutionTrace | null>(null);

  // ── Demo-ready flag (set right after a Reset Demo) ──
  const [demoReady, setDemoReady] = useState(false);

  // ── Scroll anchor ──
  const bottomRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── 1. Fetch seed customers, preselect demo order ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    api
      .getSeedCustomers()
      .then(({ customers: c }) => {
        if (cancelled) return;
        setCustomers(c);
        setCustomersLoading(false);

        const allOrders = c.flatMap((cu) => cu.orders);
        const demo =
          allOrders.find((o) => o.id === DEMO_ORDER_ID) ??
          allOrders.find((o) => o.status === 'delayed');
        if (demo) setSelectedOrderId(demo.id);
      })
      .catch(() => {
        if (!cancelled) setCustomersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 2. Restore conversation history from localStorage ─────────────────────
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setHistoryLoading(true);
    api
      .getConversation(conversationId)
      .then(({ messages: apiMsgs }) => {
        if (cancelled) return;
        const chatMsgs: ChatMessage[] = apiMsgs.map(apiMessageToChatMessage);
        setMessages(orderMessages(chatMsgs) as ChatMessage[]);
        setHistoryLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setConversationId(null);
          try {
            localStorage.removeItem(CONVERSATION_ID_KEY);
          } catch {
            /* ignore */
          }
          setHistoryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 3. Auto-scroll on new messages ───────────────────────────────────────
  useEffect(() => {
    // While the AI is responding, keep the loading indicator pinned in view.
    if (sending) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    // Once the response completes (trace ready), bring the full latest turn
    // into view — the customer message at the top, followed by the AI response
    // and the Resolution Trace panel — so the whole resolution is visible.
    if (trace && turnRef.current) {
      turnRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, trace]);

  // ── 3b. Extended-wait indicator after 10s ─────────────────────────────────
  useEffect(() => {
    if (!sending) {
      setExtendedWait(false);
      return;
    }
    const timerId = setTimeout(() => setExtendedWait(true), 10_000);
    return () => clearTimeout(timerId);
  }, [sending]);

  // ── 4. Core send logic ────────────────────────────────────────────────────
  const doSend = useCallback(
    async (text: string) => {
      setSending(true);
      setSendError(null);
      setDemoReady(false);
      pendingRetryText.current = text;

      const optimisticMsg: ChatMessage = {
        id: `local-${Date.now()}`,
        conversationId: conversationId ?? 'pending',
        role: 'customer',
        text,
        timestampMs: Date.now(),
        seq: -1,
      };
      setMessages((prev) => orderMessages([...prev, optimisticMsg]) as ChatMessage[]);

      try {
        let convId = conversationId;

        if (!convId) {
          const createBody = selectedOrderId ? { orderId: selectedOrderId } : {};
          const { conversation } = await api.createConversation(createBody);
          convId = conversation.id;
          setConversationId(convId);
          try {
            localStorage.setItem(CONVERSATION_ID_KEY, convId);
          } catch {
            /* ignore */
          }
        }

        const sendBody = selectedOrderId ? { text, orderId: selectedOrderId } : { text };
        const result = await api.sendMessage(convId, sendBody);

        const realCustomerMsg = apiMessageToChatMessage(result.message);
        const assistantMsg: ChatMessage | null = result.response
          ? { ...apiMessageToChatMessage(result.response), passages: result.passages }
          : null;

        setMessages((prev) => {
          const withoutOptimistic = prev.filter((m) => m.id !== optimisticMsg.id);
          const next: ChatMessage[] = [
            ...withoutOptimistic,
            realCustomerMsg,
            ...(assistantMsg ? [assistantMsg] : []),
          ];
          return orderMessages(next) as ChatMessage[];
        });

        // Build the Resolution Trace from the action log for this turn.
        try {
          const { actions } = await api.getConversationActions(convId);
          setTrace(buildTrace(actions, result.passages));
        } catch {
          // Trace is a nice-to-have; ignore failures so the chat still works.
          setTrace(null);
        }

        pendingRetryText.current = null;
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
        setSendError('Message could not be sent.');
      } finally {
        setSending(false);
      }
    },
    [conversationId, selectedOrderId],
  );

  // ── 5. Handle form submission ─────────────────────────────────────────────
  const submitText = useCallback(
    (raw: string) => {
      const validation = validateMessage(raw);
      if (!validation.ok) {
        if (validation.reason === 'empty') {
          setValidationError(null);
        } else {
          setValidationError(
            `Message is too long. Maximum length is ${validation.max ?? 2000} characters.`,
          );
        }
        return;
      }
      setValidationError(null);
      setInputText('');
      void doSend(validation.value);
    },
    [doSend],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitText(inputText);
    },
    [inputText, submitText],
  );

  // ── 6. Retry handler ──────────────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    const text = pendingRetryText.current;
    if (!text) return;
    void doSend(text);
  }, [doSend]);

  // ── 6b. Reset Demo — clean slate + one fresh conversation on the demo order ─
  const handleReset = useCallback(() => {
    setMessages([]);
    setTrace(null);
    setSendError(null);
    setValidationError(null);
    setInputText('');
    setDemoReady(false);
    pendingRetryText.current = null;

    // Drop the current conversation immediately so stale state can't leak.
    setConversationId(null);
    try {
      localStorage.removeItem(CONVERSATION_ID_KEY);
    } catch {
      /* ignore */
    }

    // Reset to the demo order (prefer ORD-1001, else first delayed order).
    const allOrders = customers.flatMap((cu) => cu.orders);
    const demo =
      allOrders.find((o) => o.id === DEMO_ORDER_ID)?.id ??
      allOrders.find((o) => o.status === 'delayed')?.id ??
      DEMO_ORDER_ID;
    setSelectedOrderId(demo);

    // Backend wipes all prior demo state, restores the demo order's flags, and
    // returns one fresh conversation. Adopt that conversation so exactly one
    // demo conversation exists (no duplicate empty conversation on next send),
    // then refresh seed data so the order context badge reflects the clean state.
    void api
      .resetDemo(demo)
      .then(async ({ conversation }) => {
        setConversationId(conversation.id);
        try {
          localStorage.setItem(CONVERSATION_ID_KEY, conversation.id);
        } catch {
          /* ignore */
        }
        setDemoReady(true);
        const { customers: c } = await api.getSeedCustomers();
        setCustomers(c);
      })
      .catch(() => {
        /* reset is best-effort; chat still works without it */
      });

    inputRef.current?.focus();
  }, [customers]);

  // ── 7. Demo prompt chip handler ───────────────────────────────────────────
  const handleChip = useCallback(
    (prompt: string) => {
      if (sending) return;
      submitText(prompt);
    },
    [sending, submitText],
  );

  // ── 8. Enter to send, Shift+Enter for newline ─────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitText(inputText);
      }
    },
    [inputText, submitText],
  );

  // ── Derived ───────────────────────────────────────────────────────────────
  const orderedMessages = orderMessages(messages) as ChatMessage[];
  const hasMessages = orderedMessages.length > 0;
  const conversationStarted = !!conversationId;

  // Id of the most recent customer message — anchors the auto-scroll so the
  // full latest turn (customer → AI response → trace) is brought into view.
  const lastCustomerId =
    [...orderedMessages].reverse().find((m) => m.role === 'customer')?.id ?? null;

  const selectedOrder = useMemo<Order | undefined>(
    () => customers.flatMap((c) => c.orders).find((o) => o.id === selectedOrderId),
    [customers, selectedOrderId],
  );
  const selectedCustomer = useMemo<SeedCustomer | undefined>(
    () => customers.find((c) => c.orders.some((o) => o.id === selectedOrderId)),
    [customers, selectedOrderId],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section className="mx-auto max-w-5xl px-4 py-6 flex flex-col h-[calc(100vh-72px)]">
      {/* Header */}
      <header className="mb-4 flex flex-shrink-0 items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Support Chat
            </h1>
            <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-600 ring-1 ring-indigo-200">
              AI Copilot
            </span>
            {demoReady && !hasMessages && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-600 ring-1 ring-emerald-200">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Demo ready
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            Describe your issue — ResolveAI classifies, checks policy, and resolves it autonomously.
          </p>
        </div>

        <button
          type="button"
          onClick={handleReset}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400"
          title="Start a fresh conversation on the demo order"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Reset Demo
        </button>
      </header>

      {/* Selected order context banner */}
      <div className="mb-4 flex-shrink-0 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <OrderSelector
            customers={customers}
            selectedOrderId={selectedOrderId}
            onChangeOrderId={setSelectedOrderId}
            disabled={customersLoading || conversationStarted || sending}
          />

          {selectedOrder && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {selectedOrder.id === DEMO_ORDER_ID && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700 ring-1 ring-amber-200">
                  ★ Demo order
                </span>
              )}
              {selectedCustomer && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 ring-1 ring-slate-200">
                  {selectedCustomer.name}
                </span>
              )}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 ring-1 ring-slate-200 capitalize">
                {selectedOrder.status}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 ring-1 ring-slate-200">
                ${selectedOrder.amount.toFixed(2)}
              </span>
              {selectedOrder.refunded && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700 ring-1 ring-emerald-200">
                  Refunded
                </span>
              )}
            </div>
          )}
        </div>
        {conversationStarted && (
          <p className="mt-2 text-[11px] text-slate-400">
            Order locked for this conversation. Use <span className="font-medium">Reset Demo</span> to start fresh.
          </p>
        )}
      </div>

      {/* Message history */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-5 flex flex-col gap-5 shadow-inner min-h-0">
        {/* Empty state */}
        {!historyLoading && !hasMessages && !sending && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <p className="text-center text-slate-400 text-sm max-w-sm leading-relaxed">
              Describe your issue and ResolveAI will help resolve it. Try a suggested prompt below to start the demo.
            </p>
          </div>
        )}

        {/* History loading skeleton */}
        {historyLoading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex gap-1.5" aria-label="Loading conversation history">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="block h-2 w-2 rounded-full bg-indigo-300 animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        {orderedMessages.map((msg) => (
          <div
            key={msg.id}
            ref={msg.id === lastCustomerId ? turnRef : undefined}
            style={{ scrollMarginTop: '0.75rem' }}
          >
            <MessageBubble msg={msg} />
          </div>
        ))}

        {/* Loading indicator */}
        {sending && <LoadingBubble extendedWait={extendedWait} />}

        {/* Resolution trace (latest turn) */}
        {!sending && trace && <ResolutionTracePanel trace={trace} />}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Error state with retry */}
      {sendError && (
        <div className="mt-3 flex-shrink-0 flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">
          <span>{sendError}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="ml-4 rounded-md bg-rose-100 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-200 transition-colors focus:outline-none focus:ring-2 focus:ring-rose-400"
          >
            Retry
          </button>
        </div>
      )}

      {/* Suggested demo prompt chips */}
      <div className="mt-3 flex flex-shrink-0 flex-wrap gap-2">
        {DEMO_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => handleChip(prompt)}
            disabled={sending}
            className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="mt-2 flex-shrink-0" noValidate>
        {validationError && (
          <p className="mb-1.5 text-xs text-rose-600" role="alert">
            {validationError}
          </p>
        )}

        <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500 transition-shadow">
          <textarea
            ref={inputRef}
            rows={2}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              if (validationError) setValidationError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Describe your issue… (Enter to send, Shift+Enter for new line)"
            disabled={sending}
            aria-label="Message input"
            className="flex-1 resize-none bg-transparent text-sm text-slate-800 placeholder-slate-400 focus:outline-none disabled:cursor-not-allowed min-h-[2.5rem] max-h-40"
          />
          <button
            type="submit"
            disabled={sending}
            aria-label="Send message"
            className="flex-shrink-0 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 active:bg-indigo-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>

        <p className="mt-1 text-right text-[10px] text-slate-400">{inputText.length}/2000</p>
      </form>
    </section>
  );
}
