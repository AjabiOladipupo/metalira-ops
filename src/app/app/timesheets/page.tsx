import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";
import { getPageSession } from "@/server/identity/session";
import { SELFIE_READERS } from "@/server/workforce/punch-selfie-link";
import { TIMESHEET_REOPENERS } from "@/server/workforce/timesheet-approval";
import { loadTimesheetReview, recentPeriods } from "@/server/workforce/timesheet-review-data";
import { TIMESHEET_CORRECTORS, TIMESHEET_READERS } from "@/server/workforce/timesheets";
import { loadTimesheetSettings } from "@/server/workforce/timesheets-data";

import { RouteGate } from "../_shell/slots";
import { TimesheetBoard } from "./_components/timesheet-board";

export const metadata: Metadata = { title: "Timesheets" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Timesheet approval (slice 4.3, prototype Timesheets.dc.html): the pay period's days, flagged
 * first, with the detail panel, Approve, Adjust hours, Reject, Reopen and "Approve N clean".
 * Opening the page refreshes the period up to today (must-do 5), then reads it through
 * public.timesheet_review_days, which decides who sees which days.
 */
async function TimesheetsPage({ period }: { period: string | undefined }) {
  const session = await getPageSession();
  if (!session?.active || !TIMESHEET_READERS.includes(session.active.role)) {
    redirect(NO_ACCESS_PATH);
  }
  const { organisationId, role } = session.active;
  const supabase = await createServerSupabase();
  const [review, settings] = await Promise.all([
    loadTimesheetReview(supabase, organisationId, period),
    loadTimesheetSettings(supabase, organisationId),
  ]);
  return (
    <TimesheetBoard
      review={review}
      periods={recentPeriods(review.today, settings.payCycleStartDay)}
      canCorrect={TIMESHEET_CORRECTORS.includes(role)}
      canReopen={TIMESHEET_REOPENERS.includes(role)}
      canSeeSelfie={SELFIE_READERS.includes(role)}
    />
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: PageProps<"/app/timesheets">["searchParams"];
}) {
  const query = await searchParams;
  const raw = typeof query.period === "string" ? query.period : undefined;
  return (
    <RouteGate href="/app/timesheets">
      <TimesheetsPage period={raw && ISO_DATE.test(raw) ? raw : undefined} />
    </RouteGate>
  );
}
