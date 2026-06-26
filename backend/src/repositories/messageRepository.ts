/**
 * Message repository.
 *
 * Append-and-read operations over the `messages` SQLite table using the
 * synchronous `better-sqlite3` API.
 *
 * Key design constraints (Req 1.3, 1.4, 12.8):
 * - `seq` is assigned as `MAX(seq) + 1` for the conversation inside the same
 *   synchronous INSERT, making the assignment race-free on the single-process
 *   backend connection.
 * - `getMessagesByConversationId` returns rows sorted by
 *   `(timestamp_ms ASC, seq ASC)` to guarantee stable chronological ordering
 *   even when multiple messages share an identical millisecond timestamp
 *   (Req 1.3, 8.4).
 *
 * _Requirements: 1.3, 1.4, 12.8_
 */

import type Database from 'better-sqlite3';
import { getDb } from '../data/db.js';
import type { Message } from '../domain/types.js';

// ── Row shape returned by SQLite ─────────────────────────────────────────────

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  text: string;
  timestamp_ms: number;
  seq: number;
}

// ── Row → domain mapping ─────────────────────────────────────────────────────

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as 'customer' | 'assistant',
    text: row.text,
    timestampMs: row.timestamp_ms,
    seq: row.seq,
  };
}

// ── Repository ───────────────────────────────────────────────────────────────

export class MessageRepository {
  private readonly db: Database.Database;

  /**
   * Prepared statement that atomically computes the next `seq` value and
   * inserts the row in one operation, making seq assignment race-free.
   *
   * The subquery `COALESCE(MAX(seq), 0) + 1` returns 1 for the first message
   * in a conversation and increments monotonically for subsequent ones.
   */
  private readonly insertStmt: Database.Statement<
    [string, string, string, string, number, string]
  >;

  constructor(db?: Database.Database) {
    this.db = db ?? getDb();

    // Prepare once and reuse — safer and faster than repeated .prepare() calls.
    // The statement has 6 bind parameters: id, conversation_id, role, text,
    // timestamp_ms, and the correlated subquery's conversation_id.
    this.insertStmt = this.db.prepare<[string, string, string, string, number, string]>(
      `INSERT INTO messages (id, conversation_id, role, text, timestamp_ms, seq)
       VALUES (
         ?,
         ?,
         ?,
         ?,
         ?,
         (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?)
       )`,
    );
  }

  /**
   * Append a message to a conversation.
   *
   * `seq` is NOT supplied by the caller — it is computed atomically as
   * `MAX(seq FOR conversationId) + 1` (or 1 when there are no prior messages)
   * inside the same synchronous write. The inserted message, including the
   * assigned `seq`, is returned.
   *
   * @param msg — all Message fields except `seq`
   */
  appendMessage(msg: Omit<Message, 'seq'>): Message {
    this.insertStmt.run(
      msg.id,
      msg.conversationId,
      msg.role,
      msg.text,
      msg.timestampMs,
      // The subquery correlated parameter: WHERE conversation_id = ?
      msg.conversationId,
    );

    // Retrieve the row we just inserted to get the assigned `seq`.
    const row = this.db
      .prepare<[string], MessageRow>(
        `SELECT id, conversation_id, role, text, timestamp_ms, seq
         FROM messages
         WHERE id = ?`,
      )
      .get(msg.id);

    if (row === undefined) {
      throw new Error(
        `MessageRepository.appendMessage: failed to re-fetch inserted message id=${msg.id}`,
      );
    }

    return rowToMessage(row);
  }

  /**
   * Return all messages for a conversation ordered by
   * `(timestamp_ms ASC, seq ASC)`.
   *
   * This ordering is critical for Requirements 1.3 ("display the response in
   * the conversation history ordered by ascending message timestamp") and 8.4
   * (monotonic sequence numbers as tiebreakers when two messages share an
   * identical millisecond timestamp).
   */
  getMessagesByConversationId(conversationId: string): Message[] {
    const rows = this.db
      .prepare<[string], MessageRow>(
        `SELECT id, conversation_id, role, text, timestamp_ms, seq
         FROM messages
         WHERE conversation_id = ?
         ORDER BY timestamp_ms ASC, seq ASC`,
      )
      .all(conversationId);

    return rows.map(rowToMessage);
  }
}

// ── Default singleton instance ────────────────────────────────────────────────

let defaultInstance: MessageRepository | undefined;

/** Return (or create) the default shared `MessageRepository` instance. */
export function getMessageRepository(): MessageRepository {
  if (defaultInstance === undefined) {
    defaultInstance = new MessageRepository();
  }
  return defaultInstance;
}
