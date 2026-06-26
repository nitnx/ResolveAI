/**
 * Confidence/risk gate decision function for the Orchestrator.
 *
 * Implements the two-gate execution model:
 *   - Gate 2 (risk): high-value refund check — evaluated FIRST, takes
 *     precedence over confidence (Req 7.3)
 *   - Gate 1 (confidence): non-high-risk actionable paths execute only when
 *     confidence ≥ threshold (Req 7.1, 7.2)
 *
 * Informational paths always execute.
 * Any other path (e.g. 'escalation') escalates directly.
 *
 * _Requirements: 7.1, 7.2, 7.3, 12.5, 12.6_
 */

import type { ResolutionPath } from '../domain/types.js';

// ── Input / output types ───────────────────────────────────────────────────────

export interface DecideExecutionArgs {
  /** Confidence score in [0, 1] produced by the Orchestrator for this path. */
  confidence: number;
  /** Configurable threshold from CONFIDENCE_THRESHOLD env var (Req 12.5). */
  threshold: number;
  /** The resolution path selected by the Orchestrator for this turn. */
  path: ResolutionPath;
  /**
   * Monetary total of the order; required when `path === 'refund'`.
   * Used to evaluate the high-value risk gate (Req 7.3, 12.6).
   */
  refundAmount?: number;
  /** Configurable ceiling from REFUND_HIGH_VALUE_LIMIT env var (Req 12.6). */
  highValueLimit: number;
}

export type DecideExecutionResult =
  | { action: 'execute'; path: ResolutionPath }
  | { action: 'escalate'; reason: string };

// ── Core gate function ─────────────────────────────────────────────────────────

/**
 * Decides whether to execute a resolution path or escalate.
 *
 * Evaluation order:
 * 1. **Risk gate** (Gate 2) — checked first for refunds:
 *    If `refundAmount > highValueLimit`, escalate with reason
 *    `'high_value_refund'`. This fires even at confidence 1.0 (Req 7.3).
 *
 * 2. **Confidence gate** (Gate 1) — for actionable non-high-risk paths
 *    (`'refund'`, `'replacement'`):
 *    If `confidence < threshold`, escalate with reason `'below_threshold'`
 *    (Req 7.1, 7.2). Otherwise execute.
 *
 * 3. **Informational** — always execute (Req 7.1).
 *
 * 4. **Any other path** (e.g. `'escalation'`) — escalate with reason
 *    `'path_escalation'`.
 */
export function decideExecution(args: DecideExecutionArgs): DecideExecutionResult {
  // Gate 2 (risk) takes precedence over confidence for refunds (Req 7.3).
  // A non-null assertion is safe here: refundAmount is always provided when
  // path === 'refund' per the contract documented on DecideExecutionArgs.
  if (args.path === 'refund' && args.refundAmount! > args.highValueLimit) {
    return { action: 'escalate', reason: 'high_value_refund' };
  }

  // Gate 1 (confidence) for non-high-risk actionable paths (Req 7.1, 7.2).
  if (args.path === 'refund' || args.path === 'replacement') {
    if (args.confidence < args.threshold) {
      return { action: 'escalate', reason: 'below_threshold' };
    }
    return { action: 'execute', path: args.path };
  }

  // Informational paths always execute — no confidence or risk gate (Req 7.1).
  if (args.path === 'informational') {
    return { action: 'execute', path: 'informational' };
  }

  // All remaining paths (e.g. 'escalation') are passed through as escalations.
  return { action: 'escalate', reason: 'path_escalation' };
}
