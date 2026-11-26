import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { FormAlert } from "@/components/form";
import { Button } from "@/components/ui/button";
import { SIGN_IN_PATH } from "@/lib/auth/routes";
import {
  isManagerOnboardingRole,
  ONBOARDING_ROLE_LABELS,
  onboardingPath,
} from "@/lib/self-onboarding";
import { createServerSupabase } from "@/lib/supabase/server";
import { invitePasswordStepFor } from "@/server/identity/invite-password";
import { getPageSession } from "@/server/identity/session";
import {
  lookupOnboarding,
  onboardingAttemptAllowed,
} from "@/server/people/self-onboarding-public";
import { signOutForOnboardingAction } from "@/server/people/self-onboarding-public-actions";

import {
  ManagerOnboardForm,
  OnboardEmailLinkForm,
  WorkerOnboardForm,
} from "./onboard-forms";

// The token is in the path: keep it out of Referer headers and search engines.
export const metadata: Metadata = {
  title: "Fill in your details",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const STATE_MESSAGES = {
  invalid: "This invite link is not valid. Check you copied the whole link from the email.",
  unavailable: "We couldn't check this invite just now. Try again in a minute.",
  limited: "Too many tries from this network. Wait an hour and try again.",
  submitted: "Thanks. Your details were sent and are waiting for HR review. We email you once you are approved.",
  approved: "Your details were approved. Workers get a separate email to set their phone app PIN; managers can sign in.",
  cancelled: "This invite was cancelled. Ask the person who invited you for a new one.",
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

async function Onboard({ token }: { token: string }) {
  if (!(await onboardingAttemptAllowed({ kind: "view" }, await headers()))) {
    return (
      <>
        <Heading eyebrow="Onboarding" title="Please wait" />
        <FormAlert message={STATE_MESSAGES.limited} />
      </>
    );
  }
  const invite = await lookupOnboarding(token, { markOpened: true });
  if (invite.state !== "pending") {
    const title =
      "organisationName" in invite
        ? `Join ${invite.organisationName}`
        : invite.state === "unavailable"
          ? "We couldn't check this invite"
          : "This invite can't be used";
    const done = invite.state === "submitted" || invite.state === "approved";
    return (
      <>
        <Heading
          eyebrow={"role" in invite ? `Onboarding · ${ONBOARDING_ROLE_LABELS[invite.role]}` : "Onboarding"}
          title={title}
        />
        {done ? (
          <p role="status" className="m-0 text-sm">
            {STATE_MESSAGES[invite.state]}
          </p>
        ) : (
          <FormAlert message={STATE_MESSAGES[invite.state]} />
        )}
      </>
    );
  }

  // Only the company and the role are shown; the address stays on the server.
  const role = ONBOARDING_ROLE_LABELS[invite.role];
  const intro = (
    <Heading
      eyebrow={`Onboarding · ${role}`}
      title={`Join ${invite.organisationName}`}
      body={`You are invited as ${role}. Fill in your own details; HR checks them before you start. The role is set by your company.`}
    />
  );

  if (!isManagerOnboardingRole(invite.role)) {
    return (
      <>
        {intro}
        <WorkerOnboardForm token={token} />
      </>
    );
  }

  const path = onboardingPath(token);
  const session = await getPageSession();
  if (!session) {
    return (
      <>
        {intro}
        <section aria-labelledby="onboard-new" className="flex flex-col gap-3">
          <h2 id="onboard-new" className="m-0 type-h3">
            Create your account
          </h2>
          <OnboardEmailLinkForm token={token} />
        </section>
        <section aria-labelledby="onboard-sign-in" className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 id="onboard-sign-in" className="m-0 type-h3">
            Already have an account?
          </h2>
          <Button asChild variant="outline" className="h-11 self-start rounded-lg px-5">
            <Link href={`${SIGN_IN_PATH}?next=${encodeURIComponent(path)}`}>Sign in</Link>
          </Button>
        </section>
      </>
    );
  }

  if (session.user.email.toLowerCase() !== invite.email) {
    return (
      <>
        {intro}
        <FormAlert
          message={`You are signed in as ${session.user.email}, but this invite was sent to another address. Sign out, then use the link from the invite email.`}
        />
        <form action={signOutForOnboardingAction}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" className="h-11 rounded-lg px-5">
            Sign out
          </Button>
        </form>
      </>
    );
  }

  const step = await invitePasswordStepFor(await createServerSupabase());
  if (step === "use_email_link") {
    return (
      <>
        {intro}
        <FormAlert message="Your password was set before your email address was confirmed, so it can't be used here. Sign out, then choose Email me a link." />
        <form action={signOutForOnboardingAction}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" className="h-11 rounded-lg px-5">
            Sign out and use an email link
          </Button>
        </form>
      </>
    );
  }
  return (
    <>
      {intro}
      <ManagerOnboardForm
        token={token}
        needsPassword={step === "set_password"}
        onPayroll={invite.onPayroll}
      />
    </>
  );
}

function OnboardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <span className="h-3 w-24 rounded bg-surface" />
      <span className="h-9 w-56 rounded bg-surface" />
      <span className="h-4 w-80 max-w-full rounded bg-surface" />
    </div>
  );
}

/**
 * /onboard/[token] (slice U.4): someone invited from People > Onboard fills in their own details
 * for the role the invite fixed. Phone first.
 */
export default function OnboardPage({ params }: PageProps<"/onboard/[token]">) {
  return (
    <Suspense fallback={<OnboardSkeleton />}>
      {params.then(({ token }) => (
        <Onboard token={token} />
      ))}
    </Suspense>
  );
}
