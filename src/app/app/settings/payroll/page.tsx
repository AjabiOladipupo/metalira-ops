import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatNaira } from "@/lib/money";
import {
  TAX_ADVISER_LINE,
  diffRuleSets,
  formatBps,
  ruleSetFigures,
  type RuleSet,
} from "@/lib/payroll/rule-set";
import { canConfirmPayrollRules, canEditPayrollRules } from "@/server/payroll/rule-sets";
import { loadPayrollRules, type RuleSetVersion } from "@/server/payroll/rule-sets-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import { ConfirmAdviserForm } from "./_components/payroll-rules-forms";

export const metadata: Metadata = { title: "Payroll rules" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** "First ₦800,000", "Next ₦2,200,000", "Above ₦50,000,000". */
function bandRows(set: RuleSet): { band: string; rate: string }[] {
  let lower = 0n;
  return set.rules.payeBands.map((b, i) => {
    const band =
      b.widthKobo === null
        ? `Above ${formatNaira(lower, { whole: true })}`
        : `${i === 0 ? "First" : "Next"} ${formatNaira(b.widthKobo, { whole: true })}`;
    if (b.widthKobo !== null) lower += b.widthKobo;
    return { band, rate: formatBps(b.rateBps) };
  });
}

function dates(v: RuleSetVersion): string {
  return v.effectiveTo
    ? `${formatDate(v.effectiveFrom)} to ${formatDate(v.effectiveTo)}`
    : `From ${formatDate(v.effectiveFrom)}`;
}

function FigureList({ set }: { set: RuleSet }) {
  const figures = ruleSetFigures(set).filter((f) => !f.key.startsWith("paye_band_"));
  return (
    <dl className="m-0 flex flex-col divide-y divide-line rounded-xl border border-line">
      {figures.map((f) => (
        <div key={f.key} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-sm font-semibold sm:w-44">{f.label}</dt>
          <dd className="m-0 text-sm">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

async function PayrollRulesPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/settings/payroll">["searchParams"];
}) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const rules = await loadPayrollRules(ctx.supabase, ctx.organisationId);
  const canEdit = canEditPayrollRules(ctx.role);
  const canConfirm = canConfirmPayrollRules(ctx.role);
  const added = first(query.added);
  const v = rules.inForce;
  const confirmed = v.adviserConfirmedAt !== null;
  const figureCount = ruleSetFigures(v.ruleSet).length;

  return (
    <>
      <PageHeader
        back={{ href: "/app/settings", label: "Settings" }}
        eyebrow="Settings"
        title="Payroll rules"
        description={`${figureCount} figures · ${v.name} in force since ${formatDate(v.effectiveFrom)}. A payroll run uses the version in force on its pay date for the whole run.`}
        actions={
          canEdit ? (
            <Button asChild>
              <Link href="/app/settings/payroll/new">Add a version</Link>
            </Button>
          ) : undefined
        }
      />
      {added ? (
        <p role="status" className="m-0 rounded-lg border border-line px-3 py-2.5 text-sm">
          Version saved · starts {added}. Runs paid before then keep the version in force on their
          pay date.
        </p>
      ) : null}

      <div
        data-testid="adviser-line"
        className="flex flex-col gap-1 rounded-xl border border-foreground bg-surface px-4 py-3"
      >
        {confirmed ? (
          <>
            <Status tone="done">Confirmed by your tax adviser</Status>
            <p className="m-0 text-sm">
              Recorded {formatDateTime(v.adviserConfirmedAt!)}: {v.adviserNote}
            </p>
          </>
        ) : (
          <>
            <p className="m-0 text-[15px] font-semibold">{TAX_ADVISER_LINE}</p>
            <p className="m-0 text-sm text-fg-muted">
              These figures are Metalira&apos;s starting values. They are not tax advice.
            </p>
          </>
        )}
      </div>

      <section aria-labelledby="in-force" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="in-force" className="m-0 type-h3">
            {v.name} · {dates(v)}
          </h2>
          <p className="m-0 text-[13px] text-fg-muted">
            {v.sourceLabel ? `Source: ${v.sourceLabel}.` : null}
            {v.reason && rules.stored ? ` Reason: ${v.reason}.` : null}
            {!rules.stored
              ? " Saved as your first version when payroll first runs or when you add a version."
              : null}
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-sm" aria-label="PAYE bands, a year">
            <caption className="sr-only">PAYE bands on yearly taxable income</caption>
            <thead className="bg-surface">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  PAYE, yearly taxable income
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                  Rate
                </th>
              </tr>
            </thead>
            <tbody>
              {bandRows(v.ruleSet).map((row) => (
                <tr key={row.band} className="border-t border-line">
                  <td className="px-4 py-2.5">{row.band}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.rate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="m-0 text-[13px] text-fg-muted">
          Taxable income is yearly pay less employee pension, NHF and rent relief. Monthly PAYE is
          the year&apos;s tax ÷ 12, rounded to the kobo once.
        </p>
        <FigureList set={v.ruleSet} />
        <p className="m-0 text-[13px] text-fg-muted">
          The pay cycle (20th to 19th, paid on the 25th) and the hourly-rate divisor are in{" "}
          {ctx.role === "owner" ? (
            <Link href="/app/settings/company" className="text-signal">
              company settings
            </Link>
          ) : (
            "company settings"
          )}
          .
        </p>
      </section>

      {canConfirm && !confirmed ? (
        <section
          aria-labelledby="confirm"
          className="flex flex-col gap-3 rounded-xl border border-line p-5"
        >
          <div className="flex flex-col gap-1">
            <h2 id="confirm" className="m-0 type-h3">
              Your tax adviser&apos;s confirmation
            </h2>
            <p className="m-0 text-sm text-fg-muted">
              Record it once your adviser has checked {v.name}. It is kept with who recorded it and
              when.
            </p>
          </div>
          <ConfirmAdviserForm ruleSetId={v.id} name={v.name} />
        </section>
      ) : null}

      {rules.scheduled.length > 0 ? (
        <section aria-labelledby="scheduled" className="flex flex-col gap-3">
          <h2 id="scheduled" className="m-0 type-h3">
            Scheduled
          </h2>
          {rules.scheduled.map((s) => {
            const changes = diffRuleSets(v.ruleSet, s.ruleSet);
            return (
              <article
                key={s.id ?? s.effectiveFrom}
                className="flex flex-col gap-2 rounded-xl border border-line p-4"
              >
                <p className="m-0 text-[15px] font-semibold">
                  {s.name} · from {formatDate(s.effectiveFrom)} · {changes.length}{" "}
                  {changes.length === 1 ? "figure changes" : "figures change"}
                </p>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {changes.map((c) => (
                    <li key={c.label} className="text-sm">
                      <span className="font-medium">{c.label}: </span>
                      {c.before ? <span className="text-fg-muted">{c.before} → </span> : null}
                      {c.after ?? "Removed"}
                    </li>
                  ))}
                </ul>
                {s.reason ? (
                  <p className="m-0 text-[13px] text-fg-muted">Reason: {s.reason}</p>
                ) : null}
              </article>
            );
          })}
        </section>
      ) : null}

      {rules.earlier.length > 0 ? (
        <section aria-labelledby="earlier" className="flex flex-col gap-3">
          <h2 id="earlier" className="m-0 type-h3">
            Earlier versions
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rules.earlier.map((e) => (
              <li
                key={e.id ?? e.effectiveFrom}
                className="flex flex-col gap-0.5 rounded-lg border border-line p-3"
              >
                <span className="text-sm font-semibold">{e.name}</span>
                <span className="text-sm text-fg-muted">
                  {dates(e)}
                  {e.adviserConfirmedAt ? " · confirmed by your tax adviser" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="m-0 text-[13px] text-fg-muted">
        A version in force is never changed: a change is a new version from tomorrow or later, and
        pay already worked out keeps the version it used.
      </p>
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/settings/payroll">) {
  return (
    <RouteGate href="/app/settings/payroll">
      <PayrollRulesPage searchParams={searchParams} />
    </RouteGate>
  );
}
