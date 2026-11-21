import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";

import { StatusDot } from "@/components/status";
import { formatDayCount } from "@/lib/leave/days";
import { formatLeaveRange, isLeaveStatus, STATUS_LABELS, statusTone } from "@/lib/leave/requests";
import { loadBalances } from "@/server/people/leave-data";
import { loadLeaveSetup } from "@/server/people/leave-setup-data";
import type { Database } from "@/types/db";

/**
 * The HR file's leave part (slice 4.4): this year's balance by type and the worker's requests,
 * newest first. Read as the viewer: owner, admin and hr see everyone, a line manager their
 * reportees (RLS on leave_requests and public.leave_balances); anyone else sees nothing here.
 */
export async function HrFileLeave({
  supabase,
  organisationId,
  workerId,
  today,
}: {
  supabase: SupabaseClient<Database>;
  organisationId: string;
  workerId: string;
  today: string;
}) {
  const year = Number(today.slice(0, 4));
  const [setup, balances, requests] = await Promise.all([
    loadLeaveSetup(supabase, organisationId),
    loadBalances(supabase, organisationId, year, [workerId]).catch(() => []),
    supabase
      .from("leave_requests")
      .select("id, start_date, end_date, days, status, leave_types ( name, counting )")
      .eq("organisation_id", organisationId)
      .eq("worker_id", workerId)
      .order("start_date", { ascending: false })
      .limit(20),
  ]);
  const rows = requests.data ?? [];
  const types = setup.types.filter((t) => t.status === "active");
  return (
    <div
      data-testid="hr-file-leave"
      className="flex flex-col gap-3 rounded-xl border border-line px-4 py-3 text-sm"
    >
      <h3 className="m-0 type-label text-fg-muted">Leave {year}</h3>
      {balances.length > 0 ? (
        <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
          {types.map((t) => {
            const b = balances.find((row) => row.leaveTypeId === t.id);
            if (!b) return null;
            return (
              <div key={t.id} className="flex flex-col gap-0.5 rounded-lg bg-surface px-3 py-2">
                <dt className="text-xs text-fg-muted">{t.name}</dt>
                <dd className="m-0 font-semibold tabular-nums">
                  {b.balance} left of {b.granted + b.carried + b.adjusted}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="m-0 text-fg-muted">No leave balance yet.</p>
      )}
      {rows.length === 0 ? (
        <p className="m-0 text-fg-muted">No leave requests yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((r) => {
            const status = isLeaveStatus(r.status) ? r.status : "cancelled";
            const counting = r.leave_types?.counting === "calendar_days" ? "calendar_days" : "working_days";
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-b-0">
                <Link href={`/app/leave/${r.id}`} className="text-signal no-underline hover:underline">
                  {r.leave_types?.name ?? "Leave"} · {formatLeaveRange(r.start_date, r.end_date)}
                </Link>
                <span className="inline-flex items-center gap-1.5 text-fg-muted">
                  <StatusDot tone={statusTone(status)} />
                  {STATUS_LABELS[status]} · {formatDayCount(r.days, counting)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
