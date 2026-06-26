/**
 * Startup configuration module.
 *
 * Reads runtime configuration from environment variables with documented
 * defaults, validates ranges, and falls back to defaults (with a logged
 * warning) on invalid values. See `.env.example` and design.md for the full
 * key/default/range table.
 *
 * Design notes:
 * - `CONFIDENCE_THRESHOLD` and `REFUND_HIGH_VALUE_LIMIT` are read *per request*
 *   (via `getConfidenceThreshold` / `getRefundHighValueLimit`) so they can be
 *   changed through the environment without a restart in supporting
 *   deployments (Req 12.5, 12.6).
 * - Provider selection is indicated purely by the presence/absence of
 *   `LLM_API_KEY`: when set the real `LlmProvider` is used, otherwise the
 *   deterministic `MockProvider` runs end-to-end with no external keys
 *   (Req 2.10, 2.11).
 */

// ── Config keys ────────────────────────────────────────────────────────────────
export const CONFIG_KEYS = {
  confidenceThreshold: 'CONFIDENCE_THRESHOLD',
  refundHighValueLimit: 'REFUND_HIGH_VALUE_LIMIT',
  llmApiKey: 'LLM_API_KEY',
  ragRelevanceThreshold: 'RAG_RELEVANCE_THRESHOLD',
  intentConfidenceFloor: 'INTENT_CONFIDENCE_FLOOR',
  dashboardPollMs: 'DASHBOARD_POLL_MS',
} as const;

// ── Documented defaults ─────────────────────────────────────────────────────────
export const DEFAULTS = {
  /** Minimum confidence required for auto-execution (Req 12.5). */
  confidenceThreshold: 0.5,
  /** Monetary ceiling above which refunds are high-risk (Req 12.6). */
  refundHighValueLimit: 200.0,
  /** Minimum TF-IDF score for a policy passage to be "relevant". */
  ragRelevanceThreshold: 0.05,
  /** Below this intent confidence, classification falls back to general_inquiry (Req 3.3). */
  intentConfidenceFloor: 0.7,
  /** Dashboard polling interval in ms; clamped to [3000, 5000] (Req 9.5). */
  dashboardPollMs: 4000,
} as const;

// ── Documented ranges ────────────────────────────────────────────────────────────
export const DASHBOARD_POLL_MIN = 3000;
export const DASHBOARD_POLL_MAX = 5000;

/** Result of validating a single raw env value. */
export interface ValidationResult<T> {
  value: T;
  /** Present only when the raw input was invalid or had to be adjusted. */
  warning?: string;
}

type Logger = Pick<typeof console, 'warn'>;

let activeLogger: Logger = console;

/** Override the logger used for warnings (primarily for testing). */
export function setConfigLogger(logger: Logger): void {
  activeLogger = logger;
}

function emit(result: ValidationResult<unknown>, key: string): void {
  if (result.warning !== undefined) {
    activeLogger.warn(`[config] ${key}: ${result.warning}`);
  }
}

// ── Pure validators (testable without env / logging side effects) ─────────────────

/**
 * Validate a numeric env value against an inclusive [min, max] range.
 * Unset values silently use the default; unparseable or out-of-range values
 * fall back to the default and produce a warning.
 */
export function validateBoundedNumber(
  raw: string | undefined,
  opts: { min: number; max: number; fallback: number },
): ValidationResult<number> {
  if (raw === undefined || raw.trim() === '') {
    return { value: opts.fallback };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return {
      value: opts.fallback,
      warning: `invalid value "${raw}" is not a number; using default ${opts.fallback}`,
    };
  }
  if (parsed < opts.min || parsed > opts.max) {
    return {
      value: opts.fallback,
      warning: `value ${parsed} is outside [${opts.min}, ${opts.max}]; using default ${opts.fallback}`,
    };
  }
  return { value: parsed };
}

/**
 * Validate a numeric env value, clamping it into the inclusive [min, max] range.
 * Unparseable values fall back to the default; out-of-range values are clamped
 * to the nearest bound. Both cases produce a warning.
 */
export function validateClampedNumber(
  raw: string | undefined,
  opts: { min: number; max: number; fallback: number },
): ValidationResult<number> {
  if (raw === undefined || raw.trim() === '') {
    return { value: opts.fallback };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return {
      value: opts.fallback,
      warning: `invalid value "${raw}" is not a number; using default ${opts.fallback}`,
    };
  }
  if (parsed < opts.min) {
    return {
      value: opts.min,
      warning: `value ${parsed} is below ${opts.min}; clamped to ${opts.min}`,
    };
  }
  if (parsed > opts.max) {
    return {
      value: opts.max,
      warning: `value ${parsed} is above ${opts.max}; clamped to ${opts.max}`,
    };
  }
  return { value: parsed };
}

/**
 * Validate a non-negative monetary value. Unparseable or negative values fall
 * back to the default with a warning.
 */
export function validateNonNegativeNumber(
  raw: string | undefined,
  opts: { fallback: number },
): ValidationResult<number> {
  if (raw === undefined || raw.trim() === '') {
    return { value: opts.fallback };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      value: opts.fallback,
      warning: `invalid value "${raw}"; must be a non-negative number; using default ${opts.fallback}`,
    };
  }
  return { value: parsed };
}

/** True when a usable (non-empty) LLM API key is configured. */
export function isApiKeyPresent(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== '';
}

// ── Per-request reads (Req 12.5, 12.6) ───────────────────────────────────────────

/** Read the confidence threshold per request; validated to [0.00, 1.00] (Req 12.5). */
export function getConfidenceThreshold(): number {
  const result = validateBoundedNumber(process.env[CONFIG_KEYS.confidenceThreshold], {
    min: 0,
    max: 1,
    fallback: DEFAULTS.confidenceThreshold,
  });
  emit(result, CONFIG_KEYS.confidenceThreshold);
  return result.value;
}

/** Read the high-value refund limit per request; non-negative monetary value (Req 12.6). */
export function getRefundHighValueLimit(): number {
  const result = validateNonNegativeNumber(process.env[CONFIG_KEYS.refundHighValueLimit], {
    fallback: DEFAULTS.refundHighValueLimit,
  });
  emit(result, CONFIG_KEYS.refundHighValueLimit);
  return result.value;
}

// ── Startup reads ────────────────────────────────────────────────────────────────

/** Read the RAG relevance threshold; validated to [0, 1]. */
export function getRagRelevanceThreshold(): number {
  const result = validateBoundedNumber(process.env[CONFIG_KEYS.ragRelevanceThreshold], {
    min: 0,
    max: 1,
    fallback: DEFAULTS.ragRelevanceThreshold,
  });
  emit(result, CONFIG_KEYS.ragRelevanceThreshold);
  return result.value;
}

/** Read the intent confidence floor; validated to [0, 1] (Req 3.3). */
export function getIntentConfidenceFloor(): number {
  const result = validateBoundedNumber(process.env[CONFIG_KEYS.intentConfidenceFloor], {
    min: 0,
    max: 1,
    fallback: DEFAULTS.intentConfidenceFloor,
  });
  emit(result, CONFIG_KEYS.intentConfidenceFloor);
  return result.value;
}

/** Read the dashboard poll interval; clamped to [3000, 5000] ms (Req 9.5). */
export function getDashboardPollMs(): number {
  const result = validateClampedNumber(process.env[CONFIG_KEYS.dashboardPollMs], {
    min: DASHBOARD_POLL_MIN,
    max: DASHBOARD_POLL_MAX,
    fallback: DEFAULTS.dashboardPollMs,
  });
  emit(result, CONFIG_KEYS.dashboardPollMs);
  return result.value;
}

/** The configured LLM API key, or undefined when not set (Req 2.10, 2.11). */
export function getLlmApiKey(): string | undefined {
  const raw = process.env[CONFIG_KEYS.llmApiKey];
  return isApiKeyPresent(raw) ? raw : undefined;
}

/** True when the real LLM provider should be used; false selects the MockProvider. */
export function isLlmProviderConfigured(): boolean {
  return isApiKeyPresent(process.env[CONFIG_KEYS.llmApiKey]);
}

/** Provider selection indicator (Req 2.10, 2.11). */
export function getProviderMode(): 'llm' | 'mock' {
  return isLlmProviderConfigured() ? 'llm' : 'mock';
}

// ── Snapshot ─────────────────────────────────────────────────────────────────────

export interface AppConfig {
  confidenceThreshold: number;
  refundHighValueLimit: number;
  ragRelevanceThreshold: number;
  intentConfidenceFloor: number;
  dashboardPollMs: number;
  llmApiKey: string | undefined;
  providerMode: 'llm' | 'mock';
}

/**
 * Build a configuration snapshot, validating every key (emitting warnings for
 * invalid values). Note that `confidenceThreshold` and `refundHighValueLimit`
 * are also re-readable per request via their dedicated getters; the snapshot
 * captures their value at call time.
 */
export function loadConfig(): AppConfig {
  return {
    confidenceThreshold: getConfidenceThreshold(),
    refundHighValueLimit: getRefundHighValueLimit(),
    ragRelevanceThreshold: getRagRelevanceThreshold(),
    intentConfidenceFloor: getIntentConfidenceFloor(),
    dashboardPollMs: getDashboardPollMs(),
    llmApiKey: getLlmApiKey(),
    providerMode: getProviderMode(),
  };
}
