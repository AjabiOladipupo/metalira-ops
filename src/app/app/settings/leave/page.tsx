import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  formatLeavePay,
  formatMonths,
  formatScheduled,
  scheduledVersions,
} from "@/lib/leave/entitlements";
import { ADVISER_LINE, PRESETS, type Preset } from "@/lib/leave/presets";
import { currentVersion, loadLeaveSetup, type LeaveTypeRow } from "@/server/people/leave-setup-data";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";

export const metadata: Metadata = { title: "Leave settings" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** One preset card: name, figures, source and the adviser line. */
function PresetCard({ preset, canEdit }: { preset: Preset; canEdit: boolean }) {
  return (
    <article
      aria-labelledby={`preset-${preset.id}`}
      data-testid={`preset-card-${preset.id}`}
      className="flex flex-col gap-4 rounded-xl border border-line p-5"
    >
      <div className="flex flex-col gap-1">
        <span className="type-label text-fg-muted">Preset {preset.id}</span>
        <h3 id={`preset-${preset.id}`} className="m-0 type-h3">
          {preset.name}
        </h3>
      </div>
      <dl className="m-0 flex flex-col gap-2">
        {preset.types.map((t) => (
          <div key={t.code} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <dt className="shrink-0 text-sm font-semibold sm:w-32">{t.name}</dt>
            <dd className="m-0 text-sm">{t.summary}</dd>
          </div>
        ))}
        {preset.none ? <p className="m-0 text-sm text-fg-muted">{preset.none}</p> : null}
      </dl>
      <p className="m-0 text-[13px] text-fg-muted">
        <span className="font-medium text-foreground">Source: </span>
        {preset.source}
      </p>
      <p className="m-0 rounded-lg bg-surface px-3 py-2.5 text-[13px] font-medium">
        {ADVISER_LINE}
      </p>
      {canEdit ? (
        <Button asChild variant="outline" className="mt-auto self-start">
          <Link href={`/app/settings/leave/preset/${preset.id}`}>Use preset {preset.id}</Link>
        </Button>
      ) : null}
    </article>
  );
}

function rules(type: LeaveTypeRow): string {
  const parts: string[] = [type.counting === "working_days" ? "Working days" : "Calendar days"];
  if (type.minServiceMonths > 0) parts.push(`after ${formatMonths(type.minServiceMonths)}' service`);
  if (type.needsCertificate) parts.push("certificate needed");
  return parts.join(" · ");
}

async function LeaveSettings({
  searchParams,
}: {
  searchParams: PageProps<"/app/settings/leave">["searchParams"];
}) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const setup = await loadLeaveSetup(ctx.supabase, ctx.organisationId);
  const canEdit = canEditLeaveSetup(ctx.role);
  const applied = first(query.applied);
  const active = setup.types.filter((t) => t.status === "active").length;

  const columns: Column<LeaveTypeRow>[] = [
    {
      key: "name",
      header: "Leave type",
      cell: (t) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{t.name}</span>
          {t.status === "retired" ? (
            <Status tone="pending">Retired</Status>
          ) : t.preset ? (
            <span className="text-xs text-fg-muted">From preset {t.preset}</span>
          ) : (
            <span className="text-xs text-fg-muted">Your own</span>
          )}
        </span>
      ),
    },
    {
      key: "days",
      header: "Days a year",
      kind: "number",
      cell: (t) => {
        const now = currentVersion(t, setup.today);
        const next = scheduledVersions(t.versions, setup.today).at(-1);
        return (
          <span className="flex flex-col items-end gap-0.5">
            <span className="font-semibold">{now ? now.daysPerYear : "—"}</span>
            {next && next !== now ? (
              <span className="text-xs whitespace-nowrap text-fg-muted">
                {formatScheduled(next, t.counting)}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "paid",
      header: "Paid",
      cell: (t) => {
        const now = currentVersion(t, setup.today);
        return now ? formatLeavePay(t.paid, now.payPercent, now.payMinServiceMonths) : "—";
      },
    },
    {
      key: "rules",
      header: "Rules",
      cell: (t) => {
        const now = currentVersion(t, setup.today);
        const cap = now?.carryOverCapDays;
        return (
          <span className="flex flex-col gap-0.5">
            <span>{rules(t)}</span>
            <span className="text-xs text-fg-muted">
              {cap ? `Carry over up to ${cap} days` : "No carry-over"}
              {t.sourceLabel ? ` · Source: ${t.sourceLabel}` : ""}
            </span>
          </span>
        );
      },
    },
    { key: "approvers", header: "Approvers", cell: () => "Line manager, then HR" },
    {
      key: "edit",
      header: "",
      cell: (t) =>
        canEdit ? (
          <Link
            href={`/app/settings/leave/types/${t.id}`}
            className="font-medium text-signal no-underline hover:underline"
            aria-label={`Edit ${t.name}`}
          >
            Edit
          </Link>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        back={{ href: "/app/settings", label: "Settings" }}
        eyebrow="Settings"
        title="Leave"
        description={`${active} leave ${active === 1 ? "type" : "types"} · every request goes to the line manager, then HR.`}
        actions={
          canEdit ? (
            <Button asChild>
              <Link href="/app/settings/leave/types/new">Add a leave type</Link>
            </Button>
          ) : undefined
        }
      />
      {applied === "A" || applied === "B" ? (
        <p role="status" className="m-0 rounded-lg border border-line px-3 py-2.5 text-sm">
          Preset {applied} applied. Edit any figure below to fit your company.
        </p>
      ) : null}

      <section aria-labelledby="presets" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="presets" className="m-0 type-h3">
            Start from a preset
          </h2>
          <p className="m-0 text-sm text-fg-muted">
            2 presets with their sources. Applying one adds its leave types; types you already have
            change from a date you choose, and your other types stay.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {PRESETS.map((p) => (
            <PresetCard key={p.id} preset={p} canEdit={canEdit} />
          ))}
        </div>
      </section>

      <section aria-labelledby="types" className="flex flex-col gap-3">
        <h2 id="types" className="m-0 type-h3">
          Your leave types
        </h2>
        {setup.types.length === 0 ? (
          <p className="m-0 rounded-xl border border-line p-5 text-sm text-fg-muted">
            No leave types yet. Use a preset above, or add your own.
          </p>
        ) : (
          <DataTable
            caption="Leave types"
            columns={columns}
            rows={setup.types}
            getRowId={(t) => t.id}
          />
        )}
        <p className="m-0 text-[13px] text-fg-muted">
          These are your company&apos;s settings. Check them against the Labour Act and your
          employment contracts before going live. {ADVISER_LINE}
        </p>
        <p className="m-0 text-[13px] text-fg-muted">
          Days are whole days. Working-day types skip each worker&apos;s off-days and your{" "}
          <Link href="/app/settings/holidays" className="text-signal">
            public holidays
          </Link>
          ; calendar-day types count every day.
        </p>
      </section>
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/settings/leave">) {
  return (
    <RouteGate href="/app/settings/leave">
      <LeaveSettings searchParams={searchParams} />
    </RouteGate>
  );
}
