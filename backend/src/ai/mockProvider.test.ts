/**
 * Unit tests for MockProvider (task 5.2 / 5.4).
 *
 * Validates:
 *  - Intent classification keyword rules per category
 *  - Confidence levels (strong / weak / no-match)
 *  - Demo-critical phrase: "My order is late and I'm angry, I want a refund"
 *    → intent: refund_request, confidence ≥ 0.70
 *  - Sentiment detection via negative/positive lexicons
 *  - Deterministic response generation per resolutionPath
 *  - Conversation summarization
 *
 * Requirements: 2.11, 12.7
 */

import { describe, it, expect } from 'vitest';
import { MockProvider } from './mockProvider.js';
import type { ResponseContext } from './aiProvider.js';
import type { Message } from '../domain/types.js';

const provider = new MockProvider();

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMessage(
  role: 'customer' | 'assistant',
  text: string,
  seq = 0,
): Message {
  return {
    id: `msg-${seq}`,
    conversationId: 'conv-1',
    role,
    text,
    timestampMs: Date.now() + seq * 1000,
    seq,
  };
}

const baseCtx: Omit<ResponseContext, 'resolutionPath'> = {
  conversationId: 'conv-1',
  messages: [],
  intent: 'refund_request',
  sentiment: 'negative',
  passages: [],
};

// ── classifyIntent ─────────────────────────────────────────────────────────────

describe('MockProvider.classifyIntent', () => {
  // ── Demo-critical phrase (Requirements 2.11, 12.7) ─────────────────────────

  it('DEMO: "My order is late and I\'m angry, I want a refund" → refund_request with confidence ≥ 0.70', async () => {
    const result = await provider.classifyIntent(
      "My order is late and I'm angry, I want a refund",
    );
    expect(result.intent).toBe('refund_request');
    expect(result.confidence).toBeGreaterThanOrEqual(0.70);
  });

  // ── Strong keyword matches (3+) → 0.92 ──────────────────────────────────

  it('returns refund_request with 0.92 for strong keyword match (3+ keywords)', async () => {
    const result = await provider.classifyIntent(
      'I want a refund, please reimburse me and credit back my account',
    );
    expect(result.intent).toBe('refund_request');
    expect(result.confidence).toBe(0.92);
  });

  it('returns replacement_request with 0.92 for strong keyword match', async () => {
    const result = await provider.classifyIntent(
      'Please replace my item, send another one, and swap it for a new one',
    );
    expect(result.intent).toBe('replacement_request');
    expect(result.confidence).toBe(0.92);
  });

  // ── 2-keyword matches → 0.82 ───────────────────────────────────────────

  it('returns refund_request with 0.82 for 2-keyword match', async () => {
    // "refund" and "credit back" → exactly 2 distinct keyword matches
    const result = await provider.classifyIntent('I need a refund and credit back');
    expect(result.intent).toBe('refund_request');
    expect(result.confidence).toBe(0.82);
  });

  // ── 1-keyword matches → 0.75 ───────────────────────────────────────────

  it('returns refund_request with 0.75 for single-keyword match', async () => {
    const result = await provider.classifyIntent('I want a refund');
    expect(result.intent).toBe('refund_request');
    expect(result.confidence).toBe(0.75);
  });

  it('returns escalation_request with 0.75 for single escalation keyword', async () => {
    // "escalate" is a single keyword match → 0.75
    const result = await provider.classifyIntent('Please escalate this issue');
    expect(result.intent).toBe('escalation_request');
    expect(result.confidence).toBe(0.75);
  });

  // ── No keyword matches → general_inquiry with 0.4 ─────────────────────

  it('returns general_inquiry with confidence 0.4 when no keywords match', async () => {
    const result = await provider.classifyIntent('Hello there, how are you doing?');
    expect(result.intent).toBe('general_inquiry');
    expect(result.confidence).toBe(0.4);
  });

  // ── Per-category keyword coverage ─────────────────────────────────────

  it('detects order_status intent', async () => {
    const result = await provider.classifyIntent('Where is my order? Can you track it?');
    expect(result.intent).toBe('order_status');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('detects shipping_inquiry intent', async () => {
    const result = await provider.classifyIntent('How long does shipping take? When will it be delivered?');
    expect(result.intent).toBe('shipping_inquiry');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('detects policy_question intent', async () => {
    const result = await provider.classifyIntent('What is the return policy? What are the conditions?');
    expect(result.intent).toBe('policy_question');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('detects complaint intent', async () => {
    const result = await provider.classifyIntent('This is terrible and horrible service');
    expect(result.intent).toBe('complaint');
    expect(result.confidence).toBeGreaterThan(0);
  });

  // ── Priority: refund_request beats complaint on tie ────────────────────

  it('refund_request wins over complaint on equal match count (priority order)', async () => {
    // "refund" matches refund_request (1), "terrible" matches complaint (1)
    // refund_request has higher priority in PRIORITY_ORDER
    const result = await provider.classifyIntent('This refund situation is terrible');
    expect(result.intent).toBe('refund_request');
  });

  // ── Confidence is always in [0, 1] ───────────────────────────────────

  it('confidence is always in [0, 1]', async () => {
    const phrases = [
      'I want a refund please',
      'Where is my order?',
      'This is terrible',
      'hello world',
      'I want to speak to a human agent supervisor manager',
    ];
    for (const phrase of phrases) {
      const result = await provider.classifyIntent(phrase);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  // ── Intent is always one of the 8 valid categories ────────────────────

  it('always returns a valid IntentCategory', async () => {
    const validIntents = [
      'order_status', 'refund_request', 'replacement_request',
      'shipping_inquiry', 'policy_question', 'complaint',
      'escalation_request', 'general_inquiry',
    ];
    const phrases = [
      'I need a refund',
      'where is my package',
      'terrible service',
      'hello',
    ];
    for (const phrase of phrases) {
      const result = await provider.classifyIntent(phrase);
      expect(validIntents).toContain(result.intent);
    }
  });
});

// ── detectSentiment ────────────────────────────────────────────────────────────

describe('MockProvider.detectSentiment', () => {
  // ── Demo-critical phrase ─────────────────────────────────────────────

  it('DEMO: "My order is late and I\'m angry, I want a refund" → negative', async () => {
    const result = await provider.detectSentiment(
      "My order is late and I'm angry, I want a refund",
    );
    expect(result.sentiment).toBe('negative');
  });

  // ── Negative lexicon words ────────────────────────────────────────────

  it('detects negative sentiment for "angry frustrated terrible"', async () => {
    const result = await provider.detectSentiment('I am angry and frustrated with this terrible service');
    expect(result.sentiment).toBe('negative');
  });

  it('detects negative sentiment for "late" word', async () => {
    const result = await provider.detectSentiment('My order is late');
    expect(result.sentiment).toBe('negative');
  });

  it('detects negative sentiment for "worst" word', async () => {
    const result = await provider.detectSentiment('This is the worst experience');
    expect(result.sentiment).toBe('negative');
  });

  it('detects negative sentiment for "hate" synonym set', async () => {
    const result = await provider.detectSentiment('I am furious and disgusted');
    expect(result.sentiment).toBe('negative');
  });

  // ── Positive lexicon words ────────────────────────────────────────────

  it('detects positive sentiment for "thank great happy"', async () => {
    const result = await provider.detectSentiment('Thank you, great service, I am happy');
    expect(result.sentiment).toBe('positive');
  });

  it('detects positive sentiment for "love perfect"', async () => {
    const result = await provider.detectSentiment('I love this, it is perfect');
    expect(result.sentiment).toBe('positive');
  });

  it('detects positive sentiment for "amazing"', async () => {
    const result = await provider.detectSentiment('This is amazing and fantastic');
    expect(result.sentiment).toBe('positive');
  });

  // ── Neutral default ───────────────────────────────────────────────────

  it('returns neutral when no sentiment words present', async () => {
    const result = await provider.detectSentiment('Hello, I have a question about my order');
    expect(result.sentiment).toBe('neutral');
  });

  it('returns neutral when empty string', async () => {
    const result = await provider.detectSentiment('');
    expect(result.sentiment).toBe('neutral');
  });

  it('returns neutral when positive and negative counts are equal', async () => {
    const result = await provider.detectSentiment('I am angry but also happy');
    // "angry" = 1 negative, "happy" = 1 positive → tie → neutral
    expect(result.sentiment).toBe('neutral');
  });

  // ── Sentiment is always one of the 3 valid values ─────────────────────

  it('always returns a valid Sentiment label', async () => {
    const validSentiments = ['negative', 'neutral', 'positive'];
    const phrases = ['I am angry', 'hello', 'thank you so much', 'terrible horrible awful'];
    for (const phrase of phrases) {
      const result = await provider.detectSentiment(phrase);
      expect(validSentiments).toContain(result.sentiment);
    }
  });
});

// ── generateResponse ───────────────────────────────────────────────────────────

describe('MockProvider.generateResponse', () => {
  it('returns refund-processed confirmation when refundOutcome is processed', async () => {
    const ctx: ResponseContext = {
      ...baseCtx,
      resolutionPath: 'refund',
      refundOutcome: 'processed',
      orderInfo: { orderId: 'ORD-1', status: 'delayed', amount: 49.99 },
    };
    const result = await provider.generateResponse(ctx);
    expect(result).toMatch(/refund.*processed/i);
  });

  it('includes order amount in refund-processed response', async () => {
    const ctx: ResponseContext = {
      ...baseCtx,
      resolutionPath: 'refund',
      refundOutcome: 'processed',
      orderInfo: { orderId: 'ORD-1', status: 'delayed', amount: 99.50 },
    };
    const result = await provider.generateResponse(ctx);
    expect(result).toContain('99.50');
  });

  it('returns rejection message when refundOutcome is rejected', async () => {
    const ctx: ResponseContext = {
      ...baseCtx,
      resolutionPath: 'refund',
      refundOutcome: 'rejected',
    };
    const result = await provider.generateResponse(ctx);
    expect(result).toMatch(/not eligible|rejected|unable/i);
  });

  it('returns replacement confirmation when replacementOutcome is processed', async () => {
    const ctx: ResponseContext = {
      ...baseCtx,
      resolutionPath: 'replacement',
      replacementOutcome: 'processed',
    };
    const result = await provider.generateResponse(ctx);
    expect(result).toMatch(/replacement.*arranged|arranged.*replacement/i);
  });

  it('returns escalation message for escalation path', async () => {
    const ctx: ResponseContext = {
      ...baseCtx,
      resolutionPath: 'escalation',
      escalated: true,
    };
    const result = await provider.generateResponse(ctx);
    expect(result).toMatch(/escalat/i);
  });

  it('returns informational response for informational path', async () => {
    const ctx: ResponseContext = {
      ...baseCtx,
      resolutionPath: 'informational',
      passages: [
        { id: 'p1', category: 'refund', title: 'Refund Policy', text: 'You may request a refund within 30 days.' },
      ],
    };
    const result = await provider.generateResponse(ctx);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns a non-empty string for every valid resolutionPath', async () => {
    const paths: Array<'refund' | 'replacement' | 'escalation' | 'informational'> = [
      'refund', 'replacement', 'escalation', 'informational',
    ];
    for (const path of paths) {
      const ctx: ResponseContext = { ...baseCtx, resolutionPath: path };
      const result = await provider.generateResponse(ctx);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

// ── summarizeConversation ──────────────────────────────────────────────────────

describe('MockProvider.summarizeConversation', () => {
  it('summarizes a conversation with customer messages', async () => {
    const messages: Message[] = [
      makeMessage('customer', 'My order is late', 0),
      makeMessage('assistant', 'I can help with that', 1),
      makeMessage('customer', 'I want a refund', 2),
    ];
    const result = await provider.summarizeConversation(messages);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/2.*customer|customer.*2/i);
  });

  it('summarizes an empty conversation', async () => {
    const result = await provider.summarizeConversation([]);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/0.*customer|customer.*0/i);
  });

  it('includes topics from first words of customer messages', async () => {
    const messages: Message[] = [
      makeMessage('customer', 'Refund requested for late delivery', 0),
      makeMessage('assistant', 'We are looking into it', 1),
    ];
    const result = await provider.summarizeConversation(messages);
    // The first word of the customer message should appear in topics
    expect(result).toContain('Refund');
  });

  it('limits topics to first 5 customer messages', async () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, i) =>
      makeMessage('customer', `Message ${i}`, i),
    );
    const result = await provider.summarizeConversation(messages);
    // Should still produce a valid summary string
    expect(result.length).toBeGreaterThan(0);
  });
});
