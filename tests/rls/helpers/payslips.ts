/**
 * Slice 5.5 seeding for the RLS suite: a run for one worker posted through the real functions
 * (create, results saved with the secret key, anomaly acknowledged, submitted by the owner,
 * approved by a second person after the server's input check) and then marked released.
 *
 * Release (approved -> released) belongs to slice 5.4's `release_payroll_run`, which isn't on
 * main yet; until it is, `markReleased` makes the one move as the database owner with the run's
 * guard switched off for that transaction (restored as ENABLE ALWAYS before commit), setting
 * 5.4's released_at and released_by too when those columns exist. TODO(5.4): call
 * release_payroll_run with an active bank file instead.
 */
import type pg from "pg";
import { expect } from "vitest";

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
): Promise<string> {
  const created = await owner.client.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: periodStart,
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

/** approved -> released, as the database owner (see the file header; TODO(5.4)). */
export async function markReleased(
  db: pg.Client,
  runId: string,
  releasedBy: string,
): Promise<void> {
  const { rows } = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'payroll_runs'
       and column_name in ('released_at', 'released_by')`,
  );
  const withColumns = rows.length === 2;
  await db.query("begin");
  try {
    await db.query("alter table public.payroll_runs disable trigger payroll_runs_guard");
    if (withColumns) {
      await db.query(
        "update public.payroll_runs set status = 'released', released_at = now(), released_by = $2 where id = $1 and status = 'approved'",
        [runId, releasedBy],
      );
    } else {
      await db.query(
        "update public.payroll_runs set status = 'released' where id = $1 and status = 'approved'",
        [runId],
      );
    }
    await db.query("alter table public.payroll_runs enable always trigger payroll_runs_guard");
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  const { rows: after } = await db.query<{ status: string }>(
    "select status from public.payroll_runs where id = $1",
    [runId],
  );
  expect(after[0]?.status).toBe("released");
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
