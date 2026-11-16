import "server-only";

import { createHash } from "node:crypto";
import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { emailSafeName } from "./index";
import { sendEmail, type SendEmailResult } from "./send";
import { BankChangeAppliedEmail, bankChangeAppliedSubject } from "./templates/bank-change-applied";
import {
  BankChangeApprovedEmail,
  bankChangeApprovedSubject,
} from "./templates/bank-change-approved";
import {
  BankChangeRequestedEmail,
  bankChangeRequestedSubject,
} from "./templates/bank-change-requested";

/**
 * Emails for bank-detail changes (slice 1.7). They name the account by its last four digits
 * only, never the bank or the full number. Names come from the database, where they are plain
 * text; they are checked again here because they reach an email from Metalira's own domain.
 * Each send has an idempotency key per change and recipient, so a retry never sends twice. A
 * worker's notices can go to more than one address (bank-change-notices.ts), so their key names
 * the address by a short hash, never in clear.
 */

/** A short, stable stand-in for an address in an idempotency key. */
function addressKey(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 16);
}

const last4 = z.string().regex(/^\d{4}$/);
const staffId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}<>]*$/u);
const dateTime = z.string().min(1).max(40);

const requestedSchema = z.object({
  to: z.email(),
  changeId: z.uuid(),
  recipientId: z.uuid(),
  organisationName: emailSafeName,
  workerName: emailSafeName,
  staffId,
  requesterName: emailSafeName.nullable(),
  last4,
});

/** To one approver: a bank change is waiting for a second person. */
export async function sendBankChangeRequestedEmail(
  input: z.input<typeof requestedSchema>,
): Promise<SendEmailResult> {
  const data = requestedSchema.parse(input);
  return sendEmail({
    to: data.to,
    subject: bankChangeRequestedSubject(data.workerName),
    react: createElement(BankChangeRequestedEmail, {
      organisationName: data.organisationName,
      workerName: data.workerName,
      staffId: data.staffId,
      requesterName: data.requesterName,
      last4: data.last4,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "bank_change_requested" }],
    idempotencyKey: `bank-change-requested/${data.changeId}/${data.recipientId}`,
  });
}

const workerSchema = z.object({
  to: z.email(),
  changeId: z.uuid(),
  organisationName: emailSafeName,
  workerName: emailSafeName,
  last4,
  at: dateTime,
});

/** To the worker: a second person approved the change; it takes effect after the hold. */
export async function sendBankChangeApprovedEmail(
  input: z.input<typeof workerSchema>,
): Promise<SendEmailResult> {
  const data = workerSchema.parse(input);
  return sendEmail({
    to: data.to,
    subject: bankChangeApprovedSubject(data.organisationName),
    react: createElement(BankChangeApprovedEmail, {
      organisationName: data.organisationName,
      workerName: data.workerName,
      last4: data.last4,
      appliesAt: data.at,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "bank_change_approved" }],
    idempotencyKey: `bank-change-approved/${data.changeId}/${addressKey(data.to)}`,
  });
}

/** To the worker: the hold has ended and payouts now use the new account. */
export async function sendBankChangeAppliedEmail(
  input: z.input<typeof workerSchema>,
): Promise<SendEmailResult> {
  const data = workerSchema.parse(input);
  return sendEmail({
    to: data.to,
    subject: bankChangeAppliedSubject(data.last4),
    react: createElement(BankChangeAppliedEmail, {
      organisationName: data.organisationName,
      workerName: data.workerName,
      last4: data.last4,
      appliedAt: data.at,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "bank_change_applied" }],
    idempotencyKey: `bank-change-applied/${data.changeId}/${addressKey(data.to)}`,
  });
}
