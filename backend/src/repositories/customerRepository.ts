/**
 * Customer repository — synchronous read access over the `customers` table.
 *
 * Provides lookups by primary key and a full-table scan helper. All queries
 * use the synchronous `better-sqlite3` API and map SQLite snake_case column
 * names to the TypeScript camelCase {@link Customer} domain type.
 *
 * _Requirements: 12.8, 6.1_
 */

import type Database from 'better-sqlite3';
import type { Customer } from '../domain/types.js';
import { getDb } from '../data/db.js';

// ── Raw row shape returned by better-sqlite3 ──────────────────────────────────

interface CustomerRow {
  id: string;
  name: string;
  email: string;
}

// ── Row → domain type mapper ──────────────────────────────────────────────────

function rowToCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
  };
}

// ── Repository factory ────────────────────────────────────────────────────────

/**
 * Create a customer repository bound to `db`.
 * Accepts an explicit connection so callers (tests, DI) can provide an
 * in-memory database; production code should pass {@link getDb}().
 */
export function createCustomerRepository(db: Database.Database) {
  /**
   * Look up a single customer by their primary key.
   * Returns `null` when no matching row exists.
   *
   * _Requirements: 6.1_
   */
  function getCustomerById(id: string): Customer | null {
    const row = db
      .prepare<[string], CustomerRow>('SELECT id, name, email FROM customers WHERE id = ?')
      .get(id);
    return row !== undefined ? rowToCustomer(row) : null;
  }

  /**
   * Return every customer in the table (no ordering guarantee).
   */
  function getAllCustomers(): Customer[] {
    const rows = db
      .prepare<[], CustomerRow>('SELECT id, name, email FROM customers')
      .all();
    return rows.map(rowToCustomer);
  }

  return { getCustomerById, getAllCustomers };
}

// ── Default singleton bound to the shared DB connection ──────────────────────

/**
 * Default customer repository using the process-wide shared database.
 * Lazily accesses the connection so it is safe to import at module load time
 * before the database is initialized.
 */
export const customerRepository = {
  getCustomerById: (id: string): Customer | null =>
    createCustomerRepository(getDb()).getCustomerById(id),

  getAllCustomers: (): Customer[] =>
    createCustomerRepository(getDb()).getAllCustomers(),
};
