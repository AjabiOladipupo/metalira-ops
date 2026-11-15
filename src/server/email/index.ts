import "server-only";

import { createElement } from "react";
import { z } from "zod";
import { emailAppUrl } from "./config";
import { sendEmail, type SendEmailResult } from "./send";
import { TestEmail, testEmailSubject } from "./templates/test-email";
import { WelcomeOwnerEmail, welcomeOwnerSubject } from "./templates/welcome-owner";

export { EmailConfigError, EmailSendError, sendEmail } from "./send";
export type { SendEmailInput, SendEmailResult } from "./send";

const welcomeOwnerSchema = z.object({
  to: z.email(),
  ownerName: z.string().trim().min(1).max(200),
  organisationName: z.string().trim().min(1).max(200),
  organisationId: z.uuid(),
});

export type WelcomeOwnerEmailInput = z.input<typeof welcomeOwnerSchema>;

/**
 * Welcome email for the owner who just signed up. Sent once per organisation:
 * the idempotency key stops a retried sign-up from sending it twice.
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

/** Manual check that sending works. Used by scripts/send-test-email.ts. */
export async function sendTestEmail(to: string): Promise<SendEmailResult> {
  return sendEmail({
    to,
    subject: testEmailSubject,
    react: createElement(TestEmail, { appUrl: emailAppUrl(), sentAt: new Date() }),
    tags: [{ name: "type", value: "test" }],
  });
}
