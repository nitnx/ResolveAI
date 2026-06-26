/**
 * Order repository — synchronous read/write access over the `orders` table.
 *
 * Provides lookups by primary key and customer ID, mutation helpers to mark an
 * order as refunded or replaced, and a convenience accessor for the designated
 * default demo order.
 *
 * Column-type notes:
 * - `items` is stored as a JSON text array; it is parsed back to the domain
 *   array type on every read.
 * - `refunded`, `replaced`, and `has_valid_complaint` are stored as INTEGER
 *   0/1; they are cast to `boolean` on every read.
 * - `delivered_at` is nullable; undefined is used in the domain type when the
 *   column is NULL (exactOptionalPropertyTypes requires an explicit absence).
 *
 * _Requirements: 12.8, 6.1, 6.2, 6.5, 6.8_
 */

import type Database from 'better-sqlite3';
import type { Order, OrderStatus } from '../domain/types.js';
import { getDb } from '../data/db.js';
import { DEMO_ORDER_ID } from '../data/seedData.js';

// ── Raw row shape returned by better-sqlite3 ──────────────────────────────────

interface OrderRow {
  id: string;
  customer_id: string;
  items: string;                  // JSON text
  amount: number;
  status: string;
  ordered_at: string;
  promised_delivery_at: string;
  delivered_at: string | null;
  refunded: number;               // 0 or 1
  replaced: number;               // 0 or 1
  has_valid_complaint: number;    // 0 or 1
}

// ── Row → domain type mapper ──────────────────────────────────────────────────

function rowToOrder(row: OrderRow): Order {
  const base: Order = {
    id: row.id,
    customerId: row.customer_id,
    items: JSON.parse(row.items) as Order['items'],
    amount: row.amount,
    status: row.status as OrderStatus,
    orderedAt: row.ordered_at,
    promisedDeliveryAt: row.promised_delivery_at,
    refunded: row.refunded !== 0,
    replaced: row.replaced !== 0,
    hasValidComplaint: row.has_valid_complaint !== 0,
  };

  // Only set deliveredAt when the column is not NULL to satisfy
  // exactOptionalPropertyTypes: the property must be absent, not undefined.
  if (row.delivered_at !== null) {
    return { ...base, deliveredAt: row.delivered_at };
  }
  return base;
}

// ── Shared SELECT projection ──────────────────────────────────────────────────

const SELECT_COLUMNS = `
  id, customer_id, items, amount, status,
  ordered_at, promised_delivery_at, delivered_at,
  refunded, replaced, has_valid_complaint
`;

// ── Repository factory ────────────────────────────────────────────────────────

/**
 * Create an order repository bound to `db`.
 * Accepts an explicit connection so callers (tests, DI) can provide an
 * in-memory database; production code should pass {@link getDb}().
 */
export function createOrderRepository(db: Database.Database) {
  /**
   * Look up a single order by its primary key.
   * Returns `null` when no matching row exists (Req 6.2 — miss is non-mutating).
   *
   * _Requirements: 6.1, 6.2_
   */
  function getOrderById(id: string): Order | null {
    const row = db
      .prepare<[string], OrderRow>(
        `SELECT ${SELECT_COLUMNS} FROM orders WHERE id = ?`,
      )
      .get(id);
    return row !== undefined ? rowToOrder(row) : null;
  }

  /**
   * Return every order in the table (no ordering guarantee).
   */
  function getAllOrders(): Order[] {
    const rows = db
      .prepare<[], OrderRow>(`SELECT ${SELECT_COLUMNS} FROM orders`)
      .all();
    return rows.map(rowToOrder);
  }

  /**
   * Return all orders associated with the given customer ID.
   */
  function getOrdersByCustomerId(customerId: string): Order[] {
    const rows = db
      .prepare<[string], OrderRow>(
        `SELECT ${SELECT_COLUMNS} FROM orders WHERE customer_id = ?`,
      )
      .all(customerId);
    return rows.map(rowToOrder);
  }

  /**
   * Set `refunded = true` on the order identified by `orderId`.
   * Used by the refund processing Business_Tool after a successful mock refund
   * (Req 6.5).
   *
   * _Requirements: 6.5_
   */
  function markRefunded(orderId: string): void {
    db.prepare<[string]>('UPDATE orders SET refunded = 1 WHERE id = ?').run(orderId);
  }

  /**
   * Set `replaced = true` on the order identified by `orderId`.
   * Used by the replacement processing Business_Tool after a successful mock
   * replacement (Req 6.8).
   *
   * _Requirements: 6.8_
   */
  function markReplaced(orderId: string): void {
    db.prepare<[string]>('UPDATE orders SET replaced = 1 WHERE id = ?').run(orderId);
  }

  /**
   * Restore an order's mutable resolution flags to their pristine state
   * (`refunded = 0`, `replaced = 0`). Used by the demo-reset endpoint so a
   * recorded demo can be replayed from a clean state without restarting the
   * server. Does not alter any other order field.
   */
  function resetOrder(orderId: string): void {
    db.prepare<[string]>(
      'UPDATE orders SET refunded = 0, replaced = 0 WHERE id = ?',
    ).run(orderId);
  }

  /**
   * Return the designated default demo order (the one seeded with
   * {@link DEMO_ORDER_ID}), or `null` if it is somehow absent.
   *
   * The Chat_Interface preselects this order on default load (Req 1.10, 10.5).
   *
   * _Requirements: 1.10, 10.5_
   */
  function getDemoOrder(): Order | null {
    return getOrderById(DEMO_ORDER_ID);
  }

  return {
    getOrderById,
    getAllOrders,
    getOrdersByCustomerId,
    markRefunded,
    markReplaced,
    resetOrder,
    getDemoOrder,
  };
}

// ── Default singleton bound to the shared DB connection ──────────────────────

/**
 * Default order repository using the process-wide shared database.
 * Lazily accesses the connection so it is safe to import at module load time
 * before the database is initialized.
 */
export const orderRepository = {
  getOrderById: (id: string): Order | null =>
    createOrderRepository(getDb()).getOrderById(id),

  getAllOrders: (): Order[] =>
    createOrderRepository(getDb()).getAllOrders(),

  getOrdersByCustomerId: (customerId: string): Order[] =>
    createOrderRepository(getDb()).getOrdersByCustomerId(customerId),

  markRefunded: (orderId: string): void =>
    createOrderRepository(getDb()).markRefunded(orderId),

  markReplaced: (orderId: string): void =>
    createOrderRepository(getDb()).markReplaced(orderId),

  getDemoOrder: (): Order | null =>
    createOrderRepository(getDb()).getDemoOrder(),
};
