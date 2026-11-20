import { z } from "zod";

import { nubanSchema } from "@/server/people/schemas";

import { bankCheckFields, bankCodeSchema } from "./bank-check-schema";

/**
 * Input for the company bank account actions (slice 2.3). Flat objects, so a form's field names
 * map straight onto the field errors `mutate()` reports. The database repeats the text rules.
 */

const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

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

/**
 * The account name is not an input: the server takes it from the bank lookup (slice 2.3b).
 */
export const requestCompanyBankSchema = z.object({
  ...bankCheckFields,
  bankAccountNumber: nubanSchema,
  reason: note("Reason").transform((value) => value ?? null),
});

/** "Check" in the form: looks the account name up before anything is sent. */
export const lookupBankAccountSchema = z.object({
  bankCode: bankCodeSchema,
  bankAccountNumber: nubanSchema,
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
