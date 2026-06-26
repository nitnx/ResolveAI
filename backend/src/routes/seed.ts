/**
 * Seed data endpoints.
 *
 * Routes:
 *   GET /api/seed/customers — seeded customers with their orders (Req 1.9)
 *
 * Returns customer dropdown data so the Chat_Interface can let a customer
 * select a seeded Customer or Order from a dropdown control (Req 1.9).
 *
 * _Requirements: 1.9_
 */

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getDb } from '../data/db.js';
import { createCustomerRepository } from '../repositories/customerRepository.js';
import { createOrderRepository } from '../repositories/orderRepository.js';
import { ConversationRepository } from '../repositories/conversationRepository.js';
import { DEMO_ORDER_ID } from '../data/seedData.js';
import type { Conversation, Order } from '../domain/types.js';

export const seedRouter = Router();

// ── GET /api/seed/customers ────────────────────────────────────────────────────
// Returns: { customers: Array<{ id, name, email, orders: Order[] }> }
seedRouter.get('/customers', (_req: Request, res: Response): void => {
  const db = getDb();
  const customerRepo = createCustomerRepository(db);
  const orderRepo = createOrderRepository(db);

  const customers = customerRepo.getAllCustomers();

  const result = customers.map((customer) => {
    const orders: Order[] = orderRepo.getOrdersByCustomerId(customer.id);
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      orders,
    };
  });

  res.json({ customers: result });
});

// ── POST /api/seed/reset-demo ──────────────────────────────────────────────────
// Produces a clean slate for a recorded demo without restarting the server:
//
//   1. Clears ALL runtime/demo state — conversations, messages, action logs
//      (including the refund/replacement actions), and escalations created
//      during testing. Seeded customers, orders, policies, and tickets are
//      left intact.
//   2. Restores the demo order (and any optionally supplied orderId) to its
//      pristine resolution state (refunded = false, replaced = false). The
//      seeded ORD-1001 is delayed and never had its status mutated at runtime,
//      so resetting the flags returns it to its original delayed, not-refunded
//      state.
//   3. Starts ONE fresh conversation bound to the demo order so the chat is
//      "demo ready" and the dashboard shows exactly one current conversation.
//
// Body (optional): { orderId?: string }
// Returns: { reset: string[], conversation: Conversation }
seedRouter.post('/reset-demo', (req: Request<Record<string, never>, unknown, { orderId?: string }>, res: Response): void => {
  const db = getDb();
  const orderRepo = createOrderRepository(db);
  const conversationRepo = new ConversationRepository(db);

  // 1. Wipe all runtime/demo state in a single transaction. Children are
  //    deleted before conversations to satisfy foreign-key constraints.
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM action_logs').run();
    db.prepare('DELETE FROM escalations').run();
    db.prepare('DELETE FROM conversations').run();
  });
  wipe();

  // 2. Restore demo order(s) to a pristine, un-refunded/un-replaced state.
  const ids = new Set<string>([DEMO_ORDER_ID]);
  if (typeof req.body?.orderId === 'string' && req.body.orderId.trim() !== '') {
    ids.add(req.body.orderId.trim());
  }

  const reset: string[] = [];
  for (const id of ids) {
    if (orderRepo.getOrderById(id) !== null) {
      orderRepo.resetOrder(id);
      reset.push(id);
    }
  }

  // 3. Start one fresh conversation for the demo order (bound to its customer).
  const demoOrder: Order | null = orderRepo.getOrderById(DEMO_ORDER_ID);
  const conversation: Conversation = conversationRepo.createConversation({
    id: randomUUID(),
    ...(demoOrder?.customerId ? { customerId: demoOrder.customerId } : {}),
    orderId: DEMO_ORDER_ID,
  });

  res.json({ reset, conversation });
});
