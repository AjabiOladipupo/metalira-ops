import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TEMPLATE_COLUMNS,
  validateImportTable,
  type ColumnKey,
  type ImportContextInput,
  type ImportResult,
  type RowResult,
} from "@/server/people/import";
import { parseCsv } from "@/server/people/import/csv";
import { generateStaffIds } from "@/server/people/import/staff-id";

type Row = Partial<Record<ColumnKey, string>>;

const BASE: Record<ColumnKey, string> = {
  employee_id: "AFS-0001",
  first_name: "Kola",
  last_name: "Adebayo",
  phone: "08031110001",
  email: "",
  job_title: "Site supervisor",
  department: "Security services",
  employment_type: "Permanent",
  start_date: "2023-05-02",
  line_manager_employee_id: "",
  client_company: "Coastline Logistics",
  project: "Coastline guarding contract",
  site: "Apapa Warehouse 3",
  shift_pattern: "Day 06:00-18:00",
  pay_type: "Monthly",
  basic_monthly: "105000",
  housing_monthly: "63000",
  transport_monthly: "42000",
  other_allowances_monthly: "15000",
  daily_rate: "",
  bank_name: "GTBank",
  bank_account_number: "0123456789",
  account_name: "Kola Adebayo",
  nin: "",
  tin: "",
  tax_state: "Lagos",
  pfa_name: "",
  rsa_pin: "",
  nhf_opt_in: "N",
  annual_rent_declared: "",
  next_of_kin_name: "",
  next_of_kin_phone: "",
};

/** Builds rows with unique staff IDs and phones unless a test sets them. */
function rows(...overrides: Row[]): Record<ColumnKey, string>[] {
  return overrides.map((override, index) => ({
    ...BASE,
    employee_id: `AFS-${String(index + 1).padStart(4, "0")}`,
    phone: `0803111${String(index + 1).padStart(4, "0")}`,
    ...override,
  }));
}

function table(
  records: Record<ColumnKey, string>[],
  columns: readonly ColumnKey[] = TEMPLATE_COLUMNS,
): string[][] {
  return [[...columns], ...records.map((record) => columns.map((key) => record[key]))];
}

function check(records: Record<ColumnKey, string>[], context: ImportContextInput = {}) {
  const result = validateImportTable(table(records), context);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
}

const row = (result: Extract<ImportResult, { ok: true }>, rowNumber: number) =>
  result.rows.find((r) => r.rowNumber === rowNumber) as RowResult;
const codes = (r: RowResult) => r.problems.map((p) => p.code);

describe("the template's example rows", () => {
  const parsed = parseCsv(
    readFileSync(
      fileURLToPath(new URL("../../../fixtures/employee_import_template.csv", import.meta.url)),
      "utf8",
    ),
  );
  if (!parsed.ok) throw new Error("template did not parse");

  it("are all ready when their outside line managers exist in the account", () => {
    const result = validateImportTable(parsed.rows, {
      existingWorkers: [
        {
          id: "w0",
          staffId: "EXAMPLE-000",
          firstName: "Emeka",
          lastName: "Nwankwo",
          phone: null,
          lineManagerStaffId: null,
        },
        {
          id: "w10",
          staffId: "EXAMPLE-010",
          firstName: "Blessing",
          lastName: "Udo",
          phone: null,
          lineManagerStaffId: null,
        },
      ],
    });
    if (!result.ok) throw new Error("template failed");
    expect(result.rows.map((r) => r.status)).toEqual(["ready", "ready", "ready", "ready"]);
    expect(result.summary.foundLine).toBe(
      "2 departments · 3 line managers · 2 clients · 2 projects · 2 sites",
    );
    const daily = result.rows[3]?.normalised;
    expect(daily?.payRate).toMatchObject({ payType: "daily", dailyRateKobo: 800_000n });
    expect(daily?.lineManager).toEqual({
      kind: "row",
      rowNumber: 2,
      staffId: "EXAMPLE-001",
      name: "Kola Adebayo",
    });
  });

  it("hold the reportees of a held-back manager until it is fixed", () => {
    const result = validateImportTable(parsed.rows, {});
    if (!result.ok) throw new Error("template failed");
    expect(result.rows.map((r) => codes(r))).toEqual([
      ["line_manager_unknown"],
      ["line_manager_held"],
      ["line_manager_unknown"],
      ["line_manager_held"],
    ]);
    expect(result.rows[1]?.problems[0]?.message).toBe(
      "Line manager EXAMPLE-001 is on row 2, which needs fixing first.",
    );
  });
});

describe("file checks", () => {
  it("refuses a file missing any of the first 15 columns", () => {
    const result = validateImportTable(
      [
        ["employee_id", "first_name"],
        ["A", "B"],
      ],
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.code).toBe("columns_missing");
    expect(result.problems[0]?.message).toMatch(
      /^13 required columns are missing: last_name, phone, /,
    );
  });

  it("refuses duplicated columns, empty files and header-only files", () => {
    const dup = validateImportTable([[...TEMPLATE_COLUMNS, "phone"]], {});
    expect(!dup.ok && dup.problems.map((p) => p.code)).toEqual(["column_duplicated", "file_empty"]);
    const empty = validateImportTable([[""], []], {});
    expect(!empty.ok && empty.problems.map((p) => p.code)).toEqual(["file_empty"]);
  });

  it("caps the number of employee rows at 5,000", () => {
    const many = Array.from({ length: 5001 }, () => TEMPLATE_COLUMNS.map(() => "x"));
    const result = validateImportTable([[...TEMPLATE_COLUMNS], ...many], {});
    expect(!result.ok && result.problems.map((p) => p.code)).toEqual(["too_many_rows"]);
  });

  it("imports with only the first 15 columns, flagging pay details for payroll", () => {
    const first15 = TEMPLATE_COLUMNS.slice(0, 15);
    const result = validateImportTable(table(rows({}, {}), first15), {});
    if (!result.ok) throw new Error("failed");
    expect(result.summary.importable).toBe(2);
    expect(result.summary.needsPayDetails).toBe(2);
    expect(result.rows[0]?.warnings.map((w) => w.message)).toEqual([
      "Needs pay details before payroll: pay columns are not in the file; bank columns are not in the file.",
    ]);
    expect(result.rows[0]?.normalised?.worker.needsPayDetails).toBe(true);
    expect(result.rows[0]?.normalised?.payRate).toBeNull();
    expect(result.fileNotes).toHaveLength(2);
    expect(result.columns.missingOptional).toContain("bank_account_number");
  });

  it("skips blank rows but keeps spreadsheet row numbers", () => {
    const t = table(rows({}, {}));
    t.splice(
      2,
      0,
      TEMPLATE_COLUMNS.map(() => ""),
    );
    const result = validateImportTable(t, {});
    expect(result.ok && result.rows.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it("notes ignored columns and flags rows wider than the header", () => {
    const t = table(rows({}));
    t[0]?.push("Favourite colour");
    t[1]?.push("Blue", "extra");
    const result = validateImportTable(t, {});
    if (!result.ok) throw new Error("failed");
    expect(result.fileNotes[0]).toBe(
      "1 column is not in the template and will be ignored: Favourite colour.",
    );
    expect(codes(row(result, 2))).toEqual(["row_too_wide"]);
  });
});

describe("single-row checks", () => {
  it("lists required values that are blank", () => {
    const result = check(rows({ first_name: "", start_date: "" }));
    expect(row(result, 2).problems.map((p) => p.message)).toEqual([
      "First name is blank.",
      "Start date is blank.",
    ]);
  });

  it("checks phone, email, employment type, dates and NHF", () => {
    const result = check(
      rows(
        { phone: "0803111" },
        { email: "kola@" },
        { employment_type: "Full time" },
        { start_date: "31/02/2024" },
        { nhf_opt_in: "maybe" },
      ),
    );
    expect(row(result, 2).problems[0]?.message).toBe(
      "Phone is not a Nigerian mobile number. Use 11 digits starting 070, 080, 081, 090 or 091.",
    );
    expect(row(result, 3).problems[0]).toMatchObject({
      code: "email_invalid",
      fix: { label: "Leave email blank", patch: { email: "" } },
    });
    expect(row(result, 4).problems[0]?.message).toBe(
      'Employment type "Full time" is not one of Permanent, Contract, Casual or Daily.',
    );
    expect(row(result, 5).problems[0]?.message).toBe(
      'Start date "31/02/2024" is not a date. Use YYYY-MM-DD, for example 2024-03-01.',
    );
    expect(codes(row(result, 6))).toEqual(["yes_no_invalid"]);
  });

  it("never shows NIN or bank account digits in a message", () => {
    const result = check(rows({ nin: "1234567890", bank_account_number: "98765432" }));
    const r = row(result, 2);
    expect(r.problems.map((p) => p.message)).toEqual([
      "NIN has 10 digits; NINs have 11.",
      "Bank account number has 8 digits; NUBAN numbers have 10.",
    ]);
    expect(r.problems.map((p) => p.fix?.label)).toEqual([
      "Leave NIN blank for now",
      "Mark for HR to fix",
    ]);
    for (const problem of r.problems) expect(problem.message).not.toMatch(/\d{5,}/);
  });

  it("allows only plain text in names", () => {
    const result = check(rows({ first_name: "<b>Kola</b>", job_title: "See www.example.com" }));
    expect(row(result, 2).problems.map((p) => p.message)).toEqual([
      "First name must be plain text, without < or >.",
      "Job title can't contain a web address.",
    ]);
  });

  it("caps cell length", () => {
    const result = check(rows({ job_title: "x".repeat(201) }));
    expect(row(result, 2).problems[0]?.message).toBe("Job title is longer than 200 characters.");
  });

  it("normalises the worker", () => {
    const result = check(
      rows({
        phone: "+234 803 111 0001",
        email: "Kola@Example.COM",
        rsa_pin: "pen 100000000001",
        nhf_opt_in: "Yes",
        annual_rent_declared: "1,200,000.50",
        bank_account_number: "0123-456-789",
        nin: "123 4567 8901",
        next_of_kin_phone: "8031230000",
      }),
    );
    expect(row(result, 2).normalised?.worker).toMatchObject({
      phone: "08031110001",
      email: "kola@example.com",
      rsaPin: "PEN100000000001",
      nhfOptIn: true,
      annualRentDeclaredKobo: 120_000_050n,
      currency: "NGN",
      bankAccountNumber: "0123456789",
      nin: "12345678901",
      nextOfKinPhone: "08031230000",
      needsPayDetails: false,
      supervisorClockIn: false,
    });
  });
});

describe("pay checks", () => {
  it("builds a monthly pay rate in kobo from the start date", () => {
    const result = check(rows({ basic_monthly: "105,000.50", other_allowances_monthly: "" }));
    expect(row(result, 2).normalised?.payRate).toEqual({
      payType: "monthly",
      basicKobo: 10_500_050n,
      housingKobo: 6_300_000n,
      transportKobo: 4_200_000n,
      otherAllowancesKobo: 0n,
      dailyRateKobo: 0n,
      currency: "NGN",
      effectiveFrom: "2023-05-02",
    });
  });

  it("rejects amounts that are not plain naira", () => {
    const result = check(
      rows(
        { basic_monthly: "₦105,000" },
        { housing_monthly: "63000.505" },
        {
          daily_rate: "-1",
          pay_type: "Daily",
          basic_monthly: "",
          housing_monthly: "",
          transport_monthly: "",
          other_allowances_monthly: "",
        },
      ),
    );
    expect(row(result, 2).problems[0]?.message).toBe(
      'Basic monthly "₦105,000" is not a naira amount. Use digits like 105000, 105,000 or 105000.50.',
    );
    expect(codes(row(result, 3))).toEqual(["amount_invalid"]);
    expect(codes(row(result, 4))).toEqual(["amount_invalid"]);
  });

  it("flags missing pay as needs pay details, not a problem", () => {
    const blankMonthly = {
      basic_monthly: "",
      housing_monthly: "",
      transport_monthly: "",
      other_allowances_monthly: "",
    };
    const result = check(
      rows(
        { ...blankMonthly },
        { ...blankMonthly, pay_type: "" },
        { ...blankMonthly, pay_type: "Daily" },
      ),
    );
    expect(result.rows.map((r) => r.status)).toEqual(["ready", "ready", "ready"]);
    expect(result.rows.map((r) => r.warnings[0]?.message)).toEqual([
      "Needs pay details before payroll: basic pay is blank.",
      "Needs pay details before payroll: pay is blank.",
      "Needs pay details before payroll: daily rate is blank.",
    ]);
  });

  it("asks for a pay type when amounts are filled, suggesting the obvious one", () => {
    const result = check(
      rows(
        { pay_type: "" },
        {
          pay_type: "",
          basic_monthly: "",
          housing_monthly: "",
          transport_monthly: "",
          other_allowances_monthly: "",
          daily_rate: "8000",
        },
      ),
    );
    expect(row(result, 2).problems[0]).toMatchObject({
      code: "pay_type_missing",
      fix: { label: "Set pay type to Monthly", patch: { pay_type: "Monthly" } },
    });
    expect(row(result, 3).problems[0]?.fix?.label).toBe("Set pay type to Daily");
  });

  it("refuses mixed monthly and daily pay, and hourly pay", () => {
    const result = check(
      rows(
        { daily_rate: "8000" },
        { pay_type: "Daily", daily_rate: "8000" },
        { pay_type: "Hourly" },
        { pay_type: "Weekly" },
      ),
    );
    expect(row(result, 2).problems[0]?.fix).toEqual({
      label: "Clear the daily rate",
      patch: { daily_rate: "" },
    });
    expect(row(result, 3).problems[0]?.fix?.label).toBe("Clear the monthly amounts");
    expect(codes(row(result, 4))).toEqual(["pay_type_hourly"]);
    expect(row(result, 5).problems[0]?.message).toBe('Pay type "Weekly" is not Monthly or Daily.');
  });

  it("lists which bank details are missing", () => {
    const result = check(rows({ bank_name: "", account_name: "" }));
    expect(row(result, 2).warnings[0]?.message).toBe(
      "Needs pay details before payroll: bank name is blank; account name is blank.",
    );
  });
});

describe("staff IDs", () => {
  it("holds a repeated staff ID (ignoring case) and offers a new one", () => {
    const result = check(rows({ employee_id: "AFS-0009" }, { employee_id: "afs-0009" }));
    expect(row(result, 2).status).toBe("ready");
    expect(row(result, 3).problems[0]).toEqual({
      code: "staff_id_duplicate_in_file",
      column: "employee_id",
      message: "Staff ID afs-0009 is also on row 2. Each employee needs their own staff ID.",
      fix: { label: "Generate a new staff ID", patch: { employee_id: "" } },
    });
  });

  it("holds a staff ID that already exists in the account", () => {
    const result = check(rows({ employee_id: "AFS-0042" }), {
      existingWorkers: [
        {
          id: "w1",
          staffId: "AFS-0042",
          firstName: "Musa",
          lastName: "Ibrahim",
          phone: null,
          lineManagerStaffId: null,
        },
      ],
    });
    expect(row(result, 2).problems[0]?.message).toBe(
      "Staff ID AFS-0042 already belongs to Musa Ibrahim in your account.",
    );
  });

  it("generates blank staff IDs in the account's pattern", () => {
    const result = check(rows({ employee_id: "" }, { employee_id: "" }), {
      existingWorkers: [
        {
          id: "w1",
          staffId: "MO-0007",
          firstName: "A",
          lastName: "B",
          phone: null,
          lineManagerStaffId: null,
        },
        {
          id: "w2",
          staffId: "MO-0002",
          firstName: "C",
          lastName: "D",
          phone: null,
          lineManagerStaffId: null,
        },
      ],
    });
    expect(result.rows.map((r) => r.normalised?.worker.staffId)).toEqual(["MO-0008", "MO-0009"]);
    expect(result.rows[0]?.warnings[0]).toMatchObject({
      code: "staff_id_generated",
      attention: false,
    });
    expect(result.summary.generatedStaffIds).toBe(2);
  });

  it("defaults to EMP-0001 with no IDs anywhere", () => {
    expect(generateStaffIds([], 2)).toEqual(["EMP-0001", "EMP-0002"]);
    expect(generateStaffIds(["X-9", "EMP-0001", "EMP-0003"], 1)).toEqual(["EMP-0004"]);
    expect(generateStaffIds(["S99"], 1)).toEqual(["S100"]);
  });
});

describe("duplicate phones", () => {
  it("imports the repeat with supervisor clock-in pre-applied and lists it", () => {
    const result = check(rows({ phone: "08030001120" }, {}, { phone: "+2348030001120" }));
    const repeat = row(result, 4);
    expect(repeat.status).toBe("warning");
    expect(repeat.warnings[0]).toEqual({
      code: "duplicate_phone",
      column: "phone",
      message:
        "Phone 0803 ••• 1120 is also on row 2. Each worker needs their own phone to clock in.",
      attention: true,
      appliedFix: "Use supervisor clock-in",
    });
    expect(repeat.normalised?.worker.supervisorClockIn).toBe(true);
    expect(row(result, 2).normalised?.worker.supervisorClockIn).toBe(false);
    expect(result.summary).toMatchObject({
      ready: 2,
      needFixing: 1,
      held: 0,
      importable: 3,
      supervisorClockIn: 1,
    });
  });

  it("also checks phones already in the account", () => {
    const result = check(rows({ phone: "08030001120" }), {
      existingWorkers: [
        {
          id: "w1",
          staffId: "AFS-0900",
          firstName: "Musa",
          lastName: "Ibrahim",
          phone: "0803 000 1120",
          lineManagerStaffId: null,
        },
      ],
    });
    expect(row(result, 2).warnings[0]?.message).toBe(
      "Phone 0803 ••• 1120 already belongs to Musa Ibrahim (AFS-0900). Each worker needs their own phone to clock in.",
    );
  });
});

describe("line managers", () => {
  it("resolves staff IDs anywhere in the file (two passes), in the account, or a manager's email", () => {
    const result = check(
      rows(
        { line_manager_employee_id: "AFS-0003" },
        { line_manager_employee_id: "AFS-0100" },
        { line_manager_employee_id: "Adaeze@AdebayoFS.example" },
      ),
      {
        existingWorkers: [
          {
            id: "w100",
            staffId: "AFS-0100",
            firstName: "Emeka",
            lastName: "Nwankwo",
            phone: null,
            lineManagerStaffId: null,
          },
        ],
        managers: [
          { membershipId: "m1", email: "adaeze@adebayofs.example", name: "Adaeze Adebayo" },
        ],
      },
    );
    expect(result.rows.map((r) => r.normalised?.lineManager)).toEqual([
      { kind: "row", rowNumber: 4, staffId: "AFS-0003", name: "Kola Adebayo" },
      { kind: "worker", workerId: "w100", staffId: "AFS-0100", name: "Emeka Nwankwo" },
      {
        kind: "membership",
        membershipId: "m1",
        email: "adaeze@adebayofs.example",
        name: "Adaeze Adebayo",
      },
    ]);
    expect(result.summary.found.lineManagers).toBe(3);
  });

  it("holds unknown managers and suggests the usual one at the same site", () => {
    const result = check(
      rows(
        { first_name: "Kola", line_manager_employee_id: "" },
        { line_manager_employee_id: "AFS-0001" },
        { line_manager_employee_id: "AFS-0001" },
        { line_manager_employee_id: "AFS-0005", site: "Ikeja Depot" },
        { first_name: "Ngozi", line_manager_employee_id: "", site: "Ikeja Depot" },
        { line_manager_employee_id: "MO-0090" },
        { line_manager_employee_id: "nobody@example.com" },
      ),
    );
    expect(row(result, 7).problems[0]).toEqual({
      code: "line_manager_unknown",
      column: "line_manager_employee_id",
      message: "Line manager ID MO-0090 is not in the file or in your account.",
      fix: { label: "Set to Kola Adebayo", patch: { line_manager_employee_id: "AFS-0001" } },
    });
    expect(row(result, 8).problems[0]?.message).toBe(
      "Line manager nobody@example.com is not a user in your account.",
    );
  });

  it("refuses an employee managing themself", () => {
    const result = check(rows({ employee_id: "AFS-0001", line_manager_employee_id: "afs-0001" }));
    expect(codes(row(result, 2))).toEqual(["line_manager_self"]);
  });

  it("refuses loops, in the file and through the account", () => {
    const result = check(
      rows(
        { employee_id: "A-1", line_manager_employee_id: "A-2" },
        { employee_id: "A-2", line_manager_employee_id: "A-1" },
        { employee_id: "A-3", line_manager_employee_id: "A-1" },
        { employee_id: "B-1", line_manager_employee_id: "W-1" },
      ),
      {
        existingWorkers: [
          {
            id: "w1",
            staffId: "W-1",
            firstName: "Old",
            lastName: "Boss",
            phone: null,
            lineManagerStaffId: "B-1",
          },
        ],
      },
    );
    expect(row(result, 2).problems.map((p) => p.message)).toEqual([
      "Line managers form a loop: A-1 → A-2 → A-1. Choose a line manager outside the loop.",
    ]);
    expect(codes(row(result, 3))).toEqual(["line_manager_cycle"]);
    // Not in the loop, but its manager is held back.
    expect(codes(row(result, 4))).toEqual(["line_manager_held"]);
    expect(row(result, 5).problems[0]?.message).toBe(
      "Line managers form a loop: B-1 → W-1 → B-1. Choose a line manager outside the loop.",
    );
  });
});

describe("clients, projects and sites", () => {
  it("matches existing names ignoring case and spacing", () => {
    const result = check(rows({ client_company: "coastline  logistics" }), {
      clients: [{ id: "c1", name: "Coastline Logistics" }],
      projects: [{ id: "p1", clientId: "c1", name: "Coastline guarding contract" }],
      sites: [{ id: "s1", clientId: "c1", name: "Apapa Warehouse 3" }],
    });
    expect(row(result, 2).normalised?.mapping).toEqual({
      client: { kind: "existing", id: "c1", name: "Coastline Logistics" },
      project: { kind: "existing", id: "p1", name: "Coastline guarding contract" },
      site: { kind: "existing", id: "s1", name: "Apapa Warehouse 3" },
    });
    expect(result.summary.newNames.clients).toEqual([]);
  });

  it("holds a near miss of an existing client with a one-click match", () => {
    const result = check(rows({ client_company: "Coastline Logistic" }), {
      clients: [{ id: "c1", name: "Coastline Logistics" }],
    });
    expect(row(result, 2).problems).toEqual([
      {
        code: "client_not_found",
        column: "client_company",
        message: 'Client "Coastline Logistic" not found.',
        fix: {
          label: "Match to Coastline Logistics",
          patch: { client_company: "Coastline Logistics" },
        },
      },
    ]);
  });

  it("does not confuse sites that differ by a number or a letter", () => {
    const result = check(
      rows(
        { site: "Apapa Warehouse 3" },
        { site: "Apapa Warehouse 5" },
        { site: "Lekki Estate Gate A" },
        { site: "Lekki Estate Gate B" },
      ),
    );
    expect(result.summary.held).toBe(0);
    expect(result.summary.found.sites).toBe(4);
  });

  it("holds a near-miss project within its client", () => {
    const result = check(rows({}, {}, { project: "Coastline guarding contrct" }));
    expect(row(result, 4).problems[0]).toMatchObject({
      code: "project_not_found",
      message: 'Project "Coastline guarding contrct" not found for Coastline Logistics.',
      fix: { label: "Match to Coastline guarding contract" },
    });
  });

  it("needs a client for a site or project", () => {
    const result = check(rows({ client_company: "" }));
    expect(row(result, 2).problems[0]?.message).toBe(
      "Project is filled but client is blank. Add the client the project belongs to.",
    );
  });

  it("allows head office staff with no client, project or site", () => {
    const result = check(rows({ client_company: "", project: "", site: "" }));
    expect(row(result, 2).status).toBe("ready");
    expect(row(result, 2).normalised?.mapping).toEqual({ client: null, project: null, site: null });
  });

  it("reuses existing departments and lists new ones", () => {
    const result = check(
      rows({ department: "SECURITY SERVICES" }, { department: "Cleaning services" }),
      {
        departments: [{ id: "d1", name: "Security services" }],
      },
    );
    expect(row(result, 2).normalised?.department).toEqual({
      kind: "existing",
      id: "d1",
      name: "Security services",
    });
    expect(result.summary.newNames.departments).toEqual(["Cleaning services"]);
  });
});

describe("context", () => {
  it("is validated at the boundary", () => {
    expect(() =>
      validateImportTable(table(rows({})), { clients: [{ id: "", name: "X" }] }),
    ).toThrow();
  });
});

describe("staff ID format", () => {
  it.each([
    ["<a href=x>"],
    ["https://evil.example/x"],
    ["AFS\u00070042"],
    ["kola@example.com"],
    ["=HYPERLINK(1)"],
    ["AFS 0042"],
    ["АFS-0042"], // Cyrillic capital A
  ])("holds staff ID %j with a fix, without echoing it", (id) => {
    const result = check(rows({ employee_id: id }));
    const r = row(result, 2);
    expect(r.status).toBe("held");
    expect(r.problems).toEqual([
      {
        code: "staff_id_invalid",
        column: "employee_id",
        message:
          "Staff ID can only use letters, digits, dots, underscores, slashes and dashes, must start with a letter or digit, and can be at most 40 characters.",
        fix: { label: "Generate a new staff ID", patch: { employee_id: "" } },
      },
    ]);
    // An invalid ID is held, not silently replaced by a generated one.
    expect(r.warnings.map((w) => w.code)).not.toContain("staff_id_generated");
  });

  it("folds fullwidth lookalikes to ASCII, so they collide with the real ID", () => {
    const result = check(rows({ employee_id: "AFS-0042" }, { employee_id: "ＡＦＳ-００４２" }));
    expect(row(result, 3).problems[0]).toMatchObject({
      code: "staff_id_duplicate_in_file",
      message: "Staff ID AFS-0042 is also on row 2. Each employee needs their own staff ID.",
    });

    const existing = check(rows({ employee_id: "ＡＦＳ-０１００" }), {
      existingWorkers: [
        {
          id: "w100",
          staffId: "AFS-0100",
          firstName: "Emeka",
          lastName: "Nwankwo",
          phone: null,
          lineManagerStaffId: null,
        },
      ],
    });
    expect(codes(row(existing, 2))).toEqual(["staff_id_exists"]);
  });

  it("holds a line manager that is neither a staff ID nor an email, without echoing it", () => {
    const result = check(
      rows(
        {},
        { line_manager_employee_id: "AFS-0001" },
        { line_manager_employee_id: "<b>boss</b>" },
        { line_manager_employee_id: "=cmd|' /C calc'!A0" },
        { line_manager_employee_id: "not an@email" },
      ),
    );
    for (const rowNumber of [4, 5, 6]) {
      expect(row(result, rowNumber).problems[0]).toMatchObject({
        code: "staff_id_invalid",
        column: "line_manager_employee_id",
        message:
          "Line manager is not a staff ID or an email address. Use the manager's staff ID, or the email they sign in with.",
        // The usual manager at the same site is offered.
        fix: { label: "Set to Kola Adebayo", patch: { line_manager_employee_id: "AFS-0001" } },
      });
    }
  });

  it("resolves a fullwidth line manager ID to the row it matches", () => {
    const result = check(rows({}, { line_manager_employee_id: "ａｆｓ-０００１" }));
    expect(row(result, 3).normalised?.lineManager).toMatchObject({
      kind: "row",
      staffId: "AFS-0001",
    });
  });
});

describe("formula characters", () => {
  it.each(["=cmd|' /C calc'!A0", "+1 Kola", "-Kola", "@SUM(A1)"])(
    "holds text starting with a formula character: %j",
    (value) => {
      const result = check(rows({ first_name: value, site: value }));
      expect(row(result, 2).problems.map((p) => [p.column, p.message])).toEqual([
        ["first_name", "First name can't start with =, +, - or @. Remove the symbol at the start."],
        ["site", "Site can't start with =, +, - or @. Remove the symbol at the start."],
      ]);
    },
  );

  it("still allows those characters inside a value", () => {
    const result = check(rows({ job_title: "Guard - night", shift_pattern: "Day 06:00-18:00" }));
    expect(row(result, 2).status).toBe("ready");
  });
});

describe("RSA PIN, TIN and next of kin phone", () => {
  it("holds badly shaped values with a fix, never echoing them", () => {
    const result = check(
      rows({ rsa_pin: "PEN12345" }, { tin: "=1+1" }, { next_of_kin_phone: "12345" }),
    );
    expect(row(result, 2).problems).toEqual([
      {
        code: "rsa_pin_invalid",
        column: "rsa_pin",
        message: "RSA PIN must be PEN followed by 12 digits.",
        fix: { label: "Leave RSA PIN blank for now", patch: { rsa_pin: "" } },
      },
    ]);
    expect(row(result, 3).problems).toEqual([
      {
        code: "tin_invalid",
        column: "tin",
        message: "TIN can only hold digits and dashes, for example 12345678-0001.",
        fix: { label: "Leave TIN blank for now", patch: { tin: "" } },
      },
    ]);
    expect(row(result, 4).problems[0]).toMatchObject({
      code: "next_of_kin_phone_invalid",
      fix: { label: "Leave next of kin phone blank", patch: { next_of_kin_phone: "" } },
    });
    for (const r of result.rows) {
      for (const p of r.problems) expect(p.message).not.toMatch(/PEN12345|=1\+1|12345\b/);
    }
  });

  it("normalises TIN spacing", () => {
    const result = check(rows({ tin: " 20000001 - 0001 " }));
    expect(row(result, 2).normalised?.worker.tin).toBe("20000001-0001");
  });
});

describe("pay amounts: cap, zero and blanks", () => {
  it("accepts ₦1,000,000,000 and refuses anything above it (CSV)", () => {
    const result = check(
      rows(
        { basic_monthly: "1,000,000,000" },
        { basic_monthly: "1000000000.01" },
        { basic_monthly: "99999999999999999999999" },
        { annual_rent_declared: "100000000000000000" },
      ),
    );
    expect(row(result, 2).status).toBe("ready");
    expect(row(result, 2).normalised?.payRate?.basicKobo).toBe(100_000_000_000n);
    expect(row(result, 3).problems).toEqual([
      {
        code: "amount_too_large",
        column: "basic_monthly",
        message:
          "Basic monthly 1000000000.01 is more than we accept for one employee (₦1,000,000,000). Check the amount.",
        fix: null,
      },
    ]);
    expect(codes(row(result, 4))).toEqual(["amount_too_large"]);
    expect(codes(row(result, 5))).toEqual(["amount_too_large"]);
    expect(row(result, 5).problems[0]?.column).toBe("annual_rent_declared");
  });

  it("holds a monthly row whose basic is 0, saying 0 rather than blank", () => {
    const result = check(
      rows(
        {
          basic_monthly: "0",
          housing_monthly: "",
          transport_monthly: "",
          other_allowances_monthly: "",
        },
        { basic_monthly: "0.00" },
      ),
    );
    expect(row(result, 2).problems).toEqual([
      {
        code: "pay_amount_zero",
        column: "basic_monthly",
        message:
          "Basic monthly can't be 0 for Monthly pay. Fill the basic amount, or leave it blank to add pay after import.",
        fix: { label: "Leave basic pay blank for now", patch: { basic_monthly: "" } },
      },
    ]);
    // With allowances filled, clearing basic would only drop them: no one-click fix.
    expect(row(result, 3).problems).toEqual([
      {
        code: "pay_amount_zero",
        column: "basic_monthly",
        message: "Basic monthly can't be 0 for Monthly pay. Fill the basic amount.",
        fix: null,
      },
    ]);
  });

  it("holds a daily row whose daily rate is 0", () => {
    const result = check(
      rows({
        pay_type: "Daily",
        basic_monthly: "",
        housing_monthly: "",
        transport_monthly: "",
        other_allowances_monthly: "",
        daily_rate: "0",
      }),
    );
    expect(row(result, 2).problems[0]).toMatchObject({
      code: "pay_amount_zero",
      column: "daily_rate",
      fix: { label: "Leave daily rate blank for now", patch: { daily_rate: "" } },
    });
  });

  it("does not drop allowances silently when basic is blank", () => {
    const result = check(rows({ basic_monthly: "" }));
    expect(row(result, 2).status).toBe("held");
    expect(row(result, 2).problems).toEqual([
      {
        code: "pay_basic_missing",
        column: "basic_monthly",
        message: "Basic is blank but allowances are filled. Fill basic or clear the allowances.",
        fix: {
          label: "Clear the allowances",
          patch: { housing_monthly: "", transport_monthly: "", other_allowances_monthly: "" },
        },
      },
    ]);
  });

  it("still treats zero allowances as nothing filled", () => {
    const result = check(
      rows({
        basic_monthly: "",
        housing_monthly: "0",
        transport_monthly: "0",
        other_allowances_monthly: "",
      }),
    );
    expect(row(result, 2).status).toBe("ready");
    expect(row(result, 2).warnings[0]?.message).toBe(
      "Needs pay details before payroll: basic pay is blank.",
    );
  });
});
