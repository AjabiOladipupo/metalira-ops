import { z } from "zod";

import { INDUSTRY_IDS, NIGERIAN_STATES, PLAN_IDS } from "@/lib/company";

import { plainText } from "./names";

/**
 * Validation for the company setup wizard and company settings (slice 1.1). Field names match
 * the form inputs. The database repeats every check (migration 20261116101100_company_setup), so
 * these exist to give a clear message under the field, not as the only guard.
 *
 * RC number and TIN get format checks only; nothing here verifies them with CAC or FIRS.
 */

/**
 * "" (an empty input) becomes null; anything else goes through `schema`, keeping its messages
 * (a union would replace them with a generic "Invalid input").
 */
function optional<T extends z.ZodType<unknown, string>>(schema: T) {
  return z
    .string()
    .trim()
    .transform((value, ctx): z.output<T> | null => {
      if (value === "") return null;
      const result = schema.safeParse(value);
      if (result.success) return result.data;
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message });
      }
      return z.NEVER;
    });
}

/** A whole number typed into a form, between `min` and `max`. Never money. */
function wholeNumber(min: number, max: number, message: string) {
  return z
    .string()
    .trim()
    .regex(/^\d{1,9}$/, message)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(min, message).max(max, message));
}

const RC_PATTERN = /^(RC|BN|IT)?(\d{1,8})$/;

/**
 * CAC number as stored: "RC 1234567", "BN 123456", "IT 12345" or bare digits. Accepts the
 * prefix in any case with or without a space or hyphen. Returns null when it does not fit.
 */
export function normaliseRcNumber(input: string): string | null {
  const compact = input.replace(/[\s-]/g, "").toUpperCase();
  const match = RC_PATTERN.exec(compact);
  if (!match) return null;
  const [, prefix, digits] = match;
  return prefix ? `${prefix} ${digits}` : (digits ?? null);
}

/**
 * Tax ID as stored: the FIRS form "12345678-0001", or 10 to 13 digits. Spaces are dropped.
 * Returns null when it does not fit either form.
 */
export function normaliseTin(input: string): string | null {
  const compact = input.replace(/\s/g, "");
  if (/^\d{8}-\d{4}$/.test(compact) || /^\d{10,13}$/.test(compact)) return compact;
  return null;
}

/** Business phone as stored: digits with an optional leading +. Returns null when it does not fit. */
export function normaliseBusinessPhone(input: string): string | null {
  const compact = input.replace(/[\s\-().]/g, "");
  return /^\+?\d{7,15}$/.test(compact) ? compact : null;
}

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

const businessPhone = z.string().transform((value, ctx) => {
  const normalised = normaliseBusinessPhone(value);
  if (!normalised) {
    ctx.addIssue({ code: "custom", message: "Enter a phone number, for example 0800 000 0000" });
    return z.NEVER;
  }
  return normalised;
});

export const planStepSchema = z.object({
  plan: z.enum(PLAN_IDS, "Choose a plan"),
  expectedWorkers: wholeNumber(1, 1_000_000, "Enter a number of workers from 1 to 1,000,000"),
});

export const businessStepSchema = z.object({
  legalName: plainText(
    z
      .string()
      .trim()
      .min(2, "Enter the registered business name")
      .max(200, "Use 200 characters or fewer"),
    "Registered business name",
  ),
  tradingName: optional(
    plainText(z.string().max(200, "Use 200 characters or fewer"), "Trading name"),
  ),
  rcNumber: optional(rcNumber),
  tin: optional(tin),
  industry: z.enum(INDUSTRY_IDS, "Choose an industry"),
  headOfficeState: z.enum(NIGERIAN_STATES, "Choose the head office state"),
  address: optional(plainText(z.string().max(300, "Use 300 characters or fewer"), "Address")),
  phone: optional(businessPhone),
  payCycleStartDay: wholeNumber(1, 28, "Choose a day from 1 to 28"),
  payDay: wholeNumber(1, 31, "Choose a day from 1 to 31"),
});

export const invoicesStepSchema = z.object({
  invoiceEmail: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter the email invoices are sent from")
    .max(320, "Use 320 characters or fewer")
    .pipe(z.email("Enter a valid email address")),
  invoiceNumberStart: wholeNumber(1, 999_999_999, "Enter a number from 1 to 999,999,999"),
  paymentTermsDays: wholeNumber(0, 365, "Choose payment terms"),
  vatRegistered: z.enum(["yes", "no"], "Choose whether you are VAT registered"),
  /** A checkbox: present ("on") when ticked, missing when not. */
  autoEmailReceipts: z
    .string()
    .optional()
    .transform((value) => value === "on"),
});

/** Wizard steps 4 and 5 have no fields of their own yet; Continue only records progress. */
export const advanceStepSchema = z.object({
  step: z.enum(["clients", "employees"]),
});

export type PlanStepInput = z.output<typeof planStepSchema>;
export type BusinessStepInput = z.output<typeof businessStepSchema>;
export type InvoicesStepInput = z.output<typeof invoicesStepSchema>;

// ---------------------------------------------------------------------------
// Logo file
// ---------------------------------------------------------------------------

export const LOGO_MAX_BYTES = 1024 * 1024;

export type LogoCheck =
  | { ok: true; ext: "png" | "svg"; contentType: "image/png" | "image/svg+xml" }
  | { ok: false; message: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Things an SVG logo never needs and a hostile one would use: scripts, event handlers, embedded
 * documents, entity declarations, animations that rewrite links, and references to anything
 * outside the file. This is a first line only: an owner or admin can write to the bucket
 * directly, skipping it, so the real guard is how the logo is served (shown in <img>, where
 * scripts do not run, and signed as a download, see LOGO_SIGNED_URL_OPTIONS).
 */
const SVG_FORBIDDEN = [
  /<script/i,
  /<(animate|set)\b[^>]*\battributename\s*=\s*["']?\s*(xlink:)?href/i,
  /<foreignobject/i,
  /<(iframe|embed|object|audio|video|link|meta)\b/i,
  /<!(doctype|entity)/i,
  /\bon[a-z]+\s*=/i,
  /javascript:/i,
  /@import/i,
  /url\(\s*['"]?\s*(?!#)/i,
  /\b(?:xlink:)?href\s*=\s*["']\s*(?!#)/i,
  /\bsrc\s*=/i,
];

/**
 * Checks an uploaded logo by its bytes, never by the browser's declared type or file name:
 * PNG (by signature) or a plain SVG, at most 1 MB.
 */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.byteLength === 0) return { ok: false, message: "Choose a PNG or SVG file." };
  if (bytes.byteLength > LOGO_MAX_BYTES) {
    return { ok: false, message: "The logo must be under 1 MB." };
  }

  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    return { ok: true, ext: "png", contentType: "image/png" };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return { ok: false, message: "Upload a PNG or SVG file." };
  }
  const start = text.replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*/, "");
  if (!/^<svg[\s>]/i.test(start)) {
    return { ok: false, message: "Upload a PNG or SVG file." };
  }
  // Scan the text with character references decoded too, so "&#106;avascript:" is caught.
  const decoded = decodeCharacterReferences(text);
  if (SVG_FORBIDDEN.some((pattern) => pattern.test(text) || pattern.test(decoded))) {
    return {
      ok: false,
      message:
        "This SVG has scripts or links to other files. Export it again as a plain SVG, or use a PNG.",
    };
  }
  return { ok: true, ext: "svg", contentType: "image/svg+xml" };
}

/** Decodes numeric (&#106; &#x6a;) and the five XML named character references. */
function decodeCharacterReferences(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (match, ref: string) => {
    const lower = ref.toLowerCase();
    const code = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : lower.startsWith("#")
        ? Number.parseInt(lower.slice(1), 10)
        : null;
    if (code === null) return named[lower] ?? match;
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/**
 * Options for every logo signed URL: Storage then serves the file as an attachment, so a signed
 * URL opened directly downloads the file instead of rendering it as a page on the Storage
 * domain. <img> ignores the attachment header and shows the logo as usual.
 */
export const LOGO_SIGNED_URL_OPTIONS = { download: true } as const;

/** Storage object name for an organisation's logo. The bucket's policies accept only these. */
export function logoObjectPath(organisationId: string, ext: "png" | "svg"): string {
  return `${organisationId}/logo.${ext}`;
}

export const ORG_ASSETS_BUCKET = "org-assets";
