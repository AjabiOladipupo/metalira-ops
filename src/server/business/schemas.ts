import { z } from "zod";

import { NIGERIAN_STATES } from "@/lib/company";
import { normaliseBusinessPhone, normaliseRcNumber, normaliseTin } from "@/server/identity/company";
import { plainText } from "@/server/identity/names";

/**
 * Input for clients and contacts (slice 2.1). Flat objects whose keys are the form's field names,
 * so `mutate()` puts each message under its field. The database repeats every check
 * (migration 20261119100000_clients_contacts); these give a clear message first.
 *
 * Text is trimmed. A blank optional field means "none" (null), in a create and an update alike:
 * the client form always sends every field.
 */

export const CONTACT_ROLES = ["billing", "approver", "ops"] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  billing: "Billing",
  approver: "Approver",
  ops: "Operations",
};

/** One line under each role in the contact form. */
export const CONTACT_ROLE_HINTS: Record<ContactRole, string> = {
  billing: "Gets invoices and receipts.",
  approver: "Approves timesheets, from Phase 4.",
  ops: "Site matters and the welcome email.",
};

export const CLIENT_STATUSES = ["active", "archived"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Payment terms a client can have; blank means the company's own terms. */
export const CLIENT_TERMS_DAYS = [0, 7, 14, 30, 45, 60, 90] as const;

/** "" (an empty input) or a missing field becomes null; anything else goes through `schema`. */
function optional<T extends z.ZodType<unknown, string>>(schema: T) {
  return z
    .string()
    .optional()
    .transform((value, ctx): z.output<T> | null => {
      const trimmed = (value ?? "").trim();
      if (trimmed === "") return null;
      const result = schema.safeParse(trimmed);
      if (result.success) return result.data;
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message });
      }
      return z.NEVER;
    });
}

function text(label: string, max: number, required = true) {
  return plainText(
    z
      .string()
      .trim()
      .min(required ? 1 : 0, `Enter the ${label.toLowerCase()}`)
      .max(max, `${label} must be ${max} characters or fewer`),
    label,
  );
}

const id = (what: string) => z.uuid(`Choose a ${what}`);

export const clientNameSchema = text("Client name", 200);

const rcNumber = z.string().transform((value, ctx) => {
  const normalised = normaliseRcNumber(value);
  if (!normalised) {
    ctx.addIssue({ code: "custom", message: "Enter the CAC number, for example RC 1234567" });
    return z.NEVER;
  }
  return normalised;
});

const tin = z.string().transform((value, ctx) => {
  const normalised = normaliseTin(value);
  if (!normalised) {
    ctx.addIssue({
      code: "custom",
      message: "Enter the TIN as 12345678-0001, or as 10 to 13 digits",
    });
    return z.NEVER;
  }
  return normalised;
});

/** Text over several lines: Windows line ends become "\n"; tabs and line breaks are allowed. */
function multiline(max: number, label: string) {
  return z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n"))
    .pipe(
      z
        .string()
        .max(max, `${label} must be ${max.toLocaleString("en-NG")} characters or fewer`)
        .regex(
          /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f<>]*$/u,
          `${label} must be plain text, without < or >`,
        ),
    );
}

/** Billing address: plain text over several lines, and no web address (it goes on invoices). */
const address = multiline(300, "Address").refine(
  (value) => !/:\/\/|www\./i.test(value),
  "An address can't contain a web address",
);

const notes = multiline(2000, "Notes");

const termsDays = z
  .string()
  .regex(/^\d{1,3}$/, "Choose the payment terms")
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().min(0).max(180, "Payment terms are 180 days or fewer"));

/** Every client field the form edits. */
const clientFields = {
  name: clientNameSchema,
  legalName: optional(text("Registered name", 200)),
  rcNumber: optional(rcNumber),
  tin: optional(tin),
  billingAddress: optional(address),
  state: optional(z.enum(NIGERIAN_STATES, "Choose a state")),
  billingTermsDays: optional(termsDays),
  notes: optional(notes),
};

export const contactNameSchema = text("Contact name", 200);

export const contactEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter an email address")
  .max(254, "Email address must be 254 characters or fewer")
  .pipe(z.email("Enter a valid email address"));

const phone = z.string().transform((value, ctx) => {
  const normalised = normaliseBusinessPhone(value);
  if (!normalised) {
    ctx.addIssue({ code: "custom", message: "Enter a phone number, like 0803 123 4567" });
    return z.NEVER;
  }
  return normalised;
});

/** A checkbox: "on" (or "yes", "true") when ticked, missing when not. */
const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "yes" || value === "true");

/**
 * Add client. The billing contact is optional here (an empty name and email add none) but, when
 * given, needs an email; it becomes the client's primary billing contact.
 */
export const createClientSchema = z
  .object({
    ...clientFields,
    contactName: optional(contactNameSchema),
    contactEmail: optional(contactEmailSchema),
    contactPhone: optional(phone),
  })
  .superRefine((value, ctx) => {
    if ((value.contactName || value.contactPhone) && !value.contactEmail) {
      ctx.addIssue({
        code: "custom",
        path: ["contactEmail"],
        message: "Enter the billing contact's email",
      });
    }
  });

export const updateClientSchema = z.object({ clientId: id("client"), ...clientFields });

export const setClientStatusSchema = z.object({
  clientId: id("client"),
  status: z.enum(CLIENT_STATUSES, "Choose active or archived"),
});

export const addContactSchema = z.object({
  clientId: id("client"),
  name: contactNameSchema,
  email: contactEmailSchema,
  phone: optional(phone),
  role: z.enum(CONTACT_ROLES, "Choose what this contact does"),
  isPrimary: checkbox,
});

export const updateContactSchema = z.object({
  contactId: id("contact"),
  name: contactNameSchema,
  email: contactEmailSchema,
  phone: optional(phone),
  isPrimary: checkbox,
});

export const contactIdSchema = z.object({ contactId: id("contact") });

/** Setup step 4: a client, its billing email (the primary billing contact) and a first site. */
export const quickAddClientSchema = z.object({
  name: clientNameSchema,
  billingEmail: optional(contactEmailSchema),
  siteName: optional(text("Site name", 200)),
});

export type CreateClientInput = z.output<typeof createClientSchema>;
export type UpdateClientInput = z.output<typeof updateClientSchema>;
export type AddContactInput = z.output<typeof addContactSchema>;
export type UpdateContactInput = z.output<typeof updateContactSchema>;
export type QuickAddClientInput = z.output<typeof quickAddClientSchema>;
