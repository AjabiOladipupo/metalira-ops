import { z } from "zod";

import { isKnownBankCode } from "@/lib/banks";

/**
 * Form fields every bank-details form sends with the account number (slice 2.3b): the bank from
 * the picker, the lookup the account name was checked with, and the reason for a close match.
 * Shared by the company account and worker bank details; the account name is never an input.
 */

const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

/** A bank code from the picker (src/lib/banks.ts). */
export const bankCodeSchema = z
  .string("Choose a bank from the list")
  .trim()
  .refine(isKnownBankCode, "Choose a bank from the list");

export const bankLookupIdSchema = z.uuid("Check the account name with the bank first");

export const nameCheckReasonSchema = z
  .preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .max(500, "Reason must be 500 characters or fewer")
      .regex(/^[^\p{Cc}<>]*$/u, "Reason must be plain text, without < or >")
      // Never an account number in clear: free text reaches the audit log as written.
      .refine((value) => !/\d{10}/.test(value), "Reason can't contain an account number")
      .nullish(),
  )
  .transform((value) => value ?? null);

export const bankCheckFields = {
  bankCode: bankCodeSchema,
  bankLookupId: bankLookupIdSchema,
  nameCheckReason: nameCheckReasonSchema,
};
