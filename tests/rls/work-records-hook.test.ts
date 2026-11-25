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
const WORK_RECORD_TABLES: readonly string[] = ["punches", "timesheet_lines", "payslips"];

/** Tables with a worker_id that are not work records, and why. */
const NOT_WORK_RECORDS: Record<string, string> = {
  bank_detail_changes: "bank-detail requests; nothing worked or paid",
  bank_account_lookups:
    "account name lookups from the bank network (slice 2.3b); nothing worked or paid",
  import_rows: "the import row that created the worker",
  inbox_items: "messages to the worker in the worker app (slice 3.1); nothing worked or paid",
  leave_decisions:
    "decisions on leave requests (slice 4.4); time off asked for, not work done or pay; Phase 5 pays from payroll lines",
  leave_ledger:
    "leave days granted, taken and adjusted (slice 4.4), keyed by the worker record, not the staff ID; nothing worked or paid",
  leave_requests:
    "time off a worker asks for (slice 4.4); approved leave days get no timesheet line, so nothing worked is recorded",
  memberships: "the worker's login",
  pay_rates: "rates of pay, not payments",
  payroll_adjustments:
    "earnings and deductions on a payroll run (slice 5.2); each is paid through a payslip, which is the work record",
  payroll_anomalies:
    "what looks wrong on a payroll run (slice 5.2); a flag about the worker, nothing worked or paid",
  payroll_nhf_numbers:
    "a worker's NHF number on file (slice 5.9a); a statutory detail, nothing worked or paid",
  payroll_opening_balances:
    "a worker's tax year before go-live (slice 5.9a), entered by HR; pay made outside the app, not a payslip",
  payroll_relief_declarations:
    "reliefs a worker declares for a tax year (slice 5.9a); tax inputs, nothing worked or paid",
  payroll_relief_proofs: "proof files of a relief declaration (slice 5.9a); nothing worked or paid",
  payroll_relief_verifications:
    "HR's check of a relief's proof (slice 5.9a); nothing worked or paid",
  payroll_run_workers:
    "the workers an off-cycle payroll run pays (slice 5.7b); each is paid through a payslip, which is the work record",
  payout_items:
    "a payslip's line in a bank file (slice 5.4); each hangs off a payslip, which is the work record",
  payout_supplement_items:
    "a left-out payslip's line in a supplementary bank file (slice 5.7c); each hangs off a payslip, which is the work record",
  payslip_sources:
    "what each payslip pays (slice 5.2); each hangs off a payslip, which is the work record",
  shift_assignments:
    "the roster (slice 3.2): planned shifts, not work done; punches (3.5) are the work records",
  staff_id_corrections: "the corrections themselves",
  staff_queries:
    "disciplinary and HR queries (slice 4.6): an HR record about the worker, kept by worker id, not staff ID; nothing worked or paid",
  timesheet_corrections:
    "corrections to a timesheet line (slice 4.2); each hangs off a line, which is the work record and is never deleted while a correction points at it",
  timesheet_decisions:
    "decisions on a timesheet line (slice 4.3); each hangs off a line, which is the work record and is never deleted once a decision points at it",
  work_units:
    "billable units made from approved timesheet lines (slice 4.3); each hangs off a line, which is the work record and is never deleted once decided",
  timesheets:
    "the pay-period container of a worker's timesheet lines (slice 4.2); the lines are the work records",
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
