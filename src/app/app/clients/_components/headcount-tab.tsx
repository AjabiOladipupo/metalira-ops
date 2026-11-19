import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  HEADCOUNT_UNIT_LABELS,
  formatDays,
  formatHeadcountTotals,
  formatHours,
  formatRoleBand,
  formatWeeklyCounts,
  headcountRequired,
  missingRateMessage,
  type HeadcountLine,
} from "@/lib/headcount";
import { formatRate, formatRateKey } from "@/lib/rate-cards";
import { contractWeek } from "@/server/business/headcount-data";
import type { ContractDetail } from "@/server/business/contracts-data";

import { RemoveHeadcountButton } from "./headcount-form";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The contract's Headcount tab (slice 2.5): rows grouped by site, each with what it comes to in
 * a week, a "No rate for ..." flag when its role and band have no rate line, and the weekly
 * total line ("4 posts · 28 shifts a week · ₦385,000 a week at today's rates"). The totals are a
 * preview from src/lib/headcount.ts; nothing is stored. Rows change only while the contract is a
 * draft.
 */
export function HeadcountTab({
  contract,
  lines,
  today,
  canEdit,
}: {
  contract: ContractDetail;
  lines: HeadcountLine[];
  today: string;
  canEdit: boolean;
}) {
  const base = `/app/clients/${contract.clientId}/contracts/${contract.id}`;
  const editable = canEdit && contract.status === "draft" && contract.sites.length > 0;
  const week = contractWeek(contract, lines, today);
  const siteName = new Map(contract.sites.map((s) => [s.id, s.name]));
  const addButton = editable ? (
    <Button asChild className="h-11 px-4">
      <Link href={`${base}/headcount/new`}>Add headcount</Link>
    </Button>
  ) : null;

  if (lines.length === 0) {
    const message =
      contract.sites.length === 0
        ? "No headcount yet. Add a site to the contract first, then the posts at it."
        : headcountRequired(contract.type)
          ? "No headcount yet. Add each post the client wants staffed, with its days, hours and people."
          : "No headcount yet. It's optional on this contract: add posts if you staff it on a plan.";
    return <EmptyState message={message} action={addButton} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1">
          <p className="m-0 text-[15px] font-medium tabular-nums" data-testid="headcount-total">
            {formatHeadcountTotals(week, week.ratesLabel)}
          </p>
          <p className="m-0 text-sm text-fg-muted">
            {week.priced
              ? "Priced from the rate card, without VAT. A preview of the plan; invoices come later."
              : "This contract bills an agreed amount, so headcount is the staffing plan only."}
            {contract.status === "draft"
              ? " Activation turns each row into a post."
              : " Frozen since activation."}
          </p>
        </div>
        {addButton}
      </div>

      {week.unpriced > 0 ? (
        <div
          role="note"
          className="flex flex-col gap-2 rounded-xl border border-foreground p-4 text-sm"
          data-testid="headcount-unpriced"
        >
          <p className="m-0">
            {plural(week.unpriced, "row has", "rows have")} no rate. Add{" "}
            {week.missingKeys.map(formatRateKey).join(", ")} to the rate card before activating.
          </p>
          {canEdit && contract.status !== "ended" ? (
            <Link href={`${base}?tab=rates`} className="font-medium">
              Open the rate card
            </Link>
          ) : null}
        </div>
      ) : null}

      {week.sites.map((site) => {
        const name = siteName.get(site.siteId) ?? "Site";
        const headingId = `headcount-site-${site.siteId}`;
        return (
          <section key={site.siteId} aria-labelledby={headingId} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 id={headingId} className="m-0 type-h3">
                {name}
              </h2>
              <p className="m-0 text-sm text-fg-muted tabular-nums">
                {plural(site.posts, "post", "posts")} · {formatWeeklyCounts(site)}
                {week.priced && site.weeklyKobo !== null
                  ? ` · ${formatRate(site.weeklyKobo)} a week`
                  : ""}
              </p>
            </div>
            <ul
              className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0"
              aria-label={`Headcount at ${name}`}
            >
              {site.rows.map((row) => (
                <li
                  key={row.line.id}
                  data-testid="headcount-row"
                  aria-label={row.label}
                  className="flex flex-col gap-2 px-4 py-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium">{row.label}</span>
                    <span className="text-sm text-fg-muted">
                      {formatRoleBand(row.line)} ·{" "}
                      {HEADCOUNT_UNIT_LABELS[row.line.unit].toLowerCase()}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                    <span>
                      {formatDays(row.line.daysOfWeek)} · {formatHours(row.line)} ·{" "}
                      {plural(row.line.requiredCount, "person", "people")}
                    </span>
                    <span className="tabular-nums">
                      {formatWeeklyCounts(
                        row.line.unit === "visit"
                          ? { shifts: 0, visits: row.perWeek }
                          : { shifts: row.perWeek, visits: 0 },
                      )}
                      {row.weeklyKobo !== null ? ` · ${formatRate(row.weeklyKobo)} a week` : ""}
                    </span>
                  </div>
                  {row.missingRate ? (
                    <Status tone="action" className="whitespace-normal">
                      {missingRateMessage(row.line)}
                    </Status>
                  ) : null}
                  {row.line.notes ? (
                    <p className="m-0 text-sm text-fg-muted">{row.line.notes}</p>
                  ) : null}
                  {editable ? (
                    <div className="flex flex-wrap items-center gap-4">
                      <Link
                        href={`${base}/headcount/${row.line.id}`}
                        className="text-sm font-medium"
                        aria-label={`Edit ${row.label} at ${name}`}
                      >
                        Edit
                      </Link>
                      <RemoveHeadcountButton
                        clientId={contract.clientId}
                        contractId={contract.id}
                        headcountId={row.line.id}
                        label={`${row.label} at ${name}`}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
