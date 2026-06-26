/**
 * In-code seed dataset for ResolveAI (Seed_Data definition).
 *
 * This module defines the realistic, preloaded sample data the application
 * loads at initialization: customers, orders, policy documents, and tickets.
 * It is the *data* only — the idempotent loader that writes it into SQLite is
 * implemented separately (task 3.2). All arrays are strongly typed against the
 * domain types in `../domain/types.ts`.
 *
 * Coverage (Req 10.1–10.5, 5.1):
 * - ≥3 customers, ≥6 orders, ≥3 tickets.
 * - ≥1 policy document for EACH category: shipping, refund, replacement, support.
 *   Policy text is realistic and keyword-rich so the in-memory TF-IDF retriever
 *   ranks refund/shipping passages highly for late-order refund queries (Req 5.1).
 * - ≥1 refund-ELIGIBLE order and ≥1 refund-INELIGIBLE order (Req 10.2).
 * - A customer with an order past its expected delivery date whose state
 *   satisfies refund eligibility, supporting the demo scenario (Req 10.4).
 * - ONE delayed, refund-eligible order designated as the default demo order via
 *   {@link DEMO_ORDER_ID}, preselected by the Chat_Interface (Req 10.5, 1.10).
 *
 * Demo eligibility (Req 6.3): the demo order has status `delayed`, is not
 * refunded, and its promised delivery date is computed as "now minus 5 days" so
 * it is ALWAYS at least 3 days past due at runtime, regardless of when the demo
 * is run. Its amount is below the default Refund_High_Value_Limit (200.00) so
 * the confidence-gated auto-refund path executes rather than escalating.
 *
 * The demo customer message that exercises this order is:
 *   "My order is late and I'm angry, I want a refund."
 *
 * _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 5.1_
 */

import type { Customer, Order, PolicyPassage, Ticket } from '../domain/types.js';

// ── Relative-date helpers ─────────────────────────────────────────────────────
// Dates are computed once at module load relative to "now" so time-sensitive
// invariants (e.g. the demo order being ≥3 days past its promised delivery)
// always hold at runtime instead of decaying against fixed calendar dates.

const NOW_MS = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp for a point `days` in the past (negative = future). */
function daysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

/** ISO timestamp for a point `days` in the future. */
function daysFromNow(days: number): string {
  return daysAgo(-days);
}

// ── Demo order designation ────────────────────────────────────────────────────

/**
 * The default demo Order the Chat_Interface preselects (Req 10.5, 1.10).
 *
 * It is a delayed, refund-eligible order: status `delayed`, promised delivery
 * 5 days in the past (≥3 days past due, Req 6.3), not refunded, low enough in
 * value to clear the high-value refund gate, and supported by the refund/shipping
 * policies. This drives the demo scenario in which a customer reports a late
 * order and requests a refund.
 */
export const DEMO_ORDER_ID = 'ORD-1001';

// ── Customers (≥3, Req 10.1) ──────────────────────────────────────────────────

export const seedCustomers: Customer[] = [
  { id: 'CUST-001', name: 'Maria Hernandez', email: 'maria.hernandez@example.com' },
  { id: 'CUST-002', name: 'James Chen', email: 'james.chen@example.com' },
  { id: 'CUST-003', name: 'Aisha Patel', email: 'aisha.patel@example.com' },
  { id: 'CUST-004', name: 'Liam O\u2019Connor', email: 'liam.oconnor@example.com' },
];

// ── Orders (≥5, with eligible & ineligible coverage, Req 10.1, 10.2, 10.4) ──────

export const seedOrders: Order[] = [
  // [DEMO] Delayed, refund-ELIGIBLE: promised delivery 5 days past due, not
  // refunded, amount below high-value limit → auto-refund path (Req 10.4, 10.5).
  {
    id: DEMO_ORDER_ID,
    customerId: 'CUST-001',
    items: [
      { sku: 'SKU-HEADPHONE-X', name: 'Aurora Wireless Headphones', quantity: 1 },
    ],
    amount: 89.99,
    status: 'delayed',
    orderedAt: daysAgo(12),
    promisedDeliveryAt: daysAgo(5), // 5 days past due → ≥3 days late (Req 6.3)
    refunded: false,
    replaced: false,
    hasValidComplaint: true,
  },

  // Refund-ELIGIBLE: delivered with a valid complaint, within the 30-day window.
  {
    id: 'ORD-1002',
    customerId: 'CUST-002',
    items: [
      { sku: 'SKU-BLENDER-PRO', name: 'KitchenPro Countertop Blender', quantity: 1 },
    ],
    amount: 129.0,
    status: 'delivered',
    orderedAt: daysAgo(20),
    promisedDeliveryAt: daysAgo(12),
    deliveredAt: daysAgo(10), // within 30 days of delivery (Req 6.3)
    refunded: false,
    replaced: false,
    hasValidComplaint: true,
  },

  // Refund-ELIGIBLE: order marked lost in transit.
  {
    id: 'ORD-1003',
    customerId: 'CUST-003',
    items: [
      { sku: 'SKU-BACKPACK-40L', name: 'TrailHead 40L Hiking Backpack', quantity: 1 },
    ],
    amount: 74.5,
    status: 'lost',
    orderedAt: daysAgo(15),
    promisedDeliveryAt: daysAgo(6),
    refunded: false,
    replaced: false,
    hasValidComplaint: true,
  },

  // Refund-INELIGIBLE: delivered, NO valid complaint → not refundable (Req 6.3).
  {
    id: 'ORD-1004',
    customerId: 'CUST-002',
    items: [
      { sku: 'SKU-MUG-CERAMIC', name: 'Glazed Ceramic Mug Set (4)', quantity: 2 },
    ],
    amount: 38.0,
    status: 'delivered',
    orderedAt: daysAgo(25),
    promisedDeliveryAt: daysAgo(18),
    deliveredAt: daysAgo(16),
    refunded: false,
    replaced: false,
    hasValidComplaint: false,
  },

  // Refund-INELIGIBLE: delayed but only 1 day past due (< 3-day rule, Req 6.3).
  {
    id: 'ORD-1005',
    customerId: 'CUST-004',
    items: [
      { sku: 'SKU-DESK-LAMP', name: 'Lumen Adjustable Desk Lamp', quantity: 1 },
    ],
    amount: 42.25,
    status: 'delayed',
    orderedAt: daysAgo(6),
    promisedDeliveryAt: daysAgo(1), // only 1 day late → ineligible
    refunded: false,
    replaced: false,
    hasValidComplaint: false,
  },

  // Refund-INELIGIBLE: still in transit (shipped, future promised delivery).
  // High value (> 200) to also exercise the high-value refund risk gate later.
  {
    id: 'ORD-1006',
    customerId: 'CUST-003',
    items: [
      { sku: 'SKU-MONITOR-27', name: 'ClearView 27" 4K Monitor', quantity: 1 },
    ],
    amount: 329.99,
    status: 'shipped',
    orderedAt: daysAgo(2),
    promisedDeliveryAt: daysFromNow(3), // not yet due
    refunded: false,
    replaced: false,
    hasValidComplaint: false,
  },
];

// ── Policy documents (≥1 per category, keyword-rich, Req 10.3, 5.1) ─────────────

export const seedPolicies: PolicyPassage[] = [
  {
    id: 'POL-SHIPPING-001',
    category: 'shipping',
    title: 'Shipping & Delivery Policy',
    text:
      'Orders are shipped within two business days and arrive by the promised delivery date shown at checkout. ' +
      'If a shipment is delayed and the order is late past its promised delivery date, customers may track the ' +
      'delivery status and contact support. An order is considered significantly delayed when it is at least three ' +
      'days late beyond the promised delivery date. Shipments that are lost in transit or never delivered are treated ' +
      'as failed deliveries and qualify the customer for a refund or replacement under the refund policy.',
  },
  {
    id: 'POL-REFUND-001',
    category: 'refund',
    title: 'Refund Eligibility Policy',
    text:
      'Customers are eligible for a refund when an order is delayed at least three days past the promised delivery ' +
      'date, when an order is lost in transit, or when a delivered order has a valid complaint reported within thirty ' +
      'days of delivery. A refund will not be issued for an order that has already been refunded. Late orders and ' +
      'undelivered shipments qualify for a full refund of the order amount. To request a refund for a late or lost ' +
      'order, customers contact support with their order identifier and the refund is processed back to the original ' +
      'payment method.',
  },
  {
    id: 'POL-REPLACEMENT-001',
    category: 'replacement',
    title: 'Replacement Policy',
    text:
      'Customers may request a replacement instead of a refund when an item arrives damaged or defective, when an ' +
      'order is lost in transit, or when an order is significantly delayed. A replacement is shipped at no additional ' +
      'cost once the original order is confirmed as damaged, lost, or delayed. An order that has already been refunded ' +
      'or replaced is not eligible for another replacement. Replacement requests for damaged goods should include a ' +
      'description of the damage so support can expedite the new shipment.',
  },
  {
    id: 'POL-SUPPORT-001',
    category: 'support',
    title: 'Customer Support Policy',
    text:
      'Our support team assists customers with order status questions, shipping inquiries, refunds, replacements, and ' +
      'general complaints. When a customer is frustrated or an issue cannot be resolved automatically, the case is ' +
      'escalated to a human support agent with a summary of the conversation. Support aims to acknowledge every ' +
      'request promptly and to keep customers informed about the resolution of their order issues.',
  },
];

// ── Tickets (≥3, Req 10.1) ─────────────────────────────────────────────────────

export const seedTickets: Ticket[] = [
  {
    id: 'TICK-001',
    customerId: 'CUST-001',
    subject: 'My order is late and I have not received it',
    status: 'open',
    createdAtMs: NOW_MS - 4 * DAY_MS,
  },
  {
    id: 'TICK-002',
    customerId: 'CUST-002',
    subject: 'Blender arrived damaged \u2013 requesting replacement',
    status: 'open',
    createdAtMs: NOW_MS - 9 * DAY_MS,
  },
  {
    id: 'TICK-003',
    customerId: 'CUST-003',
    subject: 'Refund status for lost backpack order',
    status: 'closed',
    createdAtMs: NOW_MS - 13 * DAY_MS,
  },
  {
    id: 'TICK-004',
    customerId: 'CUST-004',
    subject: 'Question about expected delivery date',
    status: 'open',
    createdAtMs: NOW_MS - 1 * DAY_MS,
  },
];

/**
 * The full seed dataset, bundled for convenient consumption by the seed loader
 * (task 3.2). The `demoOrderId` is surfaced here as well for the loader and the
 * Chat_Interface preselection (Req 10.5, 1.10).
 */
export const seedData = {
  customers: seedCustomers,
  orders: seedOrders,
  policies: seedPolicies,
  tickets: seedTickets,
  demoOrderId: DEMO_ORDER_ID,
} as const;
