import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { loadWorkerFormOptions } from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import { WorkerForm } from "../_components/worker-form";

export const metadata: Metadata = { title: "Add employee" };

async function NewWorker() {
  const ctx = await peoplePageContext();
  const options = await loadWorkerFormOptions(ctx.supabase, ctx.organisationId);
  return (
    <>
      <PageHeader
        back={{ href: "/app/people", label: "People" }}
        eyebrow="People"
        title="Add employee"
        description="One person at a time. To add a whole staff list, import a file instead."
      />
      <WorkerForm mode="create" options={options} today={ctx.today} />
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/people/new">
      <NewWorker />
    </RouteGate>
  );
}
