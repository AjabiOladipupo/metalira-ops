import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../../../_shell/slots";
import { CreateLeaveTypeForm } from "../../_components/leave-forms";

export const metadata: Metadata = { title: "Add a leave type" };

async function NewLeaveType() {
  const ctx = await peoplePageContext();
  if (!canEditLeaveSetup(ctx.role)) redirect("/app/settings/leave");
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        back={{ href: "/app/settings/leave", label: "Leave settings" }}
        eyebrow="Settings · Leave"
        title="Add a leave type"
        description="Your own type, such as casual or study leave. Its days a year start from 1 January this year; every request goes to the line manager, then HR."
      />
      <CreateLeaveTypeForm />
    </div>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/settings/leave">
      <NewLeaveType />
    </RouteGate>
  );
}
