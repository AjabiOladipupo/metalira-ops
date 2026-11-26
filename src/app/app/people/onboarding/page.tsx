import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Status, type StatusTone } from "@/components/status";
import {
  rolesFor,
  ONBOARDING_ROLE_LABELS,
  ONBOARDING_STATUS_LABELS,
  type OnboardingListStatus,
} from "@/lib/self-onboarding";
import { lagosDate } from "@/lib/worker-invites";
import { loadWorkerFormOptions } from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";
import { loadEmailsLeft, loadOnboardingInvites } from "@/server/people/self-onboarding";

import { RouteGate } from "../../_shell/slots";
import { InviteRowActions, OnboardInviteForm } from "./onboarding-forms";

export const metadata: Metadata = { title: "Onboard" };

const TONE: Record<OnboardingListStatus, StatusTone> = {
  sent: "pending",
  opened: "partial",
  submitted: "action",
  approved: "done",
  cancelled: "pending",
  expired: "pending",
};

async function Onboarding() {
  const ctx = await peoplePageContext();
  const [invites, emails, options] = await Promise.all([
    loadOnboardingInvites(ctx.supabase, ctx.organisationId),
    loadEmailsLeft(ctx.supabase, ctx.organisationId),
    loadWorkerFormOptions(ctx.supabase, ctx.organisationId),
  ]);
  const waiting = invites.filter((i) => i.status === "submitted").length;
  return (
    <>
      <PageHeader
        back={{ href: "/app/people", label: "People" }}
        eyebrow="People"
        title="Onboard"
        description={`${invites.length.toLocaleString("en-NG")} invites · ${waiting.toLocaleString("en-NG")} waiting for HR review`}
      />
      <OnboardInviteForm
        departments={options.departments}
        lineManagers={options.lineManagers}
        emailsLeft={emails.left}
        emailCap={emails.cap}
        roles={rolesFor(ctx.role)}
      />
      <section aria-labelledby="onboarding-list" className="flex flex-col gap-2">
        <h2 id="onboarding-list" className="m-0 type-h3">
          Invites
        </h2>
        {invites.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            No invites yet. Type an email and choose their role above.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {invites.map((invite) => (
              <li
                key={invite.id}
                data-testid="onboarding-invite"
                className="flex flex-col gap-2 border-t border-line py-4 first:border-t-0 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] lg:items-center lg:gap-6"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{invite.name ?? invite.email}</span>
                  {invite.name ? (
                    <span className="truncate text-[13px] text-fg-muted">{invite.email}</span>
                  ) : null}
                </div>
                <span className="text-sm">{ONBOARDING_ROLE_LABELS[invite.role]}</span>
                <div className="flex flex-col gap-0.5">
                  <Status tone={TONE[invite.status]}>
                    {ONBOARDING_STATUS_LABELS[invite.status]}
                  </Status>
                  <span className="text-xs text-fg-muted">Sent {lagosDate(invite.sentAt)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {invite.status === "submitted" ? (
                    <Link
                      href={`/app/people/onboarding/${invite.id}`}
                      className="text-sm font-medium"
                    >
                      Review
                    </Link>
                  ) : null}
                  {invite.status === "approved" && invite.workerId ? (
                    <Link href={`/app/people/${invite.workerId}`} className="text-sm font-medium">
                      Open
                    </Link>
                  ) : null}
                  <InviteRowActions
                    inviteId={invite.id}
                    canResend={
                      invite.status === "sent" ||
                      invite.status === "opened" ||
                      invite.status === "expired"
                    }
                    canCancel={
                      invite.status === "sent" ||
                      invite.status === "opened" ||
                      invite.status === "submitted" ||
                      invite.status === "expired"
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Self-onboarding invites (slice U.4): invite by email with one role, then review and approve. */
export default function Page() {
  return (
    <RouteGate href="/app/people/onboarding">
      <Onboarding />
    </RouteGate>
  );
}
