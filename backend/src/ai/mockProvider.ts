/**
 * MockProvider — deterministic, rule-based AI provider fallback (Req 2.11, 12.7).
 *
 * Implements the full `AiProvider` interface with keyword-rule-based logic that
 * requires no API keys or network access. The application runs end-to-end on
 * seed data with zero external dependencies.
 *
 * Key behaviour (demo-critical):
 *   "My order is late and I'm angry, I want a refund"
 *   → classifyIntent  : { intent: 'refund_request', confidence: 0.92 }
 *   → detectSentiment : { sentiment: 'negative' }
 *
 * Design decisions:
 *   - Intent classification: keyword rules per category; confidence is derived
 *     from match count (3+ → 0.92, 2 → 0.82, 1 → 0.75, 0 → 0 / general_inquiry).
 *     The 0.70 floor is applied by the Intent_Classifier (task 6.1), NOT here.
 *   - Sentiment detection: negative/positive lexicons; negative > positive →
 *     'negative'; positive > negative → 'positive'; tie → 'neutral'.
 *   - Response generation: deterministic string built from ctx.resolutionPath
 *     and available context fields.
 *   - Summarization: counts customer messages; extracts first word of each.
 *
 * _Requirements: 2.11, 12.7_
 */

import type { AiProvider, ResponseContext } from './aiProvider.js';
import type { IntentCategory, Sentiment, Message } from '../domain/types.js';

// ── Intent keyword rules ───────────────────────────────────────────────────────

/** Keywords per intent category. All comparisons are case-insensitive. */
const INTENT_KEYWORDS: Record<Exclude<IntentCategory, 'general_inquiry'>, string[]> = {
  refund_request: [
    'refund',
    'money back',
    'reimburse',
    'reimbursement',
    'charge back',
    'get my money',
    'credit back',
  ],
  replacement_request: [
    'replace',
    'replacement',
    'send another',
    'new item',
    'swap',
    'exchange',
    'substitute',
  ],
  order_status: [
    'where is',
    'order status',
    'tracking',
    'track my',
    'shipment',
    'shipped',
    'delivery status',
    "where's my",
  ],
  shipping_inquiry: [
    'shipping',
    'delivery',
    'dispatch',
    'how long',
    'when will',
    'estimate',
    'expedite',
    'ship',
  ],
  policy_question: [
    'policy',
    'terms',
    'rules',
    'guidelines',
    'what are the',
    'how does',
    'conditions',
    'eligibility',
  ],
  complaint: [
    'terrible',
    'horrible',
    'awful',
    'worst',
    'disappointed',
    'unacceptable',
    'ridiculous',
    'frustrated',
    'angry',
    'upset',
    'disgusted',
  ],
  escalation_request: [
    'speak to',
    'talk to',
    'human',
    'agent',
    'manager',
    'supervisor',
    'escalate',
    'representative',
  ],
};

/**
 * Tie-breaking priority order (earlier = higher priority).
 * refund_request > replacement_request > escalation_request > complaint >
 * order_status > shipping_inquiry > policy_question
 */
const PRIORITY_ORDER: Exclude<IntentCategory, 'general_inquiry'>[] = [
  'refund_request',
  'replacement_request',
  'escalation_request',
  'complaint',
  'order_status',
  'shipping_inquiry',
  'policy_question',
];

// ── Sentiment lexicons ─────────────────────────────────────────────────────────

const NEGATIVE_WORDS = new Set([
  'late',
  'angry',
  'frustrated',
  'terrible',
  'horrible',
  'awful',
  'worst',
  'disappointed',
  'unacceptable',
  'ridiculous',
  'upset',
  'disgusted',
  'furious',
  'mad',
  'annoyed',
  'bad',
  'wrong',
  'broken',
  'damaged',
  'lost',
  'delayed',
  'overdue',
  'waiting',
  'never',
  'again',
  'refund',
  'scam',
  'waste',
  // Required by spec (task 5.2 / Req 2.11, 12.7):
  'hate',
  'useless',
  'missing',
]);

const POSITIVE_WORDS = new Set([
  'thank',
  'thanks',
  'great',
  'good',
  'excellent',
  'wonderful',
  'happy',
  'pleased',
  'satisfied',
  'love',
  'amazing',
  'perfect',
  'fantastic',
  'brilliant',
  'awesome',
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Count how many distinct keywords from a list appear in the text (case-insensitive). */
function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) {
      count++;
    }
  }
  return count;
}

/** Derive confidence from the number of matching keywords. */
function matchCountToConfidence(matchCount: number): number {
  if (matchCount >= 3) return 0.92;
  if (matchCount === 2) return 0.82;
  if (matchCount === 1) return 0.75;
  return 0; // no matches → general_inquiry fallback
}

// ── MockProvider ───────────────────────────────────────────────────────────────

export class MockProvider implements AiProvider {
  /**
   * Classify intent using keyword-match rules.
   *
   * For each category, count how many distinct keywords match the text
   * (case-insensitive). Pick the category with the highest match count.
   * On a tie, prefer according to PRIORITY_ORDER. If no category has any
   * matches, return general_inquiry with confidence 0.4.
   *
   * The 0.70 floor is applied by the Intent_Classifier (task 6.1), not here.
   */
  async classifyIntent(text: string): Promise<{ intent: IntentCategory; confidence: number }> {
    let bestCategory: Exclude<IntentCategory, 'general_inquiry'> | null = null;
    let bestCount = 0;

    for (const category of PRIORITY_ORDER) {
      const count = countMatches(text, INTENT_KEYWORDS[category]);
      if (count > bestCount) {
        bestCount = count;
        bestCategory = category;
      }
      // Tie: keep the existing bestCategory because PRIORITY_ORDER is iterated
      // in priority order and the first one wins on equal count.
    }

    if (bestCategory === null || bestCount === 0) {
      return { intent: 'general_inquiry', confidence: 0.4 };
    }

    return {
      intent: bestCategory,
      confidence: matchCountToConfidence(bestCount),
    };
  }

  /**
   * Detect sentiment using negative/positive lexicons.
   *
   * Tokenise the text into lower-case words, count matches in each lexicon.
   * negative > positive → 'negative'; positive > negative → 'positive';
   * equal (including both zero) → 'neutral'.
   */
  async detectSentiment(text: string): Promise<{ sentiment: Sentiment }> {
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);

    let negCount = 0;
    let posCount = 0;

    for (const token of tokens) {
      if (NEGATIVE_WORDS.has(token)) negCount++;
      if (POSITIVE_WORDS.has(token)) posCount++;
    }

    // Also check multi-word negative phrases
    const lower = text.toLowerCase();
    if (lower.includes('never received')) negCount++;

    if (negCount > posCount) return { sentiment: 'negative' };
    if (posCount > negCount) return { sentiment: 'positive' };
    return { sentiment: 'neutral' };
  }

  /**
   * Generate a deterministic response string based on ctx.resolutionPath and
   * available context fields.
   */
  async generateResponse(ctx: ResponseContext): Promise<string> {
    const firstPassageTitle = ctx.passages[0]?.title;
    const firstPassageText = ctx.passages[0]?.text;

    switch (ctx.resolutionPath) {
      case 'refund': {
        if (ctx.refundOutcome === 'processed') {
          const amountPart =
            ctx.orderInfo != null
              ? ` Order amount: $${ctx.orderInfo.amount.toFixed(2)}.`
              : '';
          const policyPart = firstPassageTitle != null ? ` Policy basis: ${firstPassageTitle}.` : '';
          return `Your refund has been processed successfully.${amountPart}${policyPart}`;
        }
        if (ctx.refundOutcome === 'rejected') {
          const policyPart =
            firstPassageText != null
              ? ` ${firstPassageText.slice(0, 200)}`
              : '';
          return `I'm sorry, your refund request was reviewed but you're not eligible at this time.${policyPart}`;
        }
        // refundOutcome not_processed or absent
        return "Thank you for contacting support. We were unable to process your refund at this time. How can I assist you further?";
      }

      case 'replacement': {
        if (ctx.replacementOutcome === 'processed') {
          return 'A replacement has been arranged for your order.';
        }
        return "Thank you for contacting support. We were unable to process your replacement at this time. How can I assist you further?";
      }

      case 'escalation': {
        return "I've escalated your case to our support team for immediate attention. You'll hear from us shortly.";
      }

      case 'informational': {
        const policyPart =
          firstPassageText != null
            ? ` Based on our policies: ${firstPassageText.slice(0, 200)}.`
            : '';
        return `${policyPart} Is there anything else I can help with?`.trimStart();
      }

      default: {
        return 'Thank you for contacting support. How can I assist you today?';
      }
    }
  }

  /**
   * Produce a deterministic conversation summary.
   *
   * Counts customer messages and lists the first word of each (up to 5).
   */
  async summarizeConversation(messages: Message[]): Promise<string> {
    const customerMessages = messages.filter((m) => m.role === 'customer');
    const count = customerMessages.length;

    const firstWords = customerMessages
      .slice(0, 5)
      .map((m) => m.text.trim().split(/\s+/)[0] ?? '')
      .filter(Boolean);

    const topicsStr = firstWords.length > 0 ? firstWords.join(', ') : 'none';
    return `Support conversation with ${count} customer message(s). Topics discussed: ${topicsStr}.`;
  }
}
