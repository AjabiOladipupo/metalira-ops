/**
 * Slice 5.6 seeding for the RLS suite: a company's October 2026 run approved by a second person
 * in Finance (so its statutory remittances are made), and a receipt in the payroll-evidence
 * bucket recorded with the secret key, as the server does after checking its bytes.
 */
import { createHash, randomUUID } from "node:crypto";

import { expect } from "vitest";

import { addPayrollWorker, OCT_START, resultsFor, saveResults, SHA } from "./payroll";
import { createTestUser, type Client, type TenantUser, type TestUser } from "./supabase";

export const EVIDENCE_BUCKET = "payroll-evidence";
export const FILES_BUCKET = "payroll-files";

/** A tiny PDF: its magic bytes are what the server checks. */
export const RECEIPT_PDF = Buffer.from(
  "%PDF-1.4\n% receipt\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n",
);

export async function addFinance(
  admin: Client,
  orgId: string,
  label = "stat-fin",
): Promise<TestUser> {
  const finance = await createTestUser(label, "Adaeze Okafor");
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: finance.id, role: "finance" });
  expect(error).toBeNull();
  return finance;
}

/** Records the server's input check as `approver`, then approves as them. */
export async function approveRun(
  admin: Client,
  orgId: string,
  runId: string,
  approver: TestUser,
): Promise<void> {
  const clock = await admin.rpc("payroll_clock");
  expect(clock.error).toBeNull();
  const checked = await admin.rpc("record_payroll_approval_check", {
    p_organisation_id: orgId,
    p_run_id: runId,
    p_actor: approver.id,
    p_inputs_sha256: SHA,
    p_read_started_at: clock.data!,
  });
  expect(checked.error).toBeNull();
  const approved = await approver.client.rpc("approve_payroll_run", {
    p_organisation_id: orgId,
    p_run_id: runId,
  });
  expect(approved.error).toBeNull();
}

/**
 * One worker on ₦120,000 in Lagos with a PFA (or none), no anomalies: PAYE ₦1,000, pension
 * ₦9,600 + ₦12,000, NSITF ₦1,200, no ITF or NHF. Prepared and submitted by the owner.
 */
export async function seedSubmittedRun(
  admin: Client,
  owner: TenantUser,
  options: {
    pfaName?: string | null;
    periodStart?: string;
    workerExtra?: Record<string, unknown>;
  } = {},
): Promise<{ runId: string; workerId: string }> {
  const { workerId, payRateId } = await addPayrollWorker(admin, owner.orgId, options.workerExtra);
  const created = await owner.client.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: options.periodStart ?? OCT_START,
  });
  expect(created.error).toBeNull();
  const runId = created.data!;
  const pfaName = options.pfaName === undefined ? "Stanbic IBTC Pensions" : options.pfaName;
  const saved = await saveResults(
    admin,
    owner,
    runId,
    resultsFor(
      { workerId, payRateId, adjustmentId: null },
      {
        anomalies: [],
        mutate: (doc) => {
          (doc.payslips as Record<string, unknown>[])[0]!.pfa_name = pfaName;
        },
      },
    ),
  );
  expect(saved.error).toBeNull();
  const submitted = await owner.client.rpc("submit_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
  });
  expect(submitted.error).toBeNull();
  return { runId, workerId };
}

/** Puts a receipt in the bucket and records it with the secret key, naming `actor`. */
export async function seedReceipt(
  admin: Client,
  orgId: string,
  remittanceId: string,
  actor: string,
  body: Buffer = RECEIPT_PDF,
): Promise<{ receiptId: string; path: string; error: { code: string } | null }> {
  const receiptId = randomUUID();
  const path = `${orgId}/${remittanceId}/${receiptId}.pdf`;
  const upload = await admin.storage
    .from(EVIDENCE_BUCKET)
    .upload(path, body, { contentType: "application/pdf" });
  expect(upload.error).toBeNull();
  const { error } = await admin.rpc("record_statutory_receipt", {
    p_organisation_id: orgId,
    p_remittance_id: remittanceId,
    p_receipt_id: receiptId,
    p_actor: actor,
    p_file_ext: "pdf",
    p_size_bytes: body.length,
    p_sha256: createHash("sha256").update(body).digest("hex"),
  });
  return { receiptId, path, error };
}
