import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";

import { RouteGate } from "../../_shell/slots";
import { ImportWorkspace } from "./_components/import-workspace";

export const metadata: Metadata = { title: "Import employees" };

async function ImportScreen({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { batch } = await searchParams;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: "/app/people", label: "People" }}
        eyebrow="People"
        title="Import employees"
        description="One row per employee, with who they report to and which client and project they work on."
      />
      <ImportWorkspace
        path="/app/people/import"
        batchId={typeof batch === "string" ? batch : undefined}
      />
    </div>
  );
}

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <RouteGate href="/app/people/import">
      <ImportScreen searchParams={searchParams} />
    </RouteGate>
  );
}
