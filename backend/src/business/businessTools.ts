/**
 * Business_Tools — mock backend operations for ResolveAI.
 *
 * Each method corresponds to a Business_Tool invoked by the Orchestrator.
 * On every invocation the method records a `tool_call` action log entry
 * containing the tool identifier, input parameters, result, and success/failure
 * outcome (Req 6.11, 8.1).
 *
 * This module implements:
 *   - `orderLookup`                  — Req 6.1, 6.2
 *   - `checkRefundEligibility`       — Req 6.3, 6.4
 *   - `checkReplacementEligibility`  — Req 6.7
 *   - `processRefund`                — Req 6.5, 6.6
 *   - `processReplacement`           — Req 6.8, 6.9
 *   - `escalateTicket`               — Req 6.10
 *
 * Task 9.3 focus: `checkRefundEligibility` and `checkReplacementEligibility`.
 *
 * _Requirements: 6.3, 6.4, 6.7, 6.11, 8.1_
 */

import { randomUUID } from 'node:crypto';
import type { Order, PolicyPassage, ActionLogEntry, Escalation, Conversation } from '../domain/types.js';
import type { ActionLogRepository } from '../repositories/actionLogRepository.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The policy context passed to eligibility checks.
 * Contains the policy passages retrieved by the RAG_Retriever for the current
 * conversation turn (Req 5.3, design.md "Business_Tools" section).
 */
export interface PolicyContext {
  passages: PolicyPassage[];
}

/**
 * Discriminated union representing the three possible eligibility outcomes.
 * Always carries a `reason` string derived from policy context (Req 6.3, 6.7).
 */
export type EligibilityResult =
  | { status: 'eligible'; reason: string }
  | { status: 'ineligible'; reason: string }
  | { status: 'indeterminate'; reason: string };

export type OrderLookupResult =
  | { found: true; order: Order }
  | { found: false };

export type RefundResult =
  | { processed: true; orderId: string }
  | { processed: false; reason: string };

export type ReplacementResult =
  | { processed: true; orderId: string }
  | { processed: false; reason: string };

// ── Helper — extract policy reason from passages ──────────────────────────────

/**
 * Extract a human-readable reason from the retrieved policy passages.
 * Returns the text of the first refund/replacement passage (whichever is
 * relevant), or a generic fallback when none is present.
 */
function extractPolicyReason(
  passages: PolicyPassage[],
  preferredCategory: 'refund' | 'replacement',
  fallback: string,
): string {
  const match = passages.find((p) => p.category === preferredCategory);
  if (match !== undefined) {
    // Return a condensed excerpt: first 200 characters of the passage text.
    return match.text.length > 200
      ? `${match.text.slice(0, 200).trimEnd()}…`
      : match.text;
  }
  return fallback;
}

/**
 * Returns true when at least one retrieved policy passage supports the given
 * category. "Supports" means a passage of that category exists — the presence
 * of a retrieved refund/replacement policy passage is the proxy for policy
 * approval (Req 6.3, 6.7).
 */
function policySupports(
  passages: PolicyPassage[],
  category: 'refund' | 'replacement',
): boolean {
  return passages.some((p) => p.category === category);
}

// ── BusinessTools class ──────────────────────────────────────────────────────

/**
 * Dependencies injected at construction so the tools can be exercised in tests
 * with stubs (design.md: "Each backend module exposes a TypeScript interface
 * and is constructed via dependency injection").
 */
export interface BusinessToolsDeps {
  actionLogRepo: ActionLogRepository;
  orderRepo: OrderRepository;
  escalationRepo: EscalationRepository;
  /** The conversation ID for which this invocation is being made. */
  conversationId: string;
}

/**
 * A thin convenience type alias that matches the shape of
 * `createOrderRepository`'s return type.
 */
export interface OrderRepository {
  getOrderById(id: string): Order | null;
  markRefunded(orderId: string): void;
  markReplaced(orderId: string): void;
}

/**
 * A thin convenience type alias for the escalation repository.
 * Matches the signature of the standalone `createEscalation` function in
 * `escalationRepository.ts` which accepts the data without `id`/`createdAtMs`.
 */
export interface EscalationRepository {
  createEscalation(data: Omit<Escalation, 'id' | 'createdAtMs'>): Escalation;
}

export class BusinessTools {
  private readonly actionLogRepo: ActionLogRepository;
  private readonly orderRepo: OrderRepository;
  private readonly escalationRepo: EscalationRepository;
  private readonly conversationId: string;

  constructor(deps: BusinessToolsDeps) {
    this.actionLogRepo = deps.actionLogRepo;
    this.orderRepo = deps.orderRepo;
    this.escalationRepo = deps.escalationRepo;
    this.conversationId = deps.conversationId;
  }

  // ── Private helper: log a tool_call entry ───────────────────────────────────

  /**
   * Append a `tool_call` action log entry for this invocation.
   * Called at the end of every public method (Req 6.11, 8.1).
   */
  private logToolCall(
    tool: string,
    params: unknown,
    result: unknown,
    outcome: 'success' | 'failure',
  ): ActionLogEntry {
    return this.actionLogRepo.appendActionLog({
      id: randomUUID(),
      conversationId: this.conversationId,
      timestampMs: Date.now(),
      type: 'tool_call',
      payload: {
        kind: 'tool_call',
        tool,
        params,
        result,
        outcome,
      },
    });
  }

  // ── Order lookup (Req 6.1, 6.2) ─────────────────────────────────────────────

  /**
   * Look up an order by its identifier.
   *
   * - Returns the matching {@link Order} when found (Req 6.1).
   * - Returns a not-found result and never mutates any order when the
   *   identifier matches no seeded Order (Req 6.2).
   * - Records a `tool_call` action log entry on completion (Req 6.11).
   *
   * _Requirements: 6.1, 6.2, 6.11_
   */
  async orderLookup(orderId: string): Promise<OrderLookupResult> {
    let result: OrderLookupResult;
    let outcome: 'success' | 'failure' = 'success';

    try {
      const order = this.orderRepo.getOrderById(orderId);
      result = order !== null
        ? { found: true, order }
        : { found: false };
    } catch (err) {
      outcome = 'failure';
      result = { found: false };
    }

    this.logToolCall('orderLookup', { orderId }, result, outcome);
    return result;
  }

  // ── Refund eligibility (Req 6.3, 6.4) ───────────────────────────────────────

  /**
   * Check whether an order is eligible for a refund.
   *
   * Returns `eligible` **only** when ALL of the following conditions hold
   * (Req 6.3):
   *
   * 1. The order exists (passed in as the `order` parameter — caller has already
   *    resolved it via `orderLookup`).
   * 2. The order is **not** already refunded (`order.refunded === false`).
   * 3. The order status is `delayed`, `lost`, or (`delivered` AND
   *    `order.hasValidComplaint === true`).
   * 4. For **delayed** orders: the promised delivery date is at least 3 days
   *    past due as of now.
   * 5. For **delivered** orders: the refund request is within 30 days of
   *    delivery (requires `order.deliveredAt`).
   * 6. At least one refund policy passage is present in the retrieved context
   *    (proxy for "policy supports the refund").
   *
   * Returns `ineligible` when any condition fails with a human-readable reason
   * drawn from the policy passages.
   *
   * Returns `indeterminate` only when the eligibility cannot be determined —
   * e.g. the status is an unexpected value that the logic cannot categorise
   * (Req 6.4).
   *
   * Always logs a `tool_call` entry on completion (Req 6.11).
   *
   * _Requirements: 6.3, 6.4, 6.11_
   */
  checkRefundEligibility(order: Order, ctx: PolicyContext): EligibilityResult {
    let result: EligibilityResult;

    try {
      result = this._evaluateRefundEligibility(order, ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error during eligibility check';
      result = { status: 'indeterminate', reason };
    }

    this.logToolCall(
      'checkRefundEligibility',
      { orderId: order.id, orderStatus: order.status, passages: ctx.passages.map((p) => p.id) },
      result,
      result.status === 'indeterminate' ? 'failure' : 'success',
    );

    return result;
  }

  /**
   * Pure eligibility evaluation logic extracted for testability.
   * Throws when an unexpected condition prevents determination (→ `indeterminate`).
   */
  private _evaluateRefundEligibility(order: Order, ctx: PolicyContext): EligibilityResult {
    const policyReason = extractPolicyReason(
      ctx.passages,
      'refund',
      'No refund policy passage was retrieved.',
    );

    // Condition 2: not already refunded.
    if (order.refunded) {
      return {
        status: 'ineligible',
        reason: `Order ${order.id} has already been refunded.`,
      };
    }

    // Condition 6: policy must support the refund.
    if (!policySupports(ctx.passages, 'refund')) {
      return {
        status: 'ineligible',
        reason: 'No applicable refund policy was found for this request.',
      };
    }

    const now = Date.now();

    // Condition 3 + 4 + 5: status-based checks.
    switch (order.status) {
      case 'delayed': {
        // Condition 4: promised delivery date ≥ 3 days past due.
        const promisedMs = Date.parse(order.promisedDeliveryAt);
        if (!Number.isFinite(promisedMs)) {
          // Cannot parse the date — undeterminable.
          return {
            status: 'indeterminate',
            reason: `Cannot parse promisedDeliveryAt for order ${order.id}.`,
          };
        }
        const daysPastDue = (now - promisedMs) / (1000 * 60 * 60 * 24);
        if (daysPastDue >= 3) {
          return {
            status: 'eligible',
            reason: `Order is delayed ${daysPastDue.toFixed(1)} days past the promised delivery date. ${policyReason}`,
          };
        }
        return {
          status: 'ineligible',
          reason: `Order is delayed but only ${daysPastDue.toFixed(1)} days past due (minimum 3 required). ${policyReason}`,
        };
      }

      case 'lost': {
        // Lost orders are unconditionally eligible (status satisfies condition 3).
        return {
          status: 'eligible',
          reason: `Order has been marked as lost. ${policyReason}`,
        };
      }

      case 'delivered': {
        // Condition 3 requires a valid complaint for delivered orders.
        if (!order.hasValidComplaint) {
          return {
            status: 'ineligible',
            reason: 'Order was delivered and no valid complaint is on record.',
          };
        }
        // Condition 5: request within 30 days of delivery.
        if (order.deliveredAt === undefined) {
          return {
            status: 'indeterminate',
            reason: `Order ${order.id} is marked delivered but has no deliveredAt timestamp.`,
          };
        }
        const deliveredMs = Date.parse(order.deliveredAt);
        if (!Number.isFinite(deliveredMs)) {
          return {
            status: 'indeterminate',
            reason: `Cannot parse deliveredAt for order ${order.id}.`,
          };
        }
        const daysSinceDelivery = (now - deliveredMs) / (1000 * 60 * 60 * 24);
        if (daysSinceDelivery <= 30) {
          return {
            status: 'eligible',
            reason: `Order was delivered ${daysSinceDelivery.toFixed(1)} days ago with a valid complaint on record. ${policyReason}`,
          };
        }
        return {
          status: 'ineligible',
          reason: `Order was delivered ${daysSinceDelivery.toFixed(1)} days ago, which exceeds the 30-day refund window. ${policyReason}`,
        };
      }

      case 'processing':
      case 'shipped': {
        return {
          status: 'ineligible',
          reason: `Order status is "${order.status}". Refunds are only available for delayed, lost, or delivered orders with a valid complaint.`,
        };
      }

      default: {
        // Exhaustive check — TypeScript guarantees all OrderStatus values are
        // handled above, so this branch is a runtime safety net.
        const unexpected: never = order.status;
        return {
          status: 'indeterminate',
          reason: `Unexpected order status "${String(unexpected)}" prevents eligibility determination.`,
        };
      }
    }
  }

  // ── Replacement eligibility (Req 6.7) ────────────────────────────────────────

  /**
   * Check whether an order is eligible for a replacement.
   *
   * Returns `eligible` **only** when ALL of the following conditions hold
   * (Req 6.7):
   *
   * 1. The order exists (passed in as the `order` parameter).
   * 2. The order is **not** already replaced (`order.replaced === false`).
   * 3. The order is **not** already refunded (`order.refunded === false`).
   * 4. The item is damaged, lost, or significantly delayed:
   *    - `status === 'lost'` (lost)
   *    - `status === 'delayed'` (significantly delayed, per design.md)
   *    - `hasValidComplaint === true` AND `status === 'delivered'` (damaged —
   *      a delivered order with a valid complaint implies damage)
   * 5. At least one replacement policy passage is present in the retrieved
   *    context (proxy for "replacement policy supports the replacement").
   *
   * Returns `ineligible` when any condition fails.
   * Always logs a `tool_call` entry on completion (Req 6.11).
   *
   * _Requirements: 6.7, 6.11_
   */
  checkReplacementEligibility(order: Order, ctx: PolicyContext): EligibilityResult {
    let result: EligibilityResult;

    try {
      result = this._evaluateReplacementEligibility(order, ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error during eligibility check';
      result = { status: 'indeterminate', reason };
    }

    this.logToolCall(
      'checkReplacementEligibility',
      { orderId: order.id, orderStatus: order.status, passages: ctx.passages.map((p) => p.id) },
      result,
      result.status === 'indeterminate' ? 'failure' : 'success',
    );

    return result;
  }

  /**
   * Pure replacement eligibility evaluation logic extracted for testability.
   */
  private _evaluateReplacementEligibility(order: Order, ctx: PolicyContext): EligibilityResult {
    const policyReason = extractPolicyReason(
      ctx.passages,
      'replacement',
      'No replacement policy passage was retrieved.',
    );

    // Condition 3: not already refunded.
    if (order.refunded) {
      return {
        status: 'ineligible',
        reason: `Order ${order.id} has already been refunded; a replacement cannot be issued.`,
      };
    }

    // Condition 2: not already replaced.
    if (order.replaced) {
      return {
        status: 'ineligible',
        reason: `Order ${order.id} has already been replaced.`,
      };
    }

    // Condition 5: policy must support the replacement.
    if (!policySupports(ctx.passages, 'replacement')) {
      return {
        status: 'ineligible',
        reason: 'No applicable replacement policy was found for this request.',
      };
    }

    // Condition 4: item must be damaged, lost, or significantly delayed.
    const isLost = order.status === 'lost';
    const isSignificantlyDelayed = order.status === 'delayed';
    const isDamaged = order.status === 'delivered' && order.hasValidComplaint;

    if (isLost) {
      return {
        status: 'eligible',
        reason: `Order has been marked as lost; a replacement can be issued. ${policyReason}`,
      };
    }

    if (isSignificantlyDelayed) {
      return {
        status: 'eligible',
        reason: `Order is significantly delayed; a replacement can be issued. ${policyReason}`,
      };
    }

    if (isDamaged) {
      return {
        status: 'eligible',
        reason: `Order was delivered but a valid complaint is on record indicating damage; a replacement can be issued. ${policyReason}`,
      };
    }

    // Status does not qualify.
    return {
      status: 'ineligible',
      reason: `Order status "${order.status}" does not qualify for a replacement. Items must be damaged, lost, or significantly delayed. ${policyReason}`,
    };
  }

  // ── Refund processing (Req 6.5, 6.6) ────────────────────────────────────────

  /**
   * Process a mock refund for an order.
   *
   * Mutates order state (sets `refunded = true`) **only** when eligibility is
   * `eligible`. On `ineligible`, rejects without modifying the order and
   * returns a not-processed result (Req 6.6).
   *
   * _Requirements: 6.5, 6.6, 6.11_
   */
  async processRefund(order: Order, eligibility: EligibilityResult): Promise<RefundResult> {
    let result: RefundResult;
    let outcome: 'success' | 'failure' = 'success';

    if (eligibility.status !== 'eligible') {
      result = {
        processed: false,
        reason: `Refund not processed: eligibility is "${eligibility.status}". ${eligibility.reason}`,
      };
      outcome = 'failure';
    } else {
      try {
        this.orderRepo.markRefunded(order.id);
        result = { processed: true, orderId: order.id };
      } catch (err) {
        outcome = 'failure';
        result = {
          processed: false,
          reason: err instanceof Error ? err.message : 'Failed to record refund outcome.',
        };
      }
    }

    this.logToolCall('processRefund', { orderId: order.id, eligibility }, result, outcome);
    return result;
  }

  // ── Replacement processing (Req 6.8, 6.9) ───────────────────────────────────

  /**
   * Process a mock replacement for an order.
   *
   * Mutates order state (sets `replaced = true`) **only** when eligibility is
   * `eligible`. On `ineligible`, rejects without modifying the order (Req 6.9).
   *
   * _Requirements: 6.8, 6.9, 6.11_
   */
  async processReplacement(order: Order, eligibility: EligibilityResult): Promise<ReplacementResult> {
    let result: ReplacementResult;
    let outcome: 'success' | 'failure' = 'success';

    if (eligibility.status !== 'eligible') {
      result = {
        processed: false,
        reason: `Replacement not processed: eligibility is "${eligibility.status}". ${eligibility.reason}`,
      };
      outcome = 'failure';
    } else {
      try {
        this.orderRepo.markReplaced(order.id);
        result = { processed: true, orderId: order.id };
      } catch (err) {
        outcome = 'failure';
        result = {
          processed: false,
          reason: err instanceof Error ? err.message : 'Failed to record replacement outcome.',
        };
      }
    }

    this.logToolCall('processReplacement', { orderId: order.id, eligibility }, result, outcome);
    return result;
  }

  // ── Ticket escalation (Req 6.10) ─────────────────────────────────────────────

  /**
   * Create an escalation and place it in the escalation queue.
   *
   * _Requirements: 6.10, 6.11_
   */
  async escalateTicket(conv: Conversation, summary?: string): Promise<Escalation> {
    const data: Omit<Escalation, 'id' | 'createdAtMs'> = {
      conversationId: conv.id,
      priority: this._deriveEscalationPriority(conv),
      ...(summary !== undefined ? { summary } : {}),
    };

    let escalation: Escalation | undefined;
    let outcome: 'success' | 'failure' = 'success';
    try {
      escalation = this.escalationRepo.createEscalation(data);
    } catch (err) {
      outcome = 'failure';
      this.logToolCall(
        'escalateTicket',
        { conversationId: conv.id, summaryPresent: summary !== undefined },
        { error: err instanceof Error ? err.message : String(err) },
        outcome,
      );
      throw err;
    }

    this.logToolCall(
      'escalateTicket',
      { conversationId: conv.id, summaryPresent: summary !== undefined },
      { escalationId: escalation.id },
      outcome,
    );

    return escalation;
  }

  /**
   * Derive an escalation priority from the conversation's current state.
   * Negative sentiment raises priority by one level (Req 4.4).
   */
  private _deriveEscalationPriority(conv: Conversation): number {
    const base = conv.escalationPriority > 0 ? conv.escalationPriority : 1;
    return conv.latestSentiment === 'negative' ? base + 1 : base;
  }
}

/**
 * Factory function for dependency injection.
 *
 * ```ts
 * const tools = createBusinessTools({
 *   actionLogRepo, orderRepo, escalationRepo, conversationId
 * });
 * const eligibility = tools.checkRefundEligibility(order, ctx);
 * ```
 */
export function createBusinessTools(deps: BusinessToolsDeps): BusinessTools {
  return new BusinessTools(deps);
}
