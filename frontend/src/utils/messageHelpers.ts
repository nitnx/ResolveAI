/**
 * Pure utility helpers for message validation and ordering.
 *
 * These functions are framework-agnostic and contain no side-effects,
 * making them straightforward to test in isolation.
 *
 * _Requirements: 1.2, 1.3, 1.7, 1.8_
 */

/** Shape of a message as returned by the backend API. */
export interface Message {
  id: string;
  conversationId: string;
  role: string;
  text: string;
  /** Millisecond-precision creation timestamp. */
  timestampMs: number;
  /** Monotonic tiebreaker within the same conversation. */
  seq: number;
}

// ── Message validation ────────────────────────────────────────────────────────

/** Maximum permitted character length for an outgoing customer message. */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * Validates the raw text of an outgoing customer message.
 *
 * - Returns `{ ok: true, value: trimmedText }` for non-whitespace text whose
 *   **trimmed** length is in [1, 2000].
 * - Returns `{ ok: false, reason: 'empty' }` when the text is empty or
 *   entirely whitespace.
 * - Returns `{ ok: false, reason: 'too_long', max: 2000 }` when the **raw**
 *   text length exceeds 2000 characters.
 *
 * The length check is applied to the **raw** (un-trimmed) text so that
 * whitespace-padded inputs that exceed 2000 characters are still rejected.
 */
export function validateMessage(
  text: string,
): { ok: true; value: string } | { ok: false; reason: 'empty' | 'too_long'; max?: number } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: 'too_long', max: MAX_MESSAGE_LENGTH };
  }
  return { ok: true, value: trimmed };
}

// ── Message ordering ──────────────────────────────────────────────────────────

/**
 * Returns a new array of messages sorted in ascending chronological order.
 *
 * Primary sort key: `timestampMs` (ascending).
 * Tiebreaker: `seq` (ascending) — mirrors the ordering applied by the backend
 * message repository.
 *
 * The original array is never mutated.
 */
export function orderMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) =>
    a.timestampMs !== b.timestampMs
      ? a.timestampMs - b.timestampMs
      : a.seq - b.seq,
  );
}
