/**
 * Ticket repository — Data_Store layer for the `tickets` table.
 *
 * Provides CRUD operations for support tickets. Tickets are created as part of
 * the seed data load and can also be created at runtime. The repository supports
 * the full ticket lifecycle: creation, retrieval by id, retrieval by customer,
 * and status updates (open → closed).
 *
 * All reads and writes use the synchronous `better-sqlite3` API against the
 * shared connection returned by `getDb()`. Column names are snake_case in
 * SQLite; they are mapped to camelCase TypeScript at every boundary.
 *
 * UUID generation uses the built-in `crypto.randomUUID()` (Node ≥15).
 *
 * _Requirements: 6.10, 9.2_
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Ticket } from '../domain/types.js';
import { getDb } from '../data/db.js';

// ── Internal row type (matches SQLite column names) ───────────────────────────

interface TicketRow {
  id: string;
  customer_id: string;
  subject: string;
  status: 'open' | 'closed';
  created_at_ms: number;
}

// ── Row → domain mapper ───────────────────────────────────────────────────────

function rowToTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    customerId: row.customer_id,
    subject: row.subject,
    status: row.status,
    createdAtMs: row.created_at_ms,
  };
}

// ── Repository functions ──────────────────────────────────────────────────────

/**
 * Insert a new ticket into the data store.
 *
 * Generates a UUID id and sets `createdAtMs = Date.now()`.
 *
 * @param data  Fields required to create a ticket, excluding `id` and `createdAtMs`.
 * @param db    Optional database connection (defaults to the shared singleton).
 * @returns     The newly created {@link Ticket}.
 */
export function createTicket(
  data: Omit<Ticket, 'id' | 'createdAtMs'>,
  db: Database.Database = getDb(),
): Ticket {
  const id = randomUUID();
  const createdAtMs = Date.now();

  db.prepare<[string, string, string, string, number]>(`
    INSERT INTO tickets (id, customer_id, subject, status, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.customerId, data.subject, data.status, createdAtMs);

  return {
    id,
    customerId: data.customerId,
    subject: data.subject,
    status: data.status,
    createdAtMs,
  };
}

/**
 * Retrieve a single ticket by its id, or `null` if not found.
 *
 * @param id  The ticket UUID (or seed id such as `'TICK-001'`).
 * @param db  Optional database connection (defaults to the shared singleton).
 */
export function getTicketById(
  id: string,
  db: Database.Database = getDb(),
): Ticket | null {
  const row = db
    .prepare<[string], TicketRow>('SELECT * FROM tickets WHERE id = ?')
    .get(id);
  return row !== undefined ? rowToTicket(row) : null;
}

/**
 * Return all tickets belonging to a given customer, ordered by creation time
 * ascending. Returns an empty array when the customer has no tickets.
 *
 * @param customerId  The customer UUID.
 * @param db          Optional database connection (defaults to the shared singleton).
 */
export function getTicketsByCustomerId(
  customerId: string,
  db: Database.Database = getDb(),
): Ticket[] {
  const rows = db
    .prepare<[string], TicketRow>(
      'SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at_ms ASC',
    )
    .all(customerId);
  return rows.map(rowToTicket);
}

/**
 * Update the status of an existing ticket.
 *
 * This is the only mutation path for tickets — the id, customer, subject, and
 * creation timestamp are immutable after creation. A no-op if the ticket does
 * not exist (callers that care should verify with `getTicketById` beforehand).
 *
 * @param id      The ticket UUID.
 * @param status  The new status (`'open'` or `'closed'`).
 * @param db      Optional database connection (defaults to the shared singleton).
 */
export function updateTicketStatus(
  id: string,
  status: 'open' | 'closed',
  db: Database.Database = getDb(),
): void {
  db.prepare<[string, string]>(
    'UPDATE tickets SET status = ? WHERE id = ?',
  ).run(status, id);
}
