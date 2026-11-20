import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { addDays, formatDate, formatDateTime } from "@/lib/dates";
import { versionState } from "@/lib/rate-cards";

import { RouteGate } from "../../../../../../_shell/slots";
import { Section } from "../../../../../../people/_components/display";
import { CancelChangeButton } from "../../../../../_components/live-change-forms";
import { isChangeable, loadPostPage } from "../post-data";

export const metadata: Metadata = { title: "Post history" };

const STATE_LABEL = { scheduled: "Scheduled", in_force: "In force", ended: "Ended" } as const;
const STATE_TONE = { scheduled: "pending", in_force: "done", ended: "partial" } as const;

function range(from: string, to: string | null): string {
  return to ? `${formatDate(from)} to ${formatDate(to)}` : `From ${formatDate(from)}`;
}

async function PostPage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/[postId]">["params"];
}) {
  const { clientId, contractId, postId } = await params;
  const { ctx, detail, base, postPath } = await loadPostPage(clientId, contractId, postId, {
    editing: false,
  });
  const { post, versions, changes, contract } = detail;
  const today = ctx.today;
  const canChange = ctx.canEditContracts && isChangeable(detail, today);
  const changeable = canChange && (post.closedOn === null || post.closedOn >= today);
  // Open, or closing later than today (it can close sooner).
  const closable = canChange && (post.closedOn === null || post.closedOn > today);
  // The latest version, not started, with a version before it, can be cancelled.
  const latest = versions[versions.length - 1];
  const cancellable =
    canChange &&
    latest !== undefined &&
    latest.effectiveFrom > today &&
    versions.some((v) => v.effectiveTo === addDays(latest.effectiveFrom, -1))
      ? latest.id
      : null;
  const newestFirst = [...versions].reverse();
  return (
    <>
      <PageHeader
        back={{ href: `${base}?tab=posts`, label: contract.name }}
        eyebrow={`${contract.clientName} · ${contract.reference}`}
        title={post.name}
        description={`${post.siteName} · opened ${formatDate(post.openedOn)}${
          post.closedOn ? ` · last day ${formatDate(post.closedOn)}` : ""
        }`}
        actions={
          <>
            <Status tone={post.status === "open" ? "done" : "partial"}>
              {post.status === "open" ? "Open" : "Closed"}
            </Status>
            {changeable ? (
              <Button asChild className="h-11 px-4">
                <Link href={`${postPath}/change`}>Change headcount from…</Link>
              </Button>
            ) : null}
            {closable ? (
              <Button asChild variant="outline" className="h-11 px-4">
                <Link href={`${postPath}/close`}>Close post</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <Section
        id="versions"
        title="Requirement history"
        description="Every version is kept. A change is a new version from a date; days before it keep what was in force."
      >
        {newestFirst.length === 0 ? (
          <EmptyState message="No requirements. This post closed before it opened." />
        ) : (
          <ol
            className="m-0 flex list-none flex-col gap-3 p-0"
            aria-label="Requirement versions"
            data-testid="post-versions"
          >
            {newestFirst.map((v) => {
              const state = versionState(v, today);
              return (
                <li
                  key={v.id}
                  className="flex flex-col gap-2 rounded-xl border border-line p-4"
                  data-testid={`post-version-${v.effectiveFrom}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{range(v.effectiveFrom, v.effectiveTo)}</span>
                    <Status tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Status>
                  </div>
                  <p className="m-0 text-sm tabular-nums">
                    {v.days} · {v.hours} ·{" "}
                    <span data-testid="post-version-count">
                      {v.requiredCount} {v.requiredCount === 1 ? "person" : "people"}
                    </span>
                  </p>
                  {cancellable === v.id ? (
                    <CancelChangeButton
                      clientId={clientId}
                      contractId={contractId}
                      postId={post.id}
                      requirementId={v.id}
                      label={`the change from ${formatDate(v.effectiveFrom)}`}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </Section>
      <Section id="changes" title="Changes" description="Made after the contract went live.">
        {changes.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            None yet. This post is as the contract went live.
          </p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0"
            aria-label="Changes"
            data-testid="post-changes"
          >
            {changes.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 px-4 py-3">
                <span className="font-medium">{c.label}</span>
                <span className="text-sm break-words text-fg-muted">
                  {formatDateTime(c.createdAt)}
                  {c.reason ? ` · ${c.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/clients/[clientId]/contracts/[contractId]/posts/[postId]">) {
  return (
    <RouteGate href="/app/clients/[id]/contracts/[id]/posts/[id]">
      <PostPage params={params} />
    </RouteGate>
  );
}
