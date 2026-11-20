/**
 * Slice 1.11 (owner decision 19): a staff ID can be corrected only while the worker has no
 * punches, timesheets or pay records, which private.worker_has_work_records decides. This test
 * lists every public table with a worker_id column and fails when a new one appears until it is
 * declared here: as a work record (and handled in the hook) or as not one. Each later phase that
 * adds clock-ins, timesheets, payroll lines or payslips must replace the hook with a real check
 * of its table, using a foreign key to workers so an insert can't race an approval (see the
 * function's comment in migration 20261117180000).
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pgClient } from "./helpers/supabase";

/** Tables that record work or pay under the worker's staff ID: checked by the hook. */
const WORK_RECORD_TABLES: readonly string[] = [];

/** Tables with a worker_id that are not work records, and why. */
const NOT_WORK_RECORDS: Record<string, string> = {
  bank_detail_changes: "bank-detail requests; nothing worked or paid",
  bank_account_lookups:
    "account name lookups from the bank network (slice 2.3b); nothing worked or paid",
  import_rows: "the import row that created the worker",
  inbox_items: "messages to the worker in the worker app (slice 3.1); nothing worked or paid",
  memberships: "the worker's login",
  pay_rates: "rates of pay, not payments",
  shift_assignments:
    "the roster (slice 3.2): planned shifts, not work done; punches (3.5) are the work records",
  staff_id_corrections: "the corrections themselves",
  worker_assignments: "mapping to clients, sites and projects",
  worker_change_requests: "profile change requests from the worker app",
  worker_consents:
    "location and selfie consents (slice 3.1); the punches they allow are the work records",
  worker_credentials: "the phone login",
  worker_invites: "invite links",
};

let db: pg.Client;

beforeAll(async () => {
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("work records and staff ID corrections", () => {
  it("every public table with a worker_id is declared a work record or not", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select distinct c.table_name
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and c.column_name = 'worker_id'
         and t.table_type = 'BASE TABLE'
       order by 1`,
    );
    const declared = new Set([...WORK_RECORD_TABLES, ...Object.keys(NOT_WORK_RECORDS)]);
    const undeclared = rows.map((r) => r.table_name).filter((name) => !declared.has(name));
    expect(
      undeclared,
      "Declare each in tests/rls/work-records-hook.test.ts; a work record also needs a check in private.worker_has_work_records",
    ).toEqual([]);
  });

  it("the hook names every work-record table", async () => {
    const { rows } = await db.query<{ src: string }>(
      "select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'worker_has_work_records'",
    );
    for (const table of WORK_RECORD_TABLES) {
      expect(rows[0]!.src, table).toContain(`public.${table}`);
    }
  });
});
