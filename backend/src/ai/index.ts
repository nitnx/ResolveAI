/**
 * AI provider factory — startup selection (Req 2.10, 2.11).
 *
 * Selects the concrete `AiProvider` implementation at startup based on whether
 * `LLM_API_KEY` is configured:
 *
 *   - Key present  → `LlmProvider` (real LLM API, Req 2.10)
 *   - Key absent   → `MockProvider` (deterministic fallback, Req 2.11)
 *
 * All consumers should depend only on the `AiProvider` interface, never on a
 * concrete implementation, so this factory is the single selection seam.
 */

import { loadConfig } from '../config.js';
import { MockProvider } from './mockProvider.js';
import { LlmProvider } from './llmProvider.js';
import type { AiProvider } from './aiProvider.js';

export { type AiProvider } from './aiProvider.js';
export type { ResponseContext } from './aiProvider.js';
export { MockProvider } from './mockProvider.js';
export { LlmProvider } from './llmProvider.js';
export { IntentClassifier } from './intentClassifier.js';
export type { ClassifyResult, ClassifySuccess, ClassifyPersistenceFailure } from './intentClassifier.js';

/**
 * Create and return the appropriate `AiProvider` instance for the current
 * runtime configuration.
 *
 * - When `LLM_API_KEY` is set in the environment the `LlmProvider` is
 *   returned; this implementation calls the real LLM API (Req 2.10).
 * - When `LLM_API_KEY` is absent or empty the `MockProvider` is returned;
 *   this implementation is fully deterministic and requires no external
 *   integrations (Req 2.11).
 */
export function createAiProvider(): AiProvider {
  const config = loadConfig();
  return config.llmApiKey ? new LlmProvider(config) : new MockProvider();
}
