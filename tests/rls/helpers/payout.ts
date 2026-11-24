/**
 * Slice 5.4 seeding for the RLS suite: an approved October 2026 run (made through the functions,
 * as helpers/payroll.ts does, then approved by a second person after the server's input check),
 * workers with bank details on file (written with the secret key, as after an applied change; the
 * numbers are random bytes, since the database never decrypts), and the server's two steps of a
 * bank file: the file stored in `payroll-files` with the secret key, then `make_payout_batch` as
 * the signed-in user with the items (no account numbers).
 *
 * Figures as helpers/payroll.ts: each worker gross ₦120,000, PAYE ₦1,000, pension ₦9,600, net
 * ₦109,400 (10,940,000 kobo) with no allowance.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { Json } from "@/types/db";

import { addPayrollWorker, resultsFor, saveResults, SHA } from "./payroll";
import type { Client, TenantUser, TestUser } from "./supabase";

export const BUCKET = "payroll-files";
export const NET = 10_940_000;

export const enc = () => `\\x${randomBytes(48).toString("hex")}`;

export const BANK = {
  bank_name: "GTBank",
  account_name: "MUSA IBRAHIM",
  bank_account_last4: "6789",
  bank_code: "058",
};

/** Bank details on file for a worker (the secret key, as after an applied change). */
export async function giveBankDetails(
  admin: Client,
  orgId: string,
  workerId: string,
  extra: Record<string, unknown> = {},
) {
  const { error } = await admin
    .from("workers")
    .update({ ...BANK, bank_account_enc: enc(), ...extra })
    .eq("organisation_id", orgId)
    .eq("id", workerId);
  if (error) throw new Error(`bank details: ${error.message}`);
}

export interface SeededPayrollRun {
  runId: string;
  workers: { workerId: string; payRateId: string; payslipId: string }[];
}

/**
 * A submitted October run for `owner`'s company with `count` workers (each with bank details
 * unless `bank` is false), its anomalies (default: one warning per worker) acknowledged by the
 * owner. Approve it with `approveRun`.
 */
export async function seedSubmittedRun(
  admin: Client,
  owner: TenantUser,
  options: {
    count?: number;
    bank?: boolean;
    anomalies?: (workerIds: string[]) => unknown[];
    names?: string[];
  } = {},
): Promise<SeededPayrollRun> {
  const count = options.count ?? 1;
  const workers: { workerId: string; payRateId: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = options.names?.[i];
    const w = await addPayrollWorker(
      admin,
      owner.orgId,
      name ? { first_name: name.split(" ")[0], last_name: name.split(" ")[1] } : {},
    );
    if (options.bank !== false) await giveBankDetails(admin, owner.orgId, w.workerId);
    workers.push(w);
  }
  const created = await owner.client.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: "2026-09-20",
  });
  expect(created.error).toBeNull();
  const runId = created.data!;

  const docs = workers.map((w) => resultsFor({ ...w, adjustmentId: null }, { anomalies: [] })) as {
    payslips: unknown[];
    totals: Record<string, string | number>;
  }[];
  const doc = docs[0]! as Record<string, unknown> & (typeof docs)[number];
  for (const other of docs.slice(1)) {
    doc.payslips.push(...other.payslips);
    for (const [k, v] of Object.entries(other.totals)) {
      const mine = doc.totals[k]!;
      doc.totals[k] = typeof v === "number" ? Number(mine) + v : String(BigInt(mine) + BigInt(v));
    }
  }
  const ids = workers.map((w) => w.workerId);
  doc.anomalies = options.anomalies
    ? options.anomalies(ids)
    : ids.map((id) => ({
        worker_id: id,
        code: "no_pension_details",
        severity: "warning",
        detail: { no_pfa: true, no_rsa_pin: true },
      }));
  const saved = await saveResults(admin, owner, runId, doc);
  expect(saved.error).toBeNull();

  const { data: anomalies } = await admin
    .from("payroll_anomalies")
    .select("id")
    .eq("run_id", runId);
  if ((anomalies ?? []).length > 0) {
    const ack = await owner.client.rpc("acknowledge_payroll_anomalies", {
      p_organisation_id: owner.orgId,
      p_run_id: runId,
      p_anomaly_ids: (anomalies ?? []).map((a) => a.id),
    });
    expect(ack.error).toBeNull();
  }
  const submitted = await owner.client.rpc("submit_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
  });
  expect(submitted.error).toBeNull();

  const { data: slips } = await admin.from("payslips").select("id, worker_id").eq("run_id", runId);
  return {
    runId,
    workers: workers.map((w) => ({
      ...w,
      payslipId: slips!.find((s) => s.worker_id === w.workerId)!.id,
    })),
  };
}

/** The server's input check naming `approver`, then their approval. */
export async function approveRun(
  admin: Client,
  orgId: string,
  runId: string,
  approver: TestUser,
): Promise<void> {
  const clock = await admin.rpc("payroll_clock");
  expect(clock.error).toBeNull();
  const check = await admin.rpc("record_payroll_approval_check", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: approver.id,
    p_inputs_sha256: SHA,
    p_read_started_at: clock.data!,
  });
  expect(check.error).toBeNull();
  const approved = await approver.client.rpc("approve_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
  });
  expect(approved.error).toBeNull();
}

export interface PlanRow {
  payslip_id: string;
  worker_id: string;
  worker_name: string;
  net_kobo: string;
  bank_name: string | null;
  bank_code: string | null;
  account_name: string | null;
  bank_account_last4: string | null;
  bank_detail_change_id: string | null;
  bank_account_enc: string | null;
  on_file: boolean;
  in_hold: boolean;
  acknowledged_code: string | null;
}

/** The plan as `client` reads it (no ciphertext for a signed-in user). */
export async function readPlan(client: Client, orgId: string, runId: string, ciphertext = false) {
  return client.rpc("payout_plan", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_with_ciphertext: ciphertext,
  });
}

/** Items as the server sends them: every plan row paid, in plan order (positions 1..n). */
export function payAll(plan: PlanRow[]): Record<string, unknown>[] {
  return plan.map((r, i) => ({
    payslip_id: r.payslip_id,
    position: i + 1,
    status: "pending",
    left_out_reason: null,
    bank_name: r.bank_name,
    bank_code: r.bank_code,
    account_name: r.account_name,
    bank_account_last4: r.bank_account_last4,
    bank_detail_change_id: r.bank_detail_change_id,
    amount_kobo: r.net_kobo,
  }));
}

/** The file stored by the server (secret key) at the batch's path. Returns its size. */
export async function storeFile(
  admin: Client,
  orgId: string,
  runId: string,
  batchId: string,
  body = "Beneficiary name,Account number\r\nMUSA IBRAHIM,0123456789\r\n",
): Promise<{ path: string; bytes: number }> {
  const path = `${orgId}/${runId}/${batchId}.csv`;
  const bytes = Buffer.from(body, "utf8");
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: "text/csv", upsert: false });
  if (error) throw new Error(`store file: ${error.message}`);
  return { path, bytes: bytes.byteLength };
}

/** Stores a file and records it as `by`, with `items` (default: pay everyone in the plan). */
export async function makeBatch(
  admin: Client,
  by: Client,
  orgId: string,
  runId: string,
  options: {
    items?: (plan: PlanRow[]) => unknown[];
    voidReason?: string;
    notUploaded?: boolean;
    store?: boolean;
    bytes?: number;
    sha?: string;
  } = {},
) {
  const batchId = randomUUID();
  const plan = await readPlan(admin, orgId, runId, false);
  expect(plan.error).toBeNull();
  const rows = (plan.data ?? []) as unknown as PlanRow[];
  const stored =
    options.store === false
      ? { path: `${orgId}/${runId}/${batchId}.csv`, bytes: 10 }
      : await storeFile(admin, orgId, runId, batchId);
  const result = await by.rpc("make_payout_batch", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_batch_id: batchId,
    p_bank_format: "generic-csv",
    p_file_sha256: options.sha ?? "c".repeat(64),
    p_file_bytes: options.bytes ?? stored.bytes,
    p_items: (options.items ? options.items(rows) : payAll(rows)) as Json,
    ...(options.voidReason ? { p_void_reason: options.voidReason } : {}),
    ...(options.notUploaded ? { p_not_uploaded: true } : {}),
  });
  return { ...result, batchId, path: stored.path, plan: rows, sha: options.sha ?? "c".repeat(64) };
}

/** The audited download, as `by`. */
export function download(by: Client, orgId: string, batchId: string, reason?: string) {
  return by.rpc("payout_file_download", {
    p_organisation_id: orgId,
    p_batch_id: batchId,
    ...(reason ? { p_reason: reason } : {}),
  });
}

/** The release, as `by`, naming the file by id and SHA-256 (default: the test files' hash). */
export function release(
  by: Client,
  orgId: string,
  runId: string,
  batchId: string,
  sha = "c".repeat(64),
) {
  return by.rpc("release_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_batch_id: batchId,
    p_file_sha256: sha,
  });
}
