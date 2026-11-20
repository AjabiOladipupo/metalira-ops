import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { addDays, formatDate, todayIn } from "@/lib/dates";
import { formatShortDay, parseWeekParam } from "@/lib/roster";
import { createServerSupabase } from "@/lib/supabase/server";
import { describeCopyPreview } from "@/server/capabilities/roster-previews";
import { getPageSession } from "@/server/identity/session";
import { canEditRoster } from "@/server/workforce/roster";
import {
  loadRosterSettings,
  loadRosterSites,
  previewCopyLastWeek,
} from "@/server/workforce/roster-data";

import { RouteGate } from "../../_shell/slots";
import { CopyWeekForm } from "../_components/copy-week-form";

export const metadata: Metadata = { title: "Copy last week" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * "Copy last week", step one: the preview. It runs the database's copy as a dry run (every check,
 * then rolled back), so what it lists is what Confirm will do unless the roster changes between.
 */
async function CopyPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/roster/copy">["searchParams"];
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
  if (!site || site.archived || !canEditRoster(role)) redirect(back);

  const result = await previewCopyLastWeek(supabase, organisationId, site.id, weekStart);
  const preview = describeCopyPreview(result);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        back={{ href: back, label: "Roster" }}
        eyebrow={`${site.name}${site.clientName ? ` · ${site.clientName}` : ""}`}
        title="Copy last week"
        description={`From the week of ${formatDate(addDays(weekStart, -7))} into the week of ${formatDate(weekStart)}. Each person goes onto the same post on the same weekday.`}
      />
      <p className="m-0 text-[15px] font-medium" data-testid="copy-preview">
        {preview.summary}
      </p>
      {result.skipped.length > 0 ? (
        <section aria-labelledby="skipped" className="flex flex-col gap-2">
          <h2 id="skipped" className="m-0 type-h3">
            Not copied
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="copy-skipped">
            {result.skipped.map((s, i) => (
              <li
                key={`${s.postId}|${s.date}|${s.workerId}|${i}`}
                className="flex flex-col gap-0.5 rounded-lg border border-line p-3"
              >
                <span className="text-sm font-semibold">
                  {s.workerName} · {s.postName} · {formatShortDay(s.date)}
                </span>
                <span className="text-[13px] text-fg-muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.copied > 0 ? (
        <CopyWeekForm siteId={site.id} weekStart={weekStart} copies={result.copied} />
      ) : (
        <Button asChild variant="outline" className="self-start">
          <Link href={back}>Back to the roster</Link>
        </Button>
      )}
    </div>
  );
}

export default function Page({ searchParams }: PageProps<"/app/roster/copy">) {
  return (
    <RouteGate href="/app/roster/copy">
      <CopyPage searchParams={searchParams} />
    </RouteGate>
  );
}
