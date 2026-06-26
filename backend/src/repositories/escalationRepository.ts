/**
 * Escalation repository — Data_Store layer for the `escalations` table.
 *
 * Implements the persistence operations required by the Business_Tools
 * `escalateTicket` method and the Agent_Dashboard escalation-queue endpoint.
 *
 * All reads and writes use the synchronous `better-sqlite3` API against the
 * shared connection returned by `getDb()`. Column names are snake_case in
 * SQLite; they are mapped to camelCase TypeScript at every boundary.
 *
 * The `summary` column is nullable (escalations created when AI summary
 * generation fails carry no summary, Req 7.5). `exactOptionalPropertyTypes`
 * is in effect: the `summary` field is only set on the returned object when
 * a non-null value is present.
 *
 * Queue ordering: `getEscalationQueue` returns all escalations ordered by
 * `priority DESC` so the highest-priority escalation appears first (Req 9.2).
 *
 * UUID generation uses the built-in `crypto.randomUUID()` (Node ≥15), so no
 * third-party `uuid` package is required.
 *
 * _Requirements: 6.10, 9.2_
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Escalation } from '../domain/types.js';
import { getDb } from '../data/db.js';

// ── Internal row type (matches SQLite column names) ───────────────────────────

interface EscalationRow {
  id: string;
  conversation_id: string;
  priority: number;
  summary: string | null;
  created_at_ms: number;
}

// ── Row → domain mapper ───────────────────────────────────────────────────────

function rowToEscalation(row: EscalationRow): Escalation {
  const escalation: Escalation = {
    id: row.id,
    conversationId: row.conversation_id,
    priority: row.priority,
    createdAtMs: row.created_at_ms,
  };
  // Only attach `summary` when it is actually present (exactOptionalPropertyTypes)
  if (row.summary !== null) {
    escalation.summary = row.summary;
  }
  return escalation;
}

// ── Repository functions ──────────────────────────────────────────────────────

/**
 * Insert a new escalation into the queue.
 *
 * Generates a UUID id and sets `createdAtMs = Date.now()`. The `summary` field
 * is optional — pass `undefined` or omit it entirely when AI summary generation
 * failed and the escalation must be created without one (Req 7.5).
 *
 * @param data  Fields required to create an escalation, excluding `id` and `createdAtMs`.
 * @param db    Optional database connection (defaults to the shared singleton).
 * @returns     The newly created {@link Escalation}.
 */
export function createEscalation(
  data: Omit<Escalation, 'id' | 'createdAtMs'>,
  db: Database.Database = getDb(),
): Escalation {
  const id = randomUUID();
  const createdAtMs = Date.now();
  const summary = data.summary ?? null;

  db.prepare<[string, string, number, string | null, number]>(`
    INSERT INTO escalations (id, conversation_id, priority, summary, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.conversationId, data.priority, summary, createdAtMs);

  const escalation: Escalation = {
    id,
    conversationId: data.conversationId,
    priority: data.priority,
    createdAtMs,
  };
  if (summary !== null) {
    escalation.summary = summary;
  }
  return escalation;
}

/**
 * Retrieve a single escalation by its id, or `null` if not found.
 *
 * @param id  The escalation UUID.
 * @param db  Optional database connection (defaults to the shared singleton).
 */
export function getEscalationById(
  id: string,
  db: Database.Database = getDb(),
): Escalation | null {
  const row = db
    .prepare<[string], EscalationRow>('SELECT * FROM escalations WHERE id = ?')
    .get(id);
  return row !== undefined ? rowToEscalation(row) : null;
}

/**
 * Return all escalations ordered by `priority DESC` (highest priority first).
 *
 * This ordering drives the Escalation_Queue view in the Agent_Dashboard
 * (Req 9.2). Returns an empty array when no escalations exist.
 *
 * @param db  Optional database connection (defaults to the shared singleton).
 */
export function getEscalationQueue(
  db: Database.Database = getDb(),
): Escalation[] {
  const rows = db
    .prepare<[], EscalationRow>('SELECT * FROM escalations ORDER BY priority DESC')
    .all();
  return rows.map(rowToEscalation);
}

/**
 * Retrieve the escalation associated with a given conversation, or `null` if
 * the conversation has not been escalated.
 *
 * Per the ER diagram, a conversation may have at most one escalation
 * (`CONVERSATION ||--o| ESCALATION`). If somehow multiple rows exist (data
 * anomaly), the most recently created one is returned.
 *
 * @param conversationId  The conversation UUID.
 * @param db              Optional database connection (defaults to the shared singleton).
 */
export function getEscalationByConversationId(
  conversationId: string,
  db: Database.Database = getDb(),
): Escalation | null {
  const row = db
    .prepare<[string], EscalationRow>(
      'SELECT * FROM escalations WHERE conversation_id = ? ORDER BY created_at_ms DESC LIMIT 1',
    )
    .get(conversationId);
  return row !== undefined ? rowToEscalation(row) : null;
}
