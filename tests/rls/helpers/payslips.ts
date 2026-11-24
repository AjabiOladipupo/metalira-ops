/**
 * Slice 5.5 seeding for the RLS suite: a run for one worker posted through the real functions
 * (create, results saved with the secret key, anomaly acknowledged, submitted by the owner,
 * approved by a second person after the server's input check) and then released through slice
 * 5.4's release_payroll_run (`releaseRun`).
 */
import { expect } from "vitest";

import { releaseThroughBankFile } from "./payout";

import { resultsFor, saveResults, SHA } from "./payroll";
import type { Client, TenantUser, TestUser } from "./supabase";

/** A tiny file the payslips bucket takes (PDF type). */
export const FAKE_PDF = new TextEncoder().encode("%PDF-1.4\n% slice 5.5 test\n%%EOF\n");

export function periodEnd(periodStart: string): string {
  const [y, m] = periodStart.split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 19));
  return next.toISOString().slice(0, 10);
}

/** Creates, saves, acknowledges and submits a run for one worker; returns the run id. */
export async function submitRunFor(
  admin: Client,
  owner: TenantUser,
  worker: { workerId: string; payRateId: string },
  periodStart: string,
  payDate?: string,
): Promise<string> {
  const created = await owner.client.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: periodStart,
    ...(payDate ? { p_pay_date: payDate } : {}),
  });
  expect(created.error).toBeNull();
  const runId = created.data!;
  const saved = await saveResults(
    admin,
    owner,
    runId,
    resultsFor(
      { ...worker, adjustmentId: null },
      { period: { start: periodStart, end: periodEnd(periodStart) } },
    ),
  );
  expect(saved.error).toBeNull();
  const { data: anomalies } = await admin
    .from("payroll_anomalies")
    .select("id")
    .eq("run_id", runId);
  const ack = await owner.client.rpc("acknowledge_payroll_anomalies", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
    p_anomaly_ids: (anomalies ?? []).map((a) => a.id),
  });
  expect(ack.error).toBeNull();
  const submitted = await owner.client.rpc("submit_payroll_run", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
  });
  expect(submitted.error).toBeNull();
  return runId;
}

/** A second person (finance or another owner) approves after the server's input check. */
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
 * approved -> released through slice 5.4's release_payroll_run: the owner (the preparer) makes and
 * downloads the bank file, `releaser` (the approver) releases (helpers/payout.ts).
 */
export async function releaseRun(
  admin: Client,
  owner: TenantUser,
  runId: string,
  releaser: TestUser,
): Promise<void> {
  await releaseThroughBankFile(admin, owner, runId, releaser);
  const { data } = await admin.from("payroll_runs").select("status").eq("id", runId).single();
  expect(data?.status).toBe("released");
}

/** Uploads a stand-in PDF at the payslip's path and records it, as the server does. */
export async function recordDocument(
  admin: Client,
  orgId: string,
  runId: string,
  payslipId: string,
  actor: string | null,
): Promise<string> {
  const path = `${orgId}/${runId}/${payslipId}.pdf`;
  const upload = await admin.storage
    .from("payslips")
    .upload(path, FAKE_PDF, { contentType: "application/pdf", upsert: true });
  expect(upload.error).toBeNull();
  const { data, error } = await admin.rpc("record_payslip_document", {
    p_organisation_id: orgId,
    p_payslip_id: payslipId,
    p_actor: actor as string,
    p_sha256: "c".repeat(64),
    p_size_bytes: FAKE_PDF.length,
  });
  expect(error).toBeNull();
  return data!;
}
