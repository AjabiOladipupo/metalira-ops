import { z } from "zod";

import {
  MAX_RATE_LINES,
  duplicateRateKeys,
  formatRateKey,
  parsePercentBps,
  parseRateLine,
  type RateLine,
  type RateLineInput,
} from "@/lib/rate-cards";
import { plainText } from "@/server/identity/names";

/**
 * Input for contracts, rate cards and WHT rates (slice 2.4). Flat objects keyed by the form's
 * field names, so `mutate()` puts each message under its field. The database repeats every
 * check (migration 20261119130000_contracts_rate_cards); these give a clear message first.
 * Money comes in as text and is parsed to `bigint` kobo with `parseNairaToKobo` (through
 * `parseRateLine`); nothing here is a JavaScript number of naira.
 */

export const CONTRACT_TYPES = ["manned_post", "per_visit", "fixed_monthly", "per_job"] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  manned_post: "Manned post",
  per_visit: "Per visit",
  fixed_monthly: "Fixed monthly",
  per_job: "Per job",
};

export const CONTRACT_TYPE_HINTS: Record<ContractType, string> = {
  manned_post: "Guards or staff at a post on shifts, billed per shift or hour.",
  per_visit: "Cleaning, patrols or servicing, billed per visit.",
  fixed_monthly: "One agreed amount each month.",
  per_job: "One-off jobs, billed when done.",
};

export const CONTRACT_STATUSES = ["draft", "active", "ended"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const BILLING_FREQUENCIES = ["monthly", "fortnightly", "weekly", "on_completion"] as const;
export type BillingFrequency = (typeof BILLING_FREQUENCIES)[number];

export const BILLING_FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  monthly: "Monthly",
  fortnightly: "Every two weeks",
  weekly: "Weekly",
  on_completion: "When the job is done",
};

const id = (what: string) => z.uuid(`Choose a ${what}`);

const isoDate = (message: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message)
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), message);

/** "" or a missing field becomes null; anything else goes through `schema`. */
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

const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "yes" || value === "true");

const contractName = plainText(
  z
    .string()
    .trim()
    .min(1, "Enter the contract name")
    .max(200, "Contract name must be 200 characters or fewer"),
  "Contract name",
);

const reference = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/,
    "Use up to 40 letters, numbers, dots, dashes or slashes, like CTR-0007",
  );

const termsDays = z
  .string()
  .regex(/^\d{1,3}$/, "Choose the payment terms")
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().min(0).max(180, "Payment terms are 180 days or fewer"));

/** "98" or "98.5" (percent) as basis points, 0 to 10000. */
const coverageBps = z.string().transform((value, ctx) => {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(value);
  const bps = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : NaN;
  if (!match || bps > 10_000) {
    ctx.addIssue({ code: "custom", message: "Enter the coverage target as a percentage, like 98" });
    return z.NEVER;
  }
  return bps;
});

const responseMinutes = z
  .string()
  .regex(/^\d{1,5}$/, "Enter the response time in minutes, like 30")
  .transform((value) => Number.parseInt(value, 10))
  .pipe(
    z
      .number()
      .int()
      .min(1, "Enter the response time in minutes, like 30")
      .max(10_080, "Response time is a week (10,080 minutes) or less"),
  );

const slaNotes = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n"))
  .pipe(
    z
      .string()
      .max(1000, "SLA notes must be 1,000 characters or fewer")
      .regex(/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f<>]*$/u, "SLA notes must be plain text"),
  );

const whtRate = z.string().transform((value, ctx) => {
  const bps = parsePercentBps(value);
  if (bps === null) {
    ctx.addIssue({
      code: "custom",
      message: "Enter the WHT rate as a percentage from 0 to 20, like 5",
    });
    return z.NEVER;
  }
  return bps;
});

/** Site ids from the form's checkboxes (FormData.getAll), each once. */
const siteIds = z
  .array(z.uuid("Choose a site"))
  .max(200, "A contract covers 200 sites or fewer")
  .optional()
  .transform((value) => [...new Set(value ?? [])]);

export interface Sla {
  coverage_target_bps?: number;
  response_minutes?: number;
  notes?: string;
}

/** The SLA as the database stores it: only the parts that were filled in. */
export function toSla(data: {
  coverageTargetBps: number | null;
  responseMinutes: number | null;
  slaNotes: string | null;
}): Sla {
  const sla: Sla = {};
  if (data.coverageTargetBps !== null) sla.coverage_target_bps = data.coverageTargetBps;
  if (data.responseMinutes !== null) sla.response_minutes = data.responseMinutes;
  if (data.slaNotes) sla.notes = data.slaNotes;
  return sla;
}

const contractFields = {
  name: contractName,
  type: z.enum(CONTRACT_TYPES, "Choose the kind of contract"),
  startDate: isoDate("Choose the start date"),
  endDate: optional(isoDate("Choose a valid end date")),
  billingFrequency: z.enum(BILLING_FREQUENCIES, "Choose how often to invoice"),
  billingTermsDays: optional(termsDays),
  vatApplies: checkbox,
  coverageTargetBps: optional(coverageBps),
  responseMinutes: optional(responseMinutes),
  slaNotes: optional(slaNotes),
  siteIds,
};

function datesInOrder(
  value: { startDate: string; endDate: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.endDate !== null && value.endDate < value.startDate) {
    ctx.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "The end date is on or after the start date",
    });
  }
}

export const createContractSchema = z
  .object({
    clientId: id("client"),
    reference: optional(reference),
    ...contractFields,
    /** Owner and admin only (WHT writers); the database refuses it for anyone else. */
    whtRate: optional(whtRate),
  })
  .superRefine(datesInOrder);

export const updateContractSchema = z
  .object({ contractId: id("contract"), ...contractFields })
  .superRefine(datesInOrder);

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

const lineInput = z.object({
  role: z.string().max(200).default(""),
  band: z.string().max(200).default(""),
  unit: z.string().max(20).default(""),
  rate: z.string().max(40).default(""),
  otRate: z.string().max(40).default(""),
  otMultiplier: z.string().max(20).default(""),
}) satisfies z.ZodType<RateLineInput, unknown>;

/**
 * The editor sends its lines as one JSON field (`lines`), each value as typed. Every line is
 * parsed with `parseRateLine` (naira text to kobo), and a rate key may appear once.
 */
export const rateLinesField = z
  .string()
  .max(100_000, "Too many rate lines")
  .transform((text, ctx): RateLine[] => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "Add at least one rate line" });
      return z.NEVER;
    }
    const parsed = z.array(lineInput).safeParse(raw);
    if (!parsed.success || parsed.data.length === 0) {
      ctx.addIssue({ code: "custom", message: "Add at least one rate line" });
      return z.NEVER;
    }
    if (parsed.data.length > MAX_RATE_LINES) {
      ctx.addIssue({ code: "custom", message: `A rate card has ${MAX_RATE_LINES} lines or fewer` });
      return z.NEVER;
    }
    const lines: RateLine[] = [];
    for (const [index, input] of parsed.data.entries()) {
      const line = parseRateLine(input);
      if (!line.ok) {
        ctx.addIssue({ code: "custom", message: `Line ${index + 1}: ${line.message}` });
        return z.NEVER;
      }
      lines.push(line.line);
    }
    const [duplicate] = duplicateRateKeys(lines);
    if (duplicate) {
      ctx.addIssue({
        code: "custom",
        message: `${formatRateKey(duplicate)} is on the card twice. Give each role and band one rate.`,
      });
      return z.NEVER;
    }
    return lines;
  });

const rateNote = plainText(
  z.string().trim().max(300, "The note must be 300 characters or fewer"),
  "Note",
);

export const saveRateCardSchema = z.object({
  contractId: id("contract"),
  effectiveFrom: isoDate("Choose the date the rates start"),
  note: optional(rateNote),
  lines: rateLinesField,
});

export const rateCardIdSchema = z.object({ rateCardId: id("rate card") });

// ---------------------------------------------------------------------------
// WHT
// ---------------------------------------------------------------------------

export const addWhtRateSchema = z.object({
  contractId: id("contract"),
  rate: whtRate,
  effectiveFrom: isoDate("Choose the date the rate starts"),
});

export const whtRateIdSchema = z.object({ whtRateId: id("WHT rate") });

export type CreateContractInput = z.output<typeof createContractSchema>;
export type UpdateContractInput = z.output<typeof updateContractSchema>;
export type SaveRateCardInput = z.output<typeof saveRateCardSchema>;
export type AddWhtRateInput = z.output<typeof addWhtRateSchema>;
