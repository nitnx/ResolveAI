/**
 * Agent Dashboard API routes.
 *
 * Implements the three dashboard endpoints required by Requirement 9
 * (Agent_Dashboard). All errors return structured `{ error: { code, message } }`
 * responses via the centralized error handler.
 *
 * Endpoints:
 *   GET /api/dashboard/conversations  — live/resolved partition (Req 9.1)
 *   GET /api/dashboard/escalations    — priority desc with summary (Req 9.2)
 *   GET /api/dashboard/actions        — refund/replacement actions (Req 9.3)
 *
 * _Requirements: 9.1, 9.2, 9.3_
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ConversationRepository } from '../repositories/conversationRepository.js';
import { getEscalationQueue } from '../repositories/escalationRepository.js';
import { getRefundReplacementActions } from '../repositories/actionLogRepository.js';
import { getDb } from '../data/db.js';
import type { Conversation } from '../domain/types.js';

// ── Partition helper (pure, also exported for frontend helper use) ─────────────

/**
 * Partition an array of conversations into `live` (status `'active'`) and
 * `resolved` (status `'resolved'`). Every conversation appears in exactly one
 * of the two views (Req 9.1).
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

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

/**
 * GET /api/dashboard/conversations
 *
 * Returns all conversations partitioned into `live` (status `'active'`) and
 * `resolved` (status `'resolved'`). Each conversation appears in exactly one
 * partition (Req 9.1).
 *
 * Response body: `{ live: Conversation[], resolved: Conversation[] }`
 */
router.get(
  '/conversations',
  (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const repo = new ConversationRepository(db);
      const all = repo.getAllConversations();

      // Hide placeholder conversations that carry no customer messages AND no
      // action-log entries. The Reset Demo flow still creates a fresh
      // conversation internally, but until the customer sends a message it has
      // no content, so it should not clutter the dashboard.
      const withContent = new Set<string>();
      for (const row of db
        .prepare<[], { id: string }>(
          `SELECT DISTINCT conversation_id AS id FROM messages WHERE role = 'customer'`,
        )
        .all()) {
        withContent.add(row.id);
      }
      for (const row of db
        .prepare<[], { id: string }>(
          'SELECT DISTINCT conversation_id AS id FROM action_logs',
        )
        .all()) {
        withContent.add(row.id);
      }
      const visible = all.filter((conv) => withContent.has(conv.id));

      const { live, resolved } = partitionConversations(visible);
      // Newest activity first so the current demo conversation leads the list.
      const newestFirst = (a: Conversation, b: Conversation): number =>
        b.updatedAtMs - a.updatedAtMs || b.createdAtMs - a.createdAtMs;
      live.sort(newestFirst);
      resolved.sort(newestFirst);
      res.json({ live, resolved });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/dashboard/escalations
 *
 * Returns all escalations ordered by priority descending (highest priority
 * first). Each entry includes the AI-generated conversation summary when
 * present (Req 9.2).
 *
 * Response body: `{ escalations: Escalation[] }`
 */
router.get(
  '/escalations',
  (_req: Request, res: Response, next: NextFunction): void => {
    try {
      // getEscalationQueue already orders by priority DESC (Req 9.2)
      const queue = getEscalationQueue(getDb());
      // Collapse to at most one entry per conversation (keep the highest-priority,
      // which comes first) so repeated escalations within a run don't show as
      // duplicate queue items.
      const seen = new Set<string>();
      const escalations = queue.filter((esc) => {
        if (seen.has(esc.conversationId)) return false;
        seen.add(esc.conversationId);
        return true;
      });
      res.json({ escalations });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/dashboard/actions
 *
 * Returns all refund and replacement action-log entries across every
 * conversation. Each entry includes the conversation reference, tool name,
 * invocation params, result, outcome, and timestamp (Req 9.3).
 *
 * Response body:
 * ```json
 * {
 *   "actions": [
 *     {
 *       "conversationId": "...",
 *       "tool": "processRefund" | "processReplacement",
 *       "params": { ... },
 *       "result": { ... },
 *       "outcome": "success" | "failure",
 *       "timestampMs": 1234567890
 *     }
 *   ]
 * }
 * ```
 */
router.get(
  '/actions',
  (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const actions = getRefundReplacementActions(getDb());
      // Newest first so the most recent refund/replacement leads the feed.
      actions.sort((a, b) => b.timestampMs - a.timestampMs);
      res.json({ actions });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
