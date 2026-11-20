import "server-only";

import { notFound, redirect } from "next/navigation";

import { loadPostDetail, type PostDetail } from "@/server/business/live-changes-data";

import { clientsPageContext, type ClientsPageContext } from "../../../../_components/context";

/**
 * The post a change page works on (slice 2.8). It must belong to the contract and client in the
 * URL. Change and close pages are for the contract editors on a live contract; anyone else goes
 * back to the post's history. The actions and the database check again.
 */
export async function loadPostPage(
  clientId: string,
  contractId: string,
  postId: string,
  options: { editing: boolean },
): Promise<{ ctx: ClientsPageContext; detail: PostDetail; base: string; postPath: string }> {
  const ctx = await clientsPageContext();
  const detail = await loadPostDetail(ctx.supabase, ctx.organisationId, postId);
  if (
    !detail ||
    detail.post.contractId !== contractId ||
    detail.contract.clientId !== clientId
  ) {
    notFound();
  }
  const base = `/app/clients/${clientId}/contracts/${contractId}`;
  const postPath = `${base}/posts/${postId}`;
  if (options.editing && (!ctx.canEditContracts || !isChangeable(detail, ctx.today))) {
    redirect(postPath);
  }
  return { ctx, detail, base, postPath };
}

/** A live contract whose last day hasn't passed. */
export function isChangeable(detail: Pick<PostDetail, "contract">, today: string): boolean {
  const { contract } = detail;
  return contract.status === "active" && (contract.endDate === null || contract.endDate >= today);
}
