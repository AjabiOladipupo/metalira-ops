import { z } from "zod";

/**
 * Names typed by people (company names, full names) end up in emails sent from Metalira's
 * domain, so they must be plain text: no control characters, no angle brackets and nothing a
 * mail client would turn into a link.
 *
 * These rules apply wherever a name enters, not only in the sign-up form: user_metadata can be
 * set by anyone holding the publishable key (Supabase's /auth/v1/signup and auth.updateUser),
 * so names read from it are checked again before use. The database enforces the same rules on
 * organisations.name and profiles.full_name (migration 20261116090000_identity_hardening).
 */
export function plainText(schema: z.ZodString, label: string) {
  return schema
    .regex(/^[^\p{Cc}<>]*$/u, `${label} must be plain text, without < or >`)
    .refine((value) => !/:\/\/|www\./i.test(value), `${label} can't contain a web address`);
}

/** A company name, as typed at sign-up and as read back from user_metadata. */
export const companyNameSchema = plainText(
  z
    .string()
    .trim()
    .min(2, "Enter your company name")
    .max(160, "Company name must be 160 characters or fewer"),
  "Company name",
);

/** A person's full name, as typed at sign-up and as read back from user_metadata. */
export const fullNameSchema = plainText(
  z
    .string()
    .trim()
    .min(2, "Enter your full name")
    .max(120, "Full name must be 120 characters or fewer"),
  "Full name",
);
