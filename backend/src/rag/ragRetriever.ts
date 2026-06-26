/**
 * RagRetriever — async wrapper around the in-memory KnowledgeBase.
 *
 * Implements the `RagRetriever` interface from the design document:
 *
 * ```ts
 * interface RagRetriever {
 *   retrieve(query: string, opts?: { topK?: number; threshold?: number }):
 *     Promise<PolicyPassage[]>;
 * }
 * ```
 *
 * Responsibilities:
 * - Wraps `KnowledgeBase.retrieve` in a Promise so the Orchestrator can `await`
 *   it without special-casing the synchronous implementation.
 * - Guards every retrieval with a 3-second timeout (Req 5.2, 5.6). If
 *   computation does not complete within the budget — unlikely for a small
 *   corpus but required by the spec — the method rejects so the Orchestrator
 *   can escalate and log the failure (Req 5.6).
 * - Surfaces index unavailability (build errors) by rejecting immediately with
 *   the original build error, giving the Orchestrator an unambiguous signal
 *   (Req 5.6).
 *
 * Usage at startup (dependency injection):
 * ```ts
 * const kb = new KnowledgeBase(policyRepository.getAllPolicies());
 * const retriever = new RagRetriever(kb);
 * ```
 *
 * _Requirements: 5.2, 5.6_
 */

import type { PolicyPassage } from '../domain/types.js';
import { KnowledgeBase } from './knowledgeBase.js';

/** The maximum time in ms the retriever will wait for a result (Req 5.2). */
const RETRIEVAL_TIMEOUT_MS = 3_000;

export class RagRetriever {
  private readonly kb: KnowledgeBase;

  constructor(kb: KnowledgeBase) {
    this.kb = kb;
  }

  /**
   * Retrieve relevant policy passages for a query string.
   *
   * - Rejects immediately if the Knowledge_Base index is unavailable (Req 5.6).
   * - Rejects with a timeout error if the operation exceeds
   *   {@link RETRIEVAL_TIMEOUT_MS} (3 seconds) (Req 5.2, 5.6).
   * - Resolves with an empty array when no passages meet the relevance
   *   threshold — the Orchestrator handles the no-results case by escalating
   *   (Req 5.5).
   *
   * @param query   The customer message or intent-derived query string.
   * @param opts    Optional overrides for topK (default 5) and threshold
   *                (default `RAG_RELEVANCE_THRESHOLD` from config).
   *
   * @throws {Error} on index unavailability or timeout.
   */
  async retrieve(
    query: string,
    opts?: { topK?: number; threshold?: number },
  ): Promise<PolicyPassage[]> {
    // Fail fast if the index was never successfully built (Req 5.6).
    if (!this.kb.isReady()) {
      const buildErr = this.kb.getBuildError();
      throw buildErr ?? new Error('KnowledgeBase index is unavailable');
    }

    // Wrap the synchronous KB call in a race against a timeout promise so any
    // unexpectedly long computation (e.g. unusually large corpus) is caught
    // and surfaced as a retrieval failure (Req 5.6).
    return Promise.race([
      Promise.resolve().then(() => this.kb.retrieve(query, opts)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `RAG retrieval timed out after ${RETRIEVAL_TIMEOUT_MS} ms`,
              ),
            ),
          RETRIEVAL_TIMEOUT_MS,
        ),
      ),
    ]);
  }
}
