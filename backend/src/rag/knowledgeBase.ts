/**
 * In-memory TF-IDF Knowledge_Base for ResolveAI.
 *
 * Builds a TF-IDF index over seeded policy passages at construction time and
 * exposes a `retrieve` method that scores a query against every indexed passage
 * using TF-IDF cosine similarity, filters by a relevance threshold, and returns
 * the top-K passages ordered by descending score.
 *
 * No external vector database is used — the corpus is small (a handful of short
 * policy documents) so the full computation is sub-millisecond even on slow
 * hardware, comfortably within the 3-second retrieval budget (Req 5.2).
 *
 * Design reference: "RAG_Retriever + Knowledge_Base" section of design.md.
 * _Requirements: 5.1, 5.2, 5.5, 5.6, 10.3_
 */

import type { PolicyPassage } from '../domain/types.js';
import { getRagRelevanceThreshold } from '../config.js';

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Lowercase, strip non-alphanumeric characters, split on whitespace, and
 * remove stopwords. Combining the passage title + text before tokenizing
 * ensures title keywords boost relevance without duplicate weighting tricks.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'it', 'its', 'be', 'are', 'was',
  'were', 'will', 'that', 'this', 'they', 'their', 'has', 'have', 'had',
  'do', 'does', 'not', 'so', 'if', 'when', 'which', 'than', 'into', 'can',
  'may', 'should', 'would', 'also', 'about', 'all', 'any', 'each', 'more',
  'such', 'no', 'only', 'same', 'other', 'how', 'what', 'up', 'out', 'who',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ── TF helpers ────────────────────────────────────────────────────────────────

/** Compute term frequency (raw count / total tokens) for a token list. */
function computeTF(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const total = tokens.length === 0 ? 1 : tokens.length;
  const tf = new Map<string, number>();
  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }
  return tf;
}

// ── Indexed document shape ────────────────────────────────────────────────────

interface IndexedDocument {
  passage: PolicyPassage;
  /** TF values for each term in this document. */
  tf: Map<string, number>;
}

// ── KnowledgeBase ─────────────────────────────────────────────────────────────

export class KnowledgeBase {
  private readonly docs: IndexedDocument[];
  /** IDF (log-based) per term across the whole corpus. */
  private readonly idf: Map<string, number>;
  /** Whether the index was built without errors. */
  private readonly ready: boolean;
  /** Error captured during construction (if any). */
  private readonly buildError: Error | null;

  constructor(passages: PolicyPassage[]) {
    try {
      this.docs = [];
      this.idf = new Map();
      this.buildError = null;

      if (passages.length === 0) {
        this.ready = false;
        this.buildError = new Error('KnowledgeBase was constructed with an empty passage list');
        return;
      }

      // Step 1: tokenize each passage (title + text) and compute per-doc TF.
      const tokenizedDocs: Array<{ passage: PolicyPassage; tokens: string[] }> = [];
      for (const passage of passages) {
        const tokens = tokenize(`${passage.title} ${passage.text}`);
        tokenizedDocs.push({ passage, tokens });
        this.docs.push({ passage, tf: computeTF(tokens) });
      }

      // Step 2: compute IDF = ln(N / df) for every term that appears in ≥1 doc.
      // df = number of documents containing the term.
      const N = tokenizedDocs.length;
      const df = new Map<string, number>();
      for (const { tokens } of tokenizedDocs) {
        const seen = new Set(tokens);
        for (const term of seen) {
          df.set(term, (df.get(term) ?? 0) + 1);
        }
      }
      for (const [term, docFreq] of df) {
        // Add 1 to avoid log(1) = 0 for universal terms; use ln.
        this.idf.set(term, Math.log((N + 1) / (docFreq + 1)) + 1);
      }

      this.ready = true;
    } catch (err) {
      // Construction failed — mark the index as unavailable.
      this.docs = [];
      this.idf = new Map();
      this.ready = false;
      this.buildError = err instanceof Error ? err : new Error(String(err));
    }
  }

  /** True when the index was built successfully and is available for retrieval. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Returns the error that caused the index to fail to build, or null when the
   * index is ready. Callers should check `isReady()` and, on false, propagate
   * this error to signal retrieval unavailability (Req 5.6).
   */
  getBuildError(): Error | null {
    return this.buildError;
  }

  /**
   * Retrieve policy passages relevant to `query`.
   *
   * Algorithm:
   * 1. Tokenize the query.
   * 2. Compute a TF-IDF vector for the query (same IDF corpus weights).
   * 3. Compute cosine similarity between the query vector and each document vector.
   * 4. Filter passages whose cosine similarity is ≥ `threshold`.
   * 5. Sort by descending score.
   * 6. Return the top `topK` results.
   *
   * @throws {Error} when the index is not ready (callers should escalate, Req 5.6).
   *
   * _Requirements: 5.2, 5.5, 5.6_
   */
  retrieve(
    query: string,
    opts?: { topK?: number; threshold?: number },
  ): PolicyPassage[] {
    if (!this.ready) {
      throw this.buildError ?? new Error('KnowledgeBase index is not ready');
    }

    const topK = opts?.topK ?? 5;
    const threshold = opts?.threshold ?? getRagRelevanceThreshold();

    // Compute query TF-IDF vector.
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const queryTF = computeTF(queryTokens);
    const queryVec = this._tfidfVector(queryTF);

    // Score each document via cosine similarity.
    const scored: Array<{ passage: PolicyPassage; score: number }> = [];
    for (const doc of this.docs) {
      const docVec = this._tfidfVector(doc.tf);
      const score = cosineSimilarity(queryVec, docVec);
      if (score >= threshold) {
        scored.push({ passage: doc.passage, score });
      }
    }

    // Sort descending by score, then return up to topK.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.passage);
  }

  /**
   * Build a TF-IDF weight map from a TF map using the corpus IDF values.
   * Only terms present in the IDF map (i.e. terms seen during indexing) receive
   * a weight; query-only terms that were never in any document are ignored.
   */
  private _tfidfVector(tf: Map<string, number>): Map<string, number> {
    const vec = new Map<string, number>();
    for (const [term, termTf] of tf) {
      const termIdf = this.idf.get(term);
      if (termIdf !== undefined) {
        vec.set(term, termTf * termIdf);
      }
    }
    return vec;
  }
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two sparse TF-IDF vectors represented as
 * Maps. Returns 0 for zero-length vectors.
 */
export function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, weightA] of a) {
    normA += weightA * weightA;
    const weightB = b.get(term);
    if (weightB !== undefined) {
      dot += weightA * weightB;
    }
  }
  for (const [, weightB] of b) {
    normB += weightB * weightB;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
