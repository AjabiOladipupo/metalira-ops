import { z } from "zod";

import { organisationNameSchema } from "./organisations";

/** Form input for the identity actions. Messages are shown under the field as written. */

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter your email address")
  .max(320, "Email address must be 320 characters or fewer")
  .pipe(z.email("Enter a valid email address"));

// Supabase Auth caps bcrypt input at 72 bytes. The project also needs letters and digits
// (supabase/config.toml `password_requirements = "letters_digits"`).
const newPassword = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(72, "Use 72 characters or fewer")
  .regex(/[A-Za-z]/, "Use at least one letter")
  .regex(/[0-9]/, "Use at least one number");

/** Sign-in only checks presence: the rules may have changed since the password was set. */
const existingPassword = z
  .string()
  .min(1, "Enter your password")
  .max(72, "Use 72 characters or fewer");

const next = z.string().max(512).optional();

export const signInPasswordSchema = z.object({
  email,
  password: existingPassword,
  next,
});

export const magicLinkSchema = z.object({ email, next });

/**
 * Names end up in emails sent from Metalira's domain, so they must be plain text: no control
 * characters, no angle brackets and nothing a mail client would turn into a link.
 */
function plainName(schema: z.ZodString, label: string) {
  return schema
    .regex(/^[^\p{Cc}<>]*$/u, `${label} must be plain text, without < or >`)
    .refine((value) => !/:\/\/|www\./i.test(value), `${label} can't contain a web address`);
}

export const signUpSchema = z.object({
  fullName: plainName(
    z
      .string()
      .trim()
      .min(2, "Enter your full name")
      .max(120, "Full name must be 120 characters or fewer"),
    "Full name",
  ),
  companyName: plainName(
    organisationNameSchema
      .min(2, "Enter your company name")
      .max(160, "Company name must be 160 characters or fewer"),
    "Company name",
  ),
  email,
  password: newPassword,
});

export const switchOrganisationSchema = z.object({
  organisationId: z.uuid("Choose a company"),
});

export type SignInPasswordInput = z.infer<typeof signInPasswordSchema>;
export type MagicLinkInput = z.infer<typeof magicLinkSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;

/** Plain object of a form's string fields, for Zod. File inputs are dropped. */
export function formFields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
