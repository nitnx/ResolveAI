/**
 * LlmProvider — real LLM API implementation of `AiProvider` (Req 2.10).
 *
 * Instantiated only when `LLM_API_KEY` is configured (the `createAiProvider`
 * factory in `index.ts` enforces this guard).
 *
 * Each method makes an HTTP request to an OpenAI-compatible chat-completions
 * endpoint using `fetch`. If the API call fails for any reason (network error,
 * non-2xx response, malformed JSON, timeout) the method logs a warning and
 * returns a safe fallback value so the rest of the pipeline continues
 * uninterrupted — satisfying the requirement that no API key is needed for
 * the end-to-end demo.
 *
 * The constructor accepts the full `AppConfig` snapshot so the provider has
 * access to the API key and any other runtime configuration it needs.
 *
 * _Requirements: 2.10_
 */

import type { AiProvider, ResponseContext } from './aiProvider.js';
import type { IntentCategory, Sentiment, Message } from '../domain/types.js';
import type { AppConfig } from '../config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default LLM API base URL (OpenAI-compatible). */
const DEFAULT_API_BASE = 'https://api.openai.com/v1';

/** Model to use for chat completions. */
const DEFAULT_MODEL = 'gpt-4o-mini';

/** Request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 8_000;

// ── Fallback values ───────────────────────────────────────────────────────────

const FALLBACK_INTENT: { intent: IntentCategory; confidence: number } = {
  intent: 'general_inquiry',
  confidence: 0.4,
};

const FALLBACK_SENTIMENT: { sentiment: Sentiment } = { sentiment: 'neutral' };

const FALLBACK_RESPONSE = 'Thank you for contacting support. How can I assist you today?';

const FALLBACK_SUMMARY = 'Conversation summary unavailable.';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

// ── LlmProvider ───────────────────────────────────────────────────────────────

export class LlmProvider implements AiProvider {
  private readonly config: AppConfig;
  private readonly apiBase: string;
  private readonly model: string;

  constructor(config: AppConfig, apiBase?: string, model?: string) {
    this.config = config;
    this.apiBase = apiBase ?? DEFAULT_API_BASE;
    this.model = model ?? DEFAULT_MODEL;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Send a chat-completion request to the LLM API.
   *
   * Returns the trimmed text content of the first choice, or `null` when the
   * call fails (network error, non-2xx, malformed body, or timeout). Callers
   * are responsible for logging and falling back.
   */
  private async callLlm(messages: ChatMessage[]): Promise<string | null> {
    const apiKey = this.config.llmApiKey;
    if (apiKey == null || apiKey.trim() === '') {
      console.warn('[LlmProvider] LLM_API_KEY is not configured; skipping API call.');
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.2,
          max_tokens: 512,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '<unreadable>');
        console.warn(
          `[LlmProvider] API returned HTTP ${response.status}: ${errorText.slice(0, 200)}`,
        );
        return null;
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        console.warn('[LlmProvider] Unexpected API response shape; missing content.');
        return null;
      }

      return content.trim();
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        console.warn(
          `[LlmProvider] API request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        );
      } else {
        console.warn('[LlmProvider] API request failed:', err);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── AiProvider methods ───────────────────────────────────────────────────

  /**
   * Classify the intent of a customer message.
   *
   * Asks the LLM to return a JSON object `{ "intent": "<category>",
   * "confidence": <0.0–1.0> }`. If the API call fails or the response cannot
   * be parsed, falls back to `{ intent: 'general_inquiry', confidence: 0.4 }`.
   */
  async classifyIntent(
    text: string,
  ): Promise<{ intent: IntentCategory; confidence: number }> {
    const validIntents: IntentCategory[] = [
      'order_status',
      'refund_request',
      'replacement_request',
      'shipping_inquiry',
      'policy_question',
      'complaint',
      'escalation_request',
      'general_inquiry',
    ];

    const systemPrompt = `You are an intent classifier for a customer support system.
Given a customer message, identify the primary intent and your confidence.

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{"intent":"<category>","confidence":<number>}

Valid intent categories: ${validIntents.join(', ')}.
Confidence must be a decimal number between 0.00 and 1.00.
If you are uncertain, use "general_inquiry" with a low confidence.`;

    const raw = await this.callLlm([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ]);

    if (raw === null) {
      console.warn('[LlmProvider] classifyIntent fell back to default.');
      return FALLBACK_INTENT;
    }

    try {
      // Extract JSON from response (LLM may wrap in markdown fences)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch === null) throw new Error('No JSON object found in response');

      const parsed = JSON.parse(jsonMatch[0]) as { intent: unknown; confidence: unknown };
      const intent = parsed.intent;
      const confidence = parsed.confidence;

      if (
        typeof intent !== 'string' ||
        !validIntents.includes(intent as IntentCategory) ||
        typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      ) {
        throw new Error(`Invalid fields: intent=${String(intent)}, confidence=${String(confidence)}`);
      }

      return { intent: intent as IntentCategory, confidence };
    } catch (err) {
      console.warn('[LlmProvider] classifyIntent parse error; using fallback.', err);
      return FALLBACK_INTENT;
    }
  }

  /**
   * Detect the sentiment of a customer message.
   *
   * Asks the LLM to return a JSON object `{ "sentiment": "<label>" }`.
   * Falls back to `{ sentiment: 'neutral' }` on any failure.
   */
  async detectSentiment(text: string): Promise<{ sentiment: Sentiment }> {
    const validSentiments: Sentiment[] = ['negative', 'neutral', 'positive'];

    const systemPrompt = `You are a sentiment classifier for a customer support system.
Given a customer message, identify the overall sentiment.

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{"sentiment":"<label>"}

Valid sentiment labels: ${validSentiments.join(', ')}.`;

    const raw = await this.callLlm([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ]);

    if (raw === null) {
      console.warn('[LlmProvider] detectSentiment fell back to default.');
      return FALLBACK_SENTIMENT;
    }

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch === null) throw new Error('No JSON object found in response');

      const parsed = JSON.parse(jsonMatch[0]) as { sentiment: unknown };
      const sentiment = parsed.sentiment;

      if (
        typeof sentiment !== 'string' ||
        !validSentiments.includes(sentiment as Sentiment)
      ) {
        throw new Error(`Invalid sentiment value: ${String(sentiment)}`);
      }

      return { sentiment: sentiment as Sentiment };
    } catch (err) {
      console.warn('[LlmProvider] detectSentiment parse error; using fallback.', err);
      return FALLBACK_SENTIMENT;
    }
  }

  /**
   * Generate a customer-facing response given the full resolution context.
   *
   * Builds a rich prompt from the context and streams back a natural-language
   * reply. Falls back to a generic support message on any API failure.
   */
  async generateResponse(ctx: ResponseContext): Promise<string> {
    const policyContext =
      ctx.passages.length > 0
        ? ctx.passages
            .slice(0, 3)
            .map((p) => `[${p.title}]: ${p.text.slice(0, 300)}`)
            .join('\n')
        : 'No policy passages available.';

    const orderContext =
      ctx.orderInfo != null
        ? `Order ID: ${ctx.orderInfo.orderId}, Status: ${ctx.orderInfo.status}, Amount: $${ctx.orderInfo.amount.toFixed(2)}`
        : 'No order information available.';

    let outcomeContext = '';
    if (ctx.refundOutcome != null) {
      outcomeContext = `Refund outcome: ${ctx.refundOutcome}.`;
    } else if (ctx.replacementOutcome != null) {
      outcomeContext = `Replacement outcome: ${ctx.replacementOutcome}.`;
    }

    const systemPrompt = `You are a customer support assistant for an e-commerce company.
Generate a concise, empathetic, and professional response to the customer.
Base your response on the resolution context provided.

Resolution path: ${ctx.resolutionPath}
Customer sentiment: ${ctx.sentiment}
Intent: ${ctx.intent}
${outcomeContext}
${ctx.escalated === true ? 'The case has been escalated to a human agent.' : ''}

Relevant policies:
${policyContext}

Order context:
${orderContext}

Keep the response under 150 words. Be direct and helpful.`;

    const conversationHistory: ChatMessage[] = ctx.messages
      .slice(-6) // last 6 messages for context
      .map((m) => ({
        role: m.role === 'customer' ? 'user' : 'assistant',
        content: m.text,
      }));

    const raw = await this.callLlm([
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
    ]);

    if (raw === null) {
      console.warn('[LlmProvider] generateResponse fell back to default.');
      return FALLBACK_RESPONSE;
    }

    return raw;
  }

  /**
   * Produce an AI-generated summary of the conversation for escalation.
   *
   * Summarises the customer messages and the overall conversation arc.
   * Falls back to a static message on any API failure.
   */
  async summarizeConversation(messages: Message[]): Promise<string> {
    if (messages.length === 0) {
      return 'No messages to summarize.';
    }

    const transcript = messages
      .map((m) => `${m.role === 'customer' ? 'Customer' : 'Assistant'}: ${m.text}`)
      .join('\n');

    const systemPrompt = `You are summarizing a customer support conversation for a human support agent.
Provide a concise summary (2–4 sentences) covering:
- The customer's main issue or request
- Any actions taken or outcomes
- The current state requiring agent attention

Be factual and neutral. Do not include pleasantries.`;

    const raw = await this.callLlm([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Please summarize this support conversation:\n\n${transcript.slice(0, 3000)}`,
      },
    ]);

    if (raw === null) {
      console.warn('[LlmProvider] summarizeConversation fell back to default.');
      return FALLBACK_SUMMARY;
    }

    return raw;
  }
}
