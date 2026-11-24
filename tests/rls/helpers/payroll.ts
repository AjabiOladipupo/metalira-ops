/**
 * Slice 5.2 seeding for the RLS suite: a company's October 2026 run made through the functions.
 * One worker on ₦120,000 (a pay version from 6 Jan 2025), a draft run, one allowance, results
 * saved with the secret key (as the server does after running the engine), and optionally the
 * anomaly acknowledged and the run submitted (a decision row).
 *
 * The SQL checks identities and sources, not tax, so the figures here are simple and consistent:
 * gross ₦135,000 (₦120,000 salary + ₦15,000 allowance), PAYE ₦1,000, employee pension ₦9,600,
 * net ₦124,400; employer pension ₦12,000, NSITF ₦1,350, employer cost ₦148,350.
 */
import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { Json } from "@/types/db";

import type { Client, TenantUser } from "./supabase";

export const OCT_START = "2026-09-20";
export const OCT_END = "2026-10-19";

export interface SeededRun {
  runId: string;
  workerId: string;
  payRateId: string;
  adjustmentId: string;
}

export async function addPayrollWorker(
  admin: Client,
  orgId: string,
  extra: Record<string, unknown> = {},
): Promise<{ workerId: string; payRateId: string }> {
  const { data, error } = await admin
    .from("workers")
    .insert({
      organisation_id: orgId,
      staff_id: `PR-${randomUUID().slice(0, 8)}`,
      first_name: "Musa",
      last_name: "Ibrahim",
      employment_type: "permanent",
      start_date: "2025-01-06",
      tax_state: "Lagos",
      ...extra,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const rate = await admin
    .from("pay_rates")
    .insert({
      organisation_id: orgId,
      worker_id: data.id,
      pay_type: "monthly",
      basic_kobo: 6_000_000,
      housing_kobo: 3_600_000,
      transport_kobo: 2_400_000,
      other_allowances_kobo: 0,
      effective_from: "2025-01-06",
    })
    .select("id")
    .single();
  if (rate.error) throw new Error(rate.error.message);
  return { workerId: data.id, payRateId: rate.data.id };
}

/** A results document `save_payroll_results` accepts for one worker (see the file header). */
export function resultsFor(
  s: { workerId: string; payRateId: string; adjustmentId: string | null },
  over: {
    anomalies?: unknown[];
    mutate?: (doc: Record<string, unknown>) => void;
    period?: { start: string; end: string };
    extra?: { code: string; label: string; amount: number; sources: unknown[] }[];
  } = {},
): Record<string, unknown> {
  const withAllowance = s.adjustmentId !== null;
  const extra = over.extra ?? [];
  const period = over.period ?? { start: OCT_START, end: OCT_END };
  const gross = (withAllowance ? 13_500_000 : 12_000_000) + extra.reduce((n, e) => n + e.amount, 0);
  const net = gross - 100_000 - 960_000;
  const nsitf = Math.round(gross / 100);
  const cost = gross + 1_200_000 + nsitf;
  const lines: Record<string, unknown>[] = [
    {
      code: "basic",
      kind: "earning",
      label: "Basic, 20 Sep to 19 Oct",
      amount_kobo: "6000000",
      pensionable: true,
      taxable: true,
      sources: [{ kind: "pay_rate", id: s.payRateId, from: period.start, to: period.end }],
    },
    {
      code: "housing",
      kind: "earning",
      label: "Housing, 20 Sep to 19 Oct",
      amount_kobo: "3600000",
      pensionable: true,
      taxable: true,
      sources: [{ kind: "pay_rate", id: s.payRateId, from: period.start, to: period.end }],
    },
    {
      code: "transport",
      kind: "earning",
      label: "Transport, 20 Sep to 19 Oct",
      amount_kobo: "2400000",
      pensionable: true,
      taxable: true,
      sources: [{ kind: "pay_rate", id: s.payRateId, from: period.start, to: period.end }],
    },
  ];
  if (withAllowance) {
    lines.push({
      code: "adjustment_earning",
      kind: "earning",
      label: "Supervisor allowance",
      amount_kobo: "1500000",
      pensionable: false,
      taxable: true,
      sources: [{ kind: "adjustment", id: s.adjustmentId, from: period.start, to: period.end }],
    });
  }
  for (const e of extra) {
    lines.push({
      code: e.code,
      kind: "earning",
      label: e.label,
      amount_kobo: String(e.amount),
      pensionable: false,
      taxable: true,
      sources: e.sources,
    });
  }
  lines.push(
    {
      code: "paye",
      kind: "statutory",
      label: "PAYE",
      amount_kobo: "100000",
      pensionable: false,
      taxable: false,
      sources: [],
    },
    {
      code: "pension_employee",
      kind: "statutory",
      label: "Employee pension 8%",
      amount_kobo: "960000",
      pensionable: false,
      taxable: false,
      sources: [],
    },
    {
      code: "pension_employer",
      kind: "employer",
      label: "Employer pension 10%",
      amount_kobo: "1200000",
      pensionable: false,
      taxable: false,
      sources: [],
    },
    {
      code: "nsitf",
      kind: "employer",
      label: "NSITF 1%",
      amount_kobo: String(nsitf),
      pensionable: false,
      taxable: false,
      sources: [],
    },
  );
  const slip = {
    worker_id: s.workerId,
    employment_type: "permanent",
    tax_state: "Lagos",
    pfa_name: null,
    pay_rate_ids: [s.payRateId],
    days: { cycle: 30, rostered: 21, employed_rostered: 21, leave_deducted: 0 },
    gross_kobo: String(gross),
    paye_kobo: "100000",
    pension_employee_kobo: "960000",
    nhf_kobo: "0",
    other_deductions_kobo: "0",
    net_kobo: String(net),
    carried_forward_kobo: "0",
    pension_employer_kobo: "1200000",
    nsitf_kobo: String(nsitf),
    itf_kobo: "0",
    employer_cost_kobo: String(cost),
    trace: { trace_version: 1, steps: [] },
    lines,
  };
  const doc: Record<string, unknown> = {
    itf_applies: false,
    totals: {
      gross_kobo: String(gross),
      paye_kobo: "100000",
      pension_employee_kobo: "960000",
      pension_employer_kobo: "1200000",
      nhf_kobo: "0",
      other_deductions_kobo: "0",
      net_kobo: String(net),
      nsitf_kobo: String(nsitf),
      itf_kobo: "0",
      employer_cost_kobo: String(cost),
      carried_forward_kobo: "0",
      worker_count: 1,
    },
    payslips: [slip],
    anomalies: over.anomalies ?? [
      {
        worker_id: s.workerId,
        code: "no_pension_details",
        severity: "warning",
        detail: { no_pfa: true, no_rsa_pin: true },
      },
    ],
  };
  over.mutate?.(doc);
  return doc;
}

export const SHA = "a".repeat(64);

export function saveResults(
  admin: Client,
  owner: TenantUser,
  runId: string,
  doc: Record<string, unknown>,
  actor: string = owner.id,
) {
  return admin.rpc("save_payroll_results", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
    p_actor: actor,
    p_results: doc as unknown as Json,
    p_inputs_sha256: SHA,
  });
}

/** The October run for `owner`'s company, saved, and submitted when asked. */
export async function seedPayrollRun(
  admin: Client,
  owner: TenantUser,
  options: { submit?: boolean; periodStart?: string } = {},
): Promise<SeededRun> {
  const { workerId, payRateId } = await addPayrollWorker(admin, owner.orgId);
  const created = await owner.client.rpc("create_payroll_run", {
    p_organisation_id: owner.orgId,
    p_period_start: options.periodStart ?? OCT_START,
  });
  expect(created.error).toBeNull();
  const runId = created.data!;
  const adj = await owner.client.rpc("add_payroll_adjustment", {
    p_organisation_id: owner.orgId,
    p_run_id: runId,
    p_worker_id: workerId,
    p_kind: "earning",
    p_label: "Supervisor allowance",
    p_amount_kobo: "1500000",
    p_pensionable: false,
    p_taxable: true,
    p_instalments: 1,
    p_reason: "Acting supervisor at Lekki",
  });
  expect(adj.error).toBeNull();
  const adjustmentId = adj.data!;
  const saved = await saveResults(
    admin,
    owner,
    runId,
    resultsFor({ workerId, payRateId, adjustmentId }),
  );
  expect(saved.error).toBeNull();
  if (options.submit) {
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
  }
  return { runId, workerId, payRateId, adjustmentId };
}
