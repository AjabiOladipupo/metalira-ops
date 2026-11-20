import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { formatDate, todayIn } from "@/lib/dates";
import { parseWeekParam, weekEnd } from "@/lib/roster";
import { formatPublicationStatus } from "@/lib/roster-publish";
import { createServerSupabase } from "@/lib/supabase/server";
import { describePublishPreview } from "@/server/capabilities/roster-previews";
import { getPageSession } from "@/server/identity/session";
import { canEditRoster } from "@/server/workforce/roster";
import { loadRosterSettings, loadRosterSites } from "@/server/workforce/roster-data";
import {
  loadPublicationStatus,
  previewPublishRoster,
} from "@/server/workforce/roster-publish-data";

import { RouteGate } from "../../_shell/slots";
import { PublishWeekForm } from "../_components/publish-week-form";

export const metadata: Metadata = { title: "Publish roster" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const KIND_LABEL = { added: "Added", removed: "Taken off", changed: "Shifts changed" } as const;

/**
 * "Publish roster", step one: the confirm step. It runs publish_roster as a dry run (the same
 * checks and the same diff, nothing written), so the counts and names here are what Publish will
 * do unless the roster changes in between.
 */
async function PublishPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/roster/publish">["searchParams"];
}) {
  const query = await searchParams;
  const session = await getPageSession();
  if (!session?.active) redirect(NO_ACCESS_PATH);
  const { organisationId, role } = session.active;
  const supabase = await createServerSupabase();
  const settings = await loadRosterSettings(supabase, organisationId);
  const today = todayIn(settings.timeZone);
  const weekStart = parseWeekParam(first(query.week), today);
  const sites = await loadRosterSites(supabase, organisationId, today);
  const site = sites.find((s) => s.id === first(query.site));
  const back = site ? `/app/roster?site=${site.id}&week=${weekStart}` : "/app/roster";
  if (!site || site.archived || !canEditRoster(role) || weekEnd(weekStart) < today) redirect(back);

  const [result, status] = await Promise.all([
    previewPublishRoster(supabase, organisationId, site.id, weekStart),
    loadPublicationStatus(supabase, organisationId, site.id, weekStart),
  ]);
  const preview = describePublishPreview(result);
  const counts = result.counts;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        back={{ href: back, label: "Roster" }}
        eyebrow={`${site.name}${site.clientName ? ` · ${site.clientName}` : ""}`}
        title="Publish roster"
        description={`The week of ${formatDate(weekStart)}. ${formatPublicationStatus(status, settings.timeZone)}.`}
      />
      <p className="m-0 text-[15px] font-medium" data-testid="publish-preview">
        {preview.summary}
      </p>
      {!result.nothingChanged ? (
        <dl
          className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4"
          data-testid="publish-counts"
          aria-label="What publishing changes"
        >
          {[
            ["On shifts", result.assigned],
            ["Open", result.open],
            ["Workers added", counts.added],
            ["Taken off or changed", counts.removed + counts.changed],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 rounded-lg border border-line p-3">
              <dt className="type-label text-fg-muted">{label}</dt>
              <dd className="m-0 font-display text-2xl font-bold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {result.affected.length > 0 ? (
        <section aria-labelledby="told" className="flex flex-col gap-2">
          <h2 id="told" className="m-0 type-h3">
            Who is told
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="publish-affected">
            {result.affected.slice(0, 50).map((a) => (
              <li
                key={a.workerId}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-lg border border-line p-3"
              >
                <span className="text-sm font-semibold">{a.workerName}</span>
                <span className="text-[13px] text-fg-muted">
                  {KIND_LABEL[a.kind]} · {a.shifts.length}{" "}
                  {a.shifts.length === 1 ? "shift" : "shifts"} that week
                </span>
              </li>
            ))}
          </ul>
          {result.affected.length > 50 ? (
            <p className="m-0 text-[13px] text-fg-muted">And {result.affected.length - 50} more.</p>
          ) : null}
        </section>
      ) : null}
      <p className="m-0 text-[13px] text-fg-muted">
        Each worker gets one message in the worker app with their shifts that week, and an email
        when they have an address, up to the daily email limit. On a republish only the people whose
        shifts changed are told.
      </p>
      {/* Always mounted: after publishing, the page re-renders with nothing left to publish and
          the form keeps showing who was told. */}
      <PublishWeekForm
        siteId={site.id}
        weekStart={weekStart}
        version={result.version}
        back={back}
        nothingToPublish={result.nothingChanged}
      />
    </div>
  );
}

export default function Page({ searchParams }: PageProps<"/app/roster/publish">) {
  return (
    <RouteGate href="/app/roster/publish">
      <PublishPage searchParams={searchParams} />
    </RouteGate>
  );
}
