import { z } from "zod";

import { plainText } from "@/server/identity/names";
import { nubanSchema } from "@/server/people/schemas";

/**
 * Input for the company bank account actions (slice 2.3). Flat objects, so a form's field names
 * map straight onto the field errors `mutate()` reports. The database repeats the text rules.
 */

const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

function name(label: string) {
  return plainText(
    z
      .string()
      .trim()
      .min(1, `Enter the ${label.toLowerCase()}`)
      .max(200, `${label} must be 200 characters or fewer`),
    label,
  );
}

const note = (label: string) =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .max(500, `${label} must be 500 characters or fewer`)
      .regex(/^[^\p{Cc}<>]*$/u, `${label} must be plain text, without < or >`)
      // Never an account number in clear: free text reaches the audit log as written.
      .refine((value) => !/\d{10}/.test(value), `${label} can't contain an account number`)
      .nullish(),
  );

export const requestCompanyBankSchema = z.object({
  bankName: name("Bank name"),
  accountName: name("Account name"),
  bankAccountNumber: nubanSchema,
  reason: note("Reason").transform((value) => value ?? null),
});
export type RequestCompanyBankInput = z.input<typeof requestCompanyBankSchema>;

export const COMPANY_BANK_DECISIONS = ["approve", "reject", "stop"] as const;
export type CompanyBankDecision = (typeof COMPANY_BANK_DECISIONS)[number];

export const decideCompanyBankSchema = z.object({
  accountId: z.uuid("Choose a request"),
  decision: z.enum(COMPANY_BANK_DECISIONS, "Choose approve, reject or stop"),
  note: note("Note").transform((value) => value ?? null),
});
export type DecideCompanyBankInput = z.input<typeof decideCompanyBankSchema>;

export const withdrawCompanyBankSchema = z.object({
  accountId: z.uuid("Choose a request"),
});

export const revealCompanyBankSchema = z.object({
  accountId: z.uuid(),
});
