import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";

import { RouteGate } from "../../../../../../../_shell/slots";
import { ClosePostForm } from "../../../../../../_components/live-change-forms";
import { loadPostPage } from "../../post-data";

export const metadata: Metadata = { title: "Close post" };

async function ClosePage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/[postId]/close">["params"];
}) {
  const { clientId, contractId, postId } = await params;
  const { ctx, detail, postPath } = await loadPostPage(clientId, contractId, postId, {
    editing: true,
  });
  const { post, versions, contract } = detail;
  if (post.status !== "open") redirect(postPath);
  return (
    <>
      <PageHeader
        back={{ href: postPath, label: post.name }}
        eyebrow={`${contract.clientName} · ${post.siteName}`}
        title={`Close ${post.name}`}
        description="Choose the last day the post is staffed. Nothing is deleted; changes scheduled after that day are taken off."
      />
      <ClosePostForm
        clientId={clientId}
        contract={contract}
        post={post}
        versions={versions}
        today={ctx.today}
        back={postPath}
      />
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/[postId]/close">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/posts/[id]/close">
      <ClosePage params={params} />
    </RouteGate>
  );
}
