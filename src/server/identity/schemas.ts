import { z } from "zod";

import { companyNameSchema, fullNameSchema } from "./names";

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
/** A new password: chosen after an email link (slice 1.13), on /set-password or the join page. */
export const newPasswordSchema = z
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

/** Owner sign-up (slice 1.13): no password here; it is chosen after the email link. */
export const signUpSchema = z.object({
  fullName: fullNameSchema,
  companyName: companyNameSchema,
  email,
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
