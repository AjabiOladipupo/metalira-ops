import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { sendEmail, type SendEmailResult } from "./send";
import { emailDisplayName } from "./team";
import { ContractWelcomeEmail, contractWelcomeSubject } from "./templates/contract-welcome";

/**
 * The welcome email when a contract goes live (slice 2.7). One per contact, with an idempotency
 * key per contract and contact, so a retry never sends twice; activation itself returns
 * `send_welcome` only on the call that activated. Names are checked again here and any that
 * look like a web address are left out. Addresses are never logged.
 */

const name = z.string().trim().min(1).max(200);

const welcomeSchema = z.object({
  to: z.email(),
  contractId: z.uuid(),
  contactId: z.uuid(),
  organisationName: name.nullable(),
  contactName: name.nullable(),
  contractName: name.nullable(),
  reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/),
  sites: z.array(name).max(200),
  goLiveDate: z.string().min(1).max(40),
  invoiceEmail: z.email().nullable(),
});

export type ContractWelcomeInput = z.input<typeof welcomeSchema>;

export async function sendContractWelcomeEmail(
  input: ContractWelcomeInput,
): Promise<SendEmailResult> {
  const data = welcomeSchema.parse(input);
  const organisationName = emailDisplayName(data.organisationName);
  return sendEmail({
    to: data.to,
    subject: contractWelcomeSubject(organisationName, data.goLiveDate),
    react: createElement(ContractWelcomeEmail, {
      organisationName,
      contactName: emailDisplayName(data.contactName),
      contractName: emailDisplayName(data.contractName),
      reference: data.reference,
      sites: data.sites.flatMap((s) => {
        const safe = emailDisplayName(s);
        return safe ? [safe] : [];
      }),
      goLiveDate: data.goLiveDate,
      invoiceEmail: data.invoiceEmail,
      appUrl: emailAppUrl(),
    }),
    ...(data.invoiceEmail ? { replyTo: data.invoiceEmail } : {}),
    tags: [{ name: "type", value: "contract_welcome" }],
    idempotencyKey: `contract-welcome/${data.contractId}/${data.contactId}`,
  });
}
