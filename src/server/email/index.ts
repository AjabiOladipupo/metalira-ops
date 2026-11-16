import "server-only";

import { createElement } from "react";
import { z } from "zod";
import { emailAppUrl } from "./config";
import { sendEmail, type SendEmailResult } from "./send";
import { TestEmail, testEmailSubject } from "./templates/test-email";
import { WelcomeOwnerEmail, welcomeOwnerSubject } from "./templates/welcome-owner";
import { WorkerInviteEmail, workerInviteSubject } from "./templates/worker-invite";

export { EmailConfigError, EmailSendError, sendEmail } from "./send";
export type { SendEmailInput, SendEmailResult } from "./send";

/**
 * A name typed by a user that ends up in an email from Metalira's own domain (subject, preview,
 * body, footer). Plain text only: no control characters, no angle brackets and nothing that a
 * mail client would turn into a link, so a sign-up form cannot be used to send branded phishing.
 */
export const emailSafeName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}<>]*$/u, "Must not contain control characters or angle brackets")
  .refine((value) => !/:\/\/|www\./i.test(value), "Must not contain a web address");

const welcomeOwnerSchema = z.object({
  to: z.email(),
  ownerName: emailSafeName,
  organisationName: emailSafeName,
  organisationId: z.uuid(),
});

export type WelcomeOwnerEmailInput = z.input<typeof welcomeOwnerSchema>;

/**
 * Welcome email for the owner who just signed up. Sent once per organisation:
 * the idempotency key stops a retried sign-up from sending it twice.
 *
 * Callers must send it only after Supabase has confirmed the owner's email address (for
 * example from the auth confirm callback), and must take `to` from the authenticated user's
 * confirmed email, never from form input. Otherwise anyone could make Metalira send this
 * email, with a name of their choosing, to any address.
 */
export async function sendWelcomeOwnerEmail(
  input: WelcomeOwnerEmailInput,
): Promise<SendEmailResult> {
  const { to, ownerName, organisationName, organisationId } = welcomeOwnerSchema.parse(input);
  return sendEmail({
    to,
    subject: welcomeOwnerSubject(organisationName),
    react: createElement(WelcomeOwnerEmail, { ownerName, organisationName, appUrl: emailAppUrl() }),
    tags: [{ name: "type", value: "welcome_owner" }],
    idempotencyKey: `welcome-owner/${organisationId}`,
  });
}

const workerInviteSchema = z.object({
  to: z.email(),
  firstName: emailSafeName,
  organisationName: emailSafeName,
  companyCode: z.string().regex(/^[2-9A-HJKMNP-Z]{6}$/),
  staffId: emailSafeName.pipe(z.string().max(64)),
  inviteUrl: z.url({ protocol: /^https?$/ }),
  expiresAt: z.date(),
  inviteId: z.uuid(),
});

export type WorkerInviteEmailInput = z.input<typeof workerInviteSchema>;

/** "14 Nov 2026" in Lagos time, as the design system writes dates. */
function lagosDate(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Lagos",
  }).format(at);
}

/**
 * Invite for a worker who has an email address: a single-use link to set their PIN. Sent once
 * per invite (Resend idempotency key). The address comes from the worker record HR keeps, and
 * only owners, admins and HR can create invites (public.create_worker_invites).
 */
export async function sendWorkerInviteEmail(
  input: WorkerInviteEmailInput,
): Promise<SendEmailResult> {
  const e = workerInviteSchema.parse(input);
  return sendEmail({
    to: e.to,
    subject: workerInviteSubject(e.organisationName),
    react: createElement(WorkerInviteEmail, {
      firstName: e.firstName,
      organisationName: e.organisationName,
      companyCode: e.companyCode,
      staffId: e.staffId,
      inviteUrl: e.inviteUrl,
      expiresOn: lagosDate(e.expiresAt),
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "worker_invite" }],
    idempotencyKey: `worker-invite/${e.inviteId}`,
  });
}

/** Manual check that sending works. Used by scripts/send-test-email.ts. */
export async function sendTestEmail(to: string): Promise<SendEmailResult> {
  return sendEmail({
    to,
    subject: testEmailSubject,
    react: createElement(TestEmail, { appUrl: emailAppUrl(), sentAt: new Date() }),
    tags: [{ name: "type", value: "test" }],
  });
}
