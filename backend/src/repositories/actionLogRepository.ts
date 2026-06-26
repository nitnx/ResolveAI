/**
 * Append-only action log repository (Data_Store layer).
 *
 * Design invariants (Requirements 8.1, 8.4, 8.5):
 *
 * - **Insert-only**: no UPDATE or DELETE paths exist in this module. Once an
 *   entry is recorded it is immutable (Req 8.5).
 *
 * - **Atomic seq assignment**: `seq` is computed as
 *   `COALESCE(MAX(seq), 0) + 1` for the given conversation inside the same
 *   synchronous SQLite statement (a single INSERT … SELECT). Because
 *   `better-sqlite3` is synchronous and the backend uses a single shared
 *   connection, this is race-free (Req 8.4).
 *
 * - **Chronological retrieval**: `getActionLogByConversationId` returns all
 *   entries ordered by `(timestamp_ms ASC, seq ASC)`, giving a total order
 *   that is stable even when two entries share the same millisecond timestamp
 *   (Req 8.4).
 *
 * - **JSON payload round-trip**: `payload` is serialised to a JSON text column
 *   on write and deserialised back to `ActionLogPayload` on read.
 *
 * _Requirements: 8.1, 8.4, 8.5_
 */

import type Database from 'better-sqlite3';
import type { ActionLogEntry, ActionLogPayload } from '../domain/types.js';

// ── Raw DB row shape ──────────────────────────────────────────────────────────

/**
 * The shape of a raw row returned from the `action_logs` table.
 * `payload` is stored as a JSON text string and must be parsed on retrieval.
 */
interface ActionLogRow {
  id: string;
  conversation_id: string;
  seq: number;
  timestamp_ms: number;
  type: ActionLogEntry['type'];
  payload: string; // JSON-encoded ActionLogPayload
}

// ── Repository factory ────────────────────────────────────────────────────────

/**
 * Create an action log repository bound to the provided `better-sqlite3`
 * connection. Both functions it exposes are synchronous, matching the
 * synchronous `better-sqlite3` API.
 *
 * ```ts
 * const repo = createActionLogRepository(getDb());
 * const entry = repo.appendActionLog({ id, conversationId, timestampMs, type, payload });
 * const log   = repo.getActionLogByConversationId(conversationId);
 * ```
 *
 * @param db An open `better-sqlite3` database connection.
 */
export function createActionLogRepository(db: Database.Database) {
  /**
   * Append a new entry to the action log for `conversationId`.
   *
   * The `seq` is assigned atomically as `COALESCE(MAX(seq), 0) + 1` from the
   * existing rows for the same conversation inside a single INSERT statement —
   * no separate SELECT is required, and no race window exists (Req 8.4).
   *
   * @param entry All fields of `ActionLogEntry` except `seq` (assigned here).
   * @returns The complete `ActionLogEntry` including the assigned `seq`.
   *
   * _Requirements: 8.1, 8.4, 8.5_
   */
  function appendActionLog(
    entry: Omit<ActionLogEntry, 'seq'>,
  ): ActionLogEntry {
    const payloadJson = JSON.stringify(entry.payload);

    // A single INSERT … SELECT assigns seq atomically. The subquery computes
    // the next monotonic sequence number for this conversation without a
    // separate round-trip, keeping the write race-free under the synchronous
    // single-connection model (Req 8.4).
    const insertStmt = db.prepare<
      [string, string, number, string, string, string]
    >(`
      INSERT INTO action_logs (id, conversation_id, seq, timestamp_ms, type, payload)
      SELECT
        ? AS id,
        ? AS conversation_id,
        COALESCE(MAX(seq), 0) + 1 AS seq,
        ? AS timestamp_ms,
        ? AS type,
        ? AS payload
      FROM action_logs
      WHERE conversation_id = ?
    `);

    insertStmt.run(
      entry.id,
      entry.conversationId,
      entry.timestampMs,
      entry.type,
      payloadJson,
      entry.conversationId,
    );

    // Retrieve the assigned seq from the just-inserted row.
    const seqStmt = db.prepare<[string], { seq: number }>(
      'SELECT seq FROM action_logs WHERE id = ?',
    );
    const row = seqStmt.get(entry.id);

    if (row === undefined) {
      throw new Error(
        `actionLogRepository: failed to retrieve seq for inserted entry id="${entry.id}"`,
      );
    }

    return { ...entry, seq: row.seq };
  }

  /**
   * Retrieve all action log entries for a conversation, ordered
   * ascending by `(timestamp_ms, seq)` — chronological order (Req 8.4).
   *
   * Returns an empty array when no entries exist for the conversation.
   * Parses `payload` from the JSON text column back to `ActionLogPayload`.
   *
   * _Requirements: 8.4, 8.6_
   */
  function getActionLogByConversationId(conversationId: string): ActionLogEntry[] {
    const selectStmt = db.prepare<[string], ActionLogRow>(`
      SELECT id, conversation_id, seq, timestamp_ms, type, payload
      FROM   action_logs
      WHERE  conversation_id = ?
      ORDER  BY timestamp_ms ASC, seq ASC
    `);

    const rows = selectStmt.all(conversationId);

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      seq: row.seq,
      timestampMs: row.timestamp_ms,
      type: row.type,
      payload: JSON.parse(row.payload) as ActionLogPayload,
    }));
  }

  return { appendActionLog, getActionLogByConversationId } as const;
}

/** Convenience type alias for the repository returned by the factory. */
export type ActionLogRepository = ReturnType<typeof createActionLogRepository>;

// ── Dashboard helper ──────────────────────────────────────────────────────────

/**
 * Shape of a single refund or replacement action entry returned by
 * {@link getRefundReplacementActions}.
 */
export interface RefundReplacementAction {
  conversationId: string;
  tool: string;            // 'processRefund' | 'processReplacement'
  params: unknown;
  result: unknown;
  outcome: 'success' | 'failure';
  timestampMs: number;
}

/**
 * Fetch all action-log entries across all conversations where `type ===
 * 'tool_call'` and `payload.tool` is `'processRefund'` or
 * `'processReplacement'`. Used by the Agent_Dashboard actions endpoint
 * (Req 9.3).
 *
 * The query filters at the SQL layer using `json_extract` for efficiency,
 * falling back to a JS-level filter on the parsed payload to guarantee
 * correctness.
 *
 * Results are ordered chronologically (oldest first).
 *
 * @param db  Optional database connection (defaults to the shared singleton via
 *            the caller providing it).
 */
export function getRefundReplacementActions(
  db: Database.Database,
): RefundReplacementAction[] {
  // Use json_extract to push the filter into SQLite; include a type='tool_call'
  // guard so the index on conversation_id/timestamp is still useful.
  const rows = db
    .prepare<[], ActionLogRow>(`
      SELECT id, conversation_id, seq, timestamp_ms, type, payload
      FROM   action_logs
      WHERE  type = 'tool_call'
        AND  json_extract(payload, '$.tool') IN ('processRefund', 'processReplacement')
      ORDER  BY timestamp_ms ASC, seq ASC
    `)
    .all();

  return rows.map((row) => {
    const parsed = JSON.parse(row.payload) as ActionLogPayload;
    // Narrow to the tool_call variant — the SQL WHERE already guarantees this,
    // but we assert here for type safety.
    if (parsed.kind !== 'tool_call') {
      return null;
    }
    const toolPayload = parsed as Extract<ActionLogPayload, { kind: 'tool_call' }>;
    return {
      conversationId: row.conversation_id,
      tool: toolPayload.tool,
      params: toolPayload.params,
      result: toolPayload.result,
      outcome: toolPayload.outcome,
      timestampMs: row.timestamp_ms,
    };
  }).filter((item): item is RefundReplacementAction => item !== null);
}
