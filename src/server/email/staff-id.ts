import "server-only";

import { createHash } from "node:crypto";
import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { emailSafeName } from "./index";
import { sendEmail, type SendEmailResult } from "./send";
import { emailDisplayName } from "./team";
import { SignInPausedEmail, signInPausedSubject } from "./templates/sign-in-paused";
import { StaffIdChangedEmail, staffIdChangedSubject } from "./templates/staff-id-changed";
import {
  StaffIdCorrectionRequestedEmail,
  staffIdCorrectionRequestedSubject,
} from "./templates/staff-id-correction-requested";

/**
 * Emails for slice 1.11: staff ID corrections (to approvers when raised, to the worker when
 * approved) and the alert when a company reaches its cap on wrong PINs. Names and staff IDs come
 * from the database and are checked again here. A value that looks like a web address
 * (`acme-pay.com/verify`) is never put in an email from Metalira's domain, where a mail client
 * would turn it into a link: the email uses generic wording instead (`emailDisplayName`). Each
 * send has an idempotency key, so a retry never sends twice; addresses appear in keys only as a
 * short hash and are never logged.
 */

const staffId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/);

/** A short, stable stand-in for an address in an idempotency key. */
function addressKey(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 16);
}

const requestedSchema = z.object({
  to: z.email(),
  correctionId: z.uuid(),
  workerId: z.uuid(),
  recipientId: z.uuid(),
  organisationName: emailSafeName,
  workerName: emailSafeName,
  requesterName: emailSafeName,
  oldStaffId: staffId,
  newStaffId: staffId,
});

/** To one approver: a staff ID correction is waiting for a second person. */
export async function sendStaffIdCorrectionRequestedEmail(
  input: z.input<typeof requestedSchema>,
): Promise<SendEmailResult> {
  const data = requestedSchema.parse(input);
  const appUrl = emailAppUrl();
  const workerName = emailDisplayName(data.workerName);
  const oldId = emailDisplayName(data.oldStaffId);
  const newId = emailDisplayName(data.newStaffId);
  return sendEmail({
    to: data.to,
    subject: staffIdCorrectionRequestedSubject(workerName),
    react: createElement(StaffIdCorrectionRequestedEmail, {
      organisationName: emailDisplayName(data.organisationName),
      workerName,
      // Both or neither: half a change would read wrongly.
      oldStaffId: oldId && newId ? oldId : null,
      newStaffId: oldId && newId ? newId : null,
      requesterName: emailDisplayName(data.requesterName),
      reviewUrl: `${appUrl}/app/people/${data.workerId}#contact`,
      appUrl,
    }),
    tags: [{ name: "type", value: "staff_id_correction_requested" }],
    idempotencyKey: `staff-id-correction-requested/${data.correctionId}/${data.recipientId}`,
  });
}

const changedSchema = z.object({
  to: z.email(),
  correctionId: z.uuid(),
  organisationName: emailSafeName,
  workerName: emailSafeName,
  newStaffId: staffId,
});

/** To the worker: their staff ID was corrected; sign in with the new one. */
export async function sendStaffIdChangedEmail(
  input: z.input<typeof changedSchema>,
): Promise<SendEmailResult> {
  const data = changedSchema.parse(input);
  const organisationName = emailDisplayName(data.organisationName);
  return sendEmail({
    to: data.to,
    subject: staffIdChangedSubject(organisationName),
    react: createElement(StaffIdChangedEmail, {
      organisationName,
      workerName: emailDisplayName(data.workerName),
      newStaffId: emailDisplayName(data.newStaffId),
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "staff_id_changed" }],
    idempotencyKey: `staff-id-changed/${data.correctionId}/${addressKey(data.to)}`,
  });
}

const pausedSchema = z.object({
  to: z.email(),
  /** The worker_auth.company_throttled audit row: one alert per window and recipient. */
  alertId: z.uuid(),
  recipientId: z.uuid(),
  organisationName: emailSafeName,
  cap: z.number().int().positive(),
  minutes: z.number().int().positive(),
  until: z.string().min(1).max(40),
});

/** To the owner or an HR user: the company reached its cap on wrong PINs. */
export async function sendSignInPausedEmail(
  input: z.input<typeof pausedSchema>,
): Promise<SendEmailResult> {
  const data = pausedSchema.parse(input);
  const organisationName = emailDisplayName(data.organisationName);
  return sendEmail({
    to: data.to,
    subject: signInPausedSubject(organisationName),
    react: createElement(SignInPausedEmail, {
      organisationName,
      cap: data.cap,
      minutes: data.minutes,
      until: data.until,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "sign_in_paused" }],
    idempotencyKey: `sign-in-paused/${data.alertId}/${data.recipientId}`,
  });
}
