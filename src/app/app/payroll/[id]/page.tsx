import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Illustration } from "@/components/illustration";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatLeaveRange } from "@/lib/leave/requests";
import { formatNaira, sumKobo, toKobo, type Kobo } from "@/lib/money";
import { describeAnomaly } from "@/lib/payroll/anomaly-text";
import { TAX_ADVISER_LINE } from "@/lib/payroll/rule-set";
import { negatedTotals } from "@/lib/payroll/reversal";
import {
  REVERSAL_STATUS,
  RUN_STATUS,
  RUN_STEPS,
  runMonth,
  runStep,
  type RunStepId,
} from "@/lib/payroll/run-format";
import { authorityLabel } from "@/lib/payroll/statutory";
import { traceLess, traceNaira } from "@/lib/payroll/trace";
import { cn } from "@/lib/utils";
import { loadPayslipTrace, loadRunDetail, type RunDetail } from "@/server/payroll/run-data";
import { canMakeBankFile } from "@/server/payroll/payouts";
import { canDecidePayroll, canPreparePayroll } from "@/server/payroll/runs";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import {
  AcknowledgeForm,
  AddAdjustmentForm,
  ApproveRunForm,
  CarryInstalmentForm,
  RecalculateForm,
  RemoveAdjustmentForm,
  ReturnRunForm,
  SubmitRunForm,
} from "../_components/run-forms";
import { PayStep } from "../_components/pay-step";
import {
  AddCorrectionForm,
  ApproveReversalForm,
  DeclineReversalForm,
  ReverseRunForm,
} from "../_components/reversal-forms";

export const metadata: Metadata = { title: "Payroll run" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const naira = (k: Kobo) => formatNaira(k, { whole: true });
const TH = "px-3 py-2.5 text-left font-semibold whitespace-nowrap";
const THN = "px-3 py-2.5 text-right font-semibold whitespace-nowrap";
const TD = "px-3 py-3 whitespace-nowrap";
const TDN = "px-3 py-3 text-right tabular-nums whitespace-nowrap";
const DECISION_LABEL = {
  submitted: "Submitted",
  returned: "Returned",
  approved: "Approved",
  released: "Released",
  reversed: "Reversed",
} as const;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Tile({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line p-4" data-testid={testId}>
      <span className="type-label text-fg-muted">{label}</span>
      <span className="font-heading text-xl font-medium">{value}</span>
    </div>
  );
}

function StepNav({ runId, step }: { runId: string; step: RunStepId }) {
  const current = RUN_STEPS.findIndex((s) => s.id === step);
  return (
    <ol
      aria-label="Steps"
      className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4 lg:grid-cols-7"
    >
      {RUN_STEPS.map((s, i) => (
        <li key={s.id} className="flex">
          <Link
            href={`/app/payroll/${runId}?step=${s.id}`}
            aria-current={i === current ? "step" : undefined}
            className={cn(
              "flex h-11 w-full items-center gap-2.5 rounded-lg border px-3 text-sm font-medium no-underline",
              i === current
                ? "border-foreground bg-foreground text-background hover:text-background"
                : i < current
                  ? "border-surface bg-surface text-foreground hover:text-foreground"
                  : "border-line bg-background text-fg-muted hover:text-foreground",
            )}
          >
            <span className="font-heading text-[13px] font-bold">{i < current ? "✓" : i + 1}</span>
            <span>{s.label}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function PeriodStep({ d, canPrepare, canDecide }: StepProps) {
  const { run } = d;
  const sites = new Set(
    d.anomalies.filter((a) => a.code === "open_timesheet_days").map((a) => a.detail.site_name),
  );
  return (
    <section aria-labelledby="period" className="flex flex-col gap-4">
      <h2 id="period" className="sr-only">
        Period
      </h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
        <Tile label="Pay period" value={formatLeaveRange(run.periodStart, run.periodEnd)} />
        <Tile label="Pay date" value={formatDate(run.payDate)} />
        <Tile
          label="Workers in run"
          value={`${run.totals.workerCount}${sites.size > 0 ? ` · ${sites.size} sites with open days` : ""}`}
          testId="workers-in-run"
        />
      </div>
      <p className="m-0 text-sm text-fg-muted">
        Rule set {d.ruleSet?.name ?? "not found"}
        {d.ruleSet ? `, in force from ${formatDate(d.ruleSet.effectiveFrom)}` : ""}: the version in
        force on the pay date, for the whole run.{" "}
        {run.calculatedAt
          ? `Last worked out ${formatDateTime(run.calculatedAt)}.`
          : "Not worked out yet."}
        {run.needsRecalculation ? " Something changed since: recalculate before submitting." : ""}
      </p>
      {run.status === "review" && run.kind !== "reversal" ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-line p-6 text-center">
          <Illustration name="payroll-ready" size="empty" decorative />
          <p className="m-0 type-body-lg">
            Waiting for Finance approval. A different person from the one who prepared it must
            approve.
          </p>
        </div>
      ) : null}
      {run.kind !== "reversal" && (run.status === "approved" || run.status === "released") ? (
        <PostedNote d={d} />
      ) : null}
      {canDecide ? <ReversePanel d={d} /> : null}
      {run.status === "draft" && canPrepare ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-5">
          <h3 className="m-0 type-h3">Recalculate</h3>
          <p className="m-0 text-sm text-fg-muted">
            Works the run out again from today&apos;s pay rates, approved timesheets, leave and
            adjustments. You see the new totals against this draft before saving.
          </p>
          <RecalculateForm runId={run.id} />
        </div>
      ) : null}
      {run.status === "review" && canDecide && run.kind !== "reversal" ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-5">
          <h3 className="m-0 type-h3">Return to HR</h3>
          <p className="m-0 text-sm text-fg-muted">
            Sends the run back as a draft with your reason. To approve it, open the Submit step.
          </p>
          <ReturnRunForm runId={run.id} />
        </div>
      ) : null}
      {d.decisions.length > 0 ? (
        <section aria-labelledby="history" className="flex flex-col gap-2">
          <h3 id="history" className="m-0 type-h3">
            History
          </h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {d.decisions.map((x) => (
              <li key={x.id} className="rounded-lg border border-line px-3 py-2.5 text-sm">
                {DECISION_LABEL[x.decision]} by {x.actorName ?? "a manager"} ·{" "}
                {formatDateTime(x.createdAt)}
                {x.reason ? <span className="block text-fg-muted">{x.reason}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function TimesheetsStep({ d }: StepProps) {
  const open = d.anomalies.filter((a) => a.code === "open_timesheet_days");
  const days = open.reduce(
    (n, a) => n + (typeof a.detail.days === "number" ? a.detail.days : 0),
    0,
  );
  return (
    <section aria-labelledby="timesheets" className="flex flex-col gap-3">
      <h2 id="timesheets" className="m-0 type-h2">
        {days === 0
          ? "No timesheet days still open"
          : `${days} timesheet ${days === 1 ? "day still blocks" : "days still block"} this run`}
      </h2>
      <p className="m-0 text-[15px] text-fg-muted">
        Only approved days are paid. Pending and disputed days wait for a decision, or are
        acknowledged on the Anomalies step and paid next run.
      </p>
      {open.length > 0 ? (
        <div className="relative overflow-x-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-sm" aria-label="Open days by site">
            <thead className="bg-surface">
              <tr>
                <th className={TH}>Site</th>
                <th className={THN}>Open</th>
                <th className={TH}>Flags</th>
                <th className={TH}>
                  <span className="sr-only">Review</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {open.map((a) => (
                <tr key={a.id} className="border-t border-line">
                  <td className={cn(TD, "font-semibold")}>{String(a.detail.site_name ?? "")}</td>
                  <td className={TDN}>{String(a.detail.days ?? 0)}</td>
                  <td className="px-3 py-3">
                    {Array.isArray(a.detail.reasons)
                      ? (a.detail.reasons as string[]).join(" · ").replace(/_/g, " ")
                      : ""}
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <Link
                      href={`/app/timesheets${typeof a.detail.site_id === "string" ? `?site=${a.detail.site_id}` : ""}`}
                      className="text-signal"
                    >
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function EarningsStep({ d, canPrepare }: StepProps) {
  const draft = d.run.status === "draft";
  return (
    <section aria-labelledby="earnings" className="flex flex-col gap-3">
      <h2 id="earnings" className="m-0 type-h2">
        Earnings and one-off changes
      </h2>
      {d.items.length + d.adjustments.length === 0 ? (
        <p className="m-0 text-[15px] text-fg-muted">
          Salaries only this run: no overtime, off-day, holiday or leave lines, and no one-off
          changes.
        </p>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-sm" aria-label="Earnings and changes">
            <thead className="bg-surface">
              <tr>
                <th className={TH}>Worker</th>
                <th className={TH}>Item</th>
                <th className={THN}>Amount</th>
                <th className={TH}>Added by</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i, n) => (
                <tr key={`${i.payslipId}-${n}`} className="border-t border-line">
                  <td className={cn(TD, "font-semibold")}>{i.workerName}</td>
                  <td className="px-3 py-3">{i.label}</td>
                  <td className={TDN}>{formatNaira(i.amountKobo)}</td>
                  <td className={cn(TD, "text-fg-muted")}>
                    {i.code === "leave_deduction" ? "From leave" : "From timesheets"}
                  </td>
                </tr>
              ))}
              {d.adjustments.map((a) => (
                <tr key={a.id} className="border-t border-line align-top">
                  <td className={cn(TD, "font-semibold")}>{a.workerName}</td>
                  <td className="px-3 py-3">
                    {a.label}
                    <span className="block text-xs text-fg-muted">{a.reason}</span>
                  </td>
                  <td className={TDN}>
                    {a.kind === "deduction" ? "−" : ""}
                    {formatNaira(a.amountKobo)}
                  </td>
                  <td className="px-3 py-3 text-fg-muted">
                    {a.createdByName ?? "HR"}
                    {a.instalmentCount > 1
                      ? ` · ${a.instalmentNumber} of ${a.instalmentCount}`
                      : " · one-off"}
                    {draft && canPrepare ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-signal">Remove</summary>
                        <div className="mt-2 w-64 max-w-full">
                          <RemoveAdjustmentForm adjustmentId={a.id} label={a.label} />
                        </div>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-0 text-[13px] text-fg-muted">
        Gross pay on the Gross to net step already includes these items. Earnings are taxed and
        count toward pension only when marked; deductions come off after tax.
      </p>
      {draft && canPrepare ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-5">
          <h3 className="m-0 type-h3">Add an earning or deduction</h3>
          <AddAdjustmentForm runId={d.run.id} workers={d.workers} />
        </div>
      ) : null}
      {draft && canPrepare && d.correctable.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-5">
          <h3 className="m-0 type-h3">Correct a released payslip</h3>
          <p className="m-0 text-sm text-fg-muted">
            A released payslip never changes: the money has gone. Add the difference here, naming
            the payslip it corrects.
          </p>
          <AddCorrectionForm
            runId={d.run.id}
            payslips={d.correctable.map((p) => ({
              id: p.id,
              label: `${p.workerName} · ${runMonth(p.periodEnd)} · net ${naira(p.netKobo)}`,
            }))}
          />
        </div>
      ) : null}
    </section>
  );
}

function AnomaliesStep({ d, canPrepare }: StepProps) {
  const items = d.anomalies.map((a) => ({
    id: a.id,
    severity: a.severity,
    acknowledged: a.acknowledgedAt !== null,
    ...describeAnomaly(a.code, a.detail, a.workerName, (id) => d.names.get(id) ?? "A worker"),
  }));
  const blocking = items.filter((a) => a.severity === "blocking").length;
  const open = items.filter((a) => a.severity === "warning" && !a.acknowledged).length;
  return (
    <section aria-labelledby="anomalies" className="flex flex-col gap-3">
      <h2 id="anomalies" className="m-0 type-h2">
        {items.length === 0
          ? "No anomalies"
          : `${open} of ${items.length - blocking} anomalies to acknowledge${blocking > 0 ? ` · ${blocking} blocking` : ""}`}
      </h2>
      <p className="m-0 text-[15px] text-fg-muted">
        Acknowledge each one before submitting; blocking ones are fixed and recalculated. Finance
        sees the same list when approving.
      </p>
      {items.length > 0 ? (
        <AcknowledgeForm
          runId={d.run.id}
          anomalies={items}
          canAcknowledge={canPrepare && d.run.status === "draft"}
        />
      ) : null}
      {canPrepare && d.run.status === "draft"
        ? d.anomalies
            .filter(
              (a) => a.code === "recurring_not_carried" && typeof a.detail.series_id === "string",
            )
            .map((a) => (
              <div key={a.id} className="flex flex-col gap-2 rounded-xl border border-line p-4">
                <p className="m-0 text-sm font-semibold">
                  Recurring item not carried · {a.workerName ?? "A worker"}
                </p>
                <CarryInstalmentForm
                  runId={d.run.id}
                  seriesId={String(a.detail.series_id)}
                  label={`Carry the next instalment for ${a.workerName ?? "a worker"}`}
                />
              </div>
            ))
        : null}
    </section>
  );
}

const PAYE_STEPS = new Set([
  "annual_gross",
  "annual_pension",
  "annual_nhf",
  "rent_relief",
  "taxable",
  "paye_band",
  "paye",
]);
const LESS_STEPS = new Set(["annual_pension", "annual_nhf", "rent_relief"]);

async function ExplainPanel({ d, payslipId }: { d: RunDetail; payslipId: string }) {
  const ctx = await peoplePageContext();
  const explained = await loadPayslipTrace(ctx.supabase, ctx.organisationId, payslipId);
  if (!explained) return null;
  const steps = explained.trace.steps ?? [];
  const value = (v: string | null) => (v === null ? null : toKobo(v));
  const paye = steps.filter((s) => PAYE_STEPS.has(s.step));
  const exempt = steps.some((s) => s.step === "daily_worker");
  return (
    <section
      aria-labelledby="explain"
      data-testid="explain"
      className="flex flex-col gap-3 rounded-xl border border-line p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="explain" className="m-0 type-h3">
          How {explained.workerName}&apos;s PAYE is worked out
        </h3>
        <span className="type-label text-fg-muted">Yearly figures, then ÷ 12</span>
      </div>
      {exempt ? (
        <p className="m-0 text-sm">Daily worker: no PAYE, pension, NHF, NSITF or ITF.</p>
      ) : (
        <dl className="m-0 grid max-w-2xl grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 text-sm">
          {paye.map((s, i) => {
            const v = value(s.value_kobo) ?? 0n;
            const strong = s.step === "taxable" || s.step === "paye";
            return (
              <div key={`${s.step}-${i}`} className="contents">
                <dt className={cn(strong && "font-semibold")}>{s.label}</dt>
                <dd className={cn("m-0 text-right tabular-nums", strong && "font-semibold")}>
                  {LESS_STEPS.has(s.step) ? traceLess(v) : traceNaira(v)}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-signal">Every step</summary>
        <ol className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          {steps.map((s, i) => (
            <li
              key={`${s.step}-${i}`}
              className="flex flex-col gap-0.5 border-b border-line pb-2 text-sm sm:flex-row sm:justify-between sm:gap-4"
            >
              <span>
                <span className="font-medium">{s.label}</span>
                <span className="block text-[13px] text-fg-muted">{s.formula}</span>
              </span>
              <span className="tabular-nums">
                {s.value_kobo === null ? "" : traceNaira(toKobo(s.value_kobo))}
              </span>
            </li>
          ))}
        </ol>
      </details>
      <p className="m-0 text-[13px] text-fg-muted">
        Rule set {d.ruleSet?.name ?? ""}.{" "}
        {d.ruleSet?.adviserConfirmed ? "Confirmed by your tax adviser." : TAX_ADVISER_LINE}
      </p>
    </section>
  );
}

function GrossToNetStep({ d, explain }: StepProps & { explain: string | undefined }) {
  const s = d.payslips;
  const total = (pick: (p: (typeof s)[number]) => Kobo) => sumKobo(s.map(pick));
  const nhfAny = s.some((p) => p.nhfKobo > 0n);
  const explainId = explain && s.some((p) => p.id === explain) ? explain : undefined;
  return (
    <section aria-labelledby="gross-to-net" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="gross-to-net" className="m-0 type-h2">
          Gross to net
        </h2>
        <span className="text-[13px] text-fg-muted">
          {s.length} {s.length === 1 ? "worker" : "workers"}
        </span>
      </div>
      {d.ruleSet && !d.ruleSet.adviserConfirmed ? (
        <p className="m-0 rounded-lg border border-foreground bg-surface px-3 py-2.5 text-sm font-medium">
          {TAX_ADVISER_LINE}
        </p>
      ) : null}
      <div className="relative overflow-x-auto rounded-xl border border-line">
        <table className="w-full border-collapse text-sm" aria-label="Gross to net">
          <thead className="bg-surface">
            <tr>
              <th className={TH}>Worker</th>
              <th className={THN}>Gross</th>
              <th className={THN}>PAYE</th>
              <th className={THN}>Pension 8%</th>
              <th className={THN}>NHF</th>
              <th className={THN}>Net pay</th>
              <th className={THN}>Employer pension 10%</th>
              <th className={THN}>Employer cost</th>
              <th className={TH}>
                <span className="sr-only">Explain</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {s.map((p) => (
              <tr
                key={p.id}
                data-testid="gross-to-net-row"
                className={cn(
                  "border-t border-line",
                  p.id === explainId && "shadow-[inset_0_0_0_1.5px_var(--signal)]",
                )}
              >
                <td className={TD}>
                  <span className="flex flex-col">
                    <span className="font-semibold">{p.workerName}</span>
                    <span className="text-xs text-fg-muted">
                      {[p.staffId, p.jobTitle].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </td>
                <td className={TDN}>{naira(p.grossKobo)}</td>
                <td className={TDN}>{naira(p.payeKobo)}</td>
                <td className={TDN}>{naira(p.pensionEmployeeKobo)}</td>
                <td className={cn(TDN, p.nhfKobo === 0n && "text-fg-muted")}>
                  {p.nhfKobo === 0n ? "—" : naira(p.nhfKobo)}
                </td>
                <td className={cn(TDN, "font-semibold")}>{naira(p.netKobo)}</td>
                <td className={TDN}>{naira(p.pensionEmployerKobo)}</td>
                <td className={TDN}>{naira(p.employerCostKobo)}</td>
                <td className={cn(TD, "text-right")}>
                  <Link
                    href={`/app/payroll/${d.run.id}?step=gross-to-net&explain=${p.id}#explain`}
                    className="text-signal"
                    aria-label={`Explain ${p.workerName}`}
                  >
                    Explain
                  </Link>
                </td>
              </tr>
            ))}
            <tr className="bg-surface" data-testid="gross-to-net-totals">
              <td className={cn(TD, "font-semibold")}>
                {s.length === d.run.totals.workerCount ? `These ${s.length} workers` : "Total"}
              </td>
              <td className={cn(TDN, "font-semibold")}>{naira(total((p) => p.grossKobo))}</td>
              <td className={cn(TDN, "font-semibold")}>{naira(total((p) => p.payeKobo))}</td>
              <td className={cn(TDN, "font-semibold")}>
                {naira(total((p) => p.pensionEmployeeKobo))}
              </td>
              <td className={TDN}>{nhfAny ? naira(total((p) => p.nhfKobo)) : "—"}</td>
              <td className={cn(TDN, "font-semibold")}>{naira(total((p) => p.netKobo))}</td>
              <td className={cn(TDN, "font-semibold")}>
                {naira(total((p) => p.pensionEmployerKobo))}
              </td>
              <td className={cn(TDN, "font-semibold")}>
                {naira(total((p) => p.employerCostKobo))}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="m-0 text-[13px] text-fg-muted">
        Employer cost adds 10% pension, 1% NSITF
        {d.run.itfApplies
          ? " and a 1% ITF accrual"
          : " (ITF doesn't apply: under 5 in the levy base)"}
        . NHF applies only to workers who opted in.
      </p>
      {explainId ? <ExplainPanel d={d} payslipId={explainId} /> : null}
    </section>
  );
}

function SubmitStep({ d, canPrepare, canDecide }: StepProps) {
  const { run } = d;
  if (run.kind === "reversal") return <ReversalStep d={d} canDecide={canDecide} />;
  const t = run.totals;
  const byState = new Map<string | null, Kobo>();
  const pfas = new Set<string>();
  for (const p of d.payslips) {
    if (p.payeKobo > 0n) {
      const key = p.taxState;
      byState.set(key, (byState.get(key) ?? 0n) + p.payeKobo);
    }
    if (p.pensionEmployeeKobo + p.pensionEmployerKobo > 0n && p.pfaName) pfas.add(p.pfaName);
  }
  const blocking = d.anomalies.filter((a) => a.severity === "blocking").length;
  const acked = d.anomalies.filter((a) => a.acknowledgedAt !== null).length;
  const preparer = d.names.get(run.preparedBy) ?? "a manager";
  return (
    <section aria-labelledby="submit" className="flex max-w-3xl flex-col gap-4">
      <h2 id="submit" className="m-0 type-h2">
        {run.status === "draft" ? "Submit for approval" : "Approval"}
      </h2>
      <dl
        className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2.5 rounded-xl border border-line p-5 text-[15px]"
        data-testid="control-totals"
      >
        <dt>
          Net pay to {t.workerCount} {t.workerCount === 1 ? "worker" : "workers"}
        </dt>
        <dd className="m-0 text-right font-semibold tabular-nums">{naira(t.netKobo)}</dd>
        {[...byState].map(([state, amount]) => (
          <div key={state ?? ""} className="contents">
            <dt>PAYE to {authorityLabel("paye", state)}</dt>
            <dd className="m-0 text-right tabular-nums">{naira(amount)}</dd>
          </div>
        ))}
        {byState.size === 0 ? (
          <>
            <dt>PAYE</dt>
            <dd className="m-0 text-right tabular-nums">{naira(t.payeKobo)}</dd>
          </>
        ) : null}
        <dt>
          Pension to {pfas.size} {pfas.size === 1 ? "PFA" : "PFAs"} (8% + 10%)
        </dt>
        <dd className="m-0 text-right tabular-nums">
          {naira(t.pensionEmployeeKobo + t.pensionEmployerKobo)}
        </dd>
        <dt>NSITF 1%{run.itfApplies ? " · ITF 1% accrual" : ""}</dt>
        <dd className="m-0 text-right tabular-nums">{naira(t.nsitfKobo + t.itfKobo)}</dd>
        <dt>Anomalies acknowledged</dt>
        <dd className="m-0 text-right tabular-nums" data-testid="acknowledged-count">
          {acked} of {d.anomalies.length}
          {blocking > 0 ? ` · ${blocking} blocking` : ""}
        </dd>
      </dl>
      <p className="m-0 text-sm text-fg-muted">
        Prepared by {preparer}. A different person in Finance must approve before any payment file
        is released. Metalira never holds the money: the company pays from its own bank account.
      </p>
      {run.status === "draft" && canPrepare ? <SubmitRunForm runId={run.id} /> : null}
      {run.status === "review" ? (
        <p role="status" className="m-0 flex items-center gap-2 font-semibold">
          <Status tone="action">Waiting for Finance approval</Status>
          {run.submittedAt ? (
            <span className="text-sm font-normal text-fg-muted">
              · submitted {formatDateTime(run.submittedAt)}
            </span>
          ) : null}
        </p>
      ) : null}
      {run.status === "review" && canDecide ? <ApprovalPanel d={d} /> : null}
      {run.status === "approved" || run.status === "released" ? <PostedNote d={d} /> : null}
      {canDecide ? <ReversePanel d={d} /> : null}
    </section>
  );
}

/**
 * "Reverse this run" (slice 5.7a): on an approved run that isn't released, for Finance or the
 * owner. A reversal waiting for approval is linked from the banner instead. A released run is
 * corrected in a later run, never reversed.
 */
function ReversePanel({ d }: { d: RunDetail }) {
  const { run } = d;
  if (run.kind === "reversal" || run.status !== "approved") return null;
  if (d.reversals.some((r) => r.status === "review")) return null;
  return (
    <section
      aria-labelledby="reverse"
      className="flex flex-col gap-3 rounded-xl border border-line p-5"
      data-testid="reverse-panel"
    >
      <h3 id="reverse" className="m-0 type-h3">
        Reverse this run
      </h3>
      <p className="m-0 text-sm text-fg-muted">
        Before release only: the bank file hasn&apos;t paid anyone yet. A reversal copies every
        payslip as a negative and waits for a second person in Finance. Once approved the run is
        Reversed, its bank file and statutory remittances are voided, its adjustments are carried
        into the period&apos;s next run, and {formatLeaveRange(run.periodStart, run.periodEnd)}{" "}
        opens again so its days can be paid in a new run.
      </p>
      <ReverseRunForm runId={run.id} downloaded={d.activeFileDownloaded} />
    </section>
  );
}

/** A reversal run's Submit step: its negative totals, why, and approve or decline. */
function ReversalStep({ d, canDecide }: { d: RunDetail; canDecide: boolean }) {
  const { run, original } = d;
  const t = negatedTotals(run.totals);
  const asked = d.decisions.find((x) => x.decision === "submitted");
  const requester = d.names.get(run.preparedBy) ?? "a manager";
  const month = runMonth(original?.periodEnd ?? run.periodEnd);
  return (
    <section aria-labelledby="reversal" className="flex max-w-3xl flex-col gap-4">
      <h2 id="reversal" className="m-0 type-h2">
        Reversal of {month}
      </h2>
      <dl
        className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2.5 rounded-xl border border-line p-5 text-[15px]"
        data-testid="reversal-totals"
      >
        <dt>
          Net pay, {t.workerCount} {t.workerCount === 1 ? "payslip" : "payslips"}
        </dt>
        <dd className="m-0 text-right font-semibold tabular-nums">{naira(t.netKobo)}</dd>
        <dt>Gross pay</dt>
        <dd className="m-0 text-right tabular-nums">{naira(t.grossKobo)}</dd>
        <dt>PAYE</dt>
        <dd className="m-0 text-right tabular-nums">{naira(t.payeKobo)}</dd>
        <dt>Pension (8% + 10%)</dt>
        <dd className="m-0 text-right tabular-nums">
          {naira(t.pensionEmployeeKobo + t.pensionEmployerKobo)}
        </dd>
        <dt>NSITF and ITF</dt>
        <dd className="m-0 text-right tabular-nums">{naira(t.nsitfKobo + t.itfKobo)}</dd>
        <dt>Employer cost</dt>
        <dd className="m-0 text-right tabular-nums">{naira(t.employerCostKobo)}</dd>
      </dl>
      <p className="m-0 text-sm text-fg-muted">
        Asked for by {requester}
        {asked ? ` · ${formatDateTime(asked.createdAt)}` : ""}
        {asked?.reason ? `: "${asked.reason}"` : ""}. Every payslip of {month} is copied as a
        negative, so the two sum to ₦0. A different person must approve it.
      </p>
      {run.status === "review" ? (
        <p role="status" className="m-0 flex items-center gap-2 font-semibold">
          <Status tone="action">Waiting for approval</Status>
        </p>
      ) : null}
      {run.status === "review" && canDecide ? (
        <section
          aria-labelledby="approve-reversal"
          className="flex flex-col gap-4 rounded-xl border border-line p-5"
          data-testid="reversal-approval"
        >
          <h3 id="approve-reversal" className="m-0 type-h3">
            Approve or decline
          </h3>
          <p className="m-0 text-sm text-fg-muted">
            Approving reverses {month} in one step: its bank file and statutory remittances are
            voided, its timesheet days and leave become payable again, its adjustments (one-offs,
            instalments and corrections) are carried into the period&apos;s next run, and the period
            reopens for a new run. A remittance already paid stays on record for a refund or an
            offset.
          </p>
          <ApproveReversalForm runId={run.id} downloaded={d.activeFileDownloaded} />
          <details className="rounded-lg border border-line px-3 py-2.5">
            <summary className="cursor-pointer text-sm font-medium">Decline instead</summary>
            <div className="pt-3">
              <DeclineReversalForm runId={run.id} />
            </div>
          </details>
        </section>
      ) : null}
      {run.status === "approved" ? (
        <p
          role="status"
          className="m-0 flex flex-wrap items-center gap-2 rounded-xl border border-line p-4 text-sm"
          data-testid="reversal-approved"
        >
          <Status tone="done">Reversal approved</Status>
          <span>
            by {(run.approvedBy && d.names.get(run.approvedBy)) ?? "a manager"}
            {run.approvedAt ? ` · ${formatDateTime(run.approvedAt)}` : ""}. {month} is reversed and{" "}
            {formatLeaveRange(run.periodStart, run.periodEnd)} is open for a new run.
          </span>
        </p>
      ) : null}
      {run.status === "draft" ? (
        <p role="status" className="m-0 flex flex-wrap items-center gap-2 text-sm">
          <Status tone="pending">Reversal declined</Status>
          <span className="text-fg-muted">
            The run stays approved. Ask for a new reversal if one is needed.
          </span>
        </p>
      ) : null}
    </section>
  );
}

/** Links between a run and its reversal (slice 5.7a), above the steps. */
function ReversalBanner({ d }: { d: RunDetail }) {
  const { run, original } = d;
  if (run.kind === "reversal") {
    return (
      <p
        className="m-0 flex flex-wrap items-center gap-2 rounded-xl border border-line p-4 text-sm"
        data-testid="reversal-banner"
      >
        <span>
          This reverses{" "}
          {original ? (
            <Link href={`/app/payroll/${original.id}`} className="text-signal">
              {runMonth(original.periodEnd)} payroll
            </Link>
          ) : (
            "a payroll run"
          )}
          . Its amounts count negatively and pay nothing: no bank file and no remittances.
        </span>
      </p>
    );
  }
  const approved = d.reversals.find((r) => r.status === "approved");
  const waiting = d.reversals.find((r) => r.status === "review");
  if (run.status === "reversed") {
    return (
      <p
        role="status"
        className="m-0 flex flex-wrap items-center gap-2 rounded-xl border border-line p-4 text-sm"
        data-testid="reversed-banner"
      >
        <Status tone="partial">Reversed</Status>
        <span>
          These payslips no longer stand: the bank file and remittances are voided and the period is
          open for a new run.
        </span>
        {approved ? (
          <Link href={`/app/payroll/${approved.id}?step=submit`} className="text-signal">
            See the reversal
          </Link>
        ) : null}
      </p>
    );
  }
  if (waiting) {
    return (
      <p
        role="status"
        className="m-0 flex flex-wrap items-center gap-2 rounded-xl border border-line p-4 text-sm"
        data-testid="reversal-waiting"
      >
        <Status tone="action">Reversal waiting for approval</Status>
        <span>The run can&apos;t be released until it is decided.</span>
        <Link href={`/app/payroll/${waiting.id}?step=submit`} className="text-signal">
          Open the reversal
        </Link>
      </p>
    );
  }
  return null;
}

/** What the approver checks: every acknowledged anomaly, then Approve or Return. */
function ApprovalPanel({ d }: { d: RunDetail }) {
  const acked = d.anomalies.filter((a) => a.acknowledgedAt !== null);
  return (
    <section
      aria-labelledby="approve"
      className="flex flex-col gap-4 rounded-xl border border-line p-5"
      data-testid="approval-panel"
    >
      <h3 id="approve" className="m-0 type-h3">
        Approve or return
      </h3>
      <p className="m-0 text-sm text-fg-muted">
        Check the control totals above and every anomaly HR acknowledged. Approving re-checks the
        timesheets, pay rates, leave and bank details the run was worked out from, then posts the
        payslips: they never change after, and the period&apos;s timesheets lock. Only someone who
        didn&apos;t prepare or change the run can approve it.
      </p>
      {acked.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Acknowledged anomalies">
          {acked.map((a) => {
            const text = describeAnomaly(
              a.code,
              a.detail,
              a.workerName,
              (id) => d.names.get(id) ?? "A worker",
            );
            return (
              <li key={a.id} className="rounded-lg border border-line px-3 py-2.5 text-sm">
                <span className="block font-medium">{text.title}</span>
                <span className="block text-fg-muted">
                  Acknowledged by{" "}
                  {(a.acknowledgedBy && d.names.get(a.acknowledgedBy)) ?? "a manager"}
                  {a.acknowledgedAt ? ` · ${formatDateTime(a.acknowledgedAt)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 text-sm">No anomalies were acknowledged on this run.</p>
      )}
      <ApproveRunForm runId={d.run.id} />
      <details className="rounded-lg border border-line px-3 py-2.5">
        <summary className="cursor-pointer text-sm font-medium">Return to HR instead</summary>
        <div className="pt-3">
          <ReturnRunForm runId={d.run.id} />
        </div>
      </details>
    </section>
  );
}

/** A posted run: who approved it and what that means. */
function PostedNote({ d }: { d: RunDetail }) {
  const { run } = d;
  return (
    <p
      role="status"
      className="m-0 flex flex-wrap items-center gap-2 rounded-xl border border-line p-4 text-sm"
      data-testid="posted-note"
    >
      <Status tone="done">Approved</Status>
      <span>
        by {(run.approvedBy && d.names.get(run.approvedBy)) ?? "a manager"}
        {run.approvedAt ? ` · ${formatDateTime(run.approvedAt)}` : ""}. The payslips are posted and
        never change; timesheet days in {formatLeaveRange(run.periodStart, run.periodEnd)} are
        locked, and days approved from now on are paid in the next run.{" "}
        <Link href={`/app/payroll/remittances?run=${run.id}`} className="text-signal">
          Statutory remittances
        </Link>
      </span>
      <Link href={`/app/payroll/${run.id}/payslips`} className="text-signal">
        Payslips and PDFs
      </Link>
    </p>
  );
}

interface StepProps {
  d: RunDetail;
  canPrepare: boolean;
  canDecide: boolean;
}

async function RunPage({
  params,
  searchParams,
}: {
  params: PageProps<"/app/payroll/[id]">["params"];
  searchParams: PageProps<"/app/payroll/[id]">["searchParams"];
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const ctx = await peoplePageContext();
  const d = await loadRunDetail(ctx.supabase, ctx.organisationId, id);
  if (!d) notFound();
  const step = runStep(first(query.step));
  const reversal = d.run.kind === "reversal";
  const props: StepProps = {
    d,
    // A reversal run is made whole by the database: nobody prepares, adjusts or submits it.
    canPrepare: canPreparePayroll(ctx.role) && !reversal,
    canDecide: canDecidePayroll(ctx.role),
  };
  const index = RUN_STEPS.findIndex((s) => s.id === step);
  const prev = RUN_STEPS[index - 1];
  const next = RUN_STEPS[index + 1];
  const status = (reversal ? REVERSAL_STATUS : RUN_STATUS)[d.run.status];
  const shownNet = reversal ? -d.run.totals.netKobo : d.run.totals.netKobo;

  return (
    <>
      <PageHeader
        back={{ href: "/app/payroll", label: "Payroll run" }}
        eyebrow={`${formatLeaveRange(d.run.periodStart, d.run.periodEnd)} · pay date ${formatDate(d.run.payDate)}`}
        title={
          reversal
            ? `Reversal of ${runMonth(d.run.periodEnd)} payroll`
            : `Run ${runMonth(d.run.periodEnd)} payroll`
        }
        description={`${d.run.totals.workerCount} workers · net pay ${naira(shownNet)} · rule set ${d.ruleSet?.name ?? ""}${d.ruleSet ? ` · effective ${formatDate(d.ruleSet.effectiveFrom)}` : ""}`}
        actions={<Status tone={status.tone}>{status.label}</Status>}
      />
      <ReversalBanner d={d} />
      <StepNav runId={d.run.id} step={step} />
      {step === "period" ? <PeriodStep {...props} /> : null}
      {step === "timesheets" ? <TimesheetsStep {...props} /> : null}
      {step === "earnings" ? <EarningsStep {...props} /> : null}
      {step === "anomalies" ? <AnomaliesStep {...props} /> : null}
      {step === "gross-to-net" ? (
        <GrossToNetStep {...props} explain={first(query.explain)} />
      ) : null}
      {step === "submit" ? <SubmitStep {...props} /> : null}
      {step === "pay" ? <PayStep d={d} canMake={canMakeBankFile(ctx.role)} /> : null}
      <nav
        aria-label="Step navigation"
        className="flex justify-between gap-3 border-t border-line pt-3"
      >
        {prev ? (
          <Link
            href={`/app/payroll/${d.run.id}?step=${prev.id}`}
            className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-medium text-foreground no-underline hover:bg-surface hover:text-foreground"
          >
            Back
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            href={`/app/payroll/${d.run.id}?step=${next.id}`}
            className="inline-flex h-10 items-center rounded-lg border border-foreground bg-foreground px-4 text-sm font-semibold text-background no-underline hover:text-background"
          >
            Next: {next.label}
          </Link>
        ) : null}
      </nav>
    </>
  );
}

export default function Page({ params, searchParams }: PageProps<"/app/payroll/[id]">) {
  return (
    <RouteGate href="/app/payroll/[id]">
      <RunPage params={params} searchParams={searchParams} />
    </RouteGate>
  );
}
