/**
 * SQLite connection and schema module (Data_Store foundation).
 *
 * Opens a single synchronous `better-sqlite3` connection and initializes the
 * relational schema idempotently. The schema mirrors the domain types in
 * `../domain/types.ts` and the "SQLite Schema Notes" / "Data Models" sections
 * of the design document.
 *
 * Design notes:
 * - All entity tables use text primary keys; foreign keys reference
 *   `customers` / `orders` / `conversations`.
 * - `messages` and `action_logs` carry `(conversation_id, seq)` with `seq`
 *   assigned monotonically per conversation; queries order by
 *   `(timestamp_ms ASC, seq ASC)` (Req 1.3, 8.4). Supporting indexes exist.
 * - `action_logs.payload` is stored as a JSON text column; entries are
 *   insert-only — no UPDATE/DELETE paths exist in the repositories (Req 8.5).
 * - `orders.amount` feeds the high-value gate; `refunded` / `replaced` flags
 *   enforce single-outcome eligibility. Booleans are stored as INTEGER 0/1.
 *
 * Persistence:
 * - Runtime uses a file-backed database (durable across restarts, Req 12.8),
 *   path configurable via the `DATABASE_PATH` env var.
 * - Tests pass `{ path: ':memory:' }` for an isolated in-memory database.
 *
 * _Requirements: 12.8, 8.4, 8.5_
 */

import Database from 'better-sqlite3';

/** Default file-backed database path used at runtime when none is provided. */
export const DEFAULT_DB_PATH = 'resolveai.db';

/** Sentinel path that opens a transient in-memory database (used by tests). */
export const IN_MEMORY_PATH = ':memory:';

export interface DatabaseOptions {
  /**
   * Database file path. Use {@link IN_MEMORY_PATH} (`':memory:'`) for an
   * in-memory database in tests. Defaults to `DATABASE_PATH` env var, falling
   * back to {@link DEFAULT_DB_PATH}.
   */
  path?: string;
}

/**
 * The DDL that defines the eight tables and the ordering indexes. Every
 * statement uses `IF NOT EXISTS`, so running this repeatedly is safe and
 * idempotent (re-runs are no-ops on an already-initialized database).
 */
const SCHEMA_SQL = `
-- ── customers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL
);

-- ── orders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY,
  customer_id          TEXT NOT NULL,
  items                TEXT NOT NULL,            -- JSON array of { sku, name, quantity }
  amount               REAL NOT NULL,            -- monetary total (high-value gate)
  status               TEXT NOT NULL,            -- OrderStatus union
  ordered_at           TEXT NOT NULL,            -- ISO timestamp
  promised_delivery_at TEXT NOT NULL,            -- ISO timestamp
  delivered_at         TEXT,                     -- ISO timestamp, nullable
  refunded             INTEGER NOT NULL DEFAULT 0, -- boolean 0/1
  replaced             INTEGER NOT NULL DEFAULT 0, -- boolean 0/1
  has_valid_complaint  INTEGER NOT NULL DEFAULT 0, -- boolean 0/1
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (customer_id);

-- ── policies ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policies (
  id       TEXT PRIMARY KEY,
  category TEXT NOT NULL,                         -- PolicyCategory union
  title    TEXT NOT NULL,
  text     TEXT NOT NULL                          -- indexed for TF-IDF
);

-- ── conversations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT,                        -- nullable FK
  order_id            TEXT,                        -- nullable FK
  status              TEXT NOT NULL,               -- ConversationStatus union
  latest_intent       TEXT,                        -- IntentCategory, nullable
  latest_sentiment    TEXT NOT NULL,               -- Sentiment union
  escalation_priority INTEGER NOT NULL DEFAULT 0,
  created_at_ms       INTEGER NOT NULL,
  updated_at_ms       INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers (id),
  FOREIGN KEY (order_id) REFERENCES orders (id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations (status);

-- ── messages ─────────────────────────────────────────────────────────────────
-- Carries (conversation_id, seq); ordered by (timestamp_ms ASC, seq ASC).
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,                   -- 'customer' | 'assistant'
  text            TEXT NOT NULL,
  timestamp_ms    INTEGER NOT NULL,
  seq             INTEGER NOT NULL,                -- monotonic per conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_order
  ON messages (conversation_id, timestamp_ms ASC, seq ASC);

-- ── action_logs (insert-only / append-only, Req 8.5) ───────────────────────────
-- Carries (conversation_id, seq); payload is JSON text; ordered by
-- (timestamp_ms ASC, seq ASC). Repositories never UPDATE or DELETE rows.
CREATE TABLE IF NOT EXISTS action_logs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,                -- monotonic per conversation
  timestamp_ms    INTEGER NOT NULL,
  type            TEXT NOT NULL,                   -- ActionLogEntry.type union
  payload         TEXT NOT NULL,                   -- JSON-encoded ActionLogPayload
  FOREIGN KEY (conversation_id) REFERENCES conversations (id),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_action_logs_order
  ON action_logs (conversation_id, timestamp_ms ASC, seq ASC);

-- ── tickets ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  subject       TEXT NOT NULL,
  status        TEXT NOT NULL,                     -- 'open' | 'closed'
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets (customer_id);

-- ── escalations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalations (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  priority        INTEGER NOT NULL,                -- queue ordering (Req 9.2)
  summary         TEXT,                            -- nullable (Req 7.5)
  created_at_ms   INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);
CREATE INDEX IF NOT EXISTS idx_escalations_priority ON escalations (priority DESC);
`;

/**
 * Create (or open) a `better-sqlite3` database connection and initialize the
 * schema idempotently. Enables foreign-key enforcement and, for file-backed
 * databases, WAL journaling for durability/concurrency.
 *
 * @param options.path File path, or `':memory:'` for an in-memory database.
 */
export function createDatabase(options: DatabaseOptions = {}): Database.Database {
  const path =
    options.path ?? process.env['DATABASE_PATH'] ?? DEFAULT_DB_PATH;

  const db = new Database(path);

  // Enforce declared foreign keys (off by default in SQLite).
  db.pragma('foreign_keys = ON');

  // WAL mode improves durability/concurrency for file-backed databases; it is
  // a no-op (and unnecessary) for in-memory databases.
  if (path !== IN_MEMORY_PATH) {
    db.pragma('journal_mode = WAL');
  }

  initializeSchema(db);
  return db;
}

/**
 * Initialize the relational schema on an open connection. Uses
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` throughout, so it
 * is safe to call multiple times — re-runs against an already-initialized
 * database are no-ops (Req 12.8).
 */
export function initializeSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

// ── Shared singleton connection ──────────────────────────────────────────────

let sharedDb: Database.Database | undefined;

/**
 * Return the process-wide shared synchronous database connection, creating and
 * initializing it on first use. Runtime code should use this single instance so
 * the synchronous, single-connection ordering guarantees for the action log
 * hold (Req 8.4).
 */
export function getDb(): Database.Database {
  if (sharedDb === undefined) {
    sharedDb = createDatabase();
  }
  return sharedDb;
}

/**
 * Close and clear the shared connection. Primarily used by tests to reset
 * state between cases.
 */
export function closeDb(): void {
  if (sharedDb !== undefined) {
    sharedDb.close();
    sharedDb = undefined;
  }
}
