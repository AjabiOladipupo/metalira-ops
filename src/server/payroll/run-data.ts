import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { toKobo, type Kobo } from "@/lib/money";
import type { StoredTrace } from "@/lib/payroll/trace";
import type { RunTotals } from "@/lib/payroll/run";
import type { Database } from "@/types/db";

/**
 * Reads for the payroll run screens (slice 5.2), under RLS as the signed-in member: owner, hr
 * and finance see a company's runs, payslips, anomalies, adjustments and decisions; everyone
 * else gets no rows. Kobo columns are read as text and turned into `bigint` (never a `number`).
 */

type Client = SupabaseClient<Database>;

export type RunStatus = "draft" | "review" | "approved" | "released";

export interface PayrollRunRow {
  id: string;
  kind: string;
  status: RunStatus;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  ruleSetId: string;
  itfApplies: boolean;
  inputsSha256: string | null;
  needsRecalculation: boolean;
  calculatedAt: string | null;
  calculatedBy: string | null;
  preparedBy: string;
  submittedAt: string | null;
  submittedBy: string | null;
  createdAt: string;
  totals: RunTotals;
}

const RUN_COLUMNS =
  "id, kind, status, period_start, period_end, pay_date, rule_set_id, itf_applies, inputs_sha256, needs_recalculation, calculated_at, calculated_by, prepared_by, submitted_at, submitted_by, created_at, worker_count, gross_kobo::text, paye_kobo::text, pension_employee_kobo::text, pension_employer_kobo::text, nhf_kobo::text, other_deductions_kobo::text, net_kobo::text, nsitf_kobo::text, itf_kobo::text, employer_cost_kobo::text, carried_forward_kobo::text" as const;

type RunRecord = {
  id: string;
  kind: string;
  status: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  rule_set_id: string;
  itf_applies: boolean;
  inputs_sha256: string | null;
  needs_recalculation: boolean;
  calculated_at: string | null;
  calculated_by: string | null;
  prepared_by: string;
  submitted_at: string | null;
  submitted_by: string | null;
  created_at: string;
  worker_count: number;
  gross_kobo: string;
  paye_kobo: string;
  pension_employee_kobo: string;
  pension_employer_kobo: string;
  nhf_kobo: string;
  other_deductions_kobo: string;
  net_kobo: string;
  nsitf_kobo: string;
  itf_kobo: string;
  employer_cost_kobo: string;
  carried_forward_kobo: string;
};

function toRun(r: RunRecord): PayrollRunRow {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status as RunStatus,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    payDate: r.pay_date,
    ruleSetId: r.rule_set_id,
    itfApplies: r.itf_applies,
    inputsSha256: r.inputs_sha256,
    needsRecalculation: r.needs_recalculation,
    calculatedAt: r.calculated_at,
    calculatedBy: r.calculated_by,
    preparedBy: r.prepared_by,
    submittedAt: r.submitted_at,
    submittedBy: r.submitted_by,
    createdAt: r.created_at,
    totals: {
      grossKobo: toKobo(r.gross_kobo),
      payeKobo: toKobo(r.paye_kobo),
      pensionEmployeeKobo: toKobo(r.pension_employee_kobo),
      pensionEmployerKobo: toKobo(r.pension_employer_kobo),
      nhfKobo: toKobo(r.nhf_kobo),
      otherDeductionsKobo: toKobo(r.other_deductions_kobo),
      netKobo: toKobo(r.net_kobo),
      nsitfKobo: toKobo(r.nsitf_kobo),
      itfKobo: toKobo(r.itf_kobo),
      employerCostKobo: toKobo(r.employer_cost_kobo),
      carriedForwardKobo: toKobo(r.carried_forward_kobo),
      workerCount: r.worker_count,
    },
  };
}

/** The company's runs, newest period first. */
export async function listRuns(supabase: Client, organisationId: string): Promise<PayrollRunRow[]> {
  const { data, error } = await supabase
    .from("payroll_runs")
    .select(RUN_COLUMNS)
    .eq("organisation_id", organisationId)
    .order("period_start", { ascending: false })
    .limit(60);
  if (error) throw new Error(`Could not read payroll runs (${error.code})`);
  return (data ?? []).map((r) => toRun(r as RunRecord));
}

export async function loadRun(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<PayrollRunRow | null> {
  const { data, error } = await supabase
    .from("payroll_runs")
    .select(RUN_COLUMNS)
    .eq("organisation_id", organisationId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the payroll run (${error.code})`);
  return data ? toRun(data as RunRecord) : null;
}

/** The latest posted run before a period (for "against the last posted run"). */
export async function loadLastPostedRun(
  supabase: Client,
  organisationId: string,
  beforePeriod: string,
): Promise<PayrollRunRow | null> {
  const { data, error } = await supabase
    .from("payroll_runs")
    .select(RUN_COLUMNS)
    .eq("organisation_id", organisationId)
    .in("status", ["approved", "released"])
    .lt("period_start", beforePeriod)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not read earlier runs (${error.code})`);
  return data ? toRun(data as RunRecord) : null;
}

export interface PayslipRow {
  id: string;
  workerId: string;
  workerName: string;
  staffId: string;
  jobTitle: string | null;
  employmentType: string;
  taxState: string | null;
  pfaName: string | null;
  grossKobo: Kobo;
  payeKobo: Kobo;
  pensionEmployeeKobo: Kobo;
  pensionEmployerKobo: Kobo;
  nhfKobo: Kobo;
  otherDeductionsKobo: Kobo;
  netKobo: Kobo;
  nsitfKobo: Kobo;
  itfKobo: Kobo;
  employerCostKobo: Kobo;
  carriedForwardKobo: Kobo;
}

export interface AnomalyRow {
  id: string;
  workerId: string | null;
  workerName: string | null;
  code: string;
  severity: "blocking" | "warning";
  detail: Record<string, unknown>;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface AdjustmentRow {
  id: string;
  workerId: string;
  workerName: string;
  kind: "earning" | "deduction";
  label: string;
  amountKobo: Kobo;
  pensionable: boolean;
  taxable: boolean;
  instalmentNumber: number;
  instalmentCount: number;
  reason: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

export interface DecisionRow {
  id: string;
  decision: "submitted" | "returned";
  reason: string | null;
  actorId: string;
  actorName: string | null;
  createdAt: string;
}

/** An earning beyond the monthly salary (from timesheets, leave or arrears) on a payslip. */
export interface EarningItem {
  payslipId: string;
  workerName: string;
  code: string;
  label: string;
  amountKobo: Kobo;
}

export interface RunWorker {
  id: string;
  name: string;
  staffId: string;
}

export interface RunDetail {
  run: PayrollRunRow;
  ruleSet: { name: string; effectiveFrom: string; adviserConfirmed: boolean } | null;
  payslips: PayslipRow[];
  anomalies: AnomalyRow[];
  adjustments: AdjustmentRow[];
  decisions: DecisionRow[];
  items: EarningItem[];
  /** Workers who can get an adjustment (the run's payslips, by name). */
  workers: RunWorker[];
  names: Map<string, string>;
}

/** The display copy of an anomaly's detail, with its site's name (never stored). */
function withSiteName(
  detail: Record<string, unknown>,
  siteNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const id = detail.site_id;
  if (typeof id !== "string") return detail;
  return { ...detail, site_name: siteNames.get(id) ?? "A site" };
}

const fullName = (w: { first_name: string; last_name: string }) =>
  `${w.first_name} ${w.last_name}`.trim();

async function profileNames(
  supabase: Client,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
  for (const p of data ?? []) if (p.full_name) names.set(p.user_id, p.full_name);
  return names;
}

/** Everything the run page shows (a run the caller can't read gives null). */
export async function loadRunDetail(
  supabase: Client,
  organisationId: string,
  runId: string,
): Promise<RunDetail | null> {
  const run = await loadRun(supabase, organisationId, runId);
  if (!run) return null;
  const [ruleSet, slips, anomalies, adjustments, decisions, itemRows] = await Promise.all([
    supabase
      .from("tax_rule_sets")
      .select("name, effective_from, adviser_confirmed_at")
      .eq("organisation_id", organisationId)
      .eq("id", run.ruleSetId)
      .maybeSingle(),
    supabase
      .from("payslips")
      .select(
        "id, worker_id, employment_type, tax_state, pfa_name, gross_kobo::text, paye_kobo::text, pension_employee_kobo::text, pension_employer_kobo::text, nhf_kobo::text, other_deductions_kobo::text, net_kobo::text, nsitf_kobo::text, itf_kobo::text, employer_cost_kobo::text, carried_forward_kobo::text",
      )
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .limit(5000),
    supabase
      .from("payroll_anomalies")
      .select("id, worker_id, code, severity, detail, acknowledged_at, acknowledged_by")
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .order("created_at")
      .limit(5000),
    supabase
      .from("payroll_adjustments")
      .select(
        "id, worker_id, kind, label, amount_kobo::text, pensionable, taxable, instalment_number, instalment_count, reason, created_by, created_at",
      )
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .order("created_at"),
    supabase
      .from("payroll_run_decisions")
      .select("id, decision, reason, actor_id, created_at")
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .order("created_at", { ascending: false }),
    supabase
      .from("payslip_lines")
      .select("payslip_id, code, label, amount_kobo::text, position")
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .in("code", [
        "daily_pay",
        "hourly_pay",
        "overtime",
        "off_day",
        "public_holiday",
        "arrears",
        "leave_deduction",
      ])
      .order("position")
      .limit(5000),
  ]);
  for (const r of [slips, anomalies, adjustments, decisions, itemRows]) {
    if (r.error) throw new Error(`Could not read the payroll run (${r.error.code})`);
  }

  const workerIds = new Set<string>();
  for (const s of slips.data ?? []) workerIds.add(s.worker_id);
  for (const a of anomalies.data ?? []) if (a.worker_id) workerIds.add(a.worker_id);
  for (const a of adjustments.data ?? []) workerIds.add(a.worker_id);
  for (const a of anomalies.data ?? []) {
    const ids = (a.detail as { worker_ids?: unknown } | null)?.worker_ids;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") workerIds.add(id);
  }
  const workerRows = new Map<string, { name: string; staffId: string; jobTitle: string | null }>();
  const idList = [...workerIds];
  for (let i = 0; i < idList.length; i += 200) {
    const { data, error } = await supabase
      .from("workers")
      .select("id, first_name, last_name, staff_id, job_title")
      .eq("organisation_id", organisationId)
      .in("id", idList.slice(i, i + 200));
    if (error) throw new Error(`Could not read workers (${error.code})`);
    for (const w of data ?? []) {
      workerRows.set(w.id, { name: fullName(w), staffId: w.staff_id, jobTitle: w.job_title });
    }
  }
  const names = new Map([...workerRows].map(([id, w]) => [id, w.name] as const));
  // Open timesheet days name their site by id only; the name is read here for the screen.
  const siteIds = [
    ...new Set(
      (anomalies.data ?? []).flatMap((a) => {
        const id = (a.detail as { site_id?: unknown } | null)?.site_id;
        return typeof id === "string" ? [id] : [];
      }),
    ),
  ];
  const siteNames = new Map<string, string>();
  if (siteIds.length > 0) {
    const { data: sites } = await supabase
      .from("sites")
      .select("id, name")
      .eq("organisation_id", organisationId)
      .in("id", siteIds);
    for (const site of sites ?? []) siteNames.set(site.id, site.name);
  }
  const people = await profileNames(supabase, [
    run.preparedBy,
    ...(run.submittedBy ? [run.submittedBy] : []),
    ...(adjustments.data ?? []).map((a) => a.created_by),
    ...(decisions.data ?? []).map((d) => d.actor_id),
  ]);

  const payslips: PayslipRow[] = (slips.data ?? [])
    .map((s) => {
      const w = workerRows.get(s.worker_id);
      return {
        id: s.id,
        workerId: s.worker_id,
        workerName: w?.name ?? "A worker",
        staffId: w?.staffId ?? "",
        jobTitle: w?.jobTitle ?? null,
        employmentType: s.employment_type,
        taxState: s.tax_state,
        pfaName: s.pfa_name,
        grossKobo: toKobo(s.gross_kobo),
        payeKobo: toKobo(s.paye_kobo),
        pensionEmployeeKobo: toKobo(s.pension_employee_kobo),
        pensionEmployerKobo: toKobo(s.pension_employer_kobo),
        nhfKobo: toKobo(s.nhf_kobo),
        otherDeductionsKobo: toKobo(s.other_deductions_kobo),
        netKobo: toKobo(s.net_kobo),
        nsitfKobo: toKobo(s.nsitf_kobo),
        itfKobo: toKobo(s.itf_kobo),
        employerCostKobo: toKobo(s.employer_cost_kobo),
        carriedForwardKobo: toKobo(s.carried_forward_kobo),
      };
    })
    .sort((a, b) => a.workerName.localeCompare(b.workerName));

  return {
    run,
    ruleSet: ruleSet.data
      ? {
          name: ruleSet.data.name,
          effectiveFrom: ruleSet.data.effective_from,
          adviserConfirmed: ruleSet.data.adviser_confirmed_at !== null,
        }
      : null,
    payslips,
    anomalies: (anomalies.data ?? []).map((a) => ({
      id: a.id,
      workerId: a.worker_id,
      workerName: a.worker_id ? (names.get(a.worker_id) ?? "A worker") : null,
      code: a.code,
      severity: a.severity === "blocking" ? "blocking" : "warning",
      detail: withSiteName((a.detail ?? {}) as Record<string, unknown>, siteNames),
      acknowledgedAt: a.acknowledged_at,
      acknowledgedBy: a.acknowledged_by,
    })),
    adjustments: (adjustments.data ?? []).map((a) => ({
      id: a.id,
      workerId: a.worker_id,
      workerName: names.get(a.worker_id) ?? "A worker",
      kind: a.kind === "deduction" ? "deduction" : "earning",
      label: a.label,
      amountKobo: toKobo(a.amount_kobo),
      pensionable: a.pensionable,
      taxable: a.taxable,
      instalmentNumber: a.instalment_number,
      instalmentCount: a.instalment_count,
      reason: a.reason,
      createdBy: a.created_by,
      createdByName: people.get(a.created_by) ?? null,
      createdAt: a.created_at,
    })),
    decisions: (decisions.data ?? []).map((d) => ({
      id: d.id,
      decision: d.decision === "returned" ? "returned" : "submitted",
      reason: d.reason,
      actorId: d.actor_id,
      actorName: people.get(d.actor_id) ?? null,
      createdAt: d.created_at,
    })),
    items: (itemRows.data ?? [])
      .map((l) => ({
        payslipId: l.payslip_id,
        workerName: payslips.find((p) => p.id === l.payslip_id)?.workerName ?? "A worker",
        code: l.code,
        label: l.label,
        amountKobo: toKobo(l.amount_kobo),
      }))
      .sort((a, b) => a.workerName.localeCompare(b.workerName)),
    workers: payslips.map((p) => ({ id: p.workerId, name: p.workerName, staffId: p.staffId })),
    names: new Map([...names, ...[...people].map(([k, v]) => [k, v] as const)]),
  };
}

export interface PayslipTrace {
  payslipId: string;
  workerId: string;
  workerName: string;
  trace: StoredTrace;
  lines: { position: number; code: string; kind: string; label: string; amountKobo: Kobo }[];
}

/** One payslip's trace and lines, for Explain. */
export async function loadPayslipTrace(
  supabase: Client,
  organisationId: string,
  payslipId: string,
): Promise<PayslipTrace | null> {
  const [slip, lines] = await Promise.all([
    supabase
      .from("payslips")
      .select("id, worker_id, trace")
      .eq("organisation_id", organisationId)
      .eq("id", payslipId)
      .maybeSingle(),
    supabase
      .from("payslip_lines")
      .select("position, code, kind, label, amount_kobo::text")
      .eq("organisation_id", organisationId)
      .eq("payslip_id", payslipId)
      .order("position"),
  ]);
  if (slip.error) throw new Error(`Could not read the payslip (${slip.error.code})`);
  if (lines.error) throw new Error(`Could not read the payslip (${lines.error.code})`);
  if (!slip.data) return null;
  const { data: worker } = await supabase
    .from("workers")
    .select("first_name, last_name")
    .eq("organisation_id", organisationId)
    .eq("id", slip.data.worker_id)
    .maybeSingle();
  return {
    payslipId: slip.data.id,
    workerId: slip.data.worker_id,
    workerName: worker ? fullName(worker) : "A worker",
    trace: slip.data.trace as unknown as StoredTrace,
    lines: (lines.data ?? []).map((l) => ({
      position: l.position,
      code: l.code,
      kind: l.kind,
      label: l.label,
      amountKobo: toKobo(l.amount_kobo),
    })),
  };
}

export interface RunSummary {
  runs: number;
  latest: {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    status: RunStatus;
    workers: number;
    anomaliesOpen: number;
    netKobo: string;
    grossKobo: string;
  } | null;
}

/** Counts and totals only (no names with amounts): the capability registry's read. */
export async function loadRunSummary(
  supabase: Client,
  organisationId: string,
): Promise<RunSummary> {
  const runs = await listRuns(supabase, organisationId);
  const latest = runs[0];
  if (!latest) return { runs: 0, latest: null };
  const { count, error } = await supabase
    .from("payroll_anomalies")
    .select("id", { count: "exact", head: true })
    .eq("organisation_id", organisationId)
    .eq("run_id", latest.id)
    .is("acknowledged_at", null);
  if (error) throw new Error(`Could not count anomalies (${error.code})`);
  return {
    runs: runs.length,
    latest: {
      periodStart: latest.periodStart,
      periodEnd: latest.periodEnd,
      payDate: latest.payDate,
      status: latest.status,
      workers: latest.totals.workerCount,
      anomaliesOpen: count ?? 0,
      netKobo: latest.totals.netKobo.toString(),
      grossKobo: latest.totals.grossKobo.toString(),
    },
  };
}
