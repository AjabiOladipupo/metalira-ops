import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";

import { RouteGate } from "../../../../../../_shell/slots";
import { HeadcountForm } from "../../../../../_components/headcount-form";
import { headcountEditorProps, loadHeadcountEditor } from "../editor-data";

export const metadata: Metadata = { title: "Add headcount" };

async function AddHeadcountPage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/headcount/new">["params"];
}) {
  const { clientId, contractId } = await params;
  const editor = await loadHeadcountEditor(clientId, contractId);
  const { contract } = editor;
  return (
    <>
      <PageHeader
        back={{ href: editor.back, label: contract.name }}
        eyebrow={`${contract.clientName} · ${contract.reference}`}
        title="Add headcount"
        description="One post the client wants staffed: where, which role, which days and hours, and how many people."
      />
      {/* Keyed on the rows it adds to: a route kept alive by the router (cacheComponents) must
          not carry the last visit's typed row into a changed plan. */}
      <HeadcountForm
        key={editor.lines.map((l) => l.id).join(",")}
        {...headcountEditorProps(editor)}
        initial={{
          siteId: contract.sites.length === 1 ? contract.sites[0]!.id : "",
          postName: "",
          role: "",
          band: "",
          unit: contract.type === "per_visit" ? "visit" : "shift",
          days: ["1", "2", "3", "4", "5", "6", "7"],
          startTime: "06:00",
          endTime: "18:00",
          requiredCount: "1",
          notes: "",
        }}
      />
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/headcount/new">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/headcount/new">
      <AddHeadcountPage params={params} />
    </RouteGate>
  );
}
