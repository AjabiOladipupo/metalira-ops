/**
 * Slice 3.1: row-level security checks the session once per statement (migration
 * 20261120110000). A policy that calls a security-definer helper with a row value runs it, and
 * private.session_trusted() inside it, once per row: on 100k rows that took minutes.
 *
 * Every `private.<fn>(` call in a public or storage policy must take one of these forms:
 * - `IN ( SELECT private.<set_fn>(<constants>) ...)`, `( SELECT private.<fn>() ...)` or
 *   `IN ( SELECT k.a, k.b FROM private.<set_fn>() k)`: an
 *   uncorrelated subquery Postgres runs once per statement. Its arguments may only be constants
 *   (`ARRAY['owner'::text, ...]`), never a column.
 * - a call to one of IMMUTABLE_HELPERS, pure functions of their arguments (the storage path
 *   parsers), which may take a column. The test checks they really are immutable and not
 *   security definer.
 * Write role checks as `organisation_id in (select private.role_org_ids(array['owner', 'admin']))`.
 *
 * A second, behavioural check counts calls to private.session_trusted while HR reads 1,000
 * workers: it must not grow with the rows.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminClient, createTenantUser, createTestUser, pgClient } from "./helpers/supabase";

const IMMUTABLE_HELPERS = new Set([
  "org_asset_org_id",
  "import_file_org_id",
  "contract_doc_org_id",
]);

/** Constant arguments only: nothing, or one array of text literals. */
const CONSTANT_ARGS = /^(ARRAY\['[a-z_]+'::text(, '[a-z_]+'::text)*\])?$/;

interface Call {
  name: string;
  args: string;
  wrapped: boolean;
}

/** Every private.<fn>(...) call in a policy expression, with its balanced argument text. */
function privateCalls(expr: string): Call[] {
  const calls: Call[] = [];
  const pattern = /private\.(\w+)\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(expr)) !== null) {
    let depth = 1;
    let i = pattern.lastIndex;
    for (; i < expr.length && depth > 0; i += 1) {
      if (expr[i] === "(") depth += 1;
      else if (expr[i] === ")") depth -= 1;
    }
    const before = expr.slice(Math.max(0, match.index - 10), match.index);
    calls.push({
      name: match[1]!,
      args: expr.slice(pattern.lastIndex, i - 1).trim(),
      // `( SELECT private.f(...)` or `FROM private.f(...) alias` inside a subquery.
      wrapped: /(\(\s*SELECT\s+|\sFROM\s+)$/.test(before),
    });
  }
  return calls;
}

const allowed = (call: Call) =>
  IMMUTABLE_HELPERS.has(call.name) || (call.wrapped && CONSTANT_ARGS.test(call.args));

let db: pg.Client;

beforeAll(async () => {
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("policies run the session checks once per statement", () => {
  it("calls private helpers only as uncorrelated subqueries or immutable path parsers", async () => {
    const { rows } = await db.query<{ name: string; expr: string }>(
      `select schemaname || '.' || tablename || '.' || policyname as name,
              coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
       from pg_policies where schemaname in ('public', 'storage')`,
    );
    expect(rows.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    let checked = 0;
    for (const row of rows) {
      for (const call of privateCalls(row.expr)) {
        checked += 1;
        if (!allowed(call)) offenders.push(`${row.name}: private.${call.name}(${call.args})`);
      }
    }
    expect(checked).toBeGreaterThan(80);
    expect(offenders, "Use private.role_org_ids and the set helpers (see this file)").toEqual([]);
  });

  it("scans only the caller's own companies in set helpers that read a business table", async () => {
    // Slice 4.6 (security review L1): private.my_staff_query_ids() reads staff_queries; it must
    // narrow to private.user_org_ids() before its role and reportee checks, and the replies
    // policy leads with the same narrowing.
    const { rows } = await db.query<{ src: string }>(
      "select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'my_staff_query_ids'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.src).toMatch(
      /where\s+q\.organisation_id\s+in\s+\(select private\.user_org_ids\(\)\)\s+and/,
    );
    const policy = await db.query<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'public' and tablename = 'staff_query_replies' and policyname = 'staff_query_replies_select'",
    );
    expect(policy.rows[0]!.qual).toMatch(
      /^\(\(organisation_id IN \( SELECT private\.user_org_ids\(\)/,
    );
  });

  it("allows column arguments only to immutable, non-definer helpers", async () => {
    const { rows } = await db.query<{ name: string; volatile: string; definer: boolean }>(
      `select p.proname as name, p.provolatile as volatile, p.prosecdef as definer
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and p.proname = any($1)`,
      [[...IMMUTABLE_HELPERS]],
    );
    expect(rows).toHaveLength(IMMUTABLE_HELPERS.size);
    for (const row of rows) expect(row, row.name).toMatchObject({ volatile: "i", definer: false });
  });

  it("flags the per-row forms", () => {
    for (const expr of [
      "private.has_role(organisation_id, ARRAY['owner'::text])",
      "(id IN ( SELECT private.my_worker_ids(organisation_id) AS x))",
      "private.is_reportee(worker_id)",
      "(user_id = private.session_uid())",
    ]) {
      expect(privateCalls(expr).every(allowed), expr).toBe(false);
    }
    const good =
      "((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'hr'::text]) AS r)) OR (user_id = ( SELECT private.session_uid() AS s)) OR (private.org_asset_org_id(name) IS NOT NULL))";
    expect(privateCalls(good)).toHaveLength(3);
    expect(privateCalls(good).every(allowed)).toBe(true);
  });

  it("calls session_trusted a handful of times however many rows HR reads", async () => {
    const owner = await createTenantUser("speed-owner", `Speed Co ${randomUUID().slice(0, 6)}`);
    const hr = await createTestUser("speed-hr");
    const added = await adminClient()
      .from("memberships")
      .insert({ organisation_id: owner.orgId, user_id: hr.id, role: "hr" });
    expect(added.error).toBeNull();
    await db.query(
      `insert into public.workers (organisation_id, staff_id, first_name, last_name, employment_type, start_date)
       select $1, 'SP-' || lpad(g::text, 5, '0'), 'Speed', 'Worker ' || g, 'permanent', '2025-01-06'
       from generate_series(1, 1000) g`,
      [owner.orgId],
    );
    const { data: session } = await hr.client.auth.getSession();
    const claims = JSON.parse(
      Buffer.from(session.session!.access_token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    /** Calls to private.session_trusted while `sql` runs as the HR user, and its count. */
    async function measure(sql: string): Promise<{ calls: number; rows: number }> {
      await db.query("begin");
      try {
        await db.query("set local track_functions = 'all'");
        await db.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(claims),
        ]);
        await db.query("set local role authenticated");
        const result = await db.query<{ n: string }>(sql, [owner.orgId]);
        await db.query("reset role");
        const { rows } = await db.query<{ calls: string }>(
          "select coalesce(pg_stat_get_xact_function_calls('private.session_trusted()'::regprocedure), 0) as calls",
        );
        return { calls: Number(rows[0]!.calls), rows: Number(result.rows[0]!.n) };
      } finally {
        await db.query("rollback");
      }
    }

    const policy = await measure(
      "select count(*) as n from public.workers where organisation_id = $1",
    );
    expect(policy.rows).toBe(1000);
    expect(policy.calls).toBeGreaterThan(0);
    expect(policy.calls).toBeLessThan(10);

    // The counter itself works: the old per-row form calls it once per row.
    const perRow = await measure(
      "select count(*) as n from public.workers where organisation_id = $1 and private.has_role(organisation_id, array['hr'])",
    );
    expect(perRow.rows).toBe(1000);
    expect(perRow.calls).toBeGreaterThanOrEqual(1000);
  }, 120_000);
});
