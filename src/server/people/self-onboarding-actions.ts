"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { ONBOARDING_ROLE_LABELS, onboardingPath } from "@/lib/self-onboarding";
import { sendSelfOnboardingApprovedEmail } from "@/server/email/self-onboarding";
import { getCompany } from "@/server/identity/company-data";
import { MutationError, mutate } from "@/server/identity/mutate";
import { notifyOwnerGrantedRole } from "@/server/identity/owner-notices";
import { appOrigin } from "@/server/identity/origin";
import { formFields } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";
import {
  createInvitesSpec,
  emailInvites,
  inviteOrigin,
  loadRecipients,
} from "@/server/identity/worker-invites";
import { createServerSupabase } from "@/lib/supabase/server";

import {
  approveOnboardingSpec,
  cancelOnboardingSpec,
  emailOnboardingInvite,
  inviteOnboardingSpec,
  resendOnboardingSpec,
  type ApprovedOnboarding,
  type IssuedOnboardingInvite,
} from "./self-onboarding";
import type { OnboardingActionState } from "./self-onboarding-state";

/**
 * Server Actions for People > Onboard (slice U.4). Each goes through mutate() (owner or HR of the
 * active company); the database checks the role and the invite's state again and audits. Emails
 * go out after the change, under the shared daily caps; addresses never reach the logs.
 */

const ONBOARDING_PATH = "/app/people/onboarding";
const FAILED = "That was not saved. Try again in a minute.";

function logFailure(event: string, error: unknown): void {
  const cause = error instanceof MutationError && error.cause ? error.cause : error;
  console.error(
    `${event}:`,
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
}

function refusal(error: unknown, values?: Record<string, string>): OnboardingActionState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, formError: error.message, values };
    if (error.code === "invalid") {
      const fieldErrors = error.fieldErrors;
      const hasFields = Object.keys(fieldErrors).length > 0;
      return {
        ok: false,
        formError: hasFields ? undefined : error.message,
        fieldErrors,
        values,
      };
    }
  }
  logFailure("onboarding.save_failed", error);
  return { ok: false, formError: FAILED, values };
}

async function inviteResult(
  invite: IssuedOnboardingInvite,
  verb: "sent" | "sent again",
): Promise<OnboardingActionState> {
  const session = await getSession();
  const organisationId = session?.active?.organisationId;
  // Links in emails use the configured app address (NEXT_PUBLIC_APP_URL), never the request.
  const url = `${(await appOrigin()).replace(/\/+$/, "")}${onboardingPath(invite.token)}`;
  const outcome = organisationId
    ? await emailOnboardingInvite(invite, organisationId, session?.user.fullName ?? null, url)
    : "failed";
  revalidatePath(ONBOARDING_PATH);
  const role = ONBOARDING_ROLE_LABELS[invite.role];
  switch (outcome) {
    case "sent":
      return {
        ok: true,
        message: `Invite ${verb} to ${invite.email} as ${role}. The link works for 7 days.`,
      };
    case "skipped":
      // Only where email is deliberately off (no Resend key): the inviter passes the link on.
      return {
        ok: true,
        message: `Invite created for ${invite.email} as ${role}, but email is not set up here. Copy the link and send it to them yourself.`,
        link: url,
      };
    case "capped":
      return {
        ok: true,
        message: `Invite created for ${invite.email} as ${role}, but today's email limit is reached, so it wasn't emailed. Use Resend tomorrow.`,
      };
    case "failed":
      return {
        ok: true,
        message: `Invite created for ${invite.email} as ${role}, but the email couldn't be sent. Use Resend to try again.`,
      };
  }
}

/** Invites someone by email with one role, fixed from now on. */
export async function inviteToOnboardAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const fields = formFields(formData);
  const values = {
    email: fields.email ?? "",
    role: fields.role ?? "",
    departmentId: fields.departmentId ?? "",
    lineManager: fields.lineManager ?? "",
    onPayroll: fields.onPayroll ?? "",
  };
  let invite: IssuedOnboardingInvite;
  try {
    invite = await mutate(inviteOnboardingSpec, fields);
  } catch (error) {
    return refusal(error, values);
  }
  return inviteResult(invite, "sent");
}

/** A new link for an invite nobody has sent details for; the old link stops working. */
export async function resendOnboardingInviteAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  let invite: IssuedOnboardingInvite;
  try {
    invite = await mutate(resendOnboardingSpec, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  return inviteResult(invite, "sent again");
}

/** Cancels an invite: its link stops working and any details sent are cleared. */
export async function cancelOnboardingInviteAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  try {
    await mutate(cancelOnboardingSpec, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  revalidatePath(ONBOARDING_PATH);
  return { ok: true, message: "Invite cancelled. Its link no longer works." };
}

/** A worker's sign-in invite (the normal one: link, then their own PIN), emailed. Never throws. */
async function inviteApprovedWorker(workerId: string, organisationId: string): Promise<boolean> {
  try {
    const company = await getCompany(organisationId);
    if (!company) return false;
    const invites = await mutate(createInvitesSpec, { workerIds: [workerId], channel: "email" });
    const supabase = await createServerSupabase();
    const recipients = await loadRecipients(supabase, organisationId, [workerId]);
    const outcome = await emailInvites(invites, recipients, company, await inviteOrigin());
    return outcome.sent > 0;
  } catch (error) {
    logFailure("onboarding.worker_invite_failed", error);
    return false;
  }
}

/** Tells an approved manager they can sign in, and every owner when HR or finance was granted. */
function managerNoticesAfter(
  approved: ApprovedOnboarding,
  organisationId: string,
  actorId: string,
) {
  const { userId, inviteId, role, email } = approved;
  if (!userId) return;
  after(async () => {
    try {
      await notifyOwnerGrantedRole(organisationId, userId, role, actorId, inviteId);
      const company = await getCompany(organisationId);
      if (!company) return;
      await sendSelfOnboardingApprovedEmail({
        to: email,
        inviteId,
        organisationName: company.name,
        roleLabel: ONBOARDING_ROLE_LABELS[role],
        signInUrl: `${(await appOrigin()).replace(/\/+$/, "")}${SIGN_IN_PATH}`,
      });
    } catch (error) {
      logFailure("onboarding.approved_notice_failed", error);
    }
  });
}

/** Approves what the invitee sent: creates their membership or employee record with the role. */
export async function approveOnboardingAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const fields = formFields(formData);
  const values = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "inviteId"));
  let approved: ApprovedOnboarding;
  try {
    approved = await mutate(approveOnboardingSpec, fields);
  } catch (error) {
    return refusal(error, values);
  }
  const session = await getSession();
  const organisationId = session?.active?.organisationId;
  const role = ONBOARDING_ROLE_LABELS[approved.role];
  const parts = [`Approved as ${role}.`];
  if (approved.membershipId && session && organisationId) {
    managerNoticesAfter(approved, organisationId, session.user.id);
    parts.push("They can now sign in to the manager app.");
  }
  if (approved.workerId && organisationId && !approved.membershipId) {
    const emailed = await inviteApprovedWorker(approved.workerId, organisationId);
    parts.push(
      emailed
        ? "Their phone app invite is on its way by email."
        : "Send their phone app invite from Worker invites.",
    );
  }
  if (approved.bankDetailsPending) {
    parts.push("Their bank details wait for a second person to approve them in Approvals.");
  }
  revalidatePath(ONBOARDING_PATH);
  revalidatePath("/app/people");
  return { ok: true, message: parts.join(" ") };
}
