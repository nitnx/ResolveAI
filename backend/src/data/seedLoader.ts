/**
 * Idempotent seed data loader for ResolveAI (Data_Store initialization).
 *
 * Loads the static seed dataset ({@link seedData}) into the SQLite
 * Persistence_Store. All inserts use `INSERT OR IGNORE` so the function is
 * safe to call multiple times — on a re-run every statement is a no-op when
 * the row already exists, and no data is duplicated (Req 10.6).
 *
 * If any insert fails for a reason other than a duplicate-key conflict, the
 * error is allowed to propagate. The server startup code in `index.ts` catches
 * that error, logs a clear diagnostic message, and exits so initialization is
 * halted (Req 10.7).
 *
 * All inserts run inside a single synchronous transaction so the database is
 * never left in a partially-seeded state if loading is interrupted.
 *
 * _Requirements: 10.6, 10.7_
 */

import type Database from 'better-sqlite3';
import { seedData } from './seedData.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all seed data into `db` idempotently.
 *
 * Uses `INSERT OR IGNORE` for every table, so calling this function multiple
 * times on the same database is always safe — rows that already exist are
 * silently skipped (Req 10.6).
 *
 * @param db  An open `better-sqlite3` connection with the schema already
 *            initialized (call {@link createDatabase} / {@link initializeSchema}
 *            before this function).
 *
 * @throws {SeedLoadError} when any insert fails for a reason other than a
 *         primary-key conflict. The caller (server startup) should treat this
 *         as a fatal error and halt initialization (Req 10.7).
 */
export function loadSeedData(db: Database.Database): void {
  try {
    _runSeedTransaction(db);
  } catch (cause) {
    throw new SeedLoadError(
      'Failed to load seed data into the Persistence_Store. ' +
        'Initialization cannot continue without sample data.',
      cause,
    );
  }
}

/**
 * Structured error type thrown when seed loading fails. Carries the
 * originating `cause` so callers can log the underlying SQLite error detail.
 */
export class SeedLoadError extends Error {
  /** The underlying error that triggered the failure. */
  public override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SeedLoadError';
    this.cause = cause;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Execute all seed inserts inside a single synchronous transaction. This
 * guarantees an atomic load: either all rows are present or none are (in the
 * case of a first-time failure). On a re-run, `INSERT OR IGNORE` makes every
 * statement a no-op for existing rows, so the transaction commits instantly
 * with zero writes.
 */
function _runSeedTransaction(db: Database.Database): void {
  const insertAll = db.transaction(() => {
    _insertCustomers(db);
    _insertOrders(db);
    _insertPolicies(db);
    _insertTickets(db);
  });

  insertAll();
}

// ── Per-table inserters ───────────────────────────────────────────────────────

function _insertCustomers(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO customers (id, name, email)
     VALUES (@id, @name, @email)`,
  );

  for (const c of seedData.customers) {
    stmt.run({ id: c.id, name: c.name, email: c.email });
  }
}

function _insertOrders(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO orders (
       id, customer_id, items, amount, status,
       ordered_at, promised_delivery_at, delivered_at,
       refunded, replaced, has_valid_complaint
     ) VALUES (
       @id, @customerId, @items, @amount, @status,
       @orderedAt, @promisedDeliveryAt, @deliveredAt,
       @refunded, @replaced, @hasValidComplaint
     )`,
  );

  for (const o of seedData.orders) {
    stmt.run({
      id: o.id,
      customerId: o.customerId,
      items: JSON.stringify(o.items),
      amount: o.amount,
      status: o.status,
      orderedAt: o.orderedAt,
      promisedDeliveryAt: o.promisedDeliveryAt,
      deliveredAt: o.deliveredAt ?? null,
      refunded: o.refunded ? 1 : 0,
      replaced: o.replaced ? 1 : 0,
      hasValidComplaint: o.hasValidComplaint ? 1 : 0,
    });
  }
}

function _insertPolicies(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO policies (id, category, title, text)
     VALUES (@id, @category, @title, @text)`,
  );

  for (const p of seedData.policies) {
    stmt.run({ id: p.id, category: p.category, title: p.title, text: p.text });
  }
}

function _insertTickets(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tickets (id, customer_id, subject, status, created_at_ms)
     VALUES (@id, @customerId, @subject, @status, @createdAtMs)`,
  );

  for (const t of seedData.tickets) {
    stmt.run({
      id: t.id,
      customerId: t.customerId,
      subject: t.subject,
      status: t.status,
      createdAtMs: t.createdAtMs,
    });
  }
}
