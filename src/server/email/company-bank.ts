import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { sendEmail, type SendEmailResult } from "./send";
import { emailDisplayName } from "./team";
import {
  CompanyBankAppliedEmail,
  CompanyBankApprovedEmail,
  CompanyBankRequestedEmail,
  companyBankAppliedSubject,
  companyBankApprovedSubject,
  companyBankRequestedSubject,
} from "./templates/company-bank";

/**
 * Emails about the company bank account (slice 2.3). They name the account by bank and last
 * four digits only, never the full number. Names come from the database and are checked again
 * here; one that looks like a web address is left out for generic wording (`emailDisplayName`).
 * Each send has an idempotency key per request and recipient, so a retry never sends twice.
 * Addresses are never logged.
 */

const last4 = z.string().regex(/^\d{4}$/);
const dateTime = z.string().min(1).max(40);
/** Names are refused by the schema only when empty; anything odd falls back to generic wording. */
const name = z.string().trim().min(1).max(200);

const commonSchema = z.object({
  to: z.email(),
  accountId: z.uuid(),
  recipientId: z.uuid(),
  organisationName: name,
  bankName: name,
  last4,
});

const requestedSchema = commonSchema.extend({ requesterName: name.nullable() });

/** To one approver: a new collection account is waiting for a second person. */
export async function sendCompanyBankRequestedEmail(
  input: z.input<typeof requestedSchema>,
): Promise<SendEmailResult> {
  const data = requestedSchema.parse(input);
  const organisationName = emailDisplayName(data.organisationName);
  return sendEmail({
    to: data.to,
    subject: companyBankRequestedSubject(organisationName),
    react: createElement(CompanyBankRequestedEmail, {
      organisationName,
      requesterName: emailDisplayName(data.requesterName),
      bankName: emailDisplayName(data.bankName),
      last4: data.last4,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "company_bank_requested" }],
    idempotencyKey: `company-bank-requested/${data.accountId}/${data.recipientId}`,
  });
}

const approvedSchema = commonSchema.extend({ at: dateTime });

/** To an owner or finance user: a second person approved; it takes effect after the hold. */
export async function sendCompanyBankApprovedEmail(
  input: z.input<typeof approvedSchema>,
): Promise<SendEmailResult> {
  const data = approvedSchema.parse(input);
  return sendEmail({
    to: data.to,
    subject: companyBankApprovedSubject(data.last4),
    react: createElement(CompanyBankApprovedEmail, {
      organisationName: emailDisplayName(data.organisationName),
      bankName: emailDisplayName(data.bankName),
      last4: data.last4,
      appliesAt: data.at,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "company_bank_approved" }],
    idempotencyKey: `company-bank-approved/${data.accountId}/${data.recipientId}`,
  });
}

/** To an owner or finance user: invoices now show this account. */
export async function sendCompanyBankAppliedEmail(
  input: z.input<typeof approvedSchema>,
): Promise<SendEmailResult> {
  const data = approvedSchema.parse(input);
  return sendEmail({
    to: data.to,
    subject: companyBankAppliedSubject(data.last4),
    react: createElement(CompanyBankAppliedEmail, {
      organisationName: emailDisplayName(data.organisationName),
      bankName: emailDisplayName(data.bankName),
      last4: data.last4,
      appliedAt: data.at,
      appUrl: emailAppUrl(),
    }),
    tags: [{ name: "type", value: "company_bank_applied" }],
    idempotencyKey: `company-bank-applied/${data.accountId}/${data.recipientId}`,
  });
}
