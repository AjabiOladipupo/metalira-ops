import { formatDate } from "@/lib/dates";
import { maskAccount, maskPhone, maskRsaPin } from "@/lib/mask";
import { workerMessages } from "@/lib/messages/worker";
import { formatNaira, type Kobo } from "@/lib/money";
import type { EmploymentType } from "@/lib/people";

/**
 * The worker's own profile as the Me screen shows it (WkProfile board, slice 1.10). Pure and
 * browser-safe. Personal data is always masked here, even though it is the worker's own: the
 * phone may be seen over a shoulder, and the full values never leave the server (rule 9).
 */

export interface MyProfileInput {
  departmentName: string | null;
  /** Whether a line manager is set, and their name when the worker may see it. */
  lineManager: { isSet: boolean; name: string | null };
  siteNames: readonly string[];
  projectNames: readonly string[];
  startDate: string;
  employmentType: EmploymentType;
  bankName: string | null;
  bankAccountLast4: string | null;
  pfaName: string | null;
  rsaPinOnFile: boolean;
  rsaPinLast4: string | null;
  taxState: string | null;
  annualRentDeclared: Kobo | null;
  ninOnFile: boolean;
  phone: string | null;
  nextOfKinName: string | null;
  nextOfKinPhone: string | null;
}

export interface ProfileRow {
  label: string;
  /** Null shows as "Not set". */
  value: string | null;
  testId: string;
}

export interface ProfileSection {
  id: "work" | "pay" | "identity";
  title: string;
  rows: ProfileRow[];
}

const copy = workerMessages.me;

/** Joins the parts that are present with " · ", or null when none are. */
function joined(...parts: (string | null | undefined)[]): string | null {
  const present = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return present.length > 0 ? present.join(" · ") : null;
}

function list(values: readonly string[]): string | null {
  return values.length > 0 ? values.join(", ") : null;
}

export function myProfileSections(p: MyProfileInput): ProfileSection[] {
  return [
    {
      id: "work",
      title: copy.work,
      rows: [
        { label: copy.department, value: p.departmentName, testId: "me-department" },
        {
          label: copy.lineManager,
          value: p.lineManager.isSet ? (p.lineManager.name ?? copy.lineManagerUnnamed) : null,
          testId: "me-line-manager",
        },
        { label: copy.site, value: list(p.siteNames), testId: "me-site" },
        { label: copy.project, value: list(p.projectNames), testId: "me-project" },
        {
          label: copy.started,
          value: copy.startedValue(formatDate(p.startDate), copy.employmentTypes[p.employmentType]),
          testId: "me-started",
        },
      ],
    },
    {
      id: "pay",
      title: copy.pay,
      rows: [
        {
          label: copy.bank,
          // "GTBank ••••7712", as on the board.
          value:
            [p.bankName?.trim(), maskAccount(p.bankAccountLast4)].filter(Boolean).join(" ") || null,
          testId: "me-bank",
        },
        {
          label: copy.pension,
          value: joined(
            p.pfaName,
            maskRsaPin(p.rsaPinLast4) || (p.rsaPinOnFile ? copy.ninOnFile : null),
          ),
          testId: "me-pension",
        },
        { label: copy.taxState, value: p.taxState, testId: "me-tax-state" },
        {
          label: copy.rent,
          value:
            p.annualRentDeclared === null
              ? null
              : copy.rentValue(formatNaira(p.annualRentDeclared, { whole: true })),
          testId: "me-rent",
        },
      ],
    },
    {
      id: "identity",
      title: copy.identity,
      rows: [
        {
          label: copy.nin,
          value: p.ninOnFile ? copy.ninOnFile : copy.ninMissing,
          testId: "me-nin",
        },
        { label: copy.phone, value: maskPhone(p.phone) || null, testId: "me-phone" },
        {
          label: copy.nextOfKin,
          value: joined(p.nextOfKinName, maskPhone(p.nextOfKinPhone)),
          testId: "me-next-of-kin",
        },
      ],
    },
  ];
}
