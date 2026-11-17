import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import { lookupWorkerInvite } from "@/server/identity/worker-invite-lookup";

import { WorkerBrand } from "../../_components/worker-brand";
import { WorkerTopBar } from "../../_components/worker-top-bar";
import { AcceptInviteForm } from "./accept-invite-form";

// The token is in the path: keep it out of Referer headers and search engines.
export const metadata: Metadata = {
  title: "Set your PIN",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const copy = workerMessages.invite;

const STATE_MESSAGES = {
  invalid: copy.invalid,
  used: copy.used,
  revoked: copy.revoked,
  expired: copy.expired,
  ended: copy.ended,
  unavailable: copy.failed,
} as const;

async function Invite({ token }: { token: string }) {
  const invite = await lookupWorkerInvite(token);
  if (invite.state !== "valid") {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]">
          {STATE_MESSAGES[invite.state]}
        </p>
        <Link href={WORKER_SIGN_IN_PATH} className="text-[15px]">
          Go to sign-in
        </Link>
      </div>
    );
  }

  const name = `${invite.firstName} ${invite.lastName}`;
  return (
    <>
      <div className="flex flex-col gap-3 rounded-xl bg-surface p-4">
        <p className="m-0 text-[15px]">{copy.company(invite.organisationName)}</p>
        <p className="m-0 text-[17px] font-semibold" data-testid="invite-identity">
          {copy.confirmName(name, invite.staffId)}
        </p>
        <p className="m-0 text-sm text-fg-muted">{copy.notYou}</p>
      </div>
      <AcceptInviteForm token={token} />
      <p className="m-0 text-sm text-fg-muted" data-testid="invite-keep">
        {copy.keep(invite.companyCode, invite.staffId)}
      </p>
    </>
  );
}

function InviteSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <span className="h-24 rounded-xl bg-surface" />
      <span className="h-[52px] rounded-lg bg-surface" />
      <span className="h-[52px] rounded-lg bg-surface" />
    </div>
  );
}

/**
 * /m/invite/[token]: the worker confirms who they are, reads the notice and sets a 6-digit PIN.
 * Using the invite creates their login and signs them in (slice 1.9).
 */
export default function InvitePage({ params }: PageProps<"/m/invite/[token]">) {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 pt-4 pb-8">
      <WorkerTopBar>
        <WorkerBrand />
      </WorkerTopBar>
      <div className="flex flex-col gap-1.5">
        <span className="type-label text-fg-muted">{copy.eyebrow}</span>
        <h1 className="m-0 font-display text-[25px] leading-tight font-bold">{copy.title}</h1>
      </div>
      <Suspense fallback={<InviteSkeleton />}>
        {params.then(({ token }) => (
          <Invite token={token} />
        ))}
      </Suspense>
    </main>
  );
}
