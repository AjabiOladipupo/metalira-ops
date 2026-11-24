/**
 * Slice 5.4: the bank file and release (docs/PHASE_5.md 5.4) against the real database.
 * - worker_bank_details_as_of returns the bank code, and the code a change replaces during its hold
 *   (previous_bank_code); its role check stays (owner, hr, finance, the secret key).
 * - payout_plan: owner and finance read it without ciphertext; only the secret key gets the
 *   encrypted numbers; hr and line managers are refused.
 * - make_payout_batch: owner or finance only; the stored file must be there with its size; the
 *   items must be the run's payslips with the details in force (amount, last 4 digits, bank code);
 *   a missing bank code and unacknowledged missing details are refused by name; acknowledged ones
 *   are left out; a second file needs a reason and voids the first; one active batch per run.
 * - The bucket refuses direct reads, lists and writes by every signed-in role and another company.
 * - payout_file_download: owner and finance, audited with the batch id only; a voided file
 *   doesn't open.
 * - release_payroll_run: owner or finance with an active file, never anyone who prepared or
 *   changed the run; approved -> released, with its decision; nothing changes after.
 * - Batches and items are insert-only (but the void), for the database owner too, replica mode and
 *   truncate included.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/db";

import { makeLookup } from "./helpers/bank-lookup";
import {
  approveRun,
  BANK,
  BUCKET,
  enc,
  giveBankDetails,
  makeBatch,
  NET,
  payAll,
  readPlan,
  seedSubmittedRun,
  storeFile,
  type PlanRow,
  type SeededPayrollRun,
} from "./helpers/payout";
import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type Role = Database["public"]["Enums"]["membership_role"];

const DENIED = "42501";

let admin: Client;
let db: pg.Client;

async function addMember(user: TestUser, role: Role, orgId: string) {
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  expect(error).toBeNull();
}

interface Company {
  owner: TenantUser;
  hr: TestUser;
  finance: TestUser;
  lineManager: TestUser;
}

async function company(label: string): Promise<Company> {
  const owner = await createTenantUser(`pout-${label}-owner`, `Payout ${label} Org`);
  const hr = await createTestUser(`pout-${label}-hr`);
  const finance = await createTestUser(`pout-${label}-fin`);
  const lineManager = await createTestUser(`pout-${label}-lm`);
  await addMember(hr, "hr", owner.orgId);
  await addMember(finance, "finance", owner.orgId);
  await addMember(lineManager, "line_manager", owner.orgId);
  return { owner, hr, finance, lineManager };
}

/** A company with an approved run (the owner prepared it, Finance approved it). */
async function approvedCompany(
  label: string,
  options: Parameters<typeof seedSubmittedRun>[2] = {},
): Promise<Company & { run: SeededPayrollRun }> {
  const c = await company(label);
  const run = await seedSubmittedRun(admin, c.owner, options);
  await approveRun(admin, c.owner.orgId, run.runId, c.finance);
  return { ...c, run };
}

/** As the database owner, optionally in replica mode, in its own transaction. */
async function asDbOwner(sql: string, params: unknown[], replica = false) {
  await db.query("begin");
  try {
    if (replica) await db.query("set local session_replication_role = replica");
    const result = await db.query(sql, params);
    await db.query("commit");
    return { error: null as null | { code?: string; message: string }, result };
  } catch (error) {
    await db.query("rollback");
    return { error: error as { code?: string; message: string }, result: null };
  }
}

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
});

afterAll(async () => {
  await db?.end();
});

describe("bank details as of a moment carry the bank code", () => {
  it("returns the code in force, and the replaced code during a change's hold", async () => {
    const c = await company("asof");
    const workerId = randomUUID();
    const { error } = await admin.from("workers").insert({
      id: workerId,
      organisation_id: c.owner.orgId,
      staff_id: "AS-0001",
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: "2025-01-06",
      ...BANK,
      bank_account_enc: enc(),
    });
    expect(error).toBeNull();
    const asOf = (client: Client, at = new Date()) =>
      client.rpc("worker_bank_details_as_of", {
        p_organisation_id: c.owner.orgId,
        p_worker_id: workerId,
        p_at: at.toISOString(),
      });
    const now = await asOf(c.finance.client);
    expect(now.error).toBeNull();
    expect(now.data?.[0]).toMatchObject({ bank_code: "058", bank_account_last4: "6789" });
    // The role check stays: hr reads it, a line manager is refused.
    expect((await asOf(c.hr.client)).error).toBeNull();
    expect((await asOf(c.lineManager.client)).error?.code).toBe(DENIED);

    // hr raises a change to another bank (code 044); finance approves; the hold begins.
    const lookup = await makeLookup(admin, {
      orgId: c.owner.orgId,
      userId: c.hr.id,
      purpose: "worker_bank",
      workerId,
      last4: "7712",
      bankCode: "044",
      accountName: "MUSA IBRAHIM",
    });
    const raised = await c.hr.client
      .from("bank_detail_changes")
      .insert({
        organisation_id: c.owner.orgId,
        worker_id: workerId,
        bank_name: "Access Bank",
        account_name: "MUSA IBRAHIM",
        bank_account_enc: enc(),
        bank_account_last4: "7712",
        reason: "Moved banks",
        bank_code: lookup.bankCode,
        bank_lookup_id: lookup.id,
        bank_account_digest: lookup.digest,
        name_check: "match",
      })
      .select("id, previous_bank_code")
      .single();
    expect(raised.error).toBeNull();
    expect(raised.data?.previous_bank_code).toBeNull();
    const decided = await c.finance.client
      .from("bank_detail_changes")
      .update({ status: "approved" })
      .eq("id", raised.data!.id)
      .select("previous_bank_code, applies_after")
      .single();
    expect(decided.error).toBeNull();
    expect(decided.data?.previous_bank_code).toBe("058");

    // During the hold the old account and its code are in force; after it, the new ones.
    const during = await asOf(c.finance.client);
    expect(during.data?.[0]).toMatchObject({ bank_code: "058", bank_account_last4: "6789" });
    const after = await asOf(
      c.finance.client,
      new Date(Date.parse(decided.data!.applies_after!) + 60_000),
    );
    expect(after.data?.[0]).toMatchObject({
      bank_code: "044",
      bank_account_last4: "7712",
      bank_detail_change_id: raised.data!.id,
    });
  });
});

describe("the plan", () => {
  let c: Company & { run: SeededPayrollRun };
  beforeAll(async () => {
    c = await approvedCompany("plan");
  });

  it("gives owner and finance each payslip with its details, never the ciphertext", async () => {
    for (const who of [c.finance.client, c.owner.client]) {
      const { data, error } = await readPlan(who, c.owner.orgId, c.run.runId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({
        payslip_id: c.run.workers[0]!.payslipId,
        net_kobo: String(NET),
        bank_code: "058",
        bank_account_last4: "6789",
        bank_account_enc: null,
        on_file: true,
        in_hold: false,
      });
    }
    const asked = await readPlan(c.finance.client, c.owner.orgId, c.run.runId, true);
    expect(asked.error?.code).toBe(DENIED);
    const server = await readPlan(admin, c.owner.orgId, c.run.runId, true);
    expect(server.error).toBeNull();
    expect(server.data![0]!.bank_account_enc).toMatch(/^\\x[0-9a-f]+$/);
  });

  it("refuses hr, line managers and another company", async () => {
    expect((await readPlan(c.hr.client, c.owner.orgId, c.run.runId)).error?.code).toBe(DENIED);
    expect((await readPlan(c.lineManager.client, c.owner.orgId, c.run.runId)).error?.code).toBe(
      DENIED,
    );
    const other = await createTenantUser("pout-plan-other", "Payout Other Org");
    expect((await readPlan(other.client, c.owner.orgId, c.run.runId)).error?.code).toBe(DENIED);
  });

  it("has nothing for a run not yet approved", async () => {
    const d = await company("plan-draft");
    const run = await seedSubmittedRun(admin, d.owner);
    expect((await readPlan(d.finance.client, d.owner.orgId, run.runId)).error?.code).toBe("MLBF5");
  });
});

describe("making the file", () => {
  it("refuses hr and line managers; finance makes it with control totals and masked items", async () => {
    const c = await approvedCompany("make");
    expect((await makeBatch(admin, c.hr.client, c.owner.orgId, c.run.runId)).error?.code).toBe(
      DENIED,
    );
    expect(
      (await makeBatch(admin, c.lineManager.client, c.owner.orgId, c.run.runId)).error?.code,
    ).toBe(DENIED);

    const made = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId);
    expect(made.error).toBeNull();
    expect(made.data).toMatchObject({
      batch_id: made.batchId,
      item_count: 1,
      total_kobo: String(NET),
      left_out_count: 0,
    });
    const { data: batch } = await c.hr.client
      .from("payout_batches")
      .select("status, item_count, total_kobo, file_path, file_sha256, made_by")
      .eq("id", made.batchId)
      .single();
    expect(batch).toEqual({
      status: "active",
      item_count: 1,
      total_kobo: NET,
      file_path: `${c.owner.orgId}/${c.run.runId}/${made.batchId}.csv`,
      file_sha256: "c".repeat(64),
      made_by: c.finance.id,
    });
    // The control totals equal the run's net total and count.
    const { data: run } = await admin
      .from("payroll_runs")
      .select("net_kobo, worker_count")
      .eq("id", c.run.runId)
      .single();
    expect(run).toEqual({ net_kobo: NET, worker_count: 1 });

    const { data: items } = await c.hr.client
      .from("payout_items")
      .select("*")
      .eq("batch_id", made.batchId);
    expect(items).toHaveLength(1);
    expect(items![0]).toMatchObject({
      status: "pending",
      amount_kobo: NET,
      bank_code: "058",
      bank_account_last4: "6789",
      position: 1,
    });
    // Never a number: no column holds more than the last 4 digits.
    expect(JSON.stringify(items)).not.toMatch(/\d{10}/);
    expect(Object.keys(items![0]!).filter((k) => /_enc$|account_number/.test(k))).toEqual([]);

    // Audited with control totals, never a number.
    const { data: audit } = await admin
      .from("audit_log")
      .select("after")
      .eq("organisation_id", c.owner.orgId)
      .eq("action", "payroll.bank_file_made")
      .eq("entity_id", made.batchId);
    expect(audit?.[0]?.after).toMatchObject({ item_count: 1, total_kobo: String(NET) });
  });

  it("needs the stored file at its path with its size", async () => {
    const c = await approvedCompany("store");
    const missing = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, {
      store: false,
    });
    expect(missing.error?.code).toBe("MLBF9");
    const size = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, {
      bytes: 3,
    });
    expect(size.error?.code).toBe("MLBF9");
  });

  it("refuses items that don't match the run and the details in force", async () => {
    const c = await approvedCompany("match");
    const tweak = (patch: Record<string, unknown>) => (plan: PlanRow[]) =>
      payAll(plan).map((i) => ({ ...i, ...patch }));
    for (const patch of [
      { amount_kobo: String(NET + 1) },
      { bank_account_last4: "0000" },
      { bank_code: "044" },
      { account_name: "SOMEONE ELSE" },
      { status: "left_out", left_out_reason: "nothing_to_pay" },
      { position: 2 },
    ]) {
      const r = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, {
        items: tweak(patch),
      });
      expect(r.error?.code, JSON.stringify(patch)).toBe("MLBF4");
    }
    const none = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, {
      items: () => [],
    });
    expect(none.error?.code).toBe("MLBF4");
    const { count } = await admin
      .from("payout_batches")
      .select("id", { count: "exact", head: true })
      .eq("run_id", c.run.runId);
    expect(count).toBe(0);
  });

  it("refuses a missing bank code and unacknowledged missing details, by name", async () => {
    const c = await approvedCompany("code", { names: ["Grace Edet"] });
    const workerId = c.run.workers[0]!.workerId;
    await giveBankDetails(admin, c.owner.orgId, workerId, { bank_code: null });
    const noCode = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId);
    expect(noCode.error?.code).toBe("MLBF3");
    expect(noCode.error?.message).toContain("Grace Edet");

    await giveBankDetails(admin, c.owner.orgId, workerId, {
      bank_name: null,
      account_name: null,
      bank_account_enc: null,
      bank_account_last4: null,
      bank_code: null,
    });
    const noDetails = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, {
      items: (plan) =>
        plan.map((r, i) => ({
          payslip_id: r.payslip_id,
          position: i + 1,
          status: "left_out",
          left_out_reason: "no_bank_details",
          amount_kobo: "0",
        })),
    });
    expect(noDetails.error?.code).toBe("MLBF2");
    expect(noDetails.error?.message).toContain("Grace Edet");
  });

  it("leaves out a worker HR acknowledged as having no bank details", async () => {
    const c = await approvedCompany("left", {
      count: 2,
      names: ["Musa Ibrahim", "Ada Obi"],
      anomalies: (ids) => [
        { worker_id: ids[1], code: "bank_missing", severity: "warning", detail: {} },
      ],
    });
    const ada = c.run.workers[1]!;
    await giveBankDetails(admin, c.owner.orgId, ada.workerId, {
      bank_name: null,
      account_name: null,
      bank_account_enc: null,
      bank_account_last4: null,
      bank_code: null,
    });
    const items = (plan: PlanRow[]) => {
      const paid = plan.filter((r) => r.payslip_id !== ada.payslipId);
      return [
        ...payAll(paid),
        {
          payslip_id: ada.payslipId,
          position: paid.length + 1,
          status: "left_out",
          left_out_reason: "no_bank_details",
          amount_kobo: "0",
        },
      ];
    };
    const made = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, { items });
    expect(made.error).toBeNull();
    expect(made.data).toMatchObject({ item_count: 1, left_out_count: 1, total_kobo: String(NET) });
    const { data: left } = await c.finance.client
      .from("payout_items")
      .select("status, left_out_reason, amount_kobo, bank_account_last4")
      .eq("payslip_id", ada.payslipId)
      .single();
    expect(left).toEqual({
      status: "left_out",
      left_out_reason: "no_bank_details",
      amount_kobo: 0,
      bank_account_last4: null,
    });
  });

  it("keeps one active file per run: a new one needs a reason and voids the old", async () => {
    const c = await approvedCompany("void");
    const first = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId);
    expect(first.error).toBeNull();
    const noReason = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId);
    expect(noReason.error?.code).toBe("MLBF6");
    const badReason = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, {
      voidReason: "Account 0123456789 was wrong",
    });
    expect(badReason.error?.code).toBe("22023");
    const second = await makeBatch(admin, c.owner.client, c.owner.orgId, c.run.runId, {
      voidReason: "The bank asked for a new upload",
    });
    expect(second.error).toBeNull();
    const { data: batches } = await admin
      .from("payout_batches")
      .select("id, status, void_reason, voided_by")
      .eq("run_id", c.run.runId)
      .order("created_at");
    expect(batches).toEqual([
      {
        id: first.batchId,
        status: "voided",
        void_reason: "The bank asked for a new upload",
        voided_by: c.owner.id,
      },
      { id: second.batchId, status: "active", void_reason: null, voided_by: null },
    ]);
    const { data: oldItems } = await admin
      .from("payout_items")
      .select("status")
      .eq("batch_id", first.batchId);
    expect(oldItems).toEqual([{ status: "voided" }]);

    // A second active batch can't exist, even for the database owner.
    const dup = await asDbOwner(
      `update public.payout_batches set status = 'active', voided_at = null, voided_by = null,
         void_reason = null where id = $1`,
      [first.batchId],
    );
    expect(dup.error).not.toBeNull();

    // A voided file doesn't open.
    const old = await c.finance.client.rpc("payout_file_download", {
      p_organisation_id: c.owner.orgId,
      p_batch_id: first.batchId,
    });
    expect(old.error?.code).toBe("MLBF5");
  });
});

describe("the bucket and downloads", () => {
  let c: Company & { run: SeededPayrollRun };
  let path: string;
  let batchId: string;
  beforeAll(async () => {
    c = await approvedCompany("bucket");
    const made = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId);
    expect(made.error).toBeNull();
    path = made.path;
    batchId = made.batchId;
  });

  it("refuses direct reads, lists, signed links and writes by every signed-in role", async () => {
    const other = await createTenantUser("pout-bucket-other", "Payout Bucket Other");
    for (const who of [c.owner, c.finance, c.hr, c.lineManager, other]) {
      const bucket = who.client.storage.from(BUCKET);
      expect((await bucket.download(path)).data).toBeNull();
      expect((await bucket.createSignedUrl(path, 60)).data).toBeNull();
      const listed = await bucket.list(`${c.owner.orgId}/${c.run.runId}`);
      expect(listed.data ?? []).toEqual([]);
      expect(
        (await bucket.upload(`${c.owner.orgId}/${c.run.runId}/${randomUUID()}.csv`, "a,b\r\n"))
          .error,
      ).not.toBeNull();
      expect((await bucket.remove([path])).data ?? []).toEqual([]);
    }
    // The file is still there for the server.
    expect((await admin.storage.from(BUCKET).download(path)).data).not.toBeNull();
    // Another company's path is no different for its owner.
    const theirs = await storeFile(admin, other.orgId, randomUUID(), randomUUID());
    expect((await c.owner.client.storage.from(BUCKET).download(theirs.path)).data).toBeNull();
  });

  it("gives owner and finance the path, audited with the batch id only; refuses hr", async () => {
    for (const who of [c.finance, c.owner]) {
      const { data, error } = await who.client.rpc("payout_file_download", {
        p_organisation_id: c.owner.orgId,
        p_batch_id: batchId,
      });
      expect(error).toBeNull();
      expect(data).toBe(path);
    }
    for (const who of [c.hr, c.lineManager]) {
      const { error } = await who.client.rpc("payout_file_download", {
        p_organisation_id: c.owner.orgId,
        p_batch_id: batchId,
      });
      expect(error?.code).toBe(DENIED);
    }
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, entity, entity_id, before, after")
      .eq("organisation_id", c.owner.orgId)
      .eq("action", "payroll.bank_file_downloaded")
      .order("at");
    expect(audit).toEqual([
      {
        actor_id: c.finance.id,
        entity: "payout_batches",
        entity_id: batchId,
        before: null,
        after: { batch_id: batchId },
      },
      {
        actor_id: c.owner.id,
        entity: "payout_batches",
        entity_id: batchId,
        before: null,
        after: { batch_id: batchId },
      },
    ]);
  });
});

describe("release", () => {
  it("needs owner or finance, a file, and someone who didn't prepare the run", async () => {
    const c = await approvedCompany("release");
    const release = (client: Client) =>
      client.rpc("release_payroll_run", {
        p_organisation_id: c.owner.orgId,
        p_run_id: c.run.runId,
      });

    expect((await release(c.finance.client)).error?.code).toBe("MLBF7");
    expect((await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId)).error).toBeNull();

    expect((await release(c.hr.client)).error?.code).toBe(DENIED);
    expect((await release(c.lineManager.client)).error?.code).toBe(DENIED);
    // The owner prepared, acknowledged and submitted the run.
    const own = await release(c.owner.client);
    expect(own.error?.code).toBe("MLBF8");
    expect(own.error?.message).toContain("a different person must release it");

    const done = await release(c.finance.client);
    expect(done.error).toBeNull();
    const { data: run } = await admin
      .from("payroll_runs")
      .select("status, released_by, released_at")
      .eq("id", c.run.runId)
      .single();
    expect(run).toMatchObject({ status: "released", released_by: c.finance.id });
    expect(run?.released_at).not.toBeNull();
    const { data: decision } = await admin
      .from("payroll_run_decisions")
      .select("id, decision, actor_id, net_kobo")
      .eq("run_id", c.run.runId)
      .eq("decision", "released")
      .single();
    expect(decision).toEqual({
      id: done.data,
      decision: "released",
      actor_id: c.finance.id,
      net_kobo: NET,
    });

    // Once released: no second release, no new file, nothing changes.
    expect((await release(c.finance.client)).error?.code).toBe("MLBF5");
    const again = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId, {
      voidReason: "Too late",
    });
    expect(again.error?.code).toBe("MLBF5");
    const edit = await asDbOwner(
      "update public.payroll_runs set net_kobo = net_kobo where id = $1",
      [c.run.runId],
      true,
    );
    expect(edit.error?.code).toBe("MLPRD");
    const voidAfter = await asDbOwner(
      `update public.payout_batches set status = 'voided', voided_by = $2, void_reason = 'x'
       where run_id = $1`,
      [c.run.runId, c.finance.id],
      true,
    );
    expect(voidAfter.error?.code).toBe("MLBF5");
  });

  it("keeps the releaser apart from the preparer in SQL, and a release changes nothing else", async () => {
    const c = await approvedCompany("release-owner");
    expect((await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId)).error).toBeNull();
    // A preparer can't be written in as the releaser, even by the database owner.
    const forged = await asDbOwner(
      `update public.payroll_runs set status = 'released', released_at = now(), released_by = prepared_by
       where id = $1`,
      [c.run.runId],
    );
    expect(forged.error?.code).toBe("23514");
    // A release that changes anything else is refused by the guard.
    const sneaky = await asDbOwner(
      `update public.payroll_runs set status = 'released', released_at = now(), released_by = $2,
         net_kobo = net_kobo + 1, gross_kobo = gross_kobo + 1, employer_cost_kobo = employer_cost_kobo + 1
       where id = $1`,
      [c.run.runId, c.finance.id],
      true,
    );
    expect(sneaky.error?.code).toBe("MLPRD");
  });
});

describe("batches and items are kept as written", () => {
  let c: Company & { run: SeededPayrollRun };
  let batchId: string;
  beforeAll(async () => {
    c = await approvedCompany("keep");
    const made = await makeBatch(admin, c.finance.client, c.owner.orgId, c.run.runId);
    expect(made.error).toBeNull();
    batchId = made.batchId;
  });

  it("refuses signed-in writes", async () => {
    for (const who of [c.owner, c.finance]) {
      const ins = await who.client.from("payout_batches").insert({
        organisation_id: c.owner.orgId,
        run_id: c.run.runId,
        bank_format: "generic-csv",
        file_path: "x",
        file_sha256: "c".repeat(64),
        file_bytes: 1,
        item_count: 1,
        total_kobo: 1,
        left_out_count: 0,
        left_out_kobo: 0,
        made_by: who.id,
      });
      expect(ins.error?.code).toBe(DENIED);
      const upd = await who.client
        .from("payout_items")
        .update({ amount_kobo: 1 })
        .eq("batch_id", batchId)
        .select("id");
      expect(upd.error?.code).toBe(DENIED);
    }
  });

  it("refuses the database owner, in replica mode too, and truncate", async () => {
    for (const replica of [false, true]) {
      const items = await asDbOwner(
        "update public.payout_items set amount_kobo = amount_kobo + 1 where batch_id = $1",
        [batchId],
        replica,
      );
      expect(items.error?.code).toBe("MLBF5");
      const gone = await asDbOwner(
        "delete from public.payout_items where batch_id = $1",
        [batchId],
        replica,
      );
      expect(gone.error?.code).toBe("MLBF5");
      const batch = await asDbOwner(
        "update public.payout_batches set total_kobo = total_kobo + 1 where id = $1",
        [batchId],
        replica,
      );
      expect(batch.error?.code).toBe("MLBF5");
      const del = await asDbOwner(
        "delete from public.payout_batches where id = $1",
        [batchId],
        replica,
      );
      expect(del.error?.code).toBe("MLBF5");
      const late = await asDbOwner(
        `insert into public.payout_items (organisation_id, batch_id, run_id, payslip_id, worker_id,
           position, status, left_out_reason, amount_kobo)
         values ($1, $2, $3, $4, $5, 9, 'left_out', 'nothing_to_pay', 0)`,
        [
          c.owner.orgId,
          batchId,
          c.run.runId,
          c.run.workers[0]!.payslipId,
          c.run.workers[0]!.workerId,
        ],
        replica,
      );
      expect(late.error?.code).toBe("MLBF5");
    }
    for (const table of ["payout_items", "payout_batches"]) {
      const t = await asDbOwner(`truncate public.${table} cascade`, []);
      expect(t.error?.code).toBe("MLPRD");
    }
  });
});
