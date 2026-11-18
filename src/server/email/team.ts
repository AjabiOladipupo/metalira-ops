import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { emailSafeName } from "./index";
import { sendEmail, type SendEmailResult } from "./send";
import { OwnerChangeEmail, ownerChangeSubject } from "./templates/owner-change";
import { TeamInviteEmail, teamInviteSubject } from "./templates/team-invite";
import { TeamRemovedEmail, teamRemovedSubject } from "./templates/team-removed";
import { TeamRoleChangedEmail, teamRoleChangedSubject } from "./templates/team-role-changed";

/**
 * Emails for Settings → Team (slice 1.12): the invite, and notices when a manager's role
 * changes or they are removed. Addresses come from the database (the invite row, or the
 * member's confirmed sign-in address), never from form input other than the invite address the
 * owner or admin typed. Names are checked again because they reach an email from Metalira's
 * own domain. Invites and removals have an idempotency key, so a retry never sends twice.
 */

/** "24 Nov 2026" in Lagos time, as the design system writes dates. */
function lagosDate(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Lagos",
  }).format(at);
}

/**
 * Text that looks like a web address without a scheme ("verify at paypal-secure.co"). A company
 * or person's name like that never reaches a subject or an email body from Metalira's domain:
 * the email falls back to generic wording, so the invite can't be used for branded phishing.
 * Names are not refused at sign-up, so a company with a dot in its name still works in the app.
 */
const DOMAIN_LIKE = /\b[a-z0-9-]+\.[a-z]{2,}\b/i;

/** `name` when it is safe to put in an email, else null (generic wording). */
export function emailDisplayName(name: string | null): string | null {
  if (!name) return null;
  if (DOMAIN_LIKE.test(name)) return null;
  // Anything the email schemas would refuse (control characters, angle brackets, a web address,
  // over 200 characters) falls back to generic wording too, so one odd name never stops a send.
  return emailSafeName.safeParse(name).success ? name : null;
}

const roleLabel = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z ]+$/);

const inviteSchema = z.object({
  to: z.email(),
  inviteId: z.uuid(),
  organisationName: emailSafeName,
  inviterName: emailSafeName.nullable(),
  roleLabel,
  inviteUrl: z.url({ protocol: /^https?$/ }),
  expiresAt: z.date(),
});

/** The invite link, once per token (a resend has a new expiry, so a new key). */
export async function sendTeamInviteEmail(
  input: z.input<typeof inviteSchema>,
): Promise<SendEmailResult> {
  const e = inviteSchema.parse(input);
  const organisationName = emailDisplayName(e.organisationName);
  return sendEmail({
    to: e.to,
    subject: teamInviteSubject(organisationName),
    react: createElement(TeamInviteEmail, {
      organisationName,
      inviterName: emailDisplayName(e.inviterName),
      roleLabel: e.roleLabel,
      email: e.to,
      inviteUrl: e.inviteUrl,
      expiresOn: lagosDate(e.expiresAt),
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "team_invite" }],
    idempotencyKey: `team-invite/${e.inviteId}/${e.expiresAt.getTime()}`,
  });
}

const roleChangedSchema = z.object({
  to: z.email(),
  organisationName: emailSafeName,
  memberName: emailSafeName.nullable(),
  changedBy: emailSafeName.nullable(),
  oldRoleLabel: roleLabel,
  newRoleLabel: roleLabel,
});

/** To the member: their role in the company changed. */
export async function sendTeamRoleChangedEmail(
  input: z.input<typeof roleChangedSchema>,
): Promise<SendEmailResult> {
  const e = roleChangedSchema.parse(input);
  const organisationName = emailDisplayName(e.organisationName);
  return sendEmail({
    to: e.to,
    subject: teamRoleChangedSubject(organisationName, e.newRoleLabel),
    react: createElement(TeamRoleChangedEmail, {
      organisationName,
      memberName: emailDisplayName(e.memberName),
      oldRoleLabel: e.oldRoleLabel,
      newRoleLabel: e.newRoleLabel,
      changedBy: emailDisplayName(e.changedBy),
      appUrl: emailAppUrl(),
    }),
    // No idempotency key: the same change can rightly happen twice (HR to finance and back).
    tags: [{ name: "type", value: "team_role_changed" }],
  });
}

const removedSchema = z.object({
  to: z.email(),
  membershipId: z.uuid(),
  organisationName: emailSafeName,
  memberName: emailSafeName.nullable(),
  removedBy: emailSafeName.nullable(),
});

/** To the former member: they were removed from the company. A membership is removed once. */
export async function sendTeamRemovedEmail(
  input: z.input<typeof removedSchema>,
): Promise<SendEmailResult> {
  const e = removedSchema.parse(input);
  const organisationName = emailDisplayName(e.organisationName);
  return sendEmail({
    to: e.to,
    subject: teamRemovedSubject(organisationName),
    react: createElement(TeamRemovedEmail, {
      organisationName,
      memberName: emailDisplayName(e.memberName),
      removedBy: emailDisplayName(e.removedBy),
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "team_removed" }],
    idempotencyKey: `team-removed/${e.membershipId}`,
  });
}

const ownerChangeSchema = z.object({
  to: z.email(),
  /** changeId/event/recipient: a retry never sends the same notice twice. */
  idempotencyKey: z.string().min(1).max(256),
  organisationName: emailSafeName,
  event: z.enum(["requested", "done", "rejected", "withdrawn", "joined"]),
  summary: z
    .string()
    .min(1)
    .max(400)
    .regex(/^[^\p{Cc}<>]*$/u),
  actorName: emailSafeName.nullable(),
  singleOwner: z.boolean(),
});

/**
 * To an owner (slice 1.13): the owners changed, or a change was asked for, rejected or withdrawn.
 * The summary is built from names already passed through emailDisplayName.
 */
export async function sendOwnerChangeEmail(
  input: z.input<typeof ownerChangeSchema>,
): Promise<SendEmailResult> {
  const e = ownerChangeSchema.parse(input);
  const organisationName = emailDisplayName(e.organisationName);
  return sendEmail({
    to: e.to,
    subject: ownerChangeSubject(organisationName, e.event),
    react: createElement(OwnerChangeEmail, {
      organisationName,
      event: e.event,
      summary: e.summary,
      actorName: emailDisplayName(e.actorName),
      singleOwner: e.singleOwner,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: `owner_change_${e.event}` }],
    idempotencyKey: e.idempotencyKey,
  });
}
