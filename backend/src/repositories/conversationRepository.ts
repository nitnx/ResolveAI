/**
 * Conversation repository.
 *
 * CRUD operations over the `conversations` SQLite table using the synchronous
 * `better-sqlite3` API. Handles snake_case ↔ camelCase mapping between the
 * database and the domain `Conversation` type.
 *
 * _Requirements: 1.4, 12.8_
 */

import type Database from 'better-sqlite3';
import { getDb } from '../data/db.js';
import type {
  Conversation,
  ConversationStatus,
  IntentCategory,
  Sentiment,
} from '../domain/types.js';

// ── Row shape returned by SQLite ─────────────────────────────────────────────

interface ConversationRow {
  id: string;
  customer_id: string | null;
  order_id: string | null;
  status: string;
  latest_intent: string | null;
  latest_sentiment: string;
  escalation_priority: number;
  created_at_ms: number;
  updated_at_ms: number;
}

// ── Row → domain mapping ─────────────────────────────────────────────────────

function rowToConversation(row: ConversationRow): Conversation {
  const conv: Conversation = {
    id: row.id,
    status: row.status as ConversationStatus,
    latestSentiment: row.latest_sentiment as Sentiment,
    escalationPriority: row.escalation_priority,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };

  // Optional fields — only set when present (exactOptionalPropertyTypes)
  if (row.customer_id !== null) {
    conv.customerId = row.customer_id;
  }
  if (row.order_id !== null) {
    conv.orderId = row.order_id;
  }
  if (row.latest_intent !== null) {
    conv.latestIntent = row.latest_intent as IntentCategory;
  }

  return conv;
}

// ── Repository ───────────────────────────────────────────────────────────────

export class ConversationRepository {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDb();
  }

  /**
   * Insert a new conversation with status `'active'`, `latestSentiment`
   * `'neutral'`, and `escalationPriority` 0. Returns the created domain
   * object.
   */
  createConversation(data: {
    id: string;
    customerId?: string;
    orderId?: string;
  }): Conversation {
    const nowMs = Date.now();

    this.db
      .prepare<[string, string | null, string | null, number, number]>(
        `INSERT INTO conversations
           (id, customer_id, order_id, status, latest_intent, latest_sentiment,
            escalation_priority, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'active', NULL, 'neutral', 0, ?, ?)`,
      )
      .run(
        data.id,
        data.customerId ?? null,
        data.orderId ?? null,
        nowMs,
        nowMs,
      );

    // Safe cast — we just inserted this row, so it must exist.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.getConversationById(data.id)!;
  }

  /**
   * Fetch a conversation by its primary key. Returns `null` when not found.
   */
  getConversationById(id: string): Conversation | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT id, customer_id, order_id, status, latest_intent,
                latest_sentiment, escalation_priority, created_at_ms, updated_at_ms
         FROM conversations
         WHERE id = ?`,
      )
      .get(id);

    return row !== undefined ? rowToConversation(row) : null;
  }

  /**
   * Return all conversations ordered by creation time (oldest first).
   */
  getAllConversations(): Conversation[] {
    const rows = this.db
      .prepare<[], ConversationRow>(
        `SELECT id, customer_id, order_id, status, latest_intent,
                latest_sentiment, escalation_priority, created_at_ms, updated_at_ms
         FROM conversations
         ORDER BY created_at_ms ASC`,
      )
      .all();

    return rows.map(rowToConversation);
  }

  /**
   * Update the lifecycle status of a conversation and stamp `updated_at_ms`.
   */
  updateConversationStatus(id: string, status: ConversationStatus): void {
    this.db
      .prepare<[string, number, string]>(
        `UPDATE conversations
         SET status = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(status, Date.now(), id);
  }

  /**
   * Record the most recently detected intent on a conversation.
   */
  updateLatestIntent(id: string, intent: IntentCategory): void {
    this.db
      .prepare<[string, number, string]>(
        `UPDATE conversations
         SET latest_intent = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(intent, Date.now(), id);
  }

  /**
   * Record the most recently detected sentiment on a conversation (Req 9.4).
   */
  updateLatestSentiment(id: string, sentiment: Sentiment): void {
    this.db
      .prepare<[string, number, string]>(
        `UPDATE conversations
         SET latest_sentiment = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(sentiment, Date.now(), id);
  }

  /**
   * Set the escalation priority on a conversation (higher = more urgent,
   * Req 9.2). Raised by the Orchestrator when latest sentiment is negative
   * (Req 4.4).
   */
  updateEscalationPriority(id: string, priority: number): void {
    this.db
      .prepare<[number, number, string]>(
        `UPDATE conversations
         SET escalation_priority = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(priority, Date.now(), id);
  }
}

// ── Default singleton instance ────────────────────────────────────────────────

let defaultInstance: ConversationRepository | undefined;

/** Return (or create) the default shared `ConversationRepository` instance. */
export function getConversationRepository(): ConversationRepository {
  if (defaultInstance === undefined) {
    defaultInstance = new ConversationRepository();
  }
  return defaultInstance;
}
