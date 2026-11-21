import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { koboToMajorString } from "@/lib/money";
import { encodeLineManager } from "@/lib/people";
import { formatWorkDays } from "@/lib/leave/entitlements";
import { loadCalendar } from "@/server/people/leave-setup-data";
import { loadWorkerFormOptions, loadWorkerProfile } from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../../_shell/slots";
import { WorkerForm } from "../../_components/worker-form";

export const metadata: Metadata = { title: "Edit employee" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function EditWorker({ params }: { params: PageProps<"/app/people/[id]/edit">["params"] }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await peoplePageContext();
  const [worker, options, calendar] = await Promise.all([
    loadWorkerProfile(ctx.supabase, ctx.organisationId, id, ctx.today),
    loadWorkerFormOptions(ctx.supabase, ctx.organisationId, id),
    loadCalendar(ctx.supabase, ctx.organisationId),
  ]);
  if (!worker) notFound();
  // Someone who has left is read-only; their record stays as it was.
  if (worker.status !== "active") redirect(`/app/people/${worker.id}`);

  return (
    <>
      <PageHeader
        back={{ href: `/app/people/${worker.id}`, label: worker.name }}
        eyebrow="Edit employee"
        title={worker.name}
        description={`${worker.jobTitle ? `${worker.jobTitle} · ` : ""}${worker.staffId}`}
      />
      <WorkerForm
        mode="update"
        options={options}
        today={ctx.today}
        companyWeekLabel={formatWorkDays(calendar.workDays)}
        worker={{
          id: worker.id,
          staffId: worker.staffId,
          firstName: worker.firstName,
          lastName: worker.lastName,
          phone: worker.phone,
          email: worker.email,
          jobTitle: worker.jobTitle,
          departmentId: worker.departmentId,
          lineManager: encodeLineManager(worker.lineManager),
          employmentType: worker.employmentType,
          startDate: worker.startDate,
          ninOnFile: worker.ninOnFile,
          tin: worker.tin,
          taxState: worker.taxState,
          pfaName: worker.pfaName,
          rsaPinLast4: worker.rsaPinLast4,
          rsaPinOnFile: worker.rsaPinOnFile,
          nhfOptIn: worker.nhfOptIn,
          annualRentDeclared:
            worker.annualRentDeclared === null
              ? null
              : koboToMajorString(worker.annualRentDeclared),
          nextOfKinName: worker.nextOfKinName,
          nextOfKinPhone: worker.nextOfKinPhone,
          supervisorClockIn: worker.supervisorClockIn,
          usualWorkDays: worker.usualWorkDays,
        }}
      />
    </>
  );
}

export default function Page({ params }: PageProps<"/app/people/[id]/edit">) {
  return (
    <RouteGate href="/app/people/[id]/edit">
      <EditWorker params={params} />
    </RouteGate>
  );
}
