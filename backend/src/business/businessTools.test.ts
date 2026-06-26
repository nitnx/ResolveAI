/**
 * Unit tests for BusinessTools — task 9.9.
 *
 * Covers:
 *   - `escalateTicket` creates an Escalation and enqueues it (Req 6.10)
 *   - `escalateTicket` logs a `tool_call` entry on success (Req 6.11, 8.1)
 *   - `escalateTicket` logs a `tool_call` entry with failure outcome and rethrows (Req 6.11)
 *   - Priority derivation: negative sentiment raises priority by 1 (Req 4.4)
 *   - `logToolCall` is invoked on every Business_Tool method (Req 6.11, 8.1):
 *       orderLookup, checkRefundEligibility, checkReplacementEligibility,
 *       processRefund, processReplacement
 *
 * All tests use in-memory stubs — no SQLite required.
 *
 * _Requirements: 6.10, 6.11, 8.1_
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BusinessTools } from './businessTools.js';
import type { BusinessToolsDeps, OrderRepository, EscalationRepository } from './businessTools.js';
import type { ActionLogRepository } from '../repositories/actionLogRepository.js';
import type {
  Order,
  Conversation,
  Escalation,
  ActionLogEntry,
} from '../domain/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeActionLogRepo(): ActionLogRepository & { calls: ActionLogEntry[] } {
  const calls: ActionLogEntry[] = [];
  return {
    calls,
    appendActionLog: vi.fn((entry) => {
      const full = { ...entry, seq: calls.length + 1 };
      calls.push(full as ActionLogEntry);
      return full as ActionLogEntry;
    }),
    getActionLogByConversationId: vi.fn(() => calls),
  };
}

function makeOrderRepo(order: Order | null = null): OrderRepository {
  return {
    getOrderById: vi.fn(() => order),
    markRefunded: vi.fn(),
    markReplaced: vi.fn(),
  };
}

function makeEscalationRepo(escalation?: Escalation): EscalationRepository {
  const defaultEscalation: Escalation = {
    id: 'esc-1',
    conversationId: 'conv-1',
    priority: 2,
    createdAtMs: Date.now(),
  };
  return {
    createEscalation: vi.fn(() => escalation ?? defaultEscalation),
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    status: 'active',
    latestSentiment: 'neutral',
    escalationPriority: 1,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    customerId: 'cust-1',
    items: [{ sku: 'sku-1', name: 'Widget', quantity: 1 }],
    amount: 50,
    status: 'delayed',
    orderedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    promisedDeliveryAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    refunded: false,
    replaced: false,
    hasValidComplaint: false,
    ...overrides,
  };
}

function makeTools(
  overrides: Partial<BusinessToolsDeps> = {},
): { tools: BusinessTools; actionLogRepo: ReturnType<typeof makeActionLogRepo> } {
  const actionLogRepo = makeActionLogRepo();
  const deps: BusinessToolsDeps = {
    actionLogRepo,
    orderRepo: makeOrderRepo(),
    escalationRepo: makeEscalationRepo(),
    conversationId: 'conv-1',
    ...overrides,
  };
  return { tools: new BusinessTools(deps), actionLogRepo };
}

// ── escalateTicket (Req 6.10) ─────────────────────────────────────────────────

describe('BusinessTools.escalateTicket', () => {
  it('creates an escalation via escalationRepo.createEscalation', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });
    const conv = makeConversation();

    await tools.escalateTicket(conv);

    expect(escalationRepo.createEscalation).toHaveBeenCalledOnce();
  });

  it('returns the escalation created by escalationRepo', async () => {
    const expected: Escalation = {
      id: 'esc-42',
      conversationId: 'conv-1',
      priority: 2,
      createdAtMs: 1000,
    };
    const escalationRepo = makeEscalationRepo(expected);
    const { tools } = makeTools({ escalationRepo });

    const result = await tools.escalateTicket(makeConversation());

    expect(result).toEqual(expected);
  });

  it('passes the conversationId from the conversation object', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });
    const conv = makeConversation({ id: 'conv-xyz' });

    // Tools are created with conversationId 'conv-1' but the escalation
    // conversationId comes from the conv parameter
    await tools.escalateTicket(conv);

    const call = (escalationRepo.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<Escalation, 'id' | 'createdAtMs'>,
    ];
    expect(call[0].conversationId).toBe('conv-xyz');
  });

  it('attaches the optional summary when provided', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });

    await tools.escalateTicket(makeConversation(), 'AI-generated summary here');

    const call = (escalationRepo.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<Escalation, 'id' | 'createdAtMs'>,
    ];
    expect(call[0].summary).toBe('AI-generated summary here');
  });

  it('does not attach summary when not provided', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });

    await tools.escalateTicket(makeConversation());

    const call = (escalationRepo.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<Escalation, 'id' | 'createdAtMs'>,
    ];
    expect(call[0].summary).toBeUndefined();
  });

  // ── Priority derivation (Req 4.4) ─────────────────────────────────────

  it('raises priority by 1 when sentiment is negative (Req 4.4)', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });
    const conv = makeConversation({ latestSentiment: 'negative', escalationPriority: 2 });

    await tools.escalateTicket(conv);

    const call = (escalationRepo.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<Escalation, 'id' | 'createdAtMs'>,
    ];
    // negative → base(2) + 1 = 3
    expect(call[0].priority).toBe(3);
  });

  it('does not raise priority when sentiment is neutral', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });
    const conv = makeConversation({ latestSentiment: 'neutral', escalationPriority: 2 });

    await tools.escalateTicket(conv);

    const call = (escalationRepo.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<Escalation, 'id' | 'createdAtMs'>,
    ];
    expect(call[0].priority).toBe(2);
  });

  it('does not raise priority when sentiment is positive', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });
    const conv = makeConversation({ latestSentiment: 'positive', escalationPriority: 3 });

    await tools.escalateTicket(conv);

    const call = (escalationRepo.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<Escalation, 'id' | 'createdAtMs'>,
    ];
    expect(call[0].priority).toBe(3);
  });

  it('uses 1 as base priority when escalationPriority is 0', async () => {
    const escalationRepo = makeEscalationRepo();
    const { tools } = makeTools({ escalationRepo });
    const conv = makeConversation({ latestSentiment: 'neutral', escalationPriority: 0 });

    await tools.escalateTicket(conv);

    const call = (escalationRepo.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<Escalation, 'id' | 'createdAtMs'>,
    ];
    expect(call[0].priority).toBe(1);
  });
});

// ── tool_call logging for escalateTicket (Req 6.11, 8.1) ─────────────────────

describe('BusinessTools.escalateTicket — tool_call logging', () => {
  it('appends a tool_call action log entry on success (Req 6.11, 8.1)', async () => {
    const { tools, actionLogRepo } = makeTools();

    await tools.escalateTicket(makeConversation(), 'summary');

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    expect(entry.type).toBe('tool_call');
    expect(entry.payload.kind).toBe('tool_call');
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('escalateTicket');
      expect(entry.payload.outcome).toBe('success');
    }
  });

  it('log entry params include conversationId and summaryPresent flag', async () => {
    const { tools, actionLogRepo } = makeTools();

    await tools.escalateTicket(makeConversation({ id: 'conv-abc' }), 'some summary');

    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      const params = entry.payload.params as { conversationId: string; summaryPresent: boolean };
      expect(params.conversationId).toBe('conv-abc');
      expect(params.summaryPresent).toBe(true);
    }
  });

  it('logs failure outcome and rethrows when escalationRepo throws', async () => {
    const failingEscalationRepo: EscalationRepository = {
      createEscalation: vi.fn(() => { throw new Error('DB failure'); }),
    };
    const { tools, actionLogRepo } = makeTools({ escalationRepo: failingEscalationRepo });

    await expect(tools.escalateTicket(makeConversation())).rejects.toThrow('DB failure');

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    expect(entry.type).toBe('tool_call');
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('escalateTicket');
      expect(entry.payload.outcome).toBe('failure');
    }
  });
});

// ── tool_call logging for all other Business_Tools (Req 6.11) ─────────────────

describe('BusinessTools — tool_call logging on every invocation (Req 6.11)', () => {
  it('orderLookup logs a tool_call entry on hit', async () => {
    const order = makeOrder();
    const { tools, actionLogRepo } = makeTools({ orderRepo: makeOrderRepo(order) });

    await tools.orderLookup('ord-1');

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    expect(entry.type).toBe('tool_call');
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('orderLookup');
      expect(entry.payload.outcome).toBe('success');
    }
  });

  it('orderLookup logs a tool_call entry on miss', async () => {
    const { tools, actionLogRepo } = makeTools({ orderRepo: makeOrderRepo(null) });

    await tools.orderLookup('ord-not-found');

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('orderLookup');
      expect(entry.payload.outcome).toBe('success'); // miss is a normal result, not a failure
    }
  });

  it('checkRefundEligibility logs a tool_call entry', () => {
    const order = makeOrder();
    const { tools, actionLogRepo } = makeTools();

    tools.checkRefundEligibility(order, { passages: [] });

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('checkRefundEligibility');
    }
  });

  it('checkReplacementEligibility logs a tool_call entry', () => {
    const order = makeOrder();
    const { tools, actionLogRepo } = makeTools();

    tools.checkReplacementEligibility(order, { passages: [] });

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('checkReplacementEligibility');
    }
  });

  it('processRefund logs a tool_call entry on eligible order', async () => {
    const order = makeOrder();
    const { tools, actionLogRepo } = makeTools({ orderRepo: makeOrderRepo(order) });
    const eligibility = { status: 'eligible' as const, reason: 'policy allows' };

    await tools.processRefund(order, eligibility);

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('processRefund');
      expect(entry.payload.outcome).toBe('success');
    }
  });

  it('processRefund logs a failure outcome for ineligible order', async () => {
    const order = makeOrder();
    const { tools, actionLogRepo } = makeTools();
    const eligibility = { status: 'ineligible' as const, reason: 'already refunded' };

    await tools.processRefund(order, eligibility);

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('processRefund');
      expect(entry.payload.outcome).toBe('failure');
    }
  });

  it('processReplacement logs a tool_call entry on eligible order', async () => {
    const order = makeOrder();
    const { tools, actionLogRepo } = makeTools({ orderRepo: makeOrderRepo(order) });
    const eligibility = { status: 'eligible' as const, reason: 'policy allows' };

    await tools.processReplacement(order, eligibility);

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('processReplacement');
      expect(entry.payload.outcome).toBe('success');
    }
  });

  it('processReplacement logs a failure outcome for ineligible order', async () => {
    const order = makeOrder();
    const { tools, actionLogRepo } = makeTools();
    const eligibility = { status: 'ineligible' as const, reason: 'already replaced' };

    await tools.processReplacement(order, eligibility);

    expect(actionLogRepo.appendActionLog).toHaveBeenCalledOnce();
    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBe('processReplacement');
      expect(entry.payload.outcome).toBe('failure');
    }
  });
});

// ── tool_call log entry shape (Req 8.1) ───────────────────────────────────────

describe('BusinessTools — tool_call log entry shape (Req 8.1)', () => {
  it('log entry has tool id, params, result, and outcome fields', async () => {
    const { tools, actionLogRepo } = makeTools();

    await tools.orderLookup('ord-1');

    const [entry] = (actionLogRepo.appendActionLog as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Omit<ActionLogEntry, 'seq'>,
    ];
    expect(entry.type).toBe('tool_call');
    expect(entry.timestampMs).toBeTypeOf('number');
    expect(entry.conversationId).toBe('conv-1');

    if (entry.payload.kind === 'tool_call') {
      expect(entry.payload.tool).toBeTypeOf('string');
      expect(entry.payload.params).toBeDefined();
      expect(entry.payload.result).toBeDefined();
      expect(['success', 'failure']).toContain(entry.payload.outcome);
    }
  });
});
