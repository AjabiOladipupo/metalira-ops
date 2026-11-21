import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { formatDate } from "@/lib/dates";
import { describeHolidayCopy } from "@/server/capabilities/leave-previews";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { loadCalendar, previewCopyHolidays } from "@/server/people/leave-setup-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../../_shell/slots";
import { CopyHolidaysForm } from "../_components/holiday-forms";

export const metadata: Metadata = { title: "Copy holidays" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * "Copy last year", step one: the preview. copy_public_holidays as a dry run, so what it lists is
 * what Copy will do unless the holidays change in between.
 */
async function CopyHolidays({
  searchParams,
}: {
  searchParams: PageProps<"/app/settings/holidays/copy">["searchParams"];
}) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const calendar = await loadCalendar(ctx.supabase, ctx.organisationId);
  const asked = Number(first(query.year));
  const toYear =
    Number.isInteger(asked) && asked > 2000 && asked <= 2100
      ? asked
      : Number(calendar.today.slice(0, 4));
  const back = `/app/settings/holidays?year=${toYear}`;
  if (!canEditLeaveSetup(ctx.role)) redirect(back);

  const result = await previewCopyHolidays(ctx.supabase, ctx.organisationId, toYear - 1, toYear);
  const preview = describeHolidayCopy(result);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        back={{ href: back, label: "Holidays" }}
        eyebrow="Settings · Holidays"
        title={`Copy ${toYear - 1} into ${toYear}`}
        description="Same day and month. Moveable holidays fall on other dates each year, so check them after copying."
      />
      <p className="m-0 text-[15px] font-medium" data-testid="copy-holidays-preview">
        {preview.summary}
      </p>
      {result.copied.length > 0 ? (
        <section aria-labelledby="copied" className="flex flex-col gap-2">
          <h2 id="copied" className="m-0 type-h3">
            Copied
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {result.copied.map((c) => (
              <li key={c.date} className="flex gap-3 rounded-lg border border-line p-3 text-sm">
                <span className="w-28 shrink-0 font-semibold tabular-nums">{formatDate(c.date)}</span>
                <span className="min-w-0 break-words">{c.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.skipped.length > 0 ? (
        <section aria-labelledby="skipped" className="flex flex-col gap-2">
          <h2 id="skipped" className="m-0 type-h3">
            Not copied
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {result.skipped.map((s) => (
              <li key={`${s.date}|${s.name}`} className="flex flex-col gap-0.5 rounded-lg border border-line p-3">
                <span className="text-sm font-semibold">
                  {formatDate(s.date)} · {s.name}
                </span>
                <span className="text-[13px] text-fg-muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.copied.length > 0 ? (
        <CopyHolidaysForm fromYear={toYear - 1} toYear={toYear} count={result.copied.length} />
      ) : (
        <Link href={back} className="text-sm text-signal">
          Back to holidays
        </Link>
      )}
    </div>
  );
}

export default function Page({ searchParams }: PageProps<"/app/settings/holidays/copy">) {
  return (
    <RouteGate href="/app/settings/holidays">
      <CopyHolidays searchParams={searchParams} />
    </RouteGate>
  );
}
