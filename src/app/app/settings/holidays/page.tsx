import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { formatWorkDays } from "@/lib/leave/entitlements";
import { cn } from "@/lib/utils";
import { nigerianStateName } from "@/lib/payroll/statutory";
import { loadOfficialHolidays } from "@/server/payroll/official-holidays";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { loadCalendar, loadHolidays } from "@/server/people/leave-setup-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import { AddHolidayForm, RemoveHolidayForm, WorkWeekForm } from "./_components/holiday-forms";

export const metadata: Metadata = { title: "Holidays" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function weekday(iso: string): string {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return WEEKDAY[(day + 6) % 7]!;
}

/**
 * Settings > Holidays (slice 4.1): the year's public holidays, "Copy last year", and the working
 * week. Each company keeps its own list for pay: working-day leave, overtime and the roster skip
 * these dates (slice 4.4). Slice 5.9b adds the official calendar Metalira keeps (federal and state
 * holidays), read-only, which alone counts statutory deadlines.
 */
async function Holidays({
  searchParams,
}: {
  searchParams: PageProps<"/app/settings/holidays">["searchParams"];
}) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const calendar = await loadCalendar(ctx.supabase, ctx.organisationId);
  const thisYear = Number(calendar.today.slice(0, 4));
  const asked = Number(first(query.year));
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : thisYear;
  const [holidays, previous, official] = await Promise.all([
    loadHolidays(ctx.supabase, ctx.organisationId, year),
    loadHolidays(ctx.supabase, ctx.organisationId, year - 1),
    loadOfficialHolidays(ctx.supabase, { year }),
  ]);
  const canEdit = canEditLeaveSetup(ctx.role);
  const count = holidays.live.length;
  const years = [thisYear - 1, thisYear, thisYear + 1];
  if (!years.includes(year)) years.push(year);

  return (
    <>
      <PageHeader
        back={{ href: "/app/settings", label: "Settings" }}
        eyebrow="Settings"
        title="Holidays"
        description={`${count} public ${count === 1 ? "holiday" : "holidays"} in ${year} · working week ${formatWorkDays(calendar.workDays)}.`}
        actions={
          canEdit && previous.live.length > 0 ? (
            <Button asChild variant="outline">
              <Link href={`/app/settings/holidays/copy?year=${year}`}>Copy {year - 1}</Link>
            </Button>
          ) : undefined
        }
      />

      <nav aria-label="Year" className="flex flex-wrap gap-2">
        {years
          .sort((a, b) => a - b)
          .map((y) => (
            <Link
              key={y}
              href={`/app/settings/holidays?year=${y}`}
              aria-current={y === year ? "page" : undefined}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm no-underline",
                y === year
                  ? "border-foreground font-semibold text-foreground"
                  : "border-line text-fg-muted",
              )}
            >
              {y}
            </Link>
          ))}
      </nav>

      <section aria-labelledby="holidays" className="flex flex-col gap-3">
        <h2 id="holidays" className="m-0 type-h3">
          Public holidays in {year}
        </h2>
        <p className="m-0 text-sm text-fg-muted">
          Your company&apos;s days off, for pay: leave, overtime and the roster use them. Holidays
          are declared year by year, and moveable ones (Eid, Easter) fall on new dates. Add each one
          as it is announced. Statutory deadlines don&apos;t use this list; they use the official
          calendar below.
        </p>
        {canEdit ? <AddHolidayForm year={year} /> : null}
        {count === 0 ? (
          <p className="m-0 rounded-xl border border-line p-5 text-sm text-fg-muted">
            No holidays for {year} yet.
            {canEdit && previous.live.length > 0
              ? ` Copy ${previous.live.length} from ${year - 1}, then check the dates.`
              : canEdit
                ? " Add the first one above."
                : ""}
          </p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col rounded-xl border border-line p-0"
            data-testid="holiday-list"
          >
            {holidays.live.map((h) => (
              <li
                key={h.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <span className="flex w-24 shrink-0 flex-col tabular-nums">
                  <span className="text-sm font-semibold">{formatDate(h.date)}</span>
                  <span className="text-xs text-fg-muted">{weekday(h.date)}</span>
                </span>
                <span className="min-w-0 flex-1 text-sm break-words">{h.name}</span>
                {canEdit ? <RemoveHolidayForm holidayId={h.id} name={h.name} /> : null}
              </li>
            ))}
          </ul>
        )}
        {holidays.removed.length > 0 ? (
          <details className="rounded-xl border border-line px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">
              {holidays.removed.length} removed in {year}
            </summary>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-fg-muted">
              {holidays.removed.map((h) => (
                <li key={h.id}>
                  {formatDate(h.date)} · {h.name}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="official" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="official" className="m-0 type-h3">
            Official holidays for deadlines in {year}
          </h2>
          <p className="m-0 text-sm text-fg-muted">
            {official.length} official {official.length === 1 ? "holiday" : "holidays"}, kept by
            Metalira from the Public Holidays Act and the Federal Government&apos;s declarations.
            Remittance deadlines count working days without these (and a state&apos;s own holidays
            for its PAYE). You can&apos;t change this list; tell us if a declared date is missing.
          </p>
        </div>
        {official.length === 0 ? (
          <p className="m-0 rounded-xl border border-line p-5 text-sm text-fg-muted">
            No official holidays for {year} yet.
          </p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col rounded-xl border border-line p-0"
            data-testid="official-holiday-list"
          >
            {official.map((h) => (
              <li
                key={h.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <span className="flex w-24 shrink-0 flex-col tabular-nums">
                  <span className="text-sm font-semibold">{formatDate(h.date)}</span>
                  <span className="text-xs text-fg-muted">{weekday(h.date)}</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm break-words">{h.name}</span>
                  <span className="text-xs break-words text-fg-muted">
                    {h.scope === "federal"
                      ? "Federal"
                      : h.stateKey === "fct abuja"
                        ? "FCT Abuja"
                        : `${nigerianStateName(h.stateKey ?? "") ?? h.stateKey} State`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="week" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="week" className="m-0 type-h3">
            Working week
          </h2>
          <p className="m-0 text-sm text-fg-muted">
            Leave counts these days when a worker has no roster for the dates and no usual days of
            their own. Rostered shifts always come first.
          </p>
        </div>
        {canEdit ? (
          <WorkWeekForm days={calendar.workDays} />
        ) : (
          <p className="m-0 text-sm">{formatWorkDays(calendar.workDays)}</p>
        )}
      </section>
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/settings/holidays">) {
  return (
    <RouteGate href="/app/settings/holidays">
      <Holidays searchParams={searchParams} />
    </RouteGate>
  );
}
