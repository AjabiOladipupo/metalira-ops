import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { ROLE_LABELS } from "@/lib/roles";
import { teamInvitePath } from "@/lib/team";
import { lagosDate } from "@/lib/worker-invites";
import { getPageSession } from "@/server/identity/session";
import { signOutForInviteAction } from "@/server/identity/team-actions";
import { lookupTeamInvite } from "@/server/identity/team-invite-lookup";

import { AcceptForm, JoinSignUpForm } from "./join-forms";

// The token is in the path: keep it out of Referer headers and search engines.
export const metadata: Metadata = {
  title: "Join your team",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const STATE_MESSAGES = {
  invalid: "This invite link is not valid. Check you copied the whole link from the email.",
  unavailable: "We couldn't check this invite just now. Try again in a minute.",
  accepted: "This invite has already been used. If it was you, sign in to open the app.",
  revoked: "This invite was cancelled. Ask the person who invited you for a new one.",
  expired: "This invite has expired. Ask the person who invited you to send it again.",
} as const;

function Heading({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="type-label text-fg-muted">{eyebrow}</span>
      <h1 className="m-0 type-h1">{title}</h1>
      {body ? <p className="m-0 type-body-lg text-fg-muted">{body}</p> : null}
    </div>
  );
}

async function Join({ token }: { token: string }) {
  const invite = await lookupTeamInvite(token);
  if (invite.state !== "pending") {
    return (
      <>
        <Heading
          eyebrow="Team invite"
          title={"organisationName" in invite ? `Join ${invite.organisationName}` : "Team invite"}
        />
        <p
          role="alert"
          className="m-0 rounded-lg border border-foreground bg-surface px-3 py-2.5 text-sm"
        >
          {STATE_MESSAGES[invite.state]}
        </p>
        <p className="m-0 text-sm">
          <Link href={SIGN_IN_PATH}>Go to sign in</Link>
        </p>
      </>
    );
  }

  const role = ROLE_LABELS[invite.role];
  const who = invite.inviterName ?? `Someone at ${invite.organisationName}`;
  const path = teamInvitePath(token);
  const session = await getPageSession();
  const intro = (
    <Heading
      eyebrow="Team invite"
      title={`Join ${invite.organisationName}`}
      body={`${who} invited ${invite.email} to join as ${role}. The invite works until ${lagosDate(invite.expiresAt)}.`}
    />
  );

  if (!session) {
    return (
      <>
        {intro}
        <section aria-labelledby="join-sign-in" className="flex flex-col gap-3">
          <h2 id="join-sign-in" className="m-0 type-h3">
            Already have an account?
          </h2>
          <p className="m-0 text-sm text-fg-muted">Sign in with {invite.email}, then accept.</p>
          <Button asChild className="h-11 self-start rounded-lg px-5">
            <Link href={`${SIGN_IN_PATH}?next=${encodeURIComponent(path)}`}>Sign in to accept</Link>
          </Button>
        </section>
        <section
          aria-labelledby="join-sign-up"
          className="flex flex-col gap-4 border-t border-line pt-5"
        >
          <h2 id="join-sign-up" className="m-0 type-h3">
            New to Metalira Ops?
          </h2>
          <JoinSignUpForm token={token} email={invite.email} />
        </section>
      </>
    );
  }

  const signedInAs = session.user.email.toLowerCase();
  if (signedInAs !== invite.email) {
    return (
      <>
        {intro}
        <p
          role="alert"
          className="m-0 rounded-lg border border-foreground bg-surface px-3 py-2.5 text-sm"
        >
          You are signed in as {session.user.email}. This invite is for {invite.email}: sign out,
          then sign in or create an account with that address.
        </p>
        <form action={signOutForInviteAction}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" className="h-11 rounded-lg px-5">
            Sign out and switch account
          </Button>
        </form>
      </>
    );
  }

  const existing = session.memberships.find((m) => m.organisationId === invite.organisationId);
  if (existing) {
    return (
      <>
        {intro}
        <p
          role="alert"
          className="m-0 rounded-lg border border-foreground bg-surface px-3 py-2.5 text-sm"
        >
          {existing.role === "worker"
            ? `Your sign-in is a worker's at ${invite.organisationName}, so it can't also be a manager's. Ask ${who} to invite another email address.`
            : `You are already a member of ${invite.organisationName} (${ROLE_LABELS[existing.role]}).`}
        </p>
        {existing.role !== "worker" ? (
          <Button asChild className="h-11 self-start rounded-lg px-5">
            <Link href="/app">Open the app</Link>
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <>
      {intro}
      <AcceptForm token={token} organisationName={invite.organisationName} role={role} />
    </>
  );
}

function JoinSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <span className="h-3 w-24 rounded bg-surface" />
      <span className="h-9 w-56 rounded bg-surface" />
      <span className="h-4 w-80 max-w-full rounded bg-surface" />
      <span className="h-11 w-40 rounded-lg bg-surface" />
    </div>
  );
}

/**
 * /join/[token]: a manager invited from Settings → Team signs in or creates an account with the
 * invited address, then accepts and joins the company with the invited role (slice 1.12).
 */
export default function JoinPage({ params }: PageProps<"/join/[token]">) {
  return (
    <Suspense fallback={<JoinSkeleton />}>
      {params.then(({ token }) => (
        <Join token={token} />
      ))}
    </Suspense>
  );
}
