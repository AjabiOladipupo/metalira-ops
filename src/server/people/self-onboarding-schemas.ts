import { z } from "zod";

import { hasPersonalNumber, PERSONAL_NUMBER_MESSAGE } from "@/lib/personal-number";
import { decodeLineManager } from "@/lib/people";
import { ONBOARDING_ROLES } from "@/lib/self-onboarding";
import { bankCodeSchema } from "@/server/billing/bank-check-schema";

import {
  checkPayAmounts,
  EMPLOYMENT_TYPES,
  emailSchema,
  formBoolean,
  isoDateSchema,
  nairaSchema,
  nigerianMobileSchema,
  ninSchema,
  noteField,
  nubanSchema,
  optionalField,
  PAY_TYPES,
  payAmountFields,
  rsaPinSchema,
  staffIdSchema,
  textField,
} from "./schemas";

/**
 * Input for self-onboarding (slice U.4), with the same field rules as adding an employee
 * (`createWorkerSchema`): Nigerian mobile numbers, an 11-digit NIN, a 10-digit NUBAN, an RSA PIN,
 * naira as exact kobo. Every free-text field also refuses personal numbers (CLAUDE.md rule 9:
 * `hasPersonalNumber`, as the database's private.has_personal_number), so a NIN or account
 * number can't hide in an address or a name.
 *
 * None of these schemas has a role: the invitee's details never carry one, and an extra `role`
 * key is dropped by the parse. The role is the invite's, read in the database.
 */

function noNumber<T extends z.ZodType<string | null>>(schema: T) {
  return schema.refine(
    (value) => value === null || !hasPersonalNumber(value as string),
    PERSONAL_NUMBER_MESSAGE,
  );
}

const name = (label: string) => noNumber(textField(label, 100));

// ---------------------------------------------------------------------------
// Inviting
// ---------------------------------------------------------------------------

export const onboardingInviteSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Enter their email address")
      .max(320, "Email address must be 320 characters or fewer")
      .pipe(z.email("Enter a valid email address")),
    role: z.enum(ONBOARDING_ROLES, {
      error: "Choose HR, finance, operations manager, line manager, supervisor, guard or cleaner",
    }),
    /** Manager roles only: the company also pays them through payroll. */
    onPayroll: formBoolean.default(false),
    departmentId: optionalField(z.uuid("Choose a department")),
    /** "w:<worker id>" or "m:<membership id>", as the people forms send it. */
    lineManager: z.string().max(80).optional(),
  })
  .transform(({ lineManager, ...rest }) => ({ ...rest, ...decodeLineManager(lineManager) }));

export type OnboardingInviteInput = z.input<typeof onboardingInviteSchema>;

export const onboardingInviteIdSchema = z.object({ inviteId: z.uuid("Choose an invite") });

// ---------------------------------------------------------------------------
// The invitee's details
// ---------------------------------------------------------------------------

/** Who they are: every role. */
const personFields = {
  firstName: name("First name"),
  lastName: name("Last name"),
  phone: nigerianMobileSchema,
};

/** The employee details payroll and the worker record need. */
const employeeFields = {
  dateOfBirth: optionalField(isoDateSchema),
  homeAddress: optionalField(noNumber(noteField("Home address", 300))),
  nextOfKinName: optionalField(noNumber(textField("Emergency contact name", 200))),
  nextOfKinPhone: optionalField(nigerianMobileSchema),
  nin: optionalField(ninSchema),
  bankCode: optionalField(bankCodeSchema),
  bankAccountNumber: optionalField(nubanSchema),
  accountName: optionalField(noNumber(textField("Account name", 200))),
  pfaName: optionalField(noNumber(noteField("PFA name", 200))),
  rsaPin: optionalField(rsaPinSchema),
  taxState: optionalField(noNumber(noteField("Tax state", 100))),
  nhfOptIn: formBoolean.default(false),
  nhfNumber: optionalField(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9/-]{4,20}$/, "An NHF number is 4 to 20 letters, digits, / or -"),
  ),
  annualRentDeclared: optionalField(nairaSchema("Annual rent")),
  locationConsent: formBoolean.default(false),
  selfieConsent: formBoolean.default(false),
};

type EmployeeShape = {
  dateOfBirth: string | null;
  homeAddress: string | null;
  nextOfKinName: string | null;
  nextOfKinPhone: string | null;
  bankCode: string | null;
  bankAccountNumber: string | null;
  accountName: string | null;
};

function checkEmployee(
  data: EmployeeShape,
  ctx: z.RefinementCtx,
  { required, today }: { required: boolean; today: string },
) {
  if (required) {
    const need: [keyof EmployeeShape, string][] = [
      ["dateOfBirth", "Enter your date of birth"],
      ["homeAddress", "Enter your home address"],
      ["nextOfKinName", "Enter an emergency contact"],
      ["nextOfKinPhone", "Enter your emergency contact's phone number"],
    ];
    for (const [key, message] of need) {
      if (data[key] === null) ctx.addIssue({ code: "custom", path: [key], message });
    }
  }
  if (data.dateOfBirth !== null && (data.dateOfBirth >= today || data.dateOfBirth < "1900-01-01")) {
    ctx.addIssue({
      code: "custom",
      path: ["dateOfBirth"],
      message: "Enter your date of birth as a past date",
    });
  }
  const bank = [data.bankCode, data.bankAccountNumber, data.accountName];
  if (bank.some((v) => v !== null) && bank.some((v) => v === null)) {
    const fields: [keyof EmployeeShape, string][] = [
      ["bankCode", "Choose your bank"],
      ["bankAccountNumber", "Enter your 10-digit account number"],
      ["accountName", "Enter the name on the account"],
    ];
    for (const [key, message] of fields) {
      if (data[key] === null) ctx.addIssue({ code: "custom", path: [key], message });
    }
  }
}

/** Lagos today, YYYY-MM-DD. */
function lagosToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

/**
 * A guard, cleaner or supervisor: everything on one form, no account. They also type the address
 * the invite was sent to (`confirmEmail`), which the server compares with the invite's.
 */
export function workerOnboardingSchema(today: string = lagosToday()) {
  return z
    .object({
      confirmEmail: emailSchema,
      ...personFields,
      ...employeeFields,
    })
    .superRefine((data, ctx) => checkEmployee(data, ctx, { required: true, today }));
}

/**
 * A manager role: their profile (name and phone) and, when the company also pays them through
 * payroll, the employee details, all optional. The password is checked on its own.
 */
export function managerOnboardingSchema(today: string = lagosToday()) {
  return z
    .object({
      ...personFields,
      ...employeeFields,
    })
    .superRefine((data, ctx) => checkEmployee(data, ctx, { required: false, today }));
}

export type WorkerOnboardingData = z.output<ReturnType<typeof workerOnboardingSchema>>;
export type ManagerOnboardingData = z.output<ReturnType<typeof managerOnboardingSchema>>;
export type OnboardingDetails = Omit<WorkerOnboardingData, "confirmEmail">;

// ---------------------------------------------------------------------------
// Approving
// ---------------------------------------------------------------------------

export const approveOnboardingSchema = z
  .object({
    inviteId: z.uuid("Choose an invite"),
    /** Blank: the next free ID in the company's pattern. Employees only. */
    staffId: optionalField(staffIdSchema),
    employmentType: optionalField(
      z.enum(EMPLOYMENT_TYPES, "Choose permanent, contract, casual or daily"),
    ),
    startDate: optionalField(isoDateSchema),
    payType: optionalField(z.enum(PAY_TYPES, "Choose monthly, daily or hourly pay")),
    ...payAmountFields,
    payEffectiveFrom: optionalField(isoDateSchema),
  })
  .superRefine((data, ctx) => {
    if (data.payType) {
      checkPayAmounts(data.payType, data, ctx);
    } else {
      for (const key of Object.keys(payAmountFields) as (keyof typeof payAmountFields)[]) {
        if (data[key] !== null) {
          ctx.addIssue({ code: "custom", path: ["payType"], message: "Choose the pay type" });
          break;
        }
      }
    }
    if (data.payEffectiveFrom && data.startDate && data.payEffectiveFrom < data.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["payEffectiveFrom"],
        message: "Pay can't start before the start date",
      });
    }
  });

export type ApproveOnboardingData = z.output<typeof approveOnboardingSchema>;
