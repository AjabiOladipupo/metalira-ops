import type { BusinessType } from "@/lib/modules";

/**
 * Company setup choices and the setup wizard's steps. Isomorphic: the forms render these lists
 * and src/server/identity/company.ts validates against them. The database checks the same values
 * (migration 20261116101100_company_setup).
 */

export const PLANS = [
  { id: "starter", name: "Starter", summary: "Start with the basics" },
  { id: "workforce", name: "Workforce", summary: "People, rosters, clock-in, timesheets, payroll" },
  { id: "business", name: "Business", summary: "Clients, contracts, invoices, collections" },
  { id: "ops_suite", name: "Ops Suite", summary: "Workforce + Business + Revenue Layer" },
] as const;

export type PlanId = (typeof PLANS)[number]["id"];

export const PLAN_IDS = PLANS.map((p) => p.id) as [PlanId, ...PlanId[]];

/** Label for organisations.plan; `trial` is the value before the owner picks a plan. */
export function planName(plan: string): string {
  return PLANS.find((p) => p.id === plan)?.name ?? "Trial";
}

export const INDUSTRIES = [
  { id: "security_facility", name: "Security and facility services" },
  { id: "cleaning", name: "Cleaning" },
  { id: "staffing", name: "Staffing and outsourcing" },
  { id: "field_sales", name: "Field sales and distribution" },
  { id: "logistics", name: "Logistics" },
  { id: "digital_services", name: "Digital services (design, software, marketing)" },
  { id: "professional_services", name: "Professional services (consulting, legal, accounting)" },
  { id: "other", name: "Other" },
] as const;

export type IndustryId = (typeof INDUSTRIES)[number]["id"];

export const INDUSTRY_IDS = INDUSTRIES.map((i) => i.id) as [IndustryId, ...IndustryId[]];

/** The 36 states and the Federal Capital Territory, as stored in head_office_state. */
export const NIGERIAN_STATES = [
  "Abia",
  "Adamawa",
  "Akwa Ibom",
  "Anambra",
  "Bauchi",
  "Bayelsa",
  "Benue",
  "Borno",
  "Cross River",
  "Delta",
  "Ebonyi",
  "Edo",
  "Ekiti",
  "Enugu",
  "FCT Abuja",
  "Gombe",
  "Imo",
  "Jigawa",
  "Kaduna",
  "Kano",
  "Katsina",
  "Kebbi",
  "Kogi",
  "Kwara",
  "Lagos",
  "Nasarawa",
  "Niger",
  "Ogun",
  "Ondo",
  "Osun",
  "Oyo",
  "Plateau",
  "Rivers",
  "Sokoto",
  "Taraba",
  "Yobe",
  "Zamfara",
] as const;

export type NigerianState = (typeof NIGERIAN_STATES)[number];

/** Payment terms offered in the form; the database accepts 0 to 365 days. */
export const PAYMENT_TERMS = [
  { days: 0, label: "On receipt" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 45, label: "45 days" },
  { days: 60, label: "60 days" },
  { days: 90, label: "90 days" },
] as const;

export function paymentTermsLabel(days: number): string {
  return PAYMENT_TERMS.find((t) => t.days === days)?.label ?? `${days} days`;
}

/** "1st", "2nd", "23rd", for pay day and cycle start day options. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Invoice numbers as they will print, e.g. 1 → "INV-0001". */
export function invoiceNumberPreview(start: number): string {
  return `INV-${String(start).padStart(4, "0")}`;
}

export const SETUP_STEPS = [
  { number: 1, slug: "plan", label: "Plan" },
  { number: 2, slug: "business", label: "Business details" },
  { number: 3, slug: "invoices", label: "Invoices and payments" },
  { number: 4, slug: "clients", label: "Clients and contracts" },
  { number: 5, slug: "employees", label: "Employees" },
  { number: 6, slug: "ready", label: "Ready" },
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupSlug = SetupStep["slug"];

export const SETUP_PATH = "/app/setup";

export function setupStepHref(slug: SetupSlug): string {
  return `${SETUP_PATH}/${slug}`;
}

export function setupStep(slug: SetupSlug): SetupStep {
  const step = SETUP_STEPS.find((s) => s.slug === slug);
  if (!step) throw new Error(`Unknown setup step ${slug}`);
  return step;
}

/**
 * The wizard's steps for a business type. A services business (slice 3.0) has no Employees step:
 * it starts with People, Shifts and Payroll off, so Clients and contracts leads straight to Ready.
 * Step numbers stay the same (they are what organisations.setup_step stores).
 */
export function setupStepsFor(type: BusinessType = "workforce"): readonly SetupStep[] {
  return type === "services" ? SETUP_STEPS.filter((s) => s.slug !== "employees") : SETUP_STEPS;
}

/** True when the wizard for `type` has the step `slug`. */
export function hasSetupStep(slug: SetupSlug, type: BusinessType = "workforce"): boolean {
  return setupStepsFor(type).some((s) => s.slug === slug);
}

/** The step after `slug` for `type`, or null after Ready. */
export function nextSetupStep(slug: SetupSlug, type: BusinessType = "workforce"): SetupStep | null {
  const number = setupStep(slug).number;
  return setupStepsFor(type).find((s) => s.number > number) ?? null;
}

/** The step before `slug` for `type`, or null on Plan. */
export function previousSetupStep(
  slug: SetupSlug,
  type: BusinessType = "workforce",
): SetupStep | null {
  const number = setupStep(slug).number;
  return (
    setupStepsFor(type)
      .filter((s) => s.number < number)
      .at(-1) ?? null
  );
}

/** How many steps there are to do before Ready: 5, or 4 for a services business. */
export function setupTotal(type: BusinessType = "workforce"): number {
  return setupStepsFor(type).length - 1;
}

/**
 * "Setup N of 5 done" (4 for a services business): the steps before the furthest one reached,
 * never more than the total.
 */
export function setupDoneCount(
  furthestStep: number,
  completed: boolean,
  type: BusinessType = "workforce",
): number {
  const total = setupTotal(type);
  if (completed) return total;
  const done = setupStepsFor(type).filter((s) => s.slug !== "ready" && s.number < furthestStep);
  return Math.min(total, done.length);
}

/**
 * Where /app/setup sends the owner: the furthest step reached that the type's wizard has, Ready
 * once complete.
 */
export function resumeSetupSlug(
  furthestStep: number,
  completed: boolean,
  type: BusinessType = "workforce",
): SetupSlug {
  if (completed) return "ready";
  const reached = setupStepsFor(type).filter(
    (s) => s.slug !== "ready" && s.number <= Math.max(furthestStep, 1),
  );
  return reached.at(-1)?.slug ?? "plan";
}
