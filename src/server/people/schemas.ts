import { z } from "zod";

import { isNinFormat } from "@/lib/mask";
import { parseNairaToKobo, type Kobo } from "@/lib/money";
import { plainText } from "@/server/identity/names";
import { Constants } from "@/types/db";

/**
 * Input for the people helpers (slice 1.3). Flat objects, so a form's field names map straight
 * onto the field errors that `mutate()` reports.
 *
 * Conventions:
 * - Text is trimmed. In a create, a blank optional field means "none". In an update, a field
 *   that is left out is unchanged and a blank one is cleared.
 * - Personal data (NIN, RSA PIN; bank details only at create) follows a stricter rule in an
 *   update: left out or blank means unchanged, and only an explicit `null` clears it, so a
 *   form can show the masked value with an empty input beside it.
 * - Money arrives as a naira string typed by a person ("105,000", "105000.50") and is parsed to
 *   kobo exactly, or as a `bigint` of kobo from code (the import). Never a JavaScript number.
 */

export const EMPLOYMENT_TYPES = Constants.public.Enums.employment_type;
export const PAY_TYPES = Constants.public.Enums.pay_type;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type PayType = (typeof PAY_TYPES)[number];

/** Largest amount a pay or rent column accepts (database check): 10^15 kobo. */
export const MAX_KOBO = 1_000_000_000_000_000n;

const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** Optional in a create: blank or missing gives null. */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToNull, schema.nullish()).transform((value) => value ?? null);
}

/** Optional in an update: missing stays undefined (unchanged), blank gives null (cleared). */
function clearable<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToNull, schema.nullish());
}

/** Personal data in an update: missing or blank stays undefined, explicit null clears. */
function secretUpdate<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema.nullish());
}

function text(label: string, max = 200) {
  return plainText(
    z
      .string()
      .trim()
      .min(1, `Enter the ${label.toLowerCase()}`)
      .max(max, `${label} must be ${max} characters or fewer`),
    label,
  );
}

/** Free text that never reaches an email (no web-address rule). */
function note(label: string, max = 200) {
  return z
    .string()
    .trim()
    .min(1, `Enter the ${label.toLowerCase()}`)
    .max(max, `${label} must be ${max} characters or fewer`)
    .regex(/^[^\p{Cc}<>]*$/u, `${label} must be plain text, without < or >`);
}

export const staffIdSchema = z
  .string()
  .trim()
  .min(1, "Enter a staff ID")
  .max(64, "Staff ID must be 64 characters or fewer")
  .regex(/^[^\p{Cc}<>]*$/u, "Staff ID must be plain text, without < or >");

/**
 * A Nigerian mobile number, stored in local 11-digit form (`08031234567`). Accepts spaces,
 * dashes, dots and brackets, a +234 or 234 prefix, and a 10-digit number whose leading zero a
 * spreadsheet dropped.
 */
export const nigerianMobileSchema = z
  .string()
  .trim()
  .transform((raw) => {
    let digits = raw.replace(/[\s\-().]/g, "");
    if (digits.startsWith("+234")) digits = `0${digits.slice(4)}`;
    else if (/^234\d{10}$/.test(digits)) digits = `0${digits.slice(3)}`;
    else if (/^[789][01]\d{8}$/.test(digits)) digits = `0${digits}`;
    return digits;
  })
  .pipe(
    z
      .string()
      .regex(/^0(?:70|80|81|90|91)\d{8}$/, "Enter a Nigerian mobile number, like 0803 123 4567"),
  );

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, "Email address must be 320 characters or fewer")
  .pipe(z.email("Enter a valid email address"));

export const isoDateSchema = z.iso.date("Enter a date as YYYY-MM-DD");

const digitsOnly = (value: string) => value.replace(/[\s-]/g, "");

/** NUBAN: exactly 10 digits. */
export const nubanSchema = z
  .string()
  .trim()
  .transform(digitsOnly)
  .pipe(z.string().regex(/^\d{10}$/, "Bank account numbers are 10 digits"));

/** NIN: exactly 11 digits (a format check only, never "verified": owner decision 8). */
export const ninSchema = z
  .string()
  .trim()
  .transform(digitsOnly)
  .refine((value) => isNinFormat(value), "A NIN is 11 digits");

/** RSA PIN, upper-cased without spaces (for example PEN100012344421). */
export const rsaPinSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s/g, "").toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z0-9]{4,30}$/, "Enter the RSA PIN as letters and digits, like PEN100012344421"),
  );

/**
 * A naira amount, zero or more, as kobo. Strings go through `parseNairaToKobo` (exact, no
 * floats); a `bigint` is already kobo. Numbers are refused: they may already have lost kobo.
 */
export function nairaSchema(label: string) {
  return z
    .union([
      z.bigint(),
      z.string().transform((raw, ctx): Kobo => {
        try {
          return parseNairaToKobo(raw);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: `Enter ${label.toLowerCase()} in naira, like 105,000 or 105000.50`,
          });
          return z.NEVER;
        }
      }),
    ])
    .refine((kobo) => kobo >= 0n, `${label} can't be negative`)
    .refine((kobo) => kobo <= MAX_KOBO, `${label} is too large`);
}

const formBoolean = z.preprocess((value) => {
  if (value === true || value === "true" || value === "on" || value === "1") return true;
  if (value === false || value === "false" || value === "0" || value === "") return false;
  return value;
}, z.boolean());

// ---------------------------------------------------------------------------
// Pay rates
// ---------------------------------------------------------------------------

const payAmountFields = {
  basic: optional(nairaSchema("Basic monthly")),
  housing: optional(nairaSchema("Housing monthly")),
  transport: optional(nairaSchema("Transport monthly")),
  otherAllowances: optional(nairaSchema("Other allowances monthly")),
  dailyRate: optional(nairaSchema("Daily rate")),
  hourlyRate: optional(nairaSchema("Hourly rate")),
};

type PayAmounts = { [K in keyof typeof payAmountFields]: Kobo | null };

const MONTHLY_KEYS = ["basic", "housing", "transport", "otherAllowances"] as const;

/** The amounts each pay type needs, and the ones it must leave blank. */
function checkPayAmounts(payType: PayType, data: PayAmounts, ctx: z.RefinementCtx) {
  const forbid = (keys: readonly (keyof PayAmounts)[], message: string) => {
    for (const key of keys) {
      if (data[key] !== null && data[key] !== 0n)
        ctx.addIssue({ code: "custom", path: [key], message });
    }
  };
  if (payType === "monthly") {
    if (data.basic === null || data.basic === 0n) {
      ctx.addIssue({
        code: "custom",
        path: ["basic"],
        message: "Monthly pay needs a basic amount",
      });
    }
    forbid(["dailyRate", "hourlyRate"], "Leave this blank for monthly pay");
  } else if (payType === "daily") {
    if (data.dailyRate === null || data.dailyRate === 0n) {
      ctx.addIssue({
        code: "custom",
        path: ["dailyRate"],
        message: "Daily pay needs a daily rate",
      });
    }
    forbid([...MONTHLY_KEYS, "hourlyRate"], "Leave this blank for daily pay");
  } else {
    if (data.hourlyRate === null || data.hourlyRate === 0n) {
      ctx.addIssue({
        code: "custom",
        path: ["hourlyRate"],
        message: "Hourly pay needs an hourly rate",
      });
    }
    forbid([...MONTHLY_KEYS, "dailyRate"], "Leave this blank for hourly pay");
  }
}

/** One pay version, as `public.add_pay_rate` takes it: whole kobo as strings, never numbers. */
export type PayRateRecord = {
  pay_type: PayType;
  basic_kobo: string | null;
  housing_kobo: string | null;
  transport_kobo: string | null;
  other_allowances_kobo: string | null;
  daily_rate_kobo: string | null;
  hourly_rate_kobo: string | null;
  effective_from: string;
};

/**
 * The database row shape for a pay version: only the amounts that belong to the pay type, with
 * blank monthly allowances as zero.
 */
export function toPayRateRecord(
  payType: PayType,
  amounts: PayAmounts,
  effectiveFrom: string,
): PayRateRecord {
  const str = (kobo: Kobo | null) => (kobo === null ? null : kobo.toString());
  const monthly = payType === "monthly";
  return {
    pay_type: payType,
    basic_kobo: monthly ? str(amounts.basic) : null,
    housing_kobo: monthly ? str(amounts.housing ?? 0n) : null,
    transport_kobo: monthly ? str(amounts.transport ?? 0n) : null,
    other_allowances_kobo: monthly ? str(amounts.otherAllowances ?? 0n) : null,
    daily_rate_kobo: payType === "daily" ? str(amounts.dailyRate) : null,
    hourly_rate_kobo: payType === "hourly" ? str(amounts.hourlyRate) : null,
    effective_from: effectiveFrom,
  };
}

export const addPayRateSchema = z
  .object({
    workerId: z.uuid("Choose an employee"),
    payType: z.enum(PAY_TYPES, "Choose monthly, daily or hourly pay"),
    ...payAmountFields,
    effectiveFrom: isoDateSchema,
  })
  .superRefine((data, ctx) => checkPayAmounts(data.payType, data, ctx));

export type AddPayRateInput = z.input<typeof addPayRateSchema>;

/** Cancels a scheduled pay version (one that has not started yet). */
export const cancelPayRateSchema = z.object({
  payRateId: z.uuid("Choose a pay rate"),
});

export type CancelPayRateInput = z.input<typeof cancelPayRateSchema>;

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export const createWorkerSchema = z
  .object({
    /** Blank: the next free ID in the company's pattern is generated. */
    staffId: optional(staffIdSchema),
    firstName: text("First name"),
    lastName: text("Last name"),
    phone: optional(nigerianMobileSchema),
    email: optional(emailSchema),
    jobTitle: optional(text("Job title")),
    departmentId: optional(z.uuid("Choose a department")),
    lineManagerWorkerId: optional(z.uuid("Choose a line manager")),
    lineManagerMembershipId: optional(z.uuid("Choose a line manager")),
    employmentType: z.enum(EMPLOYMENT_TYPES, "Choose permanent, contract, casual or daily"),
    startDate: isoDateSchema,

    bankName: optional(note("Bank name")),
    accountName: optional(text("Account name")),
    bankAccountNumber: optional(nubanSchema),

    nin: optional(ninSchema),
    tin: optional(note("TIN")),
    taxState: optional(note("Tax state")),
    pfaName: optional(note("PFA name")),
    rsaPin: optional(rsaPinSchema),
    nhfOptIn: formBoolean.default(false),
    annualRentDeclared: optional(nairaSchema("Annual rent declared")),

    nextOfKinName: optional(text("Next of kin name")),
    nextOfKinPhone: optional(note("Next of kin phone")),

    /** Also set automatically when another worker already has this phone number. */
    supervisorClockIn: formBoolean.default(false),

    /** First pay rate. Leave every pay field blank to add pay later (needs pay details). */
    payType: optional(z.enum(PAY_TYPES, "Choose monthly, daily or hourly pay")),
    ...payAmountFields,
    /** Defaults to the start date. */
    payEffectiveFrom: optional(isoDateSchema),
  })
  .superRefine((data, ctx) => {
    if (data.lineManagerWorkerId && data.lineManagerMembershipId) {
      ctx.addIssue({
        code: "custom",
        path: ["lineManagerWorkerId"],
        message: "Choose one line manager",
      });
    }
    const bank = [data.bankName, data.accountName, data.bankAccountNumber];
    if (bank.some((value) => value !== null) && bank.some((value) => value === null)) {
      for (const [key, value] of [
        ["bankName", data.bankName],
        ["accountName", data.accountName],
        ["bankAccountNumber", data.bankAccountNumber],
      ] as const) {
        if (value === null) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Enter the bank name, account name and account number together",
          });
        }
      }
    }
    if (data.payType) {
      checkPayAmounts(data.payType, data, ctx);
    } else {
      for (const key of Object.keys(payAmountFields) as (keyof PayAmounts)[]) {
        if (data[key] !== null) {
          ctx.addIssue({ code: "custom", path: ["payType"], message: "Choose the pay type" });
          break;
        }
      }
    }
    if (data.payEffectiveFrom && data.payEffectiveFrom < data.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["payEffectiveFrom"],
        message: "Pay can't start before the start date",
      });
    }
  });

export type CreateWorkerInput = z.input<typeof createWorkerSchema>;
export type CreateWorkerData = z.output<typeof createWorkerSchema>;

const BANK_CHANGE_MESSAGE =
  "Bank details change through a bank-detail request, which a second person approves";
const STAFF_ID_FIXED_MESSAGE = "A staff ID can't change once it is saved";

/** A field this schema refuses whenever it has a value. */
function notHere(message: string) {
  return z.preprocess(blankToUndefined, z.undefined(message)).optional();
}

/**
 * Editable worker fields. Bank details are not here: changing them needs a second approver
 * (slice 1.7, CLAUDE.md rule 10). Nor is the staff ID: it is fixed once saved, so it can never
 * be freed and given to a new row with someone else's bank account (the database has no update
 * grant on it either). Employment ends through `endEmployment`, pay through `addPayRate`.
 */
export const updateWorkerSchema = z
  .object({
    workerId: z.uuid("Choose an employee"),
    firstName: text("First name").optional(),
    lastName: text("Last name").optional(),
    phone: clearable(nigerianMobileSchema),
    email: clearable(emailSchema),
    jobTitle: clearable(text("Job title")),
    departmentId: clearable(z.uuid("Choose a department")),
    lineManagerWorkerId: clearable(z.uuid("Choose a line manager")),
    lineManagerMembershipId: clearable(z.uuid("Choose a line manager")),
    employmentType: z
      .enum(EMPLOYMENT_TYPES, "Choose permanent, contract, casual or daily")
      .optional(),
    startDate: isoDateSchema.optional(),
    nin: secretUpdate(ninSchema),
    tin: clearable(note("TIN")),
    taxState: clearable(note("Tax state")),
    pfaName: clearable(note("PFA name")),
    rsaPin: secretUpdate(rsaPinSchema),
    nhfOptIn: formBoolean.optional(),
    annualRentDeclared: clearable(nairaSchema("Annual rent declared")),
    nextOfKinName: clearable(text("Next of kin name")),
    nextOfKinPhone: clearable(note("Next of kin phone")),
    supervisorClockIn: formBoolean.optional(),
    // Refused rather than silently dropped, so a form that offers them finds out at once.
    staffId: notHere(STAFF_ID_FIXED_MESSAGE),
    bankName: notHere(BANK_CHANGE_MESSAGE),
    accountName: notHere(BANK_CHANGE_MESSAGE),
    bankAccountNumber: notHere(BANK_CHANGE_MESSAGE),
  })
  .superRefine((data, ctx) => {
    if (data.lineManagerWorkerId && data.lineManagerMembershipId) {
      ctx.addIssue({
        code: "custom",
        path: ["lineManagerWorkerId"],
        message: "Choose one line manager",
      });
    }
  });

export type UpdateWorkerInput = z.input<typeof updateWorkerSchema>;
export type UpdateWorkerData = z.output<typeof updateWorkerSchema>;

export const endEmploymentSchema = z.object({
  workerId: z.uuid("Choose an employee"),
  endDate: isoDateSchema,
  reason: optional(z.string().trim().max(1000, "Reason must be 1000 characters or fewer")),
});

export type EndEmploymentInput = z.input<typeof endEmploymentSchema>;
