import { z } from "zod";

import type { Kobo } from "@/lib/money";
import { plainText } from "@/server/identity/names";

import {
  BANK_COLUMNS,
  COLUMN_LABELS,
  MONTHLY_PAY_COLUMNS,
  PAY_AMOUNT_COLUMNS,
  TEMPLATE_COLUMNS,
  mapHeader,
  type ColumnKey,
} from "./columns";
import { IMPORT_LIMITS } from "./limits";
import { nameKey, resolveNames, type NameResolution } from "./names";
import { generateStaffIds } from "./staff-id";
import type {
  EmploymentType,
  FileProblem,
  ImportContext,
  ImportContextInput,
  ImportFormat,
  ImportProblem,
  ImportResult,
  ImportSummary,
  ImportWarning,
  LineManagerRef,
  NormalisedPayRate,
  NormalisedRow,
  ResolvedName,
  RowResult,
  RowStatus,
  SuggestedFix,
} from "./types";
import { importContextSchema } from "./types";
import {
  checkNin,
  checkNuban,
  maskMobileForMessage,
  parseEmploymentType,
  parseImportDate,
  parseImportEmail,
  parseImportNaira,
  parseNigerianMobile,
  parsePayType,
  parseYesNo,
} from "./values";

/** One employee row of the file, cells keyed by template column. */
export interface ImportRecord {
  /** Spreadsheet row number: the header is row 1. */
  rowNumber: number;
  values: Record<ColumnKey, string>;
  /** Non-blank cells to the right of the last header column. */
  extraValues?: number;
}

const REQUIRED_VALUES = [
  "first_name",
  "last_name",
  "phone",
  "job_title",
  "department",
  "employment_type",
  "start_date",
] as const satisfies readonly ColumnKey[];

/** Free-text columns that may end up in emails and on screens: plain text only. */
const TEXT_COLUMNS = [
  "first_name",
  "last_name",
  "job_title",
  "department",
  "client_company",
  "project",
  "site",
  "shift_pattern",
  "bank_name",
  "account_name",
  "tax_state",
  "pfa_name",
  "next_of_kin_name",
] as const satisfies readonly ColumnKey[];

const AMOUNT_COLUMNS = [
  ...PAY_AMOUNT_COLUMNS,
  "annual_rent_declared",
] as const satisfies readonly ColumnKey[];

type AmountColumn = (typeof AMOUNT_COLUMNS)[number];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function emptyValues(): Record<ColumnKey, string> {
  const out = {} as Record<ColumnKey, string>;
  for (const key of TEMPLATE_COLUMNS) out[key] = "";
  return out;
}

/** Working state for one row while the checks run. */
interface Draft {
  record: ImportRecord;
  v: Record<ColumnKey, string>;
  problems: ImportProblem[];
  warnings: ImportWarning[];
  /** Columns that already have a problem, so later checks don't pile on. */
  badColumns: Set<ColumnKey>;
  staffId: string | null;
  staffIdGenerated: boolean;
  phone: string | null;
  email: string | null;
  employmentType: EmploymentType | null;
  startDate: string | null;
  amounts: Partial<Record<AmountColumn, Kobo>>;
  payRate: NormalisedPayRate | null;
  payReasons: string[];
  nhfOptIn: boolean;
  supervisorClockIn: boolean;
  department: ResolvedName | null;
  client: ResolvedName | null;
  /** Scope key of the client used to resolve projects and sites (the suggestion when near). */
  clientScope: string | null;
  project: ResolvedName | null;
  site: ResolvedName | null;
  lineManager: LineManagerRef | null;
  /** Problem waiting for a "Set to …" suggestion once every row is known. */
  lineManagerProblem: ImportProblem | null;
}

function addProblem(
  draft: Draft,
  code: ImportProblem["code"],
  column: ColumnKey | null,
  message: string,
  fix: SuggestedFix | null = null,
): ImportProblem {
  const problem: ImportProblem = { code, column, message, fix };
  draft.problems.push(problem);
  if (column) draft.badColumns.add(column);
  return problem;
}

const isHeld = (draft: Draft) => draft.problems.length > 0;

function resolvedKey(name: ResolvedName): string {
  return name.kind === "existing" ? `id:${name.id}` : `new:${nameKey(name.name)}`;
}

// ---------------------------------------------------------------------------------------------
// Single-row checks
// ---------------------------------------------------------------------------------------------

function checkCells(draft: Draft): void {
  const { v } = draft;
  if (draft.record.extraValues && draft.record.extraValues > 0) {
    addProblem(
      draft,
      "row_too_wide",
      null,
      `This row has ${plural(draft.record.extraValues, "more value", "more values")} than the header has columns. Check for a comma inside a value that isn't in quotes.`,
    );
  }
  for (const key of TEMPLATE_COLUMNS) {
    if (v[key].length > IMPORT_LIMITS.maxCellLength) {
      addProblem(
        draft,
        "value_too_long",
        key,
        `${COLUMN_LABELS[key]} is longer than ${IMPORT_LIMITS.maxCellLength} characters.`,
      );
    }
  }
  for (const key of TEXT_COLUMNS) {
    if (draft.badColumns.has(key) || v[key] === "") continue;
    const parsed = plainText(z.string(), COLUMN_LABELS[key]).safeParse(v[key]);
    if (!parsed.success) {
      addProblem(
        draft,
        "not_plain_text",
        key,
        `${parsed.error.issues[0]?.message ?? `${COLUMN_LABELS[key]} must be plain text`}.`,
      );
    }
  }
  for (const key of REQUIRED_VALUES) {
    if (v[key] === "") addProblem(draft, "required_blank", key, `${COLUMN_LABELS[key]} is blank.`);
  }
}

function checkIdentity(draft: Draft): void {
  const { v } = draft;
  draft.staffId = v.employee_id === "" ? null : v.employee_id;

  if (v.phone !== "" && !draft.badColumns.has("phone")) {
    const phone = parseNigerianMobile(v.phone);
    if (phone.ok) draft.phone = phone.value;
    else {
      addProblem(
        draft,
        "phone_invalid",
        "phone",
        "Phone is not a Nigerian mobile number. Use 11 digits starting 070, 080, 081, 090 or 091.",
      );
    }
  }

  if (v.email !== "" && !draft.badColumns.has("email")) {
    const email = parseImportEmail(v.email);
    if (email.ok) draft.email = email.value;
    else {
      addProblem(
        draft,
        "email_invalid",
        "email",
        `Email "${v.email}" is not an email address. Fix it or leave it blank.`,
        { label: "Leave email blank", patch: { email: "" } },
      );
    }
  }

  if (v.employment_type !== "" && !draft.badColumns.has("employment_type")) {
    const type = parseEmploymentType(v.employment_type);
    if (type.ok) draft.employmentType = type.value;
    else {
      addProblem(
        draft,
        "employment_type_invalid",
        "employment_type",
        `Employment type "${v.employment_type}" is not one of Permanent, Contract, Casual or Daily.`,
      );
    }
  }

  if (v.start_date !== "" && !draft.badColumns.has("start_date")) {
    const date = parseImportDate(v.start_date);
    if (date.ok) draft.startDate = date.value;
    else {
      addProblem(
        draft,
        "date_invalid",
        "start_date",
        `Start date "${v.start_date}" is not a date. Use YYYY-MM-DD, for example 2024-03-01.`,
      );
    }
  }

  if (v.nin !== "" && !draft.badColumns.has("nin")) {
    const nin = checkNin(v.nin);
    if (!nin.ok) {
      addProblem(
        draft,
        "nin_invalid",
        "nin",
        nin.reason === "wrong_length"
          ? `NIN has ${plural(nin.digits, "digit", "digits")}; NINs have 11.`
          : "NIN must be 11 digits, with no letters or symbols.",
        { label: "Leave NIN blank for now", patch: { nin: "" } },
      );
    }
  }

  if (v.nhf_opt_in !== "" && !draft.badColumns.has("nhf_opt_in")) {
    const nhf = parseYesNo(v.nhf_opt_in);
    if (nhf.ok) draft.nhfOptIn = nhf.value;
    else
      addProblem(
        draft,
        "yes_no_invalid",
        "nhf_opt_in",
        `NHF opt-in "${v.nhf_opt_in}" is not Y or N.`,
      );
  }
}

function checkPay(draft: Draft, present: ReadonlySet<ColumnKey>): void {
  const { v } = draft;
  let amountsValid = true;
  for (const key of AMOUNT_COLUMNS) {
    if (v[key] === "" || draft.badColumns.has(key)) continue;
    const amount = parseImportNaira(v[key]);
    if (amount.ok) draft.amounts[key] = amount.value;
    else {
      amountsValid = false;
      addProblem(
        draft,
        "amount_invalid",
        key,
        `${COLUMN_LABELS[key]} "${v[key]}" is not a naira amount. Use digits like 105000, 105,000 or 105000.50.`,
      );
    }
  }

  const filled = (key: AmountColumn) => (draft.amounts[key] ?? 0n) > 0n;
  const monthlyFilled = MONTHLY_PAY_COLUMNS.some(filled);
  const dailyFilled = filled("daily_rate");
  const payColumnsMissing = !PAY_AMOUNT_COLUMNS.some((key) => present.has(key));

  if (v.pay_type === "") {
    if (monthlyFilled || dailyFilled) {
      const fix: SuggestedFix | null =
        monthlyFilled && !dailyFilled
          ? { label: "Set pay type to Monthly", patch: { pay_type: "Monthly" } }
          : dailyFilled && !monthlyFilled
            ? { label: "Set pay type to Daily", patch: { pay_type: "Daily" } }
            : null;
      addProblem(
        draft,
        "pay_type_missing",
        "pay_type",
        "Pay amounts are filled but pay type is blank. Set pay type to Monthly or Daily.",
        fix,
      );
    } else if (amountsValid) {
      draft.payReasons.push(payColumnsMissing ? "pay columns are not in the file" : "pay is blank");
    }
  } else {
    const payType = parsePayType(v.pay_type);
    if (!payType.ok) {
      addProblem(
        draft,
        payType.reason === "hourly" ? "pay_type_hourly" : "pay_type_invalid",
        "pay_type",
        payType.reason === "hourly"
          ? "Hourly pay can't be imported yet. Use Monthly or Daily, or set hourly pay on the employee page after import."
          : `Pay type "${v.pay_type}" is not Monthly or Daily.`,
      );
    } else if (payType.value === "monthly") {
      if (dailyFilled) {
        addProblem(
          draft,
          "pay_amount_conflict",
          "daily_rate",
          "Pay type is Monthly but a daily rate is filled. Clear the daily rate or change pay type to Daily.",
          { label: "Clear the daily rate", patch: { daily_rate: "" } },
        );
      } else if (!filled("basic_monthly")) {
        if (amountsValid) {
          draft.payReasons.push(
            payColumnsMissing ? "pay columns are not in the file" : "basic pay is blank",
          );
        }
      } else if (amountsValid && draft.startDate) {
        draft.payRate = {
          payType: "monthly",
          basicKobo: draft.amounts.basic_monthly ?? 0n,
          housingKobo: draft.amounts.housing_monthly ?? 0n,
          transportKobo: draft.amounts.transport_monthly ?? 0n,
          otherAllowancesKobo: draft.amounts.other_allowances_monthly ?? 0n,
          dailyRateKobo: 0n,
          currency: "NGN",
          effectiveFrom: draft.startDate,
        };
      }
    } else if (monthlyFilled) {
      addProblem(
        draft,
        "pay_amount_conflict",
        "basic_monthly",
        "Pay type is Daily but monthly amounts are filled. Clear them or change pay type to Monthly.",
        {
          label: "Clear the monthly amounts",
          patch: {
            basic_monthly: "",
            housing_monthly: "",
            transport_monthly: "",
            other_allowances_monthly: "",
          },
        },
      );
    } else if (!dailyFilled) {
      if (amountsValid) {
        draft.payReasons.push(
          payColumnsMissing ? "pay columns are not in the file" : "daily rate is blank",
        );
      }
    } else if (amountsValid && draft.startDate) {
      draft.payRate = {
        payType: "daily",
        basicKobo: 0n,
        housingKobo: 0n,
        transportKobo: 0n,
        otherAllowancesKobo: 0n,
        dailyRateKobo: draft.amounts.daily_rate ?? 0n,
        currency: "NGN",
        effectiveFrom: draft.startDate,
      };
    }
  }
}

function checkBank(draft: Draft, present: ReadonlySet<ColumnKey>): void {
  const { v } = draft;
  if (v.bank_account_number !== "" && !draft.badColumns.has("bank_account_number")) {
    const nuban = checkNuban(v.bank_account_number);
    if (!nuban.ok) {
      addProblem(
        draft,
        "bank_account_invalid",
        "bank_account_number",
        nuban.reason === "wrong_length"
          ? `Bank account number has ${plural(nuban.digits, "digit", "digits")}; NUBAN numbers have 10.`
          : "Bank account number must be 10 digits, with no letters or symbols.",
        { label: "Mark for HR to fix", patch: { bank_account_number: "" } },
      );
      return;
    }
  }
  if (!BANK_COLUMNS.some((key) => present.has(key))) {
    draft.payReasons.push("bank columns are not in the file");
    return;
  }
  const blank = BANK_COLUMNS.filter((key) => v[key] === "");
  if (blank.length === BANK_COLUMNS.length) draft.payReasons.push("bank details are blank");
  else
    for (const key of blank) draft.payReasons.push(`${COLUMN_LABELS[key].toLowerCase()} is blank`);
}

// ---------------------------------------------------------------------------------------------
// Cross-row checks
// ---------------------------------------------------------------------------------------------

function checkStaffIds(drafts: Draft[], ctx: ImportContext): void {
  const existing = new Map(ctx.existingWorkers.map((w) => [w.staffId.trim().toLowerCase(), w]));
  const firstRow = new Map<string, Draft>();
  for (const draft of drafts) {
    if (!draft.staffId) continue;
    const key = draft.staffId.toLowerCase();
    const worker = existing.get(key);
    const first = firstRow.get(key);
    const fix: SuggestedFix = { label: "Generate a new staff ID", patch: { employee_id: "" } };
    if (worker) {
      addProblem(
        draft,
        "staff_id_exists",
        "employee_id",
        `Staff ID ${draft.staffId} already belongs to ${worker.firstName} ${worker.lastName} in your account.`,
        fix,
      );
    } else if (first) {
      addProblem(
        draft,
        "staff_id_duplicate_in_file",
        "employee_id",
        `Staff ID ${draft.staffId} is also on row ${first.record.rowNumber}. Each employee needs their own staff ID.`,
        fix,
      );
    }
    if (!first) firstRow.set(key, draft);
  }

  const blanks = drafts.filter((draft) => draft.staffId === null);
  if (blanks.length === 0) return;
  const taken = [
    ...ctx.existingWorkers.map((w) => w.staffId),
    ...drafts.flatMap((draft) => (draft.staffId ? [draft.staffId] : [])),
  ];
  const generated = generateStaffIds(taken, blanks.length, ctx.defaultStaffIdPrefix);
  blanks.forEach((draft, index) => {
    const id = generated[index] ?? "";
    draft.staffId = id;
    draft.staffIdGenerated = true;
    draft.warnings.push({
      code: "staff_id_generated",
      column: "employee_id",
      message: `Staff ID was blank. It will be ${id}.`,
      attention: false,
      appliedFix: null,
    });
  });
}

function checkPhones(drafts: Draft[], ctx: ImportContext): void {
  const existing = new Map<string, ImportContext["existingWorkers"][number]>();
  for (const worker of ctx.existingWorkers) {
    if (!worker.phone) continue;
    const phone = parseNigerianMobile(worker.phone);
    if (phone.ok && !existing.has(phone.value)) existing.set(phone.value, worker);
  }
  const firstRow = new Map<string, Draft>();
  for (const draft of drafts) {
    if (!draft.phone) continue;
    const worker = existing.get(draft.phone);
    const first = firstRow.get(draft.phone);
    const masked = maskMobileForMessage(draft.phone);
    let message: string | null = null;
    if (worker) {
      message = `Phone ${masked} already belongs to ${worker.firstName} ${worker.lastName} (${worker.staffId}). Each worker needs their own phone to clock in.`;
    } else if (first) {
      message = `Phone ${masked} is also on row ${first.record.rowNumber}. Each worker needs their own phone to clock in.`;
    } else {
      firstRow.set(draft.phone, draft);
    }
    if (message) {
      draft.supervisorClockIn = true;
      draft.warnings.push({
        code: "duplicate_phone",
        column: "phone",
        message,
        attention: true,
        appliedFix: "Use supervisor clock-in",
      });
    }
  }
}

function countUsed(
  drafts: Draft[],
  pick: (draft: Draft) => string,
): { name: string; count: number }[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const draft of drafts) {
    const name = pick(draft);
    if (name === "") continue;
    const entry = counts.get(name);
    if (entry) entry.count += 1;
    else counts.set(name, { name, count: 1 });
  }
  return [...counts.values()];
}

function toResolved(resolution: NameResolution | undefined, fallback: string): ResolvedName {
  if (resolution?.kind === "existing")
    return { kind: "existing", id: resolution.id, name: resolution.name };
  if (resolution?.kind === "new") return { kind: "new", name: resolution.name };
  return { kind: "new", name: fallback };
}

function checkNames(drafts: Draft[], ctx: ImportContext): void {
  // Departments: exact match (case, spacing and punctuation ignored) or a new department.
  const departmentsByKey = new Map(ctx.departments.map((d) => [nameKey(d.name), d]));
  const newDepartments = new Map<string, string>();
  for (const draft of drafts) {
    if (draft.v.department === "" || draft.badColumns.has("department")) continue;
    const key = nameKey(draft.v.department);
    const match = departmentsByKey.get(key);
    if (match) draft.department = { kind: "existing", id: match.id, name: match.name };
    else {
      if (!newDepartments.has(key)) newDepartments.set(key, draft.v.department);
      draft.department = { kind: "new", name: newDepartments.get(key) ?? draft.v.department };
    }
  }

  // Clients: exact, near (typo, held back with a fix) or new.
  const clientRows = drafts.filter((d) => !d.badColumns.has("client_company"));
  const clients = resolveNames(
    countUsed(clientRows, (d) => d.v.client_company),
    ctx.clients,
  );
  const existingClientsByKey = new Map(ctx.clients.map((c) => [nameKey(c.name), c]));
  const clientByName = (name: string): ResolvedName => {
    const existing = existingClientsByKey.get(nameKey(name));
    if (existing) return { kind: "existing", id: existing.id, name: existing.name };
    return toResolved(clients.get(nameKey(name)), name);
  };

  for (const draft of clientRows) {
    const raw = draft.v.client_company;
    if (raw === "") {
      for (const key of ["project", "site"] as const) {
        if (draft.v[key] !== "" && !draft.badColumns.has(key)) {
          addProblem(
            draft,
            "client_missing",
            "client_company",
            `${COLUMN_LABELS[key]} is filled but client is blank. Add the client the ${key} belongs to.`,
          );
          break;
        }
      }
      continue;
    }
    const resolution = clients.get(nameKey(raw));
    if (resolution?.kind === "near") {
      addProblem(draft, "client_not_found", "client_company", `Client "${raw}" not found.`, {
        label: `Match to ${resolution.suggestion}`,
        patch: { client_company: resolution.suggestion },
      });
      draft.clientScope = resolvedKey(clientByName(resolution.suggestion));
    } else {
      draft.client = toResolved(resolution, raw);
      draft.clientScope = resolvedKey(draft.client);
    }
  }

  // Projects and sites: resolved within their client.
  const resolveWithinClient = (
    column: "project" | "site",
    existingRecords: ImportContext["projects"],
    assign: (draft: Draft, value: ResolvedName) => void,
    code: "project_not_found" | "site_not_found",
  ) => {
    const byScope = new Map<string, Draft[]>();
    for (const draft of drafts) {
      if (!draft.clientScope || draft.v[column] === "" || draft.badColumns.has(column)) continue;
      const list = byScope.get(draft.clientScope) ?? [];
      list.push(draft);
      byScope.set(draft.clientScope, list);
    }
    for (const [scope, scoped] of byScope) {
      const clientId = scope.startsWith("id:") ? scope.slice(3) : null;
      const known = clientId ? existingRecords.filter((r) => r.clientId === clientId) : [];
      const resolved = resolveNames(
        countUsed(scoped, (d) => d.v[column]),
        known,
      );
      for (const draft of scoped) {
        const raw = draft.v[column];
        const resolution = resolved.get(nameKey(raw));
        if (resolution?.kind === "near") {
          const clientName =
            draft.client?.name ??
            draft.problems.find((p) => p.code === "client_not_found")?.fix?.patch.client_company ??
            "";
          addProblem(
            draft,
            code,
            column,
            `${COLUMN_LABELS[column]} "${raw}" not found for ${clientName}.`,
            {
              label: `Match to ${resolution.suggestion}`,
              patch: { [column]: resolution.suggestion },
            },
          );
        } else {
          assign(draft, toResolved(resolution, raw));
        }
      }
    }
  };
  resolveWithinClient(
    "project",
    ctx.projects,
    (d, value) => (d.project = value),
    "project_not_found",
  );
  resolveWithinClient("site", ctx.sites, (d, value) => (d.site = value), "site_not_found");
}

function checkLineManagers(drafts: Draft[], ctx: ImportContext): void {
  const rowsById = new Map<string, Draft>();
  for (const draft of drafts) {
    if (draft.staffId && !draft.staffIdGenerated) {
      const key = draft.staffId.toLowerCase();
      if (!rowsById.has(key)) rowsById.set(key, draft);
    }
  }
  const workersById = new Map(ctx.existingWorkers.map((w) => [w.staffId.trim().toLowerCase(), w]));
  const managersByEmail = new Map(ctx.managers.map((m) => [m.email.trim().toLowerCase(), m]));

  // Pass 2 of the two-pass resolve: every staff ID in the file is known now.
  for (const draft of drafts) {
    const raw = draft.v.line_manager_employee_id;
    if (raw === "" || draft.badColumns.has("line_manager_employee_id")) continue;
    const key = raw.toLowerCase();
    if (raw.includes("@")) {
      const manager = managersByEmail.get(key);
      if (manager) {
        draft.lineManager = {
          kind: "membership",
          membershipId: manager.membershipId,
          email: manager.email,
          name: manager.name,
        };
      } else {
        draft.lineManagerProblem = addProblem(
          draft,
          "line_manager_unknown",
          "line_manager_employee_id",
          `Line manager ${raw} is not a user in your account.`,
        );
      }
      continue;
    }
    if (draft.staffId && key === draft.staffId.toLowerCase()) {
      draft.lineManagerProblem = addProblem(
        draft,
        "line_manager_self",
        "line_manager_employee_id",
        "An employee can't be their own line manager. Choose someone else.",
      );
      continue;
    }
    const row = rowsById.get(key);
    const worker = workersById.get(key);
    if (row && row.staffId) {
      draft.lineManager = {
        kind: "row",
        rowNumber: row.record.rowNumber,
        staffId: row.staffId,
        name: `${row.v.first_name} ${row.v.last_name}`.trim(),
      };
    } else if (worker) {
      draft.lineManager = {
        kind: "worker",
        workerId: worker.id,
        staffId: worker.staffId,
        name: `${worker.firstName} ${worker.lastName}`.trim(),
      };
    } else {
      draft.lineManagerProblem = addProblem(
        draft,
        "line_manager_unknown",
        "line_manager_employee_id",
        `Line manager ID ${raw} is not in the file or in your account.`,
      );
    }
  }

  // Cycle check over the file and the account together. Each person has at most one manager,
  // so following manager links from any start either ends or enters exactly one loop.
  const managerOf = new Map<string, string>();
  const display = new Map<string, string>();
  for (const worker of ctx.existingWorkers) {
    const key = worker.staffId.trim().toLowerCase();
    display.set(key, worker.staffId);
    if (worker.lineManagerStaffId)
      managerOf.set(key, worker.lineManagerStaffId.trim().toLowerCase());
  }
  for (const [key, draft] of rowsById) {
    display.set(key, draft.staffId ?? key);
    const ref = draft.lineManager;
    if (ref && (ref.kind === "row" || ref.kind === "worker"))
      managerOf.set(key, ref.staffId.toLowerCase());
    else managerOf.delete(key);
  }
  const inLoop = new Map<string, string[]>();
  const done = new Set<string>();
  for (const start of rowsById.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let node: string | undefined = start;
    while (node !== undefined && !done.has(node) && !position.has(node)) {
      position.set(node, path.length);
      path.push(node);
      node = managerOf.get(node);
    }
    if (node !== undefined && position.has(node)) {
      const loop = path.slice(position.get(node));
      for (const member of loop) inLoop.set(member, loop);
    }
    for (const visited of path) done.add(visited);
  }
  for (const [key, loop] of inLoop) {
    const draft = rowsById.get(key);
    if (!draft) continue;
    const from = loop.indexOf(key);
    const ordered = [...loop.slice(from), ...loop.slice(0, from), key].map(
      (k) => display.get(k) ?? k,
    );
    addProblem(
      draft,
      "line_manager_cycle",
      "line_manager_employee_id",
      `Line managers form a loop: ${ordered.join(" → ")}. Choose a line manager outside the loop.`,
    );
  }

  // A row whose line manager is a held-back row waits for that row.
  let changed = true;
  while (changed) {
    changed = false;
    for (const draft of drafts) {
      const ref = draft.lineManager;
      // One line-manager problem per row is enough (a loop already explains itself).
      if (ref?.kind !== "row" || draft.badColumns.has("line_manager_employee_id")) continue;
      const target = rowsById.get(ref.staffId.toLowerCase());
      if (target && target !== draft && isHeld(target)) {
        addProblem(
          draft,
          "line_manager_held",
          "line_manager_employee_id",
          `Line manager ${ref.staffId} is on row ${ref.rowNumber}, which needs fixing first.`,
        );
        changed = true;
      }
    }
  }
}

function lineManagerPatchValue(ref: LineManagerRef): string {
  return ref.kind === "membership" ? ref.email : ref.staffId;
}

function lineManagerKey(ref: LineManagerRef): string {
  if (ref.kind === "membership") return `m:${ref.membershipId}`;
  return `s:${ref.staffId.toLowerCase()}`;
}

/** "Set to Kola Adebayo": the line manager most used by importable rows at the same site and department. */
function suggestLineManagers(drafts: Draft[]): void {
  const candidates = drafts.filter((d) => !isHeld(d) && d.lineManager);
  const scopes: ((d: Draft) => string | null)[] = [
    (d) =>
      d.site && d.department
        ? `${resolvedKey(d.site)}|${d.clientScope}|${resolvedKey(d.department)}`
        : null,
    (d) => (d.site ? `${resolvedKey(d.site)}|${d.clientScope}` : null),
    (d) => (d.department ? resolvedKey(d.department) : null),
  ];
  for (const draft of drafts) {
    const problem = draft.lineManagerProblem;
    if (!problem) continue;
    for (const scopeOf of scopes) {
      const scope = scopeOf(draft);
      if (scope === null) continue;
      const counts = new Map<string, { ref: LineManagerRef; count: number }>();
      for (const other of candidates) {
        if (other === draft || !other.lineManager || scopeOf(other) !== scope) continue;
        if (
          draft.staffId &&
          lineManagerKey(other.lineManager) === `s:${draft.staffId.toLowerCase()}`
        )
          continue;
        const key = lineManagerKey(other.lineManager);
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { ref: other.lineManager, count: 1 });
      }
      let best: { ref: LineManagerRef; count: number } | null = null;
      for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
      if (best) {
        problem.fix = {
          label: `Set to ${best.ref.name}`,
          patch: { line_manager_employee_id: lineManagerPatchValue(best.ref) },
        };
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

function normalise(draft: Draft): NormalisedRow | null {
  const { v } = draft;
  if (
    isHeld(draft) ||
    !draft.staffId ||
    !draft.phone ||
    !draft.employmentType ||
    !draft.startDate ||
    !draft.department
  ) {
    return null;
  }
  const orNull = (value: string) => (value === "" ? null : value);
  const nextOfKinPhone =
    v.next_of_kin_phone === "" ? null : parseNigerianMobile(v.next_of_kin_phone);
  return {
    worker: {
      staffId: draft.staffId,
      staffIdGenerated: draft.staffIdGenerated,
      firstName: v.first_name,
      lastName: v.last_name,
      phone: draft.phone,
      email: draft.email,
      jobTitle: v.job_title,
      employmentType: draft.employmentType,
      startDate: draft.startDate,
      shiftPattern: orNull(v.shift_pattern),
      bankName: orNull(v.bank_name),
      accountName: orNull(v.account_name),
      bankAccountNumber:
        v.bank_account_number === "" ? null : v.bank_account_number.replace(/[\s-]/g, ""),
      nin: v.nin === "" ? null : v.nin.replace(/[\s-]/g, ""),
      tin: orNull(v.tin),
      taxState: orNull(v.tax_state),
      pfaName: orNull(v.pfa_name),
      rsaPin: v.rsa_pin === "" ? null : v.rsa_pin.replace(/\s/g, "").toUpperCase(),
      nhfOptIn: draft.nhfOptIn,
      annualRentDeclaredKobo: draft.amounts.annual_rent_declared ?? null,
      currency: "NGN",
      nextOfKinName: orNull(v.next_of_kin_name),
      nextOfKinPhone:
        nextOfKinPhone === null
          ? null
          : nextOfKinPhone.ok
            ? nextOfKinPhone.value
            : v.next_of_kin_phone,
      needsPayDetails: draft.payReasons.length > 0,
      supervisorClockIn: draft.supervisorClockIn,
    },
    department: draft.department,
    lineManager: draft.lineManager,
    payRate: draft.payRate,
    mapping: { client: draft.client, project: draft.project, site: draft.site },
  };
}

function summarise(results: RowResult[], drafts: Draft[]): ImportSummary {
  const importable = drafts.filter((d) => !isHeld(d));
  const departments = new Map<string, ResolvedName>();
  const managers = new Set<string>();
  const clients = new Map<string, ResolvedName>();
  const projects = new Map<string, { client: string; name: ResolvedName }>();
  const sites = new Map<string, { client: string; name: ResolvedName }>();
  for (const d of importable) {
    if (d.department) departments.set(resolvedKey(d.department), d.department);
    if (d.lineManager) managers.add(lineManagerKey(d.lineManager));
    if (d.client) {
      clients.set(resolvedKey(d.client), d.client);
      if (d.project)
        projects.set(`${d.clientScope}|${resolvedKey(d.project)}`, {
          client: d.client.name,
          name: d.project,
        });
      if (d.site)
        sites.set(`${d.clientScope}|${resolvedKey(d.site)}`, {
          client: d.client.name,
          name: d.site,
        });
    }
  }
  const found = {
    departments: departments.size,
    lineManagers: managers.size,
    clients: clients.size,
    projects: projects.size,
    sites: sites.size,
  };
  const count = (status: RowStatus) => results.filter((r) => r.status === status).length;
  const isNew = <T extends { name: ResolvedName }>(entry: T) => entry.name.kind === "new";
  return {
    rows: results.length,
    ready: count("ready"),
    needFixing: count("held") + count("warning"),
    held: count("held"),
    importable: count("ready") + count("warning"),
    needsPayDetails: importable.filter((d) => d.payReasons.length > 0).length,
    generatedStaffIds: importable.filter((d) => d.staffIdGenerated).length,
    supervisorClockIn: importable.filter((d) => d.supervisorClockIn).length,
    found,
    foundLine: [
      plural(found.departments, "department", "departments"),
      plural(found.lineManagers, "line manager", "line managers"),
      plural(found.clients, "client", "clients"),
      plural(found.projects, "project", "projects"),
      plural(found.sites, "site", "sites"),
    ].join(" · "),
    newNames: {
      departments: [...departments.values()].filter((n) => n.kind === "new").map((n) => n.name),
      clients: [...clients.values()].filter((n) => n.kind === "new").map((n) => n.name),
      projects: [...projects.values()]
        .filter(isNew)
        .map((p) => ({ client: p.client, name: p.name.name })),
      sites: [...sites.values()]
        .filter(isNew)
        .map((s) => ({ client: s.client, name: s.name.name })),
    },
  };
}

/**
 * Validates employee rows that are already split into template columns. Use this to check a
 * batch again after applying fixes. `presentColumns` are the template columns the file has.
 */
export function validateImportRecords(
  records: readonly ImportRecord[],
  presentColumns: readonly ColumnKey[],
  contextInput: ImportContextInput,
  options: { format?: ImportFormat | null; fileNotes?: string[]; ignoredColumns?: string[] } = {},
): ImportResult {
  const ctx = importContextSchema.parse(contextInput);
  const present = new Set(presentColumns);

  const drafts: Draft[] = records.map((record) => {
    const v = emptyValues();
    for (const key of TEMPLATE_COLUMNS) v[key] = (record.values[key] ?? "").trim();
    return {
      record,
      v,
      problems: [],
      warnings: [],
      badColumns: new Set(),
      staffId: null,
      staffIdGenerated: false,
      phone: null,
      email: null,
      employmentType: null,
      startDate: null,
      amounts: {},
      payRate: null,
      payReasons: [],
      nhfOptIn: false,
      supervisorClockIn: false,
      department: null,
      client: null,
      clientScope: null,
      project: null,
      site: null,
      lineManager: null,
      lineManagerProblem: null,
    };
  });

  for (const draft of drafts) {
    checkCells(draft);
    checkIdentity(draft);
    checkPay(draft, present);
    checkBank(draft, present);
  }
  checkStaffIds(drafts, ctx);
  checkPhones(drafts, ctx);
  checkNames(drafts, ctx);
  checkLineManagers(drafts, ctx);
  suggestLineManagers(drafts);

  const results: RowResult[] = drafts.map((draft) => {
    if (draft.payReasons.length > 0) {
      draft.warnings.push({
        code: "needs_pay_details",
        column: null,
        message: `Needs pay details before payroll: ${draft.payReasons.join("; ")}.`,
        attention: false,
        appliedFix: null,
      });
    }
    const status: RowStatus = isHeld(draft)
      ? "held"
      : draft.warnings.some((w) => w.attention)
        ? "warning"
        : "ready";
    return {
      rowNumber: draft.record.rowNumber,
      raw: draft.v,
      status,
      problems: draft.problems,
      warnings: draft.warnings,
      normalised: normalise(draft),
    };
  });

  const missingOptional = TEMPLATE_COLUMNS.filter((key) => !present.has(key));
  return {
    ok: true,
    format: options.format ?? null,
    columns: {
      present: [...presentColumns],
      missingOptional,
      ignored: options.ignoredColumns ?? [],
    },
    fileNotes: options.fileNotes ?? [],
    rows: results,
    attention: results.filter((r) => r.status !== "ready"),
    summary: summarise(results, drafts),
  };
}

/** Validates a whole sheet: the first non-blank row is the header. */
export function validateImportTable(
  table: readonly (readonly string[])[],
  contextInput: ImportContextInput,
  format: ImportFormat | null = null,
): ImportResult {
  const isBlank = (row: readonly string[]) => row.every((cell) => cell.trim() === "");
  const headerIndex = table.findIndex((row) => !isBlank(row));
  const header = headerIndex >= 0 ? table[headerIndex] : undefined;
  if (!header) {
    return {
      ok: false,
      format,
      problems: [
        {
          code: "file_empty",
          message: "The file has no rows. Fill the template and upload it again.",
        },
      ],
    };
  }

  const map = mapHeader(header);
  const problems: FileProblem[] = [];
  for (const name of map.duplicated) {
    problems.push({
      code: "column_duplicated",
      message: `Column ${name} appears more than once. Keep one and upload again.`,
    });
  }
  if (map.missingRequired.length > 0) {
    problems.push({
      code: "columns_missing",
      message: `${plural(map.missingRequired.length, "required column is", "required columns are")} missing: ${map.missingRequired.join(", ")}. Download the template and copy your data into it.`,
    });
  }

  const records: ImportRecord[] = [];
  for (let index = headerIndex + 1; index < table.length; index += 1) {
    const row = table[index] ?? [];
    if (isBlank(row)) continue;
    const values = emptyValues();
    for (const key of TEMPLATE_COLUMNS) {
      const column = map.indexOf[key];
      if (column !== undefined) values[key] = row[column] ?? "";
    }
    const extraValues = row.slice(header.length).filter((cell) => cell.trim() !== "").length;
    records.push({ rowNumber: index + 1, values, extraValues });
  }
  if (records.length === 0) {
    problems.push({ code: "file_empty", message: "The file has a header but no employee rows." });
  }
  if (records.length > IMPORT_LIMITS.maxRows) {
    problems.push({
      code: "too_many_rows",
      message: `The file has ${records.length} employee rows; the most we can check at once is 5,000. Split it into smaller files.`,
    });
  }
  if (problems.length > 0) return { ok: false, format, problems };

  const fileNotes: string[] = [];
  if (map.ignored.length > 0) {
    fileNotes.push(
      `${plural(map.ignored.length, "column is", "columns are")} not in the template and will be ignored: ${map.ignored.join(", ")}.`,
    );
  }
  if (!PAY_AMOUNT_COLUMNS.some((key) => map.indexOf[key] !== undefined)) {
    fileNotes.push(
      "Pay columns are not in the file, so every employee will need pay details before payroll.",
    );
  }
  if (!BANK_COLUMNS.some((key) => map.indexOf[key] !== undefined)) {
    fileNotes.push(
      "Bank columns are not in the file, so every employee will need bank details before payroll.",
    );
  }
  return validateImportRecords(records, map.present, contextInput, {
    format,
    fileNotes,
    ignoredColumns: map.ignored,
  });
}
