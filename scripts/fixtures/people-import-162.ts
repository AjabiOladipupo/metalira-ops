/**
 * Deterministic data for `fixtures/people-import-162.csv` and `.xlsx` (slice 1.4).
 *
 * Every name, phone, account number, NIN, TIN and RSA PIN here is made up. Phones use a fixed
 * pattern, account numbers and NINs come from simple arithmetic on the row index, and the
 * company domain is `.example`.
 *
 * 162 employee rows (spreadsheet rows 2 to 163) for "Adebayo Facility Services":
 * 4 departments, 14 line managers, 3 clients, 4 projects and 5 sites. Exactly four rows need
 * attention, as on the Setup board:
 *   row 23  line manager MO-0090 is not in the file           (held back)
 *   row 57  bank account number has 9 digits                  (held back)
 *   row 88  phone repeated from row 12                        (imports with supervisor clock-in)
 *   row 140 client "Coastline Logistic"                       (held back)
 * Plus warnings that don't need attention: rows 152 and 162 leave the staff ID blank (generated),
 * rows 102, 122 and 132 are missing pay or bank details (imported, flagged for payroll).
 */

export const PEOPLE_IMPORT_COLUMNS = [
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

export type FixtureColumn = (typeof PEOPLE_IMPORT_COLUMNS)[number];
export type FixtureRow = Record<FixtureColumn, string>;

/** Money columns, written as numbers in the .xlsx copy. */
export const FIXTURE_MONEY_COLUMNS: readonly FixtureColumn[] = [
  "basic_monthly",
  "housing_monthly",
  "transport_monthly",
  "other_allowances_monthly",
  "daily_rate",
  "annual_rent_declared",
];

/** Date columns, written as date cells in the .xlsx copy. */
export const FIXTURE_DATE_COLUMNS: readonly FixtureColumn[] = ["start_date"];

const DOMAIN = "adebayofs.example";

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const staffId = (index: number) => `AFS-${pad(index + 1, 4)}`;

interface Pay {
  type: "Monthly" | "Daily";
  basic?: string;
  housing?: string;
  transport?: string;
  other?: string;
  daily?: string;
}

interface Person {
  first: string;
  last: string;
  job: string;
  department: string;
  manager: string;
  client?: string;
  project?: string;
  site?: string;
  shift: string;
  employment: string;
  pay: Pay;
  email?: string;
}

const COASTLINE = {
  client: "Coastline Logistics",
  project: "Coastline guarding contract",
};
const GREENFIELD = { client: "Greenfield Estates" };
const MARINA = { client: "Marina Holdings", project: "VI Tower refit clean", site: "VI Tower" };

const MANAGERS: Person[] = [
  {
    first: "Emeka",
    last: "Nwankwo",
    job: "Operations manager",
    department: "Head office",
    manager: "",
    shift: "Office 08:00-17:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "450,000", housing: "270,000", transport: "180,000", other: "50,000" },
  },
  {
    first: "Folake",
    last: "Adeyemi",
    job: "HR manager",
    department: "Head office",
    manager: "",
    shift: "Office 08:00-17:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "380000", housing: "228000", transport: "152000", other: "40000" },
  },
  {
    first: "Kola",
    last: "Adebayo",
    job: "Site supervisor",
    department: "Security services",
    manager: staffId(0),
    ...COASTLINE,
    site: "Apapa Warehouse 3",
    shift: "Day 06:00-18:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "105000", housing: "63000", transport: "42000", other: "15000" },
  },
  {
    first: "Tunde",
    last: "Bakare",
    job: "Supervisor",
    department: "Security services",
    manager: staffId(0),
    ...GREENFIELD,
    project: "Greenfield guarding contract",
    site: "Lekki Estate Gate B",
    shift: "Day 06:00-18:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "98000", housing: "58800", transport: "39200", other: "14000" },
  },
  {
    first: "Blessing",
    last: "Udo",
    job: "Cleaning supervisor",
    department: "Cleaning services",
    manager: staffId(0),
    ...MARINA,
    shift: "Day 06:00-14:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "90000", housing: "54000", transport: "36000", other: "10000" },
  },
  {
    first: "Ibrahim",
    last: "Sule",
    job: "Site supervisor",
    department: "Security services",
    manager: staffId(0),
    ...COASTLINE,
    site: "Ikeja Depot",
    shift: "Day 06:00-18:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "100000", housing: "60000", transport: "40000", other: "12000" },
  },
  {
    first: "Ngozi",
    last: "Eze",
    job: "Facility supervisor",
    department: "Facility management",
    manager: staffId(0),
    ...GREENFIELD,
    project: "Greenfield facility upkeep",
    site: "Lekki Estate Clubhouse",
    shift: "Day 08:00-17:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "110000", housing: "66000", transport: "44000", other: "15000" },
  },
  {
    first: "Yusuf",
    last: "Bello",
    job: "Shift lead",
    department: "Security services",
    manager: staffId(2),
    ...COASTLINE,
    site: "Apapa Warehouse 3",
    shift: "Night 18:00-06:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "80000", housing: "48000", transport: "32000", other: "8000" },
  },
  {
    first: "Chinedu",
    last: "Okafor",
    job: "Shift lead",
    department: "Security services",
    manager: staffId(5),
    ...COASTLINE,
    site: "Ikeja Depot",
    shift: "Night 18:00-06:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "80000", housing: "48000", transport: "32000", other: "8000" },
  },
  {
    first: "Aisha",
    last: "Mohammed",
    job: "Shift lead",
    department: "Security services",
    manager: staffId(3),
    ...GREENFIELD,
    project: "Greenfield guarding contract",
    site: "Lekki Estate Gate B",
    shift: "Day 06:00-18:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "80000", housing: "48000", transport: "32000", other: "8000" },
  },
  {
    first: "Grace",
    last: "Okon",
    job: "Cleaning team lead",
    department: "Cleaning services",
    manager: staffId(4),
    ...MARINA,
    shift: "Day 06:00-14:00",
    employment: "Contract",
    pay: { type: "Monthly", basic: "60000", housing: "36000", transport: "24000", other: "5000" },
  },
  {
    first: "Samuel",
    last: "Etim",
    job: "Facility team lead",
    department: "Facility management",
    manager: staffId(6),
    ...GREENFIELD,
    project: "Greenfield facility upkeep",
    site: "Lekki Estate Clubhouse",
    shift: "Day 08:00-17:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "85000", housing: "51000", transport: "34000", other: "6000" },
  },
  {
    first: "Uche",
    last: "Nnamdi",
    job: "Cleaning team lead",
    department: "Cleaning services",
    manager: staffId(4),
    ...MARINA,
    shift: "Night 22:00-06:00",
    employment: "Contract",
    pay: { type: "Monthly", basic: "60000", housing: "36000", transport: "24000", other: "5000" },
  },
  {
    first: "Bola",
    last: "Ogunleye",
    job: "Shift lead",
    department: "Security services",
    manager: staffId(3),
    ...GREENFIELD,
    project: "Greenfield guarding contract",
    site: "Lekki Estate Gate B",
    shift: "Night 18:00-06:00",
    employment: "Permanent",
    pay: { type: "Monthly", basic: "80000", housing: "48000", transport: "32000", other: "8000" },
  },
];

interface Team {
  department: string;
  jobs: readonly string[];
  client?: string;
  project?: string;
  site?: string;
  managers: readonly string[];
  shifts: readonly string[];
  employment: readonly string[];
  pay: readonly Pay[];
}

const TEAMS: Record<string, Team> = {
  apapa: {
    department: "Security services",
    jobs: ["Security guard"],
    ...COASTLINE,
    site: "Apapa Warehouse 3",
    // Kola Adebayo (AFS-0003) leads most Apapa guards, so he is the suggested fix for row 23.
    managers: [staffId(2), staffId(2), staffId(7)],
    shifts: ["Day 06:00-18:00", "Night 18:00-06:00"],
    employment: ["Permanent", "Permanent", "Permanent", "Permanent", "Contract"],
    pay: [
      { type: "Monthly", basic: "60000", housing: "36000", transport: "24000", other: "0" },
      { type: "Monthly", basic: "60,000", housing: "36,000", transport: "24,000", other: "" },
      { type: "Monthly", basic: "62500.50", housing: "37500", transport: "25000", other: "0" },
    ],
  },
  ikeja: {
    department: "Security services",
    jobs: ["Security guard"],
    ...COASTLINE,
    site: "Ikeja Depot",
    managers: [staffId(5), staffId(8)],
    shifts: ["Day 06:00-18:00", "Night 18:00-06:00"],
    employment: ["Permanent", "Contract"],
    pay: [{ type: "Monthly", basic: "60000", housing: "36000", transport: "24000", other: "0" }],
  },
  gateB: {
    department: "Security services",
    jobs: ["Security guard"],
    ...GREENFIELD,
    project: "Greenfield guarding contract",
    site: "Lekki Estate Gate B",
    managers: [staffId(3), staffId(9), staffId(13)],
    shifts: ["Day 06:00-18:00", "Night 18:00-06:00"],
    employment: ["Permanent"],
    pay: [{ type: "Monthly", basic: "65,000", housing: "39,000", transport: "26,000", other: "2,500" }],
  },
  viTower: {
    department: "Cleaning services",
    jobs: ["Cleaner", "Cleaner, day shift"],
    ...MARINA,
    managers: [staffId(10), staffId(12), staffId(4)],
    shifts: ["Day 06:00-14:00", "Night 22:00-06:00"],
    employment: ["Contract"],
    pay: [{ type: "Monthly", basic: "42500", housing: "25500", transport: "17000", other: "0" }],
  },
  clubhouse: {
    department: "Facility management",
    jobs: ["Maintenance technician", "Electrician", "Plumber"],
    ...GREENFIELD,
    project: "Greenfield facility upkeep",
    site: "Lekki Estate Clubhouse",
    managers: [staffId(11), staffId(6)],
    shifts: ["Day 08:00-17:00"],
    employment: ["Permanent"],
    pay: [{ type: "Monthly", basic: "75000", housing: "45000", transport: "30000", other: "5000.50" }],
  },
  relief: {
    department: "Security services",
    jobs: ["Relief guard"],
    ...COASTLINE,
    site: "Apapa Warehouse 3",
    managers: [staffId(2)],
    shifts: ["Relief pool"],
    employment: ["Casual", "Daily"],
    pay: [
      { type: "Daily", daily: "8000" },
      { type: "Daily", daily: "8,500" },
    ],
  },
  headOffice: {
    department: "Head office",
    jobs: ["Accounts officer", "HR officer", "Driver", "Admin assistant"],
    managers: [staffId(1)],
    shifts: ["Office 08:00-17:00"],
    employment: ["Permanent"],
    pay: [{ type: "Monthly", basic: "85000", housing: "51000", transport: "34000", other: "10000" }],
  },
};

/** Which team each generic row joins, by `index % 20`. */
const SLOTS: readonly (keyof typeof TEAMS)[] = [
  "apapa", "apapa", "ikeja", "gateB", "viTower", "viTower", "apapa", "ikeja", "gateB", "clubhouse",
  "viTower", "apapa", "relief", "gateB", "ikeja", "viTower", "headOffice", "clubhouse", "apapa", "gateB",
];

const FIRST_NAMES = [
  "Adamu", "Adaobi", "Ahmed", "Amaka", "Bayo", "Bisi", "Chidi", "Chioma", "Dayo", "Ebere",
  "Efosa", "Femi", "Funmi", "Gbenga", "Hadiza", "Ifeanyi", "Ijeoma", "Jide", "Kemi", "Kunle",
  "Ladi", "Lola", "Musa", "Nkechi", "Obinna", "Ronke", "Segun", "Sade", "Tobi", "Zainab",
  "Abubakar", "Nneka", "Olumide", "Patience", "Rasheed", "Tope", "Victor", "Wale", "Yemi",
];
const LAST_NAMES = [
  "Abiodun", "Adekunle", "Afolabi", "Akande", "Aliyu", "Babatunde", "Danladi", "Ekwueme",
  "Eze", "Fashola", "Garba", "Ibekwe", "Idowu", "Jimoh", "Lawal", "Mbah", "Nwosu", "Obi",
  "Odukoya", "Ogbonna", "Okeke", "Olatunji", "Onyeka", "Salami", "Tijani", "Usman", "Yakubu",
];
const BANKS = ["GTBank", "Access Bank", "Zenith Bank", "First Bank", "UBA", "Moniepoint MFB", "Opay"];
const PFAS = [
  "Stanbic IBTC Pension",
  "ARM Pension",
  "Leadway Pensure",
  "Premium Pension",
  "Crusader Sterling Pensions",
];
const PHONE_PREFIXES = ["0803", "0706", "0813", "0905", "0916", "0810", "0802", "0708"];

/** The phone shared by rows 12 and 88 (masked as 0803 ••• 1120). */
const SHARED_PHONE = "08030001120";

function phoneFor(index: number): string {
  if (index === 10 || index === 86) return SHARED_PHONE; // rows 12 and 88
  return `${PHONE_PREFIXES[index % PHONE_PREFIXES.length]}4${pad(index + 1, 6)}`;
}

function startDate(index: number): string {
  const year = 2019 + (index % 7);
  const month = 1 + ((index * 5) % 12);
  const day = 1 + ((index * 7) % 28);
  return `${year}-${pad(month, 2)}-${pad(day, 2)}`;
}

function genericPerson(index: number, counters: Map<string, number>): Person {
  const slot = SLOTS[index % SLOTS.length] ?? "apapa";
  const team = TEAMS[slot] as Team;
  const n = counters.get(slot) ?? 0;
  counters.set(slot, n + 1);
  const first = FIRST_NAMES[(index * 7) % FIRST_NAMES.length] ?? "Ade";
  const last = LAST_NAMES[(index * 11) % LAST_NAMES.length] ?? "Bello";
  return {
    first,
    last,
    job: team.jobs[n % team.jobs.length] ?? "",
    department: team.department,
    manager: team.managers[n % team.managers.length] ?? "",
    client: team.client,
    project: team.project,
    site: team.site,
    shift: team.shifts[n % team.shifts.length] ?? "",
    employment: team.employment[n % team.employment.length] ?? "Permanent",
    pay: team.pay[n % team.pay.length] as Pay,
    email: index % 4 === 0 ? `${first}.${last}${index}@mail.example`.toLowerCase() : undefined,
  };
}

export function buildPeopleImport162(): FixtureRow[] {
  const counters = new Map<string, number>();
  const rows: FixtureRow[] = [];
  for (let index = 0; index < 162; index += 1) {
    const person = index < MANAGERS.length ? (MANAGERS[index] as Person) : genericPerson(index, counters);
    const isManager = index < MANAGERS.length;
    const daily = person.pay.type === "Daily";
    const row: FixtureRow = {
      employee_id: staffId(index),
      first_name: person.first,
      last_name: person.last,
      phone: phoneFor(index),
      email: isManager ? `${person.first}.${person.last}@${DOMAIN}`.toLowerCase() : (person.email ?? ""),
      job_title: person.job,
      department: person.department,
      employment_type: person.employment,
      start_date: startDate(index),
      line_manager_employee_id: person.manager,
      client_company: person.client ?? "",
      project: person.project ?? "",
      site: person.site ?? "",
      shift_pattern: person.shift,
      pay_type: person.pay.type,
      basic_monthly: person.pay.basic ?? "",
      housing_monthly: person.pay.housing ?? "",
      transport_monthly: person.pay.transport ?? "",
      other_allowances_monthly: person.pay.other ?? "",
      daily_rate: person.pay.daily ?? "",
      bank_name: BANKS[index % BANKS.length] ?? "",
      bank_account_number: `2${pad((index * 7919 + 1234) % 1_000_000_000, 9)}`,
      account_name: `${person.first} ${person.last}`,
      nin: index % 9 === 0 ? "" : `7${pad((index * 104729 + 5) % 10_000_000_000, 10)}`,
      tin: index % 3 === 0 ? `2${pad(index + 1, 7)}-0001` : "",
      tax_state: index % 11 === 0 ? "Ogun" : "Lagos",
      pfa_name: daily ? "" : (PFAS[index % PFAS.length] ?? ""),
      rsa_pin: daily ? "" : `PEN${pad(100_000_000_000 + index, 12)}`,
      nhf_opt_in: index % 4 === 0 ? "Y" : "N",
      annual_rent_declared: daily ? "" : index % 3 === 0 ? "600,000" : index % 3 === 1 ? "360000" : "",
      next_of_kin_name: index % 5 === 4 ? "" : `${FIRST_NAMES[(index * 3 + 1) % FIRST_NAMES.length]} ${person.last}`,
      next_of_kin_phone: index % 5 === 4 ? "" : `0807${pad(index + 1, 7)}`,
    };
    rows.push(row);
  }

  // The four rows from the Setup board.
  const at = (rowNumber: number) => rows[rowNumber - 2] as FixtureRow;
  at(23).line_manager_employee_id = "MO-0090";
  at(57).bank_account_number = at(57).bank_account_number.slice(1); // 9 digits
  // Row 88 shares row 12's phone through phoneFor().
  at(140).client_company = "Coastline Logistic";

  // Warnings that don't need attention.
  at(152).employee_id = "";
  at(162).employee_id = "";
  at(102).bank_name = "";
  at(102).bank_account_number = "";
  at(102).account_name = "";
  for (const key of ["basic_monthly", "housing_monthly", "transport_monthly", "other_allowances_monthly"] as const) {
    at(122)[key] = "";
    at(132)[key] = "";
  }
  at(132).pay_type = "";
  at(132).bank_name = "";
  at(132).bank_account_number = "";
  at(132).account_name = "";
  return rows;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV with a header row, LF line endings (the repo stores text as LF) and a final line break. */
export function toCsv(rows: readonly FixtureRow[]): string {
  const lines = [PEOPLE_IMPORT_COLUMNS.join(",")];
  for (const row of rows) lines.push(PEOPLE_IMPORT_COLUMNS.map((key) => csvCell(row[key])).join(","));
  return `${lines.join("\n")}\n`;
}
