/**
 * Slice 5.5: payslips in the worker app, their PDFs and notices (docs/PHASE_5.md 5.5) against the
 * real database.
 * - A worker reads only their own payslips of RELEASED runs (my_payslips): a draft, a run in
 *   review and an approved run not released yet are invisible; another worker sees nothing of
 *   theirs; managers' roles don't make my_payslips show anyone else's.
 * - Year to date sums posted payslips of the calendar year up to the payslip's pay date (bigint).
 * - payslip_documents: only the secret key records one, only for a released run and only when
 *   the file is in the bucket; insert-only for everyone, the database owner included, even with
 *   session_replication_role = replica; no truncate.
 * - The private bucket: no signed-in role reads, lists, signs or writes its objects directly.
 * - open_payslip_document: the worker their own released payslip; owner, hr and finance any;
 *   a line manager or another company never; each yes audited with ids only.
 * - Release notices: one per payslip, only to its worker, only once released.
 *
 * Runs are posted through the real functions (helpers/payslips.ts); release is marked as the
 * database owner until slice 5.4's release_payroll_run lands (TODO(5.4)).
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addPayrollWorker } from "./helpers/payroll";
import {
  approveRun,
  FAKE_PDF,
  markReleased,
  recordDocument,
  submitRunFor,
} from "./helpers/payslips";
import {
  adminClient,
  createTenantUser,
  createTestUser,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

type View = {
  payslip_id: string;
  run_id: string;
  run_status: string;
  gross_kobo: string;
  paye_kobo: string;
  net_kobo: string;
  pension_employee_kobo: string;
  pay_date: string;
  worker: Record<string, unknown>;
  lines: { code: string; amount_kobo: string }[];
  year_to_date: Record<string, string | number>;
  document: { id: string } | null;
};

let admin: Client;
let db: pg.Client;
let owner: TenantUser;
let outsider: TenantUser;
let hr: TestUser;
let finance: TestUser;
let lineManager: TestUser;
let musaUser: TestUser;
let graceUser: TestUser;
let musa: { workerId: string; payRateId: string };
let grace: { workerId: string; payRateId: string };
/** August (pay date 25 Sep) and September (25 Oct) released; October approved; November draft. */
let augRun: string;
let sepRun: string;
let octRun: string;
let novRun: string;

async function addMember(user: TestUser, role: string, orgId: string, workerId?: string) {
  const { error } = await admin.from("memberships").insert({
    organisation_id: orgId,
    user_id: user.id,
    role: role as "owner",
    worker_id: workerId ?? null,
  });
  expect(error).toBeNull();
}

async function slipOf(runId: string, workerId: string): Promise<string> {
  const { data, error } = await admin
    .from("payslips")
    .select("id")
    .eq("run_id", runId)
    .eq("worker_id", workerId)
    .single();
  expect(error).toBeNull();
  return data!.id;
}

const mine = async (client: Client, orgId = owner.orgId) =>
  client.rpc("my_payslips", { p_organisation_id: orgId });

const open = (client: Client, payslipId: string, orgId = owner.orgId) =>
  client.rpc("open_payslip_document", { p_organisation_id: orgId, p_payslip_id: payslipId });

beforeAll(async () => {
  admin = adminClient();
  db = await pgClient();
  owner = await createTenantUser("pslip-owner", "Payslips Org");
  outsider = await createTenantUser("pslip-outsider", "Payslips Other Org");
  hr = await createTestUser("pslip-hr");
  finance = await createTestUser("pslip-finance");
  lineManager = await createTestUser("pslip-lm");
  musaUser = await createTestUser("pslip-musa");
  graceUser = await createTestUser("pslip-grace");
  await addMember(hr, "hr", owner.orgId);
  await addMember(finance, "finance", owner.orgId);
  await addMember(lineManager, "line_manager", owner.orgId);
  musa = await addPayrollWorker(admin, owner.orgId, {
    pfa_name: "Stanbic IBTC Pension",
    bank_name: "GTBank",
  });
  grace = await addPayrollWorker(admin, owner.orgId, { first_name: "Grace", last_name: "Edet" });
  await addMember(musaUser, "worker", owner.orgId, musa.workerId);
  await addMember(graceUser, "worker", owner.orgId, grace.workerId);

  // The owner prepares; Finance approves; release is marked (TODO(5.4)).
  augRun = await submitRunFor(admin, owner, musa, "2026-08-20");
  await approveRun(admin, owner.orgId, augRun, finance);
  await markReleased(db, augRun, finance.id);
  sepRun = await submitRunFor(admin, owner, musa, "2026-09-20");
  await approveRun(admin, owner.orgId, sepRun, finance);
  await markReleased(db, sepRun, finance.id);
  // October pays early (21 Oct, before September's 25 Oct) and stays approved, not released:
  // its figures must not show through September's year to date.
  octRun = await submitRunFor(admin, owner, musa, "2026-10-20", "2026-10-21");
  await approveRun(admin, owner.orgId, octRun, finance);
  const created = await owner.client.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: "2026-11-20",
  });
  expect(created.error).toBeNull();
  novRun = created.data!;
});

afterAll(async () => {
  await db?.end();
});

describe("a worker reads only their own released payslips", () => {
  it("lists Musa's released payslips, newest first, with the figures in kobo", async () => {
    const { data, error } = await mine(musaUser.client);
    expect(error).toBeNull();
    const list = data as unknown as View[];
    expect(list.map((v) => v.run_id)).toEqual([sepRun, augRun]);
    const sep = list[0]!;
    expect(sep.run_status).toBe("released");
    expect(sep.pay_date).toBe("2026-10-25");
    expect(sep.gross_kobo).toBe("12000000");
    expect(sep.paye_kobo).toBe("100000");
    expect(sep.pension_employee_kobo).toBe("960000");
    expect(sep.net_kobo).toBe("10940000");
    expect(sep.lines.map((l) => l.code)).toEqual([
      "basic",
      "housing",
      "transport",
      "paye",
      "pension_employee",
      "pension_employer",
      "nsitf",
    ]);
    // Masked data only: last 4 digits (none on file here), never encrypted values or a TIN.
    expect(Object.keys(sep.worker).sort()).toEqual([
      "bank_account_last4",
      "bank_name",
      "first_name",
      "job_title",
      "last_name",
      "rsa_pin_last4",
      "staff_id",
    ]);
    expect(JSON.stringify(data)).not.toMatch(
      /_enc"|"tin"|"nin"|"bvn"|prepared_by|approved_by|submitted_by|calculated_by/i,
    );
  });

  it("sums the year to date from posted payslips up to the pay date, in bigint", async () => {
    const { data } = await mine(musaUser.client);
    const [sep, aug] = data as unknown as View[];
    // August's payslip (25 Sep) counts itself; September's (25 Oct) counts both, and not
    // October's approved-but-unreleased payslip dated 21 Oct.
    expect(aug!.year_to_date).toMatchObject({
      year: 2026,
      payslips: 1,
      gross_kobo: "12000000",
      paye_kobo: "100000",
      pension_employee_kobo: "960000",
      net_kobo: "10940000",
    });
    expect(sep!.year_to_date).toMatchObject({
      year: 2026,
      payslips: 2,
      gross_kobo: "24000000",
      paye_kobo: "200000",
      pension_employee_kobo: "1920000",
      net_kobo: "21880000",
    });
  });

  it("never shows a draft, a run in review or an approved run not released", async () => {
    const { data } = await mine(musaUser.client);
    const runs = (data as unknown as View[]).map((v) => v.run_id);
    expect(runs).not.toContain(octRun);
    expect(runs).not.toContain(novRun);
    // And the tables themselves stay closed to workers (5.2's RLS).
    const direct = await musaUser.client
      .from("payslips")
      .select("id")
      .eq("organisation_id", owner.orgId);
    expect(direct.error).toBeNull();
    expect(direct.data).toEqual([]);
    const docs = await musaUser.client.from("payslip_documents").select("id");
    expect(docs.data).toEqual([]);
  });

  it("gives another worker, managers and other companies nothing of Musa's", async () => {
    const graceList = await mine(graceUser.client);
    expect(graceList.error).toBeNull();
    expect(graceList.data).toEqual([]);
    // Managers aren't workers: my_payslips refuses them (no worker record of their own).
    for (const user of [hr, finance, lineManager]) {
      expect((await mine(user.client)).error?.code).toBe("42501");
    }
    expect((await mine(owner.client)).error?.code).toBe("42501");
    // Musa asking about another company gets nothing.
    expect((await mine(musaUser.client, outsider.orgId)).error?.code).toBe("42501");
  });
});

describe("payslip documents", () => {
  let augSlip: string;
  let sepSlip: string;
  let octSlip: string;
  let docId: string;

  beforeAll(async () => {
    augSlip = await slipOf(augRun, musa.workerId);
    sepSlip = await slipOf(sepRun, musa.workerId);
    octSlip = await slipOf(octRun, musa.workerId);
  });

  it("refuses to open a PDF before it is made (MLPD3), and before release (MLPD2)", async () => {
    expect((await open(musaUser.client, sepSlip)).error?.code).toBe("MLPD3");
    expect((await open(finance.client, sepSlip)).error?.code).toBe("MLPD3");
    expect((await open(finance.client, octSlip)).error?.code).toBe("MLPD2");
    // The worker's own approved-but-unreleased payslip is as if it weren't there.
    expect((await open(musaUser.client, octSlip)).error?.code).toBe("P0002");
  });

  it("records a PDF only with the secret key, for a released run, with its file in place", async () => {
    // Signed-in users can't record one.
    for (const client of [owner.client, finance.client, musaUser.client]) {
      const { error } = await client.rpc("record_payslip_document", {
        p_organisation_id: owner.orgId,
        p_payslip_id: sepSlip,
        p_actor: owner.id,
        p_sha256: "c".repeat(64),
        p_size_bytes: 10,
      });
      expect(error?.code).toBe("42501");
    }
    // No file in the bucket yet: refused.
    const missing = await admin.rpc("record_payslip_document", {
      p_organisation_id: owner.orgId,
      p_payslip_id: augSlip,
      p_actor: finance.id,
      p_sha256: "c".repeat(64),
      p_size_bytes: 10,
    });
    expect(missing.error?.code).toBe("MLPD4");
    // Not released: refused.
    const early = await admin.rpc("record_payslip_document", {
      p_organisation_id: owner.orgId,
      p_payslip_id: octSlip,
      p_actor: finance.id,
      p_sha256: "c".repeat(64),
      p_size_bytes: 10,
    });
    expect(early.error?.code).toBe("MLPD2");
    // Signed-in users can't insert rows directly either.
    const direct = await owner.client.from("payslip_documents").insert({
      organisation_id: owner.orgId,
      payslip_id: sepSlip,
      run_id: sepRun,
      storage_path: `${owner.orgId}/${sepRun}/${sepSlip}.pdf`,
      sha256: "c".repeat(64),
      size_bytes: 10,
    });
    expect(direct.error?.code).toBe("42501");

    docId = await recordDocument(admin, owner.orgId, sepRun, sepSlip, finance.id);
    // Recording the same file again (a second publish running together) adds nothing.
    const again = await admin.rpc("record_payslip_document", {
      p_organisation_id: owner.orgId,
      p_payslip_id: sepSlip,
      p_actor: finance.id,
      p_sha256: "c".repeat(64),
      p_size_bytes: FAKE_PDF.length,
    });
    expect(again.error).toBeNull();
    expect(again.data).toBe(docId);
    const { count } = await admin
      .from("payslip_documents")
      .select("id", { count: "exact", head: true })
      .eq("payslip_id", sepSlip);
    expect(count).toBe(1);
    const { data: row } = await admin
      .from("payslip_documents")
      .select("storage_path, made_by, run_id")
      .eq("id", docId)
      .single();
    expect(row).toEqual({
      storage_path: `${owner.orgId}/${sepRun}/${sepSlip}.pdf`,
      made_by: finance.id,
      run_id: sepRun,
    });
    const { data: audit } = await admin
      .from("audit_log")
      .select("action, after")
      .eq("entity_id", sepSlip)
      .eq("action", "payroll.payslip_pdf_made");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(".pdf");
  });

  it("keeps documents as written for every role, the database owner included", async () => {
    // The secret key has no write grant; the database owner meets the guards.
    const upd = await admin.from("payslip_documents").update({ size_bytes: 99 }).eq("id", docId);
    expect(upd.error?.code).toBe("42501");
    const del = await admin.from("payslip_documents").delete().eq("id", docId);
    expect(del.error?.code).toBe("42501");
    for (const sql of [
      "update public.payslip_documents set size_bytes = 99 where id = $1",
      "delete from public.payslip_documents where id = $1",
    ]) {
      await expect(db.query(sql, [docId])).rejects.toMatchObject({ code: "MLPD1" });
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        await expect(db.query(sql, [docId])).rejects.toMatchObject({ code: "MLPD1" });
      } finally {
        await db.query("rollback");
      }
    }
    await expect(db.query("truncate public.payslip_documents")).rejects.toMatchObject({
      code: "MLPD1",
    });
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await expect(db.query("truncate public.payslip_documents")).rejects.toMatchObject({
        code: "MLPD1",
      });
    } finally {
      await db.query("rollback");
    }
  });

  it("opens the worker's own released PDF and audits it with ids only", async () => {
    const { data, error } = await open(musaUser.client, sepSlip);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      document_id: docId,
      storage_path: `${owner.orgId}/${sepRun}/${sepSlip}.pdf`,
      period_end: "2026-10-19",
      pay_date: "2026-10-25",
    });
    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, after")
      .eq("entity_id", sepSlip)
      .eq("action", "payroll.payslip_downloaded");
    expect(audit).toHaveLength(1);
    expect(audit![0]!.actor_id).toBe(musaUser.id);
    expect(audit![0]!.after).toEqual({ document_id: docId, run_id: sepRun, as: "worker" });
  });

  it("opens any PDF for owner, hr and finance; never for a line manager, another worker or company", async () => {
    for (const user of [owner, hr, finance]) {
      const { error } = await open(user.client, sepSlip);
      expect(error, user.email).toBeNull();
    }
    expect((await open(lineManager.client, sepSlip)).error?.code).toBe("P0002");
    expect((await open(graceUser.client, sepSlip)).error?.code).toBe("P0002");
    expect((await open(outsider.client, sepSlip)).error?.code).toBe("P0002");
    expect((await open(outsider.client, sepSlip, outsider.orgId)).error?.code).toBe("P0002");
  });

  it("my_payslips says the PDF is made", async () => {
    const { data } = await mine(musaUser.client);
    const sep = (data as unknown as View[]).find((v) => v.run_id === sepRun)!;
    expect(sep.document?.id).toBe(docId);
  });
});

describe("the payslips bucket", () => {
  it("refuses direct reads, lists, signs and writes by every signed-in role", async () => {
    const sepSlip = await slipOf(sepRun, musa.workerId);
    const path = `${owner.orgId}/${sepRun}/${sepSlip}.pdf`;
    for (const user of [owner, hr, finance, musaUser, graceUser, outsider]) {
      const bucket = user.client.storage.from("payslips");
      const download = await bucket.download(path);
      expect(download.data, user.email).toBeNull();
      const signed = await bucket.createSignedUrl(path, 60);
      expect(signed.data?.signedUrl ?? null, user.email).toBeNull();
      const list = await bucket.list(`${owner.orgId}/${sepRun}`);
      expect(list.data ?? [], user.email).toEqual([]);
      const upload = await bucket.upload(`${owner.orgId}/${sepRun}/x-${user.id}.pdf`, FAKE_PDF, {
        contentType: "application/pdf",
      });
      expect(upload.error, user.email).not.toBeNull();
    }
    // The secret key can (the server signs after open_payslip_document says yes).
    const signed = await admin.storage.from("payslips").createSignedUrl(path, 60);
    expect(signed.data?.signedUrl).toBeTruthy();
  });
});

describe("release notices", () => {
  const notice = (workerId: string, payslipId: string) => ({
    organisation_id: owner.orgId,
    worker_id: workerId,
    kind: "payslip",
    title: "Your September 2026 payslip is ready",
    body: "Your payslip is in the app. Open Payslips to see it.",
    link_path: "/m/payslips",
    payslip_id: payslipId,
  });

  it("goes once to the payslip's own worker, only after release", async () => {
    const augSlip = await slipOf(augRun, musa.workerId);
    const octSlip = await slipOf(octRun, musa.workerId);
    // Not released yet.
    const early = await admin.from("inbox_items").insert(notice(musa.workerId, octSlip));
    expect(early.error?.code).toBe("MLPD2");
    // Not that payslip's worker.
    const wrong = await admin.from("inbox_items").insert(notice(grace.workerId, augSlip));
    expect(wrong.error?.code).toBe("MLPD4");
    const first = await admin
      .from("inbox_items")
      .insert(notice(musa.workerId, augSlip))
      .select("id")
      .single();
    expect(first.error).toBeNull();
    const again = await admin.from("inbox_items").insert(notice(musa.workerId, augSlip));
    expect(again.error?.code).toBe("23505");
    // Musa sees it in the inbox; the item never changes its payslip.
    const seen = await musaUser.client
      .from("inbox_items")
      .select("id, payslip_id")
      .eq("id", first.data!.id);
    expect(seen.data).toEqual([{ id: first.data!.id, payslip_id: augSlip }]);
    await expect(
      db.query("update public.inbox_items set payslip_id = null where id = $1", [first.data!.id]),
    ).rejects.toMatchObject({ code: "MLIB1" });
  });
});

describe("a released payslip is frozen with its first PDF", () => {
  async function setBankName(name: string) {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query("update public.workers set bank_name = $2 where id = $1", [
        musa.workerId,
        name,
      ]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  }

  it("keeps September's year to date and bank when October (paid earlier) is released and the bank changes", async () => {
    const sepSlip = await slipOf(sepRun, musa.workerId);
    // The server freezes the payslip before making its PDF.
    const views = await admin.rpc("payslip_pdf_views", {
      p_organisation_id: owner.orgId,
      p_run_id: sepRun,
    });
    expect(views.error).toBeNull();
    const frozen = (views.data as unknown as View[])[0]!;
    expect(frozen.year_to_date).toMatchObject({ payslips: 2, gross_kobo: "24000000" });
    expect(frozen.worker.bank_name).toBe("GTBank");
    // Signed-in users can't freeze or read the views.
    expect(
      (
        await finance.client.rpc("payslip_pdf_views", {
          p_organisation_id: owner.orgId,
          p_run_id: sepRun,
        })
      ).error?.code,
    ).toBe("42501");

    // October, paid 21 Oct (before September's 25 Oct), is released later; the bank changes.
    await markReleased(db, octRun, finance.id);
    await setBankName("Zenith Bank");

    const { data } = await mine(musaUser.client);
    const list = data as unknown as View[];
    expect(list.map((v) => v.run_id)).toEqual([sepRun, octRun, augRun]);
    const sep = list.find((v) => v.run_id === sepRun)!;
    expect(sep.year_to_date).toMatchObject({
      payslips: 2,
      gross_kobo: "24000000",
      net_kobo: "21880000",
    });
    expect(sep.worker.bank_name).toBe("GTBank");
    // October isn't frozen yet: live figures (August and October) and today's bank.
    const oct = list.find((v) => v.run_id === octRun)!;
    expect(oct.year_to_date).toMatchObject({ payslips: 2, gross_kobo: "24000000" });
    expect(oct.worker.bank_name).toBe("Zenith Bank");

    // The snapshot never changes, for anyone.
    for (const sql of [
      "update public.payslip_snapshots set ytd_net_kobo = 1 where payslip_id = $1",
      "delete from public.payslip_snapshots where payslip_id = $1",
    ]) {
      await expect(db.query(sql, [sepSlip])).rejects.toMatchObject({ code: "MLPD1" });
    }
    await expect(db.query("truncate public.payslip_snapshots")).rejects.toMatchObject({
      code: "MLPD1",
    });
  });
});

describe("year to date on the same pay date", () => {
  it("counts a run paid the same day only on the payslip approved after it", async () => {
    const o = await createTenantUser("pslip-tie-owner", "Payslips Tie Org");
    const fin = await createTestUser("pslip-tie-fin");
    const { error } = await admin
      .from("memberships")
      .insert({ organisation_id: o.orgId, user_id: fin.id, role: "finance" });
    expect(error).toBeNull();
    const w = await addPayrollWorker(admin, o.orgId);
    const wUser = await createTestUser("pslip-tie-worker");
    const member = await admin
      .from("memberships")
      .insert({
        organisation_id: o.orgId,
        user_id: wUser.id,
        role: "worker",
        worker_id: w.workerId,
      });
    expect(member.error).toBeNull();
    // September pays 25 Oct; October is set to pay the same day, approved after September.
    const sep = await submitRunFor(admin, o, w, "2026-09-20");
    await approveRun(admin, o.orgId, sep, fin);
    await markReleased(db, sep, fin.id);
    const oct = await submitRunFor(admin, o, w, "2026-10-20", "2026-10-25");
    await approveRun(admin, o.orgId, oct, fin);
    await markReleased(db, oct, fin.id);
    const { data, error: readError } = await wUser.client.rpc("my_payslips", {
      p_organisation_id: o.orgId,
    });
    expect(readError).toBeNull();
    const list = data as unknown as View[];
    expect(list.map((v) => v.run_id)).toEqual([oct, sep]);
    expect(list[0]!.year_to_date).toMatchObject({ payslips: 2, gross_kobo: "24000000" });
    expect(list[1]!.year_to_date).toMatchObject({ payslips: 1, gross_kobo: "12000000" });
  });
});
