import "server-only";

import { createElement } from "react";
import { z } from "zod";
import { emailAppUrl } from "./config";
import { sendEmail, type SendEmailResult } from "./send";
import { MappingChangedEmail, mappingChangedSubject } from "./templates/mapping-changed";
import { TestEmail, testEmailSubject } from "./templates/test-email";
import { WelcomeOwnerEmail, welcomeOwnerSubject } from "./templates/welcome-owner";

export { EmailConfigError, EmailSendError, sendEmail } from "./send";
export type { SendEmailInput, SendEmailResult } from "./send";

/**
 * A name typed by a user that ends up in an email from Metalira's own domain (subject, preview,
 * body, footer). Plain text only: no control characters, no angle brackets and nothing that a
 * mail client would turn into a link, so a sign-up form cannot be used to send branded phishing.
 */
const emailSafeName = z
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

const mappingChangedSchema = z.object({
  to: z.email(),
  managerName: emailSafeName.nullable(),
  workerName: emailSafeName,
  staffId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[^\p{Cc}<>]*$/u),
  organisationName: emailSafeName,
  reportsToYou: z.boolean(),
  // Built from names the database already holds as plain text (departments, sites, projects).
  changes: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .regex(/^[^\p{Cc}<>]*$/u),
    )
    .max(10),
  appliesFrom: z.string().max(40).nullable(),
});

export type MappingChangedEmailInput = z.input<typeof mappingChangedSchema>;

/**
 * Tells a worker's line manager that the worker now reports to them, or that their department,
 * site or projects changed (slice 1.6). The address comes from the database (the line manager's
 * worker record or confirmed sign-in address), never from form input.
 */
export async function sendMappingChangedEmail(
  input: MappingChangedEmailInput,
): Promise<SendEmailResult> {
  const { to, ...props } = mappingChangedSchema.parse(input);
  return sendEmail({
    to,
    subject: mappingChangedSubject(props.workerName, props.reportsToYou),
    react: createElement(MappingChangedEmail, { ...props, appUrl: emailAppUrl() }),
    tags: [{ name: "type", value: "mapping_changed" }],
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
