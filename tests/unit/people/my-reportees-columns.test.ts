/**
 * Slice 4.0: the column snapshot of public.my_reportees (the line manager's read of their
 * reportees). src/types/db.ts is generated from the migrations and CI checks it matches, so this
 * fails as soon as a column is added to the read. tests/rls/my-reportees.test.ts checks the
 * same list against the live database. Adding a column is a security decision: never an _enc
 * or _last4 column, bank, account, TIN, tax, PFA, NHF, rent, pay or next of kin.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SAFE_COLUMNS = [
  "department_id",
  "department_name",
  "email",
  "employment_type",
  "end_date",
  "first_name",
  "id",
  "job_title",
  "last_name",
  "line_manager_membership_id",
  "line_manager_name",
  "line_manager_worker_id",
  "phone",
  "site_ids",
  "site_names",
  "staff_id",
  "start_date",
  "status",
  "supervisor_clock_in",
  "usual_work_days",
];

const SENSITIVE =
  /(_enc|_last4|bank|account|tin|tax|pfa|nhf|rent|kobo|pay|rate|next_of_kin|nin|rsa|bvn|salary)/;

function returnedColumns(): string[] {
  const types = readFileSync(join(process.cwd(), "src/types/db.ts"), "utf8");
  const match = /"my_reportees":\s*\{\s*Args:[^;]*;\s*Returns:\s*\{([\s\S]*?)\}\[\]/.exec(types);
  if (!match) throw new Error("my_reportees is missing from src/types/db.ts");
  return [...match[1]!.matchAll(/"([a-z_0-9]+)"\s*:/g)].map((m) => m[1]!).sort();
}

describe("my_reportees columns", () => {
  it("returns exactly the safe columns", () => {
    expect(returnedColumns()).toEqual(SAFE_COLUMNS);
  });

  it("returns nothing that looks like pay, bank, tax or identity numbers", () => {
    expect(returnedColumns().filter((c) => SENSITIVE.test(c))).toEqual([]);
  });
});
