import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { postLabel, toHeadcountInput } from "@/lib/headcount";

import { RouteGate } from "../../../../../../_shell/slots";
import { HeadcountForm } from "../../../../../_components/headcount-form";
import { headcountEditorProps, loadHeadcountEditor } from "../editor-data";

export const metadata: Metadata = { title: "Change headcount" };

async function EditHeadcountPage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/headcount/[headcountId]">["params"];
}) {
  const { clientId, contractId, headcountId } = await params;
  const editor = await loadHeadcountEditor(clientId, contractId);
  const row = editor.lines.find((l) => l.id === headcountId);
  if (!row) redirect(editor.back);
  const { contract } = editor;
  return (
    <>
      <PageHeader
        back={{ href: editor.back, label: contract.name }}
        eyebrow={`${contract.clientName} · ${contract.reference}`}
        title={`Change ${postLabel(row)}`}
        description="Changes this row of the draft plan. The weekly total updates as you type."
      />
      <HeadcountForm
        key={`${row.id}:${editor.lines.map((l) => l.id).join(",")}`}
        {...headcountEditorProps(editor)}
        headcountId={row.id}
        initial={toHeadcountInput(row)}
      />
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/headcount/[headcountId]">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/headcount/[id]">
      <EditHeadcountPage params={params} />
    </RouteGate>
  );
}
