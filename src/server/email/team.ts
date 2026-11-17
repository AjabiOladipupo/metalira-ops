import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { emailSafeName } from "./index";
import { sendEmail, type SendEmailResult } from "./send";
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
  return sendEmail({
    to: e.to,
    subject: teamInviteSubject(e.organisationName),
    react: createElement(TeamInviteEmail, {
      organisationName: e.organisationName,
      inviterName: e.inviterName,
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
  return sendEmail({
    to: e.to,
    subject: teamRoleChangedSubject(e.organisationName, e.newRoleLabel),
    react: createElement(TeamRoleChangedEmail, {
      organisationName: e.organisationName,
      memberName: e.memberName,
      oldRoleLabel: e.oldRoleLabel,
      newRoleLabel: e.newRoleLabel,
      changedBy: e.changedBy,
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
  return sendEmail({
    to: e.to,
    subject: teamRemovedSubject(e.organisationName),
    react: createElement(TeamRemovedEmail, {
      organisationName: e.organisationName,
      memberName: e.memberName,
      removedBy: e.removedBy,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "team_removed" }],
    idempotencyKey: `team-removed/${e.membershipId}`,
  });
}
