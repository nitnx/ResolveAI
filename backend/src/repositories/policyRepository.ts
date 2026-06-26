/**
 * Policy repository — synchronous read access over the `policies` table.
 *
 * Provides lookups by primary key and a full-table scan helper used by the
 * Knowledge_Base to build its in-memory TF-IDF index at startup.
 *
 * All queries use the synchronous `better-sqlite3` API and map SQLite
 * snake_case column names to the TypeScript camelCase {@link PolicyPassage}
 * domain type.
 *
 * _Requirements: 12.8, 5.1_
 */

import type Database from 'better-sqlite3';
import type { PolicyCategory, PolicyPassage } from '../domain/types.js';
import { getDb } from '../data/db.js';

// ── Raw row shape returned by better-sqlite3 ──────────────────────────────────

interface PolicyRow {
  id: string;
  category: string;
  title: string;
  text: string;
}

// ── Row → domain type mapper ──────────────────────────────────────────────────

function rowToPolicy(row: PolicyRow): PolicyPassage {
  return {
    id: row.id,
    category: row.category as PolicyCategory,
    title: row.title,
    text: row.text,
  };
}

// ── Repository factory ────────────────────────────────────────────────────────

/**
 * Create a policy repository bound to `db`.
 * Accepts an explicit connection so callers (tests, DI) can provide an
 * in-memory database; production code should pass {@link getDb}().
 */
export function createPolicyRepository(db: Database.Database) {
  /**
   * Look up a single policy passage by its primary key.
   * Returns `null` when no matching row exists.
   */
  function getPolicyById(id: string): PolicyPassage | null {
    const row = db
      .prepare<[string], PolicyRow>(
        'SELECT id, category, title, text FROM policies WHERE id = ?',
      )
      .get(id);
    return row !== undefined ? rowToPolicy(row) : null;
  }

  /**
   * Return all policy passages in the table.
   *
   * Called by the Knowledge_Base at startup to build the in-memory TF-IDF
   * index over all seeded shipping, refund, replacement, and support policy
   * documents (Req 5.1).
   *
   * _Requirements: 5.1_
   */
  function getAllPolicies(): PolicyPassage[] {
    const rows = db
      .prepare<[], PolicyRow>(
        'SELECT id, category, title, text FROM policies',
      )
      .all();
    return rows.map(rowToPolicy);
  }

  return { getPolicyById, getAllPolicies };
}

// ── Default singleton bound to the shared DB connection ──────────────────────

/**
 * Default policy repository using the process-wide shared database.
 * Lazily accesses the connection so it is safe to import at module load time
 * before the database is initialized.
 */
export const policyRepository = {
  getPolicyById: (id: string): PolicyPassage | null =>
    createPolicyRepository(getDb()).getPolicyById(id),

  getAllPolicies: (): PolicyPassage[] =>
    createPolicyRepository(getDb()).getAllPolicies(),
};
