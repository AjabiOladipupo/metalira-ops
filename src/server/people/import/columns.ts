/**
 * The 32 columns of `fixtures/employee_import_template.csv`, in template order.
 *
 * The first 15 are enough to import a worker. Pay, bank, tax, pension and next-of-kin columns
 * may be left out of the file; workers then import flagged "needs pay details before payroll"
 * (owner decision 14). `employee_id` is the company's own staff ID (`workers.staff_id`).
 */
export const TEMPLATE_COLUMNS = [
  "employee_id",
  "first_name",
  "last_name",
  "phone",
  "email",
  "job_title",
  "department",
  "employment_type",
  "start_date",
  "line_manager_employee_id",
  "client_company",
  "project",
  "site",
  "shift_pattern",
  "pay_type",
  "basic_monthly",
  "housing_monthly",
  "transport_monthly",
  "other_allowances_monthly",
  "daily_rate",
  "bank_name",
  "bank_account_number",
  "account_name",
  "nin",
  "tin",
  "tax_state",
  "pfa_name",
  "rsa_pin",
  "nhf_opt_in",
  "annual_rent_declared",
  "next_of_kin_name",
  "next_of_kin_phone",
] as const;

export type ColumnKey = (typeof TEMPLATE_COLUMNS)[number];

/** Columns a file must have. Values may still be blank where the column is optional. */
export const REQUIRED_COLUMNS = TEMPLATE_COLUMNS.slice(0, 15) as readonly ColumnKey[];

export const MONTHLY_PAY_COLUMNS = [
  "basic_monthly",
  "housing_monthly",
  "transport_monthly",
  "other_allowances_monthly",
] as const satisfies readonly ColumnKey[];

export const PAY_AMOUNT_COLUMNS = [
  ...MONTHLY_PAY_COLUMNS,
  "daily_rate",
] as const satisfies readonly ColumnKey[];

export const BANK_COLUMNS = [
  "bank_name",
  "bank_account_number",
  "account_name",
] as const satisfies readonly ColumnKey[];

/** Plain-English names used in problem messages. */
export const COLUMN_LABELS: Record<ColumnKey, string> = {
  employee_id: "Staff ID",
  first_name: "First name",
  last_name: "Last name",
  phone: "Phone",
  email: "Email",
  job_title: "Job title",
  department: "Department",
  employment_type: "Employment type",
  start_date: "Start date",
  line_manager_employee_id: "Line manager",
  client_company: "Client",
  project: "Project",
  site: "Site",
  shift_pattern: "Shift pattern",
  pay_type: "Pay type",
  basic_monthly: "Basic monthly",
  housing_monthly: "Housing monthly",
  transport_monthly: "Transport monthly",
  other_allowances_monthly: "Other allowances monthly",
  daily_rate: "Daily rate",
  bank_name: "Bank name",
  bank_account_number: "Bank account number",
  account_name: "Account name",
  nin: "NIN",
  tin: "TIN",
  tax_state: "Tax state",
  pfa_name: "PFA name",
  rsa_pin: "RSA PIN",
  nhf_opt_in: "NHF opt-in",
  annual_rent_declared: "Annual rent declared",
  next_of_kin_name: "Next of kin name",
  next_of_kin_phone: "Next of kin phone",
};

/** Other spellings people use for a template column. Keys are already normalised. */
const COLUMN_ALIASES: Record<string, ColumnKey> = {
  staff_id: "employee_id",
  line_manager_staff_id: "line_manager_employee_id",
  line_manager_id: "line_manager_employee_id",
  client: "client_company",
};

const TEMPLATE_SET: ReadonlySet<string> = new Set(TEMPLATE_COLUMNS);

/** "Employee ID " → "employee_id"; also strips a UTF-8 byte order mark. */
export function normaliseHeaderName(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export interface HeaderMap {
  /** Template column → index of that column in each row. */
  indexOf: Partial<Record<ColumnKey, number>>;
  present: ColumnKey[];
  /** Header cells that are not template columns (ignored). Original spelling. */
  ignored: string[];
  missingRequired: ColumnKey[];
  /** Header names that appear more than once. Original spelling. */
  duplicated: string[];
}

export function mapHeader(header: readonly string[]): HeaderMap {
  const indexOf: Partial<Record<ColumnKey, number>> = {};
  const ignored: string[] = [];
  const duplicated: string[] = [];
  header.forEach((cell, index) => {
    const name = normaliseHeaderName(cell);
    if (name === "") return;
    const key = TEMPLATE_SET.has(name) ? (name as ColumnKey) : COLUMN_ALIASES[name];
    if (!key) {
      ignored.push(cell.trim());
      return;
    }
    if (indexOf[key] !== undefined) {
      duplicated.push(cell.trim());
      return;
    }
    indexOf[key] = index;
  });
  const present = TEMPLATE_COLUMNS.filter((key) => indexOf[key] !== undefined);
  const missingRequired = REQUIRED_COLUMNS.filter((key) => indexOf[key] === undefined);
  return { indexOf, present, ignored, missingRequired, duplicated };
}
