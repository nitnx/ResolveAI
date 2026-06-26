/**
 * Agent-facing monitoring dashboard.
 *
 * Polls three backend endpoints every DASHBOARD_POLL_MS milliseconds and
 * renders live/resolved conversation tabs, the escalation queue, and a
 * refund/replacement action log.
 *
 * Clicking a conversation row opens an inline action-log detail panel that
 * fetches `GET /api/conversations/:id/actions`.
 *
 * _Requirements: 9.1–9.9, 11.5, 11.8_
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiConversation,
  ApiEscalation,
  ApiActionEntry,
  ApiActionLogEntry,
} from '../api/client';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Polling interval for all three dashboard endpoints (ms). */
export const DASHBOARD_POLL_MS = 4_000;

/** How long to wait before declaring "initial load timed out". */
const INITIAL_LOAD_TIMEOUT_MS = 10_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sentimentBadge(s: ApiConversation['latestSentiment']) {
  if (s === 'negative') {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
        Negative
      </span>
    );
  }
  if (s === 'positive') {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
        Positive
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
      Neutral
    </span>
  );
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString();
}

function shortId(id: string) {
  return id.slice(0, 8);
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-10">
      <svg
        className="h-6 w-6 animate-spin text-indigo-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v8H4z"
        />
      </svg>
    </div>
  );
}

// ── Action-log entry renderer ─────────────────────────────────────────────────

function ActionEntryRow({ entry }: { entry: ApiActionLogEntry }) {
  const p = entry.payload;

  let summary: React.ReactNode;
  switch (p.kind) {
    case 'intent':
      summary = (
        <>
          <span className="font-medium text-indigo-700">Intent</span>{' '}
          <span className="font-semibold">{p.intent}</span>{' '}
          <span className="text-gray-500">
            (confidence {(p.classificationConfidence * 100).toFixed(0)}%)
          </span>
        </>
      );
      break;
    case 'sentiment':
      summary = (
        <>
          <span className="font-medium text-purple-700">Sentiment</span>{' '}
          <span className="font-semibold">{p.sentiment}</span>
          {p.failed ? (
            <span className="ml-1 text-xs text-red-500">(detection failed)</span>
          ) : null}
        </>
      );
      break;
    case 'retrieval':
      summary = (
        <>
          <span className="font-medium text-blue-700">Retrieval</span>{' '}
          {p.failed ? (
            <span className="text-red-500">failed</span>
          ) : (
            <span className="text-gray-600">
              {p.passageIds.length} passage{p.passageIds.length !== 1 ? 's' : ''}
            </span>
          )}
        </>
      );
      break;
    case 'decision':
      summary = (
        <>
          <span className="font-medium text-teal-700">Decision</span>{' '}
          path=<span className="font-semibold">{p.path}</span>{' '}
          <span className="text-gray-500">
            ({(p.confidence * 100).toFixed(0)}%, sentiment={p.sentimentUsed})
          </span>
        </>
      );
      break;
    case 'gate': {
      const resultColor =
        p.result === 'pass' ? 'text-green-600' : 'text-orange-600';
      summary = (
        <>
          <span className="font-medium text-yellow-700">Gate</span>{' '}
          <span className="font-semibold">{p.gate}</span>{' '}
          →{' '}
          <span className={`font-semibold ${resultColor}`}>{p.result}</span>
        </>
      );
      break;
    }
    case 'tool_call': {
      const outcomeColor =
        p.outcome === 'success' ? 'text-green-600' : 'text-red-600';
      summary = (
        <>
          <span className="font-medium text-orange-700">Tool</span>{' '}
          <span className="font-semibold">{p.tool}</span>{' '}
          →{' '}
          <span className={`font-semibold ${outcomeColor}`}>{p.outcome}</span>
        </>
      );
      break;
    }
    case 'escalation':
      summary = (
        <>
          <span className="font-medium text-red-700">Escalation</span>{' '}
          <span className="text-gray-600 text-xs">{shortId(p.escalationId)}</span>{' '}
          {p.summaryPresent ? (
            <span className="text-xs text-green-600">(summary present)</span>
          ) : (
            <span className="text-xs text-gray-400">(no summary)</span>
          )}
        </>
      );
      break;
    case 'failure':
      summary = (
        <>
          <span className="font-medium text-red-700">Failure</span>{' '}
          component=<span className="font-semibold">{p.component}</span>{' '}
          <span className="text-gray-500 text-xs">{p.condition}</span>
        </>
      );
      break;
    default:
      summary = <span className="text-gray-500 text-xs">Unknown entry</span>;
  }

  return (
    <li className="flex items-start gap-3 py-2 border-b border-gray-100 last:border-0">
      <span className="mt-0.5 w-6 text-center text-xs font-mono text-gray-400">
        {entry.seq}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm">{summary}</div>
        <div className="text-xs text-gray-400">{fmtTime(entry.timestampMs)}</div>
      </div>
    </li>
  );
}

// ── Action-log detail panel ───────────────────────────────────────────────────

interface ActionLogPanelProps {
  conversationId: string;
  onClose: () => void;
}

function ActionLogPanel({ conversationId, onClose }: ActionLogPanelProps) {
  const [entries, setEntries] = useState<ApiActionLogEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);

    const timeout = setTimeout(() => {
      setLoading(false);
      setError('Action log unavailable');
    }, 3_000);

    api
      .getConversationActions(conversationId)
      .then((data) => {
        clearTimeout(timeout);
        setEntries(data.actions);
        setLoading(false);
      })
      .catch(() => {
        clearTimeout(timeout);
        // Never show partial/empty as complete — always show error (Req 8.7)
        setEntries(null);
        setError('Action log unavailable');
        setLoading(false);
      });

    return () => clearTimeout(timeout);
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Action log"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-t-2xl sm:rounded-2xl bg-white shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Action Log</h2>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              Conversation {shortId(conversationId)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close action log"
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && <Spinner />}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm font-medium text-red-600">{error}</p>
              <button
                onClick={load}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && entries !== null && entries.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-400">
              No action log entries yet.
            </p>
          )}

          {!loading && !error && entries !== null && entries.length > 0 && (
            <ul className="divide-y divide-gray-50">
              {entries.map((e) => (
                <ActionEntryRow key={e.id} entry={e} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Conversation row ──────────────────────────────────────────────────────────

function ConversationRow({
  conv,
  onClick,
}: {
  conv: ApiConversation;
  onClick: () => void;
}) {
  return (
    <tr
      className="cursor-pointer hover:bg-indigo-50 transition-colors"
      onClick={onClick}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      aria-label={`Conversation ${shortId(conv.id)}, click to view action log`}
    >
      <td className="px-4 py-3 font-mono text-xs text-gray-500">{shortId(conv.id)}</td>
      <td className="px-4 py-3 text-sm text-gray-700">{conv.latestIntent ?? '—'}</td>
      <td className="px-4 py-3">{sentimentBadge(conv.latestSentiment)}</td>
      <td className="px-4 py-3 text-sm text-gray-500">{fmtTime(conv.updatedAtMs)}</td>
      <td className="px-4 py-3 text-xs text-indigo-500 font-medium">
        View log →
      </td>
    </tr>
  );
}

// ── Conversation table ────────────────────────────────────────────────────────

function ConversationTable({
  conversations,
  emptyMessage,
  onSelectConversation,
}: {
  conversations: ApiConversation[];
  emptyMessage: string;
  onSelectConversation: (id: string) => void;
}) {
  if (conversations.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-gray-400">{emptyMessage}</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-left">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              ID
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              Intent
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              Sentiment
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              Updated
            </th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {conversations.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              onClick={() => onSelectConversation(conv.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Escalation queue panel ────────────────────────────────────────────────────

function EscalationQueue({
  escalations,
  onSelectConversation,
}: {
  escalations: ApiEscalation[];
  onSelectConversation: (id: string) => void;
}) {
  if (escalations.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-gray-400">No pending escalations</p>
    );
  }

  return (
    <ul className="divide-y divide-gray-100">
      {escalations.map((esc) => (
        <li key={esc.id} className="px-4 py-3 flex items-start gap-3">
          <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-600">
            {esc.priority}
          </span>
          <div className="flex-1 min-w-0">
            <button
              onClick={() => onSelectConversation(esc.conversationId)}
              className="text-sm font-medium text-indigo-600 hover:underline truncate block text-left"
            >
              Conversation {shortId(esc.conversationId)}
            </button>
            {esc.summary ? (
              <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">{esc.summary}</p>
            ) : (
              <p className="mt-0.5 text-xs text-gray-400 italic">No summary available</p>
            )}
            <p className="mt-0.5 text-xs text-gray-400">{fmtTime(esc.createdAtMs)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Dashboard actions panel ───────────────────────────────────────────────────

function ActionsFeed({ actions }: { actions: ApiActionEntry[] }) {
  if (actions.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-gray-400">No refund/replacement actions yet</p>
    );
  }

  return (
    <ul className="divide-y divide-gray-100">
      {actions.map((a, i) => {
        const outcomeColor = a.outcome === 'success' ? 'text-green-600' : 'text-red-600';
        return (
          <li key={i} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-gray-800">{a.tool}</span>
              <span className={`text-xs font-medium ${outcomeColor}`}>{a.outcome}</span>
            </div>
            <p className="mt-0.5 text-xs text-gray-400">
              Conv {shortId(a.conversationId)} · {fmtTime(a.timestampMs)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

// ── View state type ───────────────────────────────────────────────────────────

type LoadState = 'loading' | 'loaded' | 'error' | 'timeout';

interface ViewData {
  live: ApiConversation[];
  resolved: ApiConversation[];
  escalations: ApiEscalation[];
  actions: ApiActionEntry[];
}

// ── Main dashboard page ───────────────────────────────────────────────────────

type Tab = 'live' | 'resolved';

export default function DashboardPage() {
  const [data, setData] = useState<ViewData>({
    live: [],
    resolved: [],
    escalations: [],
    actions: [],
  });
  const [state, setState] = useState<LoadState>('loading');
  const [tab, setTab] = useState<Tab>('live');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  // Track whether we ever received a successful response (so we can keep
  // displaying stale data during background refresh instead of blanking).
  const hasLoaded = useRef(false);

  const fetchAll = useCallback(async () => {
    try {
      const [convData, escData, actData] = await Promise.all([
        api.getDashboardConversations(),
        api.getDashboardEscalations(),
        api.getDashboardActions(),
      ]);

      // Preserve displayed content — update state only after all three
      // succeed so there's no flash/blank between partial updates.
      setData({
        live: convData.live,
        resolved: convData.resolved,
        escalations: escData.escalations,
        actions: actData.actions,
      });
      hasLoaded.current = true;
      setState('loaded');
    } catch {
      if (!hasLoaded.current) {
        setState('error');
      }
      // If we already have data, keep showing it (Req 11.5 — no blanking)
    }
  }, []);

  // Initial load with 10-second timeout indicator
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (!hasLoaded.current) {
        setState('timeout');
      }
    }, INITIAL_LOAD_TIMEOUT_MS);

    fetchAll().finally(() => clearTimeout(timeoutId));

    return () => clearTimeout(timeoutId);
  }, [fetchAll]);

  // Polling loop — preserves existing data between ticks
  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchAll();
    }, DASHBOARD_POLL_MS);

    return () => clearInterval(intervalId);
  }, [fetchAll]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const isInitialLoading = state === 'loading';
  const isError = state === 'error' || state === 'timeout';

  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Page header */}
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Agent Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Monitor live and resolved conversations, escalations, and actions.
          </p>
        </div>
        {state === 'loaded' && (
          <span className="flex items-center gap-1.5 text-xs text-green-600">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            Live
          </span>
        )}
      </header>

      {/* Initial load state */}
      {isInitialLoading && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
          <Spinner />
          <p className="mt-3 text-center text-sm text-gray-500">Loading dashboard…</p>
        </div>
      )}

      {/* Error / timeout state with retry */}
      {isError && !hasLoaded.current && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center shadow-sm">
          <p className="text-sm font-medium text-red-700">
            {state === 'timeout'
              ? 'Dashboard is taking too long to load.'
              : 'Failed to load dashboard data.'}
          </p>
          <button
            onClick={fetchAll}
            className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main content — shown once we have data (stale or fresh) */}
      {hasLoaded.current && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* ── Conversations panel (2/3 width on large screens) ─────────── */}
          <div className="lg:col-span-2 space-y-4">
            {/* Tab bar */}
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="border-b border-gray-200 flex">
                <button
                  onClick={() => setTab('live')}
                  className={`px-5 py-3 text-sm font-medium transition-colors ${
                    tab === 'live'
                      ? 'border-b-2 border-indigo-500 text-indigo-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Live
                  {data.live.length > 0 && (
                    <span className="ml-2 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                      {data.live.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setTab('resolved')}
                  className={`px-5 py-3 text-sm font-medium transition-colors ${
                    tab === 'resolved'
                      ? 'border-b-2 border-indigo-500 text-indigo-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Resolved
                  {data.resolved.length > 0 && (
                    <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {data.resolved.length}
                    </span>
                  )}
                </button>
              </div>

              {/* Per-tab error banner (background refresh failure) */}
              {isError && hasLoaded.current && (
                <div className="flex items-center justify-between bg-yellow-50 border-b border-yellow-200 px-4 py-2">
                  <span className="text-xs text-yellow-700">
                    Showing last successful data. Refresh failed.
                  </span>
                  <button
                    onClick={fetchAll}
                    className="text-xs text-indigo-600 hover:underline font-medium"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Tab body */}
              <div className="min-h-[200px]">
                {tab === 'live' ? (
                  <ConversationTable
                    conversations={data.live}
                    emptyMessage="No live conversations"
                    onSelectConversation={setSelectedConversationId}
                  />
                ) : (
                  <ConversationTable
                    conversations={data.resolved}
                    emptyMessage="No resolved conversations"
                    onSelectConversation={setSelectedConversationId}
                  />
                )}
              </div>
            </div>
          </div>

          {/* ── Sidebar (1/3 width on large screens) ─────────────────────── */}
          <div className="space-y-4">
            {/* Escalation queue */}
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="border-b border-gray-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-800">
                  Escalation Queue
                  {data.escalations.length > 0 && (
                    <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                      {data.escalations.length}
                    </span>
                  )}
                </h2>
              </div>
              <EscalationQueue
                escalations={data.escalations}
                onSelectConversation={setSelectedConversationId}
              />
            </div>

            {/* Dashboard actions feed */}
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="border-b border-gray-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-800">
                  Refund / Replacement Actions
                </h2>
              </div>
              <ActionsFeed actions={data.actions} />
            </div>
          </div>
        </div>
      )}

      {/* ── Action-log detail modal (Task 15.6) ───────────────────────────── */}
      {selectedConversationId !== null && (
        <ActionLogPanel
          conversationId={selectedConversationId}
          onClose={() => setSelectedConversationId(null)}
        />
      )}
    </section>
  );
}
