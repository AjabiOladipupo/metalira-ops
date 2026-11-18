"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import { APP_HOME_PATH, CHECK_EMAIL_PATH, NEXT_PATH_KEY, SIGN_IN_PATH } from "@/lib/auth/routes";
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
import { emailLinkAllowed } from "./email-link-limit";
import { chooseOwnPassword, invitePasswordStepFor } from "./invite-password";
import { appOrigin } from "./origin";
import { formFields, newPasswordSchema } from "./schemas";
import { notifyOwnerChange, notifyOwnerJoined } from "./owner-notices";
import {
  decideOwnerChangeSpec,
  requestOwnerChangeSpec,
  type DecidedOwnerChange,
  type RequestedOwnerChange,
} from "./owners";
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
  // Links in emails use the configured app address (NEXT_PUBLIC_APP_URL), never the request.
  const url = `${(await appOrigin()).replace(/\/+$/, "")}${teamInvitePath(invite.token)}`;
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
  // The link is shown to the inviter only where email is deliberately off (development and
  // previews without a Resend key). In production a failed send never reveals the link: with it
  // the inviter could create the invitee's account with a password of their own.
  if (outcome === "skipped") {
    return {
      ok: true,
      status: 200,
      message: `Invite created for ${invite.email} as ${role}, but email is not set up here. Copy the link and send it to them yourself.`,
      link: url,
    } satisfies TeamActionState;
  }
  return {
    ok: true,
    status: 200,
    message: `Invite created for ${invite.email} as ${role}, but the email couldn't be sent. Use Resend to try again.`,
  } satisfies TeamActionState;
}

/** Invites a manager by email with one role, or (owners only) someone as an owner. */
export async function inviteManagerAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const fields = formFields(formData);
  const values = { email: fields.email ?? "", role: fields.role ?? "" };
  if (fields.role === "owner") {
    return ownerChangeResult({ kind: "invite", email: fields.email ?? "" }, values);
  }
  let invite: IssuedInvite;
  try {
    invite = await mutate(inviteSpec, fields);
  } catch (error) {
    return refusal(error, values);
  }
  return inviteResult(invite, "sent");
}

// ---------------------------------------------------------------------------
// Owner changes (slice 1.13)
// ---------------------------------------------------------------------------

/** The owner invite a request or an approval just issued, ready to email. */
async function issuedOwnerInvite(changeId: string, token: string): Promise<IssuedInvite | null> {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("membership_invites")
    .select("id, email, expires_at")
    .eq("owner_change_id", changeId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  return {
    inviteId: data.id,
    token,
    email: data.email,
    role: "owner",
    expiresAt: new Date(data.expires_at),
  };
}

function ownerNoticeAfter(
  changeId: string,
  event: "requested" | "done" | "rejected" | "withdrawn",
  actorId: string,
) {
  after(() => notifyOwnerChange(changeId, event, actorId).then(() => undefined));
}

const OWNER_PENDING =
  "Waiting for another owner to approve. Every owner has been emailed; nothing changes until a different owner approves.";

async function ownerChangeResult(
  input: Record<string, string>,
  values?: Record<string, string>,
): Promise<TeamActionState> {
  let change: RequestedOwnerChange;
  try {
    change = await mutate(requestOwnerChangeSpec, input);
  } catch (error) {
    return refusal(error, values);
  }
  const session = await getSession();
  if (session) {
    ownerNoticeAfter(
      change.changeId,
      change.status === "pending" ? "requested" : "done",
      session.user.id,
    );
  }
  revalidatePath(TEAM_PATH);
  if (change.status === "pending") {
    return { ok: true, status: 200, message: OWNER_PENDING };
  }
  if (change.inviteToken) {
    const invite = await issuedOwnerInvite(change.changeId, change.inviteToken);
    if (invite) return inviteResult(invite, "sent");
  }
  const done: Record<string, string> = {
    add: "They are now an owner. Every owner has been emailed.",
    invite: "Owner invite created.",
    remove: "Done.",
    demote: "Done.",
  };
  return { ok: true, status: 200, message: done[change.kind] };
}

/** Asks for an owner change from a member row: make owner, remove as owner, step down. */
export async function requestOwnerChangeAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  return ownerChangeResult(formFields(formData));
}

/** Approves, rejects or withdraws a pending owner change. */
export async function decideOwnerChangeAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  let decided: DecidedOwnerChange;
  try {
    decided = await mutate(decideOwnerChangeSpec, formFields(formData));
  } catch (error) {
    return refusal(error);
  }
  const session = await getSession();
  const event =
    decided.status === "approved"
      ? "done"
      : decided.status === "rejected"
        ? "rejected"
        : "withdrawn";
  if (session) ownerNoticeAfter(decided.changeId, event, session.user.id);
  revalidatePath(TEAM_PATH);
  if (decided.status === "approved" && decided.inviteToken) {
    const invite = await issuedOwnerInvite(decided.changeId, decided.inviteToken);
    if (invite) return inviteResult(invite, "sent");
  }
  const messages = {
    approved: "Approved. The change has happened and every owner has been emailed.",
    rejected: "Rejected. Nothing changed.",
    cancelled: "Withdrawn. Nothing changed.",
    pending: "Saved.",
  } as const;
  return { ok: true, status: 200, message: messages[decided.status] };
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
  MLPW1:
    'For your safety, choose your password from a link we email you, then accept. Sign out, then choose "Email link" on the sign-in page.',
  MLOW6:
    "This owner invite now needs a second owner's approval. Ask an owner of the company to send a new one.",
  "42501":
    "This invite is for a different email address, or is no longer valid. Sign in with the address it was sent to, or ask for a new invite.",
  "22023": "This invite link is not valid.",
};

/**
 * Accepts the invite as the signed-in user, then opens the app in that company. Someone who
 * arrived through an email link (an invited manager confirming their address, slice 1.13) sets
 * their own password first, so no password chosen by anyone else survives.
 */
export async function acceptTeamInviteAction(
  _prev: JoinActionState,
  formData: FormData,
): Promise<JoinActionState> {
  const fields = formFields(formData);
  const token = tokenSchema.safeParse(fields.token);
  if (!token.success) return { ok: false, formError: ACCEPT_MESSAGES["22023"] };
  const session = await getSession();
  if (!session) {
    redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(teamInvitePath(token.data))}`);
  }

  const invite = await lookupTeamInvite(token.data);
  const supabase = await createServerSupabase();

  const step = invite.state === "pending" ? await invitePasswordStepFor(supabase) : "ready";
  if (step === "use_email_link") return { ok: false, formError: ACCEPT_MESSAGES.MLPW1 };
  if (step === "set_password") {
    // The invitee types their own name here (owner confirmed 19 Nov 2026),
    // and chooses their password: both only from this email-link session.
    const name = fullNameSchema.safeParse(fields.fullName ?? "");
    const password = newPasswordSchema.safeParse(fields.password ?? "");
    if (!name.success || !password.success) {
      return {
        ok: false,
        fieldErrors: {
          ...(name.success
            ? {}
            : { fullName: name.error.issues[0]?.message ?? "Enter your name." }),
          ...(password.success
            ? {}
            : { password: password.error.issues[0]?.message ?? "Choose a password." }),
        },
        values: { fullName: fields.fullName ?? "" },
      };
    }
    // Only once the invite is still open and for this account: never change a password for an
    // invite that can't be accepted.
    if (invite.state !== "pending" || invite.email !== session.user.email.toLowerCase()) {
      return { ok: false, formError: ACCEPT_MESSAGES["42501"] };
    }
    try {
      // Records password_set_at, ends the account's other sessions (anyone who signed the address
      // up before the invitee confirmed it) and refreshes this one.
      const refusal = await chooseOwnPassword(supabase, session.user.id, password.data);
      if (refusal) return { ok: false, fieldErrors: { password: refusal } };
    } catch (passwordError) {
      logFailure("team.join_password_failed", passwordError);
      return { ok: false, formError: FAILED };
    }
    // The user's own client, so RLS (own row only) and the audit trigger apply.
    const { error: nameError } = await supabase
      .from("profiles")
      .update({ full_name: name.data })
      .eq("user_id", session.user.id);
    if (nameError) logFailure("team.join_name_failed", new Error(nameError.code));
  }
  const { data, error } = await supabase.rpc("accept_membership_invite", { p_token: token.data });
  if (error || !data) {
    const message = error ? ACCEPT_MESSAGES[error.code] : undefined;
    if (!message) logFailure("team.accept_failed", new Error(error?.code ?? "no organisation"));
    return { ok: false, formError: message ?? FAILED };
  }

  if (invite.state === "pending" && invite.role === "owner") {
    const organisationId = data;
    after(() => notifyOwnerJoined(organisationId, session.user.id).then(() => undefined));
  }
  // Best effort: the invite path parked at sign-up (for the confirmation link) is spent now.
  await supabase.auth.updateUser({ data: { [NEXT_PATH_KEY]: null } });
  (await cookies()).set(ACTIVE_ORG_COOKIE, data, ACTIVE_ORG_COOKIE_OPTIONS);
  redirect(APP_HOME_PATH);
}

/**
 * Starts an account for the invited address (slice 1.13: no password or name here). The address
 * comes from the invite, never from the form, so this can only ever email the person the owner
 * or admin invited. Supabase emails them a confirmation link (or, for an address that already has
 * an account, a sign-in link); it brings them back to the invite signed in, where they type their
 * name, choose their password and accept. Whoever holds the invite link picks neither. Capped
 * per invite and per visitor address (email-link-limit.ts). No company is created.
 */
export async function signUpForInviteAction(
  _prev: JoinActionState,
  formData: FormData,
): Promise<JoinActionState> {
  const token = tokenSchema.safeParse(formFields(formData).token);
  if (!token.success) return { ok: false, formError: ACCEPT_MESSAGES["22023"] };

  const invite = await lookupTeamInvite(token.data);
  if (invite.state !== "pending") {
    return { ok: false, formError: "This invite can no longer be used." };
  }
  if (!(await emailLinkAllowed({ kind: "token", value: token.data }, await headers()))) {
    return { ok: false, formError: "Too many links sent for this invite. Try again in an hour." };
  }

  const path = teamInvitePath(token.data);
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email: invite.email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${await appOrigin()}/auth/callback?next=${encodeURIComponent(path)}`,
      // Used only when the account is new. next_path: where the confirmation email's link lands
      // (supabase/templates/confirmation.html).
      data: { [NEXT_PATH_KEY]: path },
    },
  });
  if (error) {
    if (
      error.status === 429 ||
      error.code === "over_request_rate_limit" ||
      error.code === "over_email_send_rate_limit"
    ) {
      return { ok: false, formError: "Too many attempts. Wait a few minutes and try again." };
    }
    if (error.code === "signup_disabled" || error.code === "otp_disabled") {
      return { ok: false, formError: "New accounts are closed for now." };
    }
    logFailure("team.join_sign_up_failed", new Error(error.code ?? "unknown"));
    return { ok: false, formError: FAILED };
  }
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
