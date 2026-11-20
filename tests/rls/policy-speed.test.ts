/**
 * Slice 3.1: row-level security checks the session once per statement (migration
 * 20261120110000). A policy that calls a security-definer helper with a row value runs it, and
 * private.session_trusted() inside it, once per row: on 100k rows that took minutes. This test
 * fails if a policy calls one of those helpers again. Write role checks as
 * `organisation_id in (select private.role_org_ids(array['owner', 'admin']))` instead of
 * `private.has_role(organisation_id, array[...])`, and wrap any other session helper in a
 * `(select ...)` or `in (select ...)` that takes no row value.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pgClient } from "./helpers/supabase";

const PER_ROW_HELPERS = [
  "has_role",
  "is_line_manager_for",
  "is_reportee",
  "manages_member",
  "session_trusted",
];

let db: pg.Client;

beforeAll(async () => {
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("policies run the session checks once per statement", () => {
  it("no public or storage policy calls a per-row session helper", async () => {
    const { rows } = await db.query<{ name: string; expr: string }>(
      `select schemaname || '.' || tablename || '.' || policyname as name,
              coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
       from pg_policies where schemaname in ('public', 'storage')`,
    );
    expect(rows.length).toBeGreaterThan(50);
    const pattern = new RegExp(`private\\.(${PER_ROW_HELPERS.join("|")})\\(`);
    const offenders = rows.filter((row) => pattern.test(row.expr)).map((row) => row.name);
    expect(offenders, "Use private.role_org_ids and the set helpers (see this file)").toEqual([]);
  });

  it("session_uid appears only as an uncorrelated subquery", async () => {
    const { rows } = await db.query<{ name: string; expr: string }>(
      `select schemaname || '.' || tablename || '.' || policyname as name,
              coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
       from pg_policies where schemaname in ('public', 'storage')`,
    );
    const bare = rows
      .filter((row) => /(?<!SELECT )private\.session_uid\(\)/.test(row.expr))
      .map((row) => row.name);
    expect(bare).toEqual([]);
  });
});
