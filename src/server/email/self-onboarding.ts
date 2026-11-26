import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { emailSafeName } from "./index";
import { sendEmail, type SendEmailResult } from "./send";
import { emailDisplayName } from "./team";
import {
  SelfOnboardingApprovedEmail,
  SelfOnboardingInviteEmail,
  selfOnboardingApprovedSubject,
  selfOnboardingInviteSubject,
} from "./templates/self-onboarding";

/**
 * Self-onboarding emails (slice U.4): the invite, and "you can sign in" to a manager whose
 * details were approved. Addresses come from the invite row. Names are checked again because
 * they reach an email from Metalira's domain.
 */

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

/** The onboarding link, once per token (a resend has a new expiry, so a new key). */
export async function sendSelfOnboardingInviteEmail(
  input: z.input<typeof inviteSchema>,
): Promise<SendEmailResult> {
  const e = inviteSchema.parse(input);
  const organisationName = emailDisplayName(e.organisationName);
  return sendEmail({
    to: e.to,
    subject: selfOnboardingInviteSubject(organisationName),
    react: createElement(SelfOnboardingInviteEmail, {
      organisationName,
      inviterName: emailDisplayName(e.inviterName),
      roleLabel: e.roleLabel,
      email: e.to,
      inviteUrl: e.inviteUrl,
      expiresOn: lagosDate(e.expiresAt),
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "self_onboarding_invite" }],
    idempotencyKey: `self-onboarding/${e.inviteId}/${e.expiresAt.getTime()}`,
  });
}

const approvedSchema = z.object({
  to: z.email(),
  inviteId: z.uuid(),
  organisationName: emailSafeName,
  roleLabel,
  signInUrl: z.url({ protocol: /^https?$/ }),
});

export async function sendSelfOnboardingApprovedEmail(
  input: z.input<typeof approvedSchema>,
): Promise<SendEmailResult> {
  const e = approvedSchema.parse(input);
  const organisationName = emailDisplayName(e.organisationName);
  return sendEmail({
    to: e.to,
    subject: selfOnboardingApprovedSubject(organisationName),
    react: createElement(SelfOnboardingApprovedEmail, {
      organisationName,
      roleLabel: e.roleLabel,
      signInUrl: e.signInUrl,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "self_onboarding_approved" }],
    idempotencyKey: `self-onboarding-approved/${e.inviteId}`,
  });
}
