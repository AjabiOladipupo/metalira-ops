import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { addDays } from "@/lib/dates";
import { isoWeekday } from "@/lib/headcount";

import { RouteGate } from "../../../../../../../_shell/slots";
import { ChangeRequirementForm } from "../../../../../../_components/live-change-forms";
import { loadPostPage } from "../../post-data";

export const metadata: Metadata = { title: "Change headcount" };

async function ChangePage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/[postId]/change">["params"];
}) {
  const { clientId, contractId, postId } = await params;
  const { ctx, detail, postPath } = await loadPostPage(clientId, contractId, postId, {
    editing: true,
  });
  const { post, versions, contract } = detail;
  const today = ctx.today;
  // Next Monday by default, or the day the post opens if that is later.
  const monday = addDays(today, 8 - isoWeekday(today));
  const initialFrom = post.openedOn > monday ? post.openedOn : monday;
  const current =
    versions.find(
      (v) =>
        v.effectiveFrom <= initialFrom && (v.effectiveTo === null || v.effectiveTo >= initialFrom),
    ) ?? versions[versions.length - 1];
  return (
    <>
      <PageHeader
        back={{ href: postPath, label: post.name }}
        eyebrow={`${contract.clientName} · ${post.siteName}`}
        title={`Change ${post.name}`}
        description="Choose the date the new numbers start. The version in force closes the day before; history keeps both."
      />
      <ChangeRequirementForm
        key={versions.map((v) => v.id).join(",")}
        clientId={clientId}
        contract={contract}
        post={post}
        versions={versions}
        today={today}
        initialFrom={initialFrom}
        back={postPath}
        initial={{
          days: (current?.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7]).map(String),
          startTime: current?.startTime ?? "06:00",
          endTime: current?.endTime ?? "18:00",
          requiredCount: String(current?.requiredCount ?? 1),
        }}
      />
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/[postId]/change">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/posts/[id]/change">
      <ChangePage params={params} />
    </RouteGate>
  );
}
