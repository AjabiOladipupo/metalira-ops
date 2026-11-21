import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { formatDate } from "@/lib/dates";
import {
  changeDateChoices,
  formatLeaveDays,
  formatLeavePay,
  type EntitlementVersion,
} from "@/lib/leave/entitlements";
import { ADVISER_LINE } from "@/lib/leave/presets";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { currentVersion, loadLeaveSetup } from "@/server/people/leave-setup-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../../../_shell/slots";
import { EntitlementForm, LeaveTypeDetailsForm } from "../../_components/leave-forms";

export const metadata: Metadata = { title: "Leave type" };

/** One leave type: its details, a change to its days and pay, and every dated version. */
async function LeaveTypePage({
  params,
}: {
  params: PageProps<"/app/settings/leave/types/[id]">["params"];
}) {
  const [{ id }, ctx] = await Promise.all([params, peoplePageContext()]);
  if (!canEditLeaveSetup(ctx.role)) redirect("/app/settings/leave");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const setup = await loadLeaveSetup(ctx.supabase, ctx.organisationId);
  const type = setup.types.find((t) => t.id === id);
  if (!type) notFound();

  const today = setup.today;
  const now = currentVersion(type, today);
  const latest = type.versions.at(-1) ?? now;
  const choices = changeDateChoices(today);
  const versions = [...type.versions].reverse();

  const columns: Column<EntitlementVersion>[] = [
    {
      key: "from",
      header: "From",
      cell: (v) => (
        <span className="flex flex-col gap-0.5">
          <span className="whitespace-nowrap">{formatDate(v.effectiveFrom)}</span>
          {v.effectiveFrom > today ? (
            <Status tone="pending">Scheduled</Status>
          ) : v.effectiveTo !== null && v.effectiveTo < today ? (
            <span className="text-xs text-fg-muted">Ended</span>
          ) : (
            <Status tone="done">In force</Status>
          )}
        </span>
      ),
    },
    {
      key: "to",
      header: "Until",
      cell: (v) => (v.effectiveTo ? formatDate(v.effectiveTo) : "No end"),
    },
    {
      key: "days",
      header: "Days a year",
      kind: "number",
      cell: (v) => v.daysPerYear,
    },
    {
      key: "pay",
      header: "Pay",
      cell: (v) => formatLeavePay(type.paid, v.payPercent, v.payMinServiceMonths),
    },
    {
      key: "cap",
      header: "Carry-over",
      cell: (v) => (v.carryOverCapDays ? `Up to ${v.carryOverCapDays} days` : "None"),
    },
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        back={{ href: "/app/settings/leave", label: "Leave settings" }}
        eyebrow={type.preset ? `Leave type · from preset ${type.preset}` : "Leave type · your own"}
        title={type.name}
        description={
          now
            ? `${formatLeaveDays(now.daysPerYear, type.counting)} a year · ${formatLeavePay(type.paid, now.payPercent, now.payMinServiceMonths)} · line manager, then HR.`
            : "No days set yet."
        }
      />
      {type.sourceLabel ? (
        <p className="m-0 rounded-lg bg-surface px-3 py-2.5 text-[13px]">
          <span className="font-medium">Source: </span>
          {type.sourceLabel}. {ADVISER_LINE}
        </p>
      ) : null}

      <section aria-labelledby="days" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="days" className="m-0 type-h3">
            Days and pay
          </h2>
          <p className="m-0 text-sm text-fg-muted">
            A change starts tomorrow or on 1 January. Days already in force stay as they were.
          </p>
        </div>
        {type.status === "retired" ? (
          <p className="m-0 text-sm text-fg-muted">
            This type is retired. Make it active below to change its days.
          </p>
        ) : (
          <EntitlementForm
            leaveTypeId={type.id}
            paid={type.paid}
            saved={{
              daysPerYear: latest?.daysPerYear ?? 0,
              carryOverCapDays: latest?.carryOverCapDays ?? null,
              payPercent: latest?.payPercent ?? (type.paid ? 100 : 0),
              payMinServiceMonths: latest?.payMinServiceMonths ?? null,
            }}
            choices={[
              { value: choices.nextJanuary, label: `From ${formatDate(choices.nextJanuary)}` },
              { value: choices.tomorrow, label: `From tomorrow, ${formatDate(choices.tomorrow)}` },
            ]}
          />
        )}
        <DataTable
          caption="Versions"
          columns={columns}
          rows={versions}
          getRowId={(v) => v.id}
          maxHeight="24rem"
        />
      </section>

      <section aria-labelledby="details" className="flex flex-col gap-3">
        <h2 id="details" className="m-0 type-h3">
          Details
        </h2>
        <LeaveTypeDetailsForm
          leaveTypeId={type.id}
          status={type.status}
          saved={{
            name: type.name,
            counting: type.counting,
            paid: type.paid,
            needsCertificate: type.needsCertificate,
            minServiceMonths: type.minServiceMonths,
          }}
        />
      </section>
    </div>
  );
}

export default function Page({ params }: PageProps<"/app/settings/leave/types/[id]">) {
  return (
    <RouteGate href="/app/settings/leave">
      <LeaveTypePage params={params} />
    </RouteGate>
  );
}
