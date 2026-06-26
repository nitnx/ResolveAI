/**
 * Pure utility helpers for the Agent Dashboard.
 *
 * These functions are framework-agnostic and contain no side-effects,
 * making them straightforward to test in isolation.
 *
 * _Requirements: 9.1, 9.2_
 */

import type { Conversation, Escalation } from './dashboardTypes.js';

// ── Conversation partitioning ─────────────────────────────────────────────────

/**
 * Partition an array of conversations into `live` (status `'active'`) and
 * `resolved` (status `'resolved'`).
 *
 * - Every conversation appears in exactly one of the two views (Req 9.1).
 * - The union of `live` and `resolved` is a permutation of the input array.
 * - The two sets are disjoint.
 *
 * _Requirements: 9.1_
 */
export function partitionConversations(convs: Conversation[]): {
  live: Conversation[];
  resolved: Conversation[];
} {
  const live: Conversation[] = [];
  const resolved: Conversation[] = [];
  for (const conv of convs) {
    if (conv.status === 'active') {
      live.push(conv);
    } else {
      resolved.push(conv);
    }
  }
  return { live, resolved };
}

// ── Escalation sorting ────────────────────────────────────────────────────────

/**
 * Return a new array of escalations sorted by priority in non-increasing order
 * (highest priority first).
 *
 * - The result is a permutation (multiset-equal) of the input.
 * - The sort is stable (preserves insertion order for equal-priority entries).
 *
 * _Requirements: 9.2_
 */
export function sortEscalations(queue: Escalation[]): Escalation[] {
  return [...queue].sort((a, b) => b.priority - a.priority);
}
