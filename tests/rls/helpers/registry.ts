/**
 * Per-module isolation registry. Every public table must be declared in a file
 * under tests/rls/tables/ (one file per module: identity.ts, people.ts, ...).
 * isolation.test.ts fails when a public table has no entry, so a new table
 * cannot ship without cross-organisation tests. Slices add their own module
 * file instead of editing a shared object literal.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Client, TenantUser } from "./supabase";

export interface SideContext {
  /** Secret-key client (bypasses RLS). */
  admin: Client;
  /** The tenant whose rows are wanted. */
  side: TenantUser;
}

export interface AttackContext {
  admin: Client;
  attacker: TenantUser;
  victim: TenantUser;
}

export interface TableSpec {
  /** Table name in schema public. */
  table: string;
  /** Column that identifies one row (usually the primary key). */
  key: string;
  /**
   * Column tying a row to its tenant. `organisation_id` for every business
   * table (CLAUDE.md rule 2).
   */
  tenantColumn: string;
  /** Value of `tenantColumn` for rows that belong to `side`. */
  tenantValue: (side: TenantUser) => string;
  /** Required, and only allowed, when the table has no organisation_id column. */
  noOrganisationIdReason?: string;
  /** Optional: create this table's rows for `side` with the admin client. */
  seed?: (ctx: SideContext) => Promise<void>;
  /** Returns the `key` value of one row that belongs to `side`. */
  rowOf: (ctx: SideContext) => Promise<string>;
  /** A plausible insert, aimed at the victim's tenant. Must be rejected. */
  attackInsert: (ctx: AttackContext) => Record<string, unknown>;
  /**
   * Columns a signed-in user may select, when the table grants only some (`clients`, slice 2.1:
   * the billing columns are read through `client_billing`). Defaults to `*`. Must include
   * `key` and `tenantColumn`.
   */
  selectColumns?: string;
  /** A harmless update patch. Must change nothing on the victim's row. */
  patch: Record<string, unknown>;
}

export async function loadRegistry(): Promise<TableSpec[]> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tables");
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .sort();

  const specs: TableSpec[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as {
      tables?: unknown;
    };
    if (!Array.isArray(mod.tables)) {
      throw new Error(`tests/rls/tables/${file} must export \`tables: TableSpec[]\`.`);
    }
    specs.push(...(mod.tables as TableSpec[]));
  }

  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.table)) {
      throw new Error(`Table ${spec.table} is declared twice in tests/rls/tables/.`);
    }
    seen.add(spec.table);
  }
  return specs;
}
