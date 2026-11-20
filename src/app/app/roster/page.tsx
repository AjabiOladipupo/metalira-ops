import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { StatusDot } from "@/components/status";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { addDays, todayIn } from "@/lib/dates";
import { formatCoverage, formatWeekOf, mondayOf, parseWeekParam, weekEnd } from "@/lib/roster";
import { formatPublicationStatus, type PublicationStatus } from "@/lib/roster-publish";
import { createServerSupabase } from "@/lib/supabase/server";
import { getPageSession } from "@/server/identity/session";
import { canEditRoster } from "@/server/workforce/roster";
import {
  loadRosterCandidates,
  loadRosterSettings,
  loadRosterSites,
  loadRosterWeek,
  trayCards,
} from "@/server/workforce/roster-data";
import { loadPublicationStatus } from "@/server/workforce/roster-publish-data";

import { RouteGate } from "../_shell/slots";
import { RosterBoard } from "./_components/roster-board";
import { SiteSelect } from "./_components/site-select";

export const metadata: Metadata = { title: "Roster" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function rosterHref(siteId: string, week: string): string {
  return `/app/roster?site=${siteId}&week=${week}`;
}

async function RosterPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/roster">["searchParams"];
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

  if (sites.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Roster" description="Who works which post, day by day." />
        <EmptyState
          illustration={<Illustration name="roster-empty" size="empty" decorative />}
          message="No posts to roster yet. Activate a contract and its posts show here, ready to fill."
          action={
            <Button asChild variant="outline">
              <Link href="/app/clients">Open clients</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const requested = first(query.site);
  const site = sites.find((s) => s.id === requested) ?? sites.find((s) => !s.archived) ?? sites[0]!;
  const [data, candidates, status] = await Promise.all([
    loadRosterWeek(supabase, organisationId, site.id, weekStart, settings.timeZone),
    loadRosterCandidates(supabase, organisationId, weekStart),
    canEditRoster(role)
      ? loadPublicationStatus(supabase, organisationId, site.id, weekStart)
      : Promise.resolve<PublicationStatus | null>(null),
  ]);
  const { week } = data;
  const canEdit = canEditRoster(role) && !site.archived;
  const canPublish = canEdit && weekEnd(weekStart) >= today;
  const upToDate = status !== null && status.version !== null && status.changed.length === 0;
  const tray = trayCards(week, site.id, candidates, settings, today);
  const thisWeek = mondayOf(today);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2" data-testid="roster-toolbar">
        <SiteSelect
          sites={sites.map((s) => ({
            id: s.id,
            label: `${s.name}${s.archived ? " (archived)" : ""}`,
          }))}
          value={site.id}
          week={weekStart}
        />
        <nav aria-label="Weeks" className="flex items-center gap-1">
          <Button asChild variant="outline" size="icon">
            <Link href={rosterHref(site.id, addDays(weekStart, -7))} aria-label="Previous week">
              <span aria-hidden>‹</span>
            </Link>
          </Button>
          {weekStart !== thisWeek ? (
            <Button asChild variant="ghost">
              <Link href={rosterHref(site.id, thisWeek)}>This week</Link>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="icon">
            <Link href={rosterHref(site.id, addDays(weekStart, 7))} aria-label="Next week">
              <span aria-hidden>›</span>
            </Link>
          </Button>
        </nav>
        <span className="hidden flex-1 sm:block" />
        {canEdit ? (
          <Button asChild variant="outline">
            <Link href={`/app/roster/copy?site=${site.id}&week=${weekStart}`} prefetch={false}>
              Copy last week
            </Link>
          </Button>
        ) : null}
        {canPublish && !upToDate ? (
          <Button asChild>
            <Link href={`/app/roster/publish?site=${site.id}&week=${weekStart}`} prefetch={false}>
              Publish roster
            </Link>
          </Button>
        ) : (
          <Button
            disabled
            title={upToDate ? "Nothing has changed since it was published" : undefined}
          >
            {upToDate ? "Published" : "Publish roster"}
          </Button>
        )}
      </div>

      <PageHeader
        eyebrow={`${site.name}${site.clientName ? ` · ${site.clientName}` : ""}`}
        title={formatWeekOf(weekStart)}
        description={
          week.posts.length === 0
            ? "No shifts at this site this week."
            : formatCoverage(week.totals)
        }
      />
      {status ? (
        <p
          className="m-0 -mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          data-testid="publication-status"
        >
          <StatusDot tone={status.version === null ? "pending" : upToDate ? "done" : "partial"} />
          <span>{formatPublicationStatus(status, settings.timeZone)}</span>
          {status.version !== null && status.workersAffected > 0 ? (
            <span className="text-fg-muted">
              · Changes for {status.workersAffected}{" "}
              {status.workersAffected === 1 ? "worker" : "workers"} not published yet
            </span>
          ) : null}
        </p>
      ) : null}

      {week.posts.length === 0 ? (
        <EmptyState
          illustration={<Illustration name="roster-empty" size="empty" decorative />}
          message="No posts are staffed at this site this week. Try another week or site, or add a post to the contract."
        />
      ) : (
        <RosterBoard
          siteId={site.id}
          weekStart={weekStart}
          today={today}
          timeZone={settings.timeZone}
          weeklyStandardMinutes={settings.weeklyStandardMinutes}
          week={week}
          tray={tray}
          candidates={candidates}
          canEdit={canEdit}
          changedCells={status?.version != null ? status.changed : []}
        />
      )}
    </div>
  );
}

export default function Page({ searchParams }: PageProps<"/app/roster">) {
  return (
    <RouteGate href="/app/roster">
      <RosterPage searchParams={searchParams} />
    </RouteGate>
  );
}
