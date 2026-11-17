"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import { APP_HOME_PATH, CHECK_EMAIL_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";
import { ROLE_LABELS } from "@/lib/roles";
import { isInviteToken, teamInvitePath } from "@/lib/team";
import {
  sendTeamInviteEmail,
  sendTeamRemovedEmail,
  sendTeamRoleChangedEmail,
} from "@/server/email/team";

import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_COOKIE_OPTIONS } from "./active-org";
import { getCompany } from "./company-data";
import { MutationError, mutate } from "./mutate";
import { fullNameSchema } from "./names";
import { appOrigin } from "./origin";
import { formFields } from "./schemas";
import { getSession } from "./session";
import {
  cancelSpec,
  changeRoleSpec,
  inviteSpec,
  removeSpec,
  resendSpec,
  type ChangedMember,
  type IssuedInvite,
} from "./team";
import { lookupTeamInvite } from "./team-invite-lookup";
import type { JoinActionState, TeamActionState } from "./team-state";
import { inviteOrigin } from "./worker-invites";

/**
 * Server Actions for Settings → Team and the join page (slice 1.12). Team changes go through
 * mutate() (owner or admin of the active company; the database checks the role and the team
 * rules again and audits every row). Emails go out after the change; addresses never reach the
 * logs, which record error names only.
 */

const TEAM_PATH = "/app/settings/team";
const FAILED = "That was not saved. Try again in a minute.";

function logFailure(event: string, error: unknown): void {
  const cause = error instanceof MutationError && error.cause ? error.cause : error;
  console.error(
    `${event}:`,
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
}

function refusal(error: unknown, values?: Record<string, string>): TeamActionState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") {
      return { ok: false, status: 403, formError: error.message, values };
    }
    if (error.code === "invalid") {
      const fieldErrors = error.fieldErrors;
      const hasFields = Object.keys(fieldErrors).length > 0;
      return {
        ok: false,
        status: 400,
        formError: hasFields ? undefined : error.message,
        fieldErrors,
        values,
      };
    }
  }
  logFailure("team.save_failed", error);
  return { ok: false, status: 500, formError: FAILED, values };
}

type EmailOutcome = "sent" | "skipped" | "failed";

/** Emails the invite link. Never throws; a failure is logged by error name only. */
async function emailInvite(
  invite: IssuedInvite,
  organisationId: string,
  inviterName: string | null,
  url: string,
): Promise<EmailOutcome> {
  try {
    const company = await getCompany(organisationId);
    if (!company) return "failed";
    const result = await sendTeamInviteEmail({
      to: invite.email,
      inviteId: invite.inviteId,
      organisationName: company.name,
      inviterName,
      roleLabel: ROLE_LABELS[invite.role],
      inviteUrl: url,
      expiresAt: invite.expiresAt,
    });
    return result.status === "sent" ? "sent" : "skipped";
  } catch (error) {
    logFailure("team.invite_email_failed", error);
    return "failed";
  }
}

async function inviteResult(invite: IssuedInvite, verb: "sent" | "sent again") {
  const session = await getSession();
  const organisationId = session?.active?.organisationId;
  const url = `${(await inviteOrigin()).replace(/\/+$/, "")}${teamInvitePath(invite.token)}`;
  const outcome = organisationId
    ? await emailInvite(invite, organisationId, session?.user.fullName ?? null, url)
    : "failed";
  revalidatePath(TEAM_PATH);
  const role = ROLE_LABELS[invite.role];
  if (outcome === "sent") {
    return {
      ok: true,
      status: 200,
      message: `Invite ${verb} to ${invite.email} as ${role}. The link works for 7 days.`,
    } satisfies TeamActionState;
  }
  return {
    ok: true,
    status: 200,
    message:
      outcome === "skipped"
        ? `Invite created for ${invite.email} as ${role}, but email is not set up here. Copy the link and send it to them yourself.`
        : `Invite created for ${invite.email} as ${role}, but the email could not be sent. Copy the link and send it to them yourself.`,
    link: url,
  } satisfies TeamActionState;
}

/** Invites a manager by email with one role. */
export async function inviteManagerAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const fields = formFields(formData);
  const values = { email: fields.email ?? "", role: fields.role ?? "" };
  let invite: IssuedInvite;
  try {
    invite = await mutate(inviteSpec, fields);
  } catch (error) {
    return refusal(error, values);
  }
  return inviteResult(invite, "sent");
}

/** Sends a pending or expired invite again with a new link. */
export async function resendInviteAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  let invite: IssuedInvite;
  try {
    invite = await mutate(resendSpec, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  return inviteResult(invite, "sent again");
}

/** Cancels a pending invite. */
export async function cancelInviteAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  try {
    await mutate(cancelSpec, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  revalidatePath(TEAM_PATH);
  return { ok: true, status: 200, message: "Invite cancelled. Its link no longer works." };
}

/** Tells the member about the change, after the response. Never throws. */
function noticeAfter(member: ChangedMember, organisationId: string, actorName: string | null) {
  after(async () => {
    try {
      const company = await getCompany(organisationId);
      if (!company) return;
      if (member.newRole) {
        await sendTeamRoleChangedEmail({
          to: member.email,
          organisationName: company.name,
          memberName: member.name,
          changedBy: actorName,
          oldRoleLabel: ROLE_LABELS[member.oldRole],
          newRoleLabel: ROLE_LABELS[member.newRole],
        });
      } else {
        await sendTeamRemovedEmail({
          to: member.email,
          membershipId: member.membershipId,
          organisationName: company.name,
          memberName: member.name,
          removedBy: actorName,
        });
      }
    } catch (error) {
      logFailure("team.notice_failed", error);
    }
  });
}

function memberName(member: ChangedMember): string {
  return member.name ?? member.email;
}

/** Gives a manager another role. */
export async function changeRoleAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  let member: ChangedMember;
  try {
    member = await mutate(changeRoleSpec, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  const session = await getSession();
  if (session?.active) {
    noticeAfter(member, session.active.organisationId, session.user.fullName);
  }
  revalidatePath(TEAM_PATH);
  return {
    ok: true,
    status: 200,
    message: `${memberName(member)} is now ${ROLE_LABELS[member.newRole ?? member.oldRole]}.`,
  };
}

/** Removes a manager from the company. */
export async function removeMemberAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  let member: ChangedMember;
  try {
    member = await mutate(removeSpec, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  const session = await getSession();
  if (session?.active) {
    noticeAfter(member, session.active.organisationId, session.user.fullName);
  }
  revalidatePath(TEAM_PATH);
  return { ok: true, status: 200, message: `${memberName(member)} no longer has access.` };
}

// ---------------------------------------------------------------------------
// The join page (/join/[token])
// ---------------------------------------------------------------------------

const tokenSchema = z.string().refine(isInviteToken, "This invite link is not valid.");

const ACCEPT_MESSAGES: Record<string, string> = {
  MLTM1: "You are already a member of this company.",
  MLTM2:
    "Your sign-in is a worker's at this company, so it can't also be a manager's. Ask the person who invited you to use another email.",
  MLTM3: "This invite has already been used.",
  MLTM4: "This invite has expired. Ask the person who invited you to send it again.",
  MLTM5: "This invite was cancelled. Ask the person who invited you for a new one.",
  "42501":
    "This invite is for a different email address, or is no longer valid. Sign in with the address it was sent to, or ask for a new invite.",
  "22023": "This invite link is not valid.",
};

/** Accepts the invite as the signed-in user, then opens the app in that company. */
export async function acceptTeamInviteAction(
  _prev: JoinActionState,
  formData: FormData,
): Promise<JoinActionState> {
  const token = tokenSchema.safeParse(formFields(formData).token);
  if (!token.success) return { ok: false, formError: ACCEPT_MESSAGES["22023"] };
  const session = await getSession();
  if (!session) {
    redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(teamInvitePath(token.data))}`);
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.rpc("accept_membership_invite", { p_token: token.data });
  if (error || !data) {
    const message = error ? ACCEPT_MESSAGES[error.code] : undefined;
    if (!message) logFailure("team.accept_failed", new Error(error?.code ?? "no organisation"));
    return { ok: false, formError: message ?? FAILED };
  }

  (await cookies()).set(ACTIVE_ORG_COOKIE, data, ACTIVE_ORG_COOKIE_OPTIONS);
  redirect(APP_HOME_PATH);
}

const joinSignUpSchema = z.object({
  token: tokenSchema,
  fullName: fullNameSchema,
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(72, "Use 72 characters or fewer")
    .regex(/[A-Za-z]/, "Use at least one letter")
    .regex(/[0-9]/, "Use at least one number"),
});

/**
 * Creates an account for the invited address. The address comes from the invite, never from
 * the form, so this can only ever sign up the person the owner or admin invited. No company is
 * created (no pending company name); the confirmation link brings them back to the invite.
 */
export async function signUpForInviteAction(
  _prev: JoinActionState,
  formData: FormData,
): Promise<JoinActionState> {
  const fields = formFields(formData);
  const values = { fullName: fields.fullName ?? "" };
  const parsed = joinSignUpSchema.safeParse(fields);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, fieldErrors, values, formError: fieldErrors.token };
  }

  const invite = await lookupTeamInvite(parsed.data.token);
  if (invite.state !== "pending") {
    return { ok: false, formError: "This invite can no longer be used.", values };
  }

  const path = teamInvitePath(parsed.data.token);
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signUp({
    email: invite.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${await appOrigin()}/auth/callback?next=${encodeURIComponent(path)}`,
      data: { full_name: parsed.data.fullName },
    },
  });
  if (error) {
    if (error.status === 429 || error.code === "over_request_rate_limit") {
      return {
        ok: false,
        formError: "Too many attempts. Wait a few minutes and try again.",
        values,
      };
    }
    if (error.code === "weak_password") {
      return {
        ok: false,
        fieldErrors: { password: "Choose a stronger password with letters and numbers." },
        values,
      };
    }
    if (error.code === "user_already_exists" || error.code === "email_exists") {
      return {
        ok: false,
        formError: "There is already an account for this address. Sign in instead.",
        values,
      };
    }
    logFailure("team.join_sign_up_failed", new Error(error.code ?? "unknown"));
    return { ok: false, formError: FAILED, values };
  }

  // With confirmation on, Supabase answers a sign-up for an existing address with a user that
  // has no identities and sends nothing. The visitor holds the invite, so say so.
  if (data.user && data.user.identities?.length === 0) {
    return {
      ok: false,
      formError: "There is already an account for this address. Sign in instead.",
      values,
    };
  }
  // Email confirmation off: signed in already, so back to the invite to accept it.
  if (data.session) redirect(path);
  redirect(`${CHECK_EMAIL_PATH}?sent=invite`);
}

/** Signs out the wrong account and sends the visitor to sign in again, back to the invite. */
export async function signOutForInviteAction(formData: FormData): Promise<void> {
  const token = tokenSchema.safeParse(formFields(formData).token);
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  (await cookies()).delete(ACTIVE_ORG_COOKIE);
  redirect(
    token.success
      ? `${SIGN_IN_PATH}?next=${encodeURIComponent(teamInvitePath(token.data))}`
      : SIGN_IN_PATH,
  );
}
