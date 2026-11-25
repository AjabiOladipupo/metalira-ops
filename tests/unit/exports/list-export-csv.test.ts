/**
 * Slice U.2: "Export selected to CSV" on the other lists. Each file has fixed columns with no
 * personal data (NIN, BVN, bank or account numbers, RSA PIN, phones, locations, reasons), pay
 * appears only in the payroll files and only when the caller reads pay, and every cell is safe to
 * open in Excel (the shared csvCell: a cell starting with =, +, -, @, tab or CR, even after
 * leading spaces, opens as text).
 */
import { describe, expect, it } from "vitest";

import type { BoardRow } from "@/lib/attendance-board";
import {
  ATTENDANCE_EXPORT_COLUMNS,
  CLIENT_EXPORT_COLUMNS,
  LEAVE_EXPORT_COLUMNS,
  SITE_EXPORT_COLUMNS,
  TIMESHEET_EXPORT_COLUMNS,
  attendanceCsv,
  clientsCsv,
  exportFileName,
  leaveCsv,
  payslipExportColumns,
  payslipsCsv,
  remittanceExportColumns,
  remittancesCsv,
  runExportColumns,
  runsCsv,
  sitesCsv,
  timesheetsCsv,
  type PayslipExportRow,
  type RunExportRow,
} from "@/server/exports/csv";

const BOM = "﻿";

function lines(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true);
  return csv.slice(BOM.length).split("\r\n").filter(Boolean);
}

/** Words that must never be a column of any list's file. */
const PII = [
  "nin",
  "bvn",
  "bank",
  "account",
  "rsa",
  "pin",
  "phone",
  "location",
  "latitude",
  "longitude",
  "selfie",
  "reason",
  "note",
  "notes",
  "email",
  "tin",
];
/** Words that mean pay: only the payroll files carry them, and only with `pay`. */
const PAY = [
  "pay",
  "gross",
  "net",
  "paye",
  "salary",
  "rate",
  "amount",
  "naira",
  "kobo",
  "deductions",
  "pension",
  "nhf",
  "cost",
];

function words(columns: readonly string[]): string[] {
  return columns
    .join(" ")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

describe("list export columns", () => {
  it("never include personal data in any list's file", () => {
    const all = [
      CLIENT_EXPORT_COLUMNS,
      SITE_EXPORT_COLUMNS,
      ATTENDANCE_EXPORT_COLUMNS,
      TIMESHEET_EXPORT_COLUMNS,
      LEAVE_EXPORT_COLUMNS,
      runExportColumns(true),
      payslipExportColumns(true),
      remittanceExportColumns(true),
    ];
    for (const columns of all) {
      for (const word of PII) {
        expect(words(columns), `${columns.join(",")}: ${word}`).not.toContain(word);
      }
    }
  });

  it("never include pay in the non-payroll files", () => {
    for (const columns of [
      CLIENT_EXPORT_COLUMNS,
      SITE_EXPORT_COLUMNS,
      ATTENDANCE_EXPORT_COLUMNS,
      TIMESHEET_EXPORT_COLUMNS,
      LEAVE_EXPORT_COLUMNS,
    ]) {
      for (const word of PAY) {
        expect(words(columns), `${columns.join(",")}: ${word}`).not.toContain(word);
      }
    }
  });

  it("drops every amount from the payroll files without pay", () => {
    for (const columns of [
      runExportColumns(false),
      payslipExportColumns(false),
      remittanceExportColumns(false),
    ]) {
      for (const word of [
        "gross",
        "net",
        "paye",
        "amount",
        "pension",
        "nhf",
        "deductions",
        "cost",
      ]) {
        expect(words(columns), word).not.toContain(word);
      }
    }
    expect(runExportColumns(true)).toContain("Net pay");
    expect(payslipExportColumns(true)).toContain("Gross");
    expect(remittanceExportColumns(true)).toContain("Amount");
  });

  it("names the file after the list and the day", () => {
    expect(exportFileName("clients", "2026-11-25")).toBe("clients-2026-11-25.csv");
  });
});

describe("clients and sites", () => {
  it("writes counts and status, and escapes formulas even after leading spaces", () => {
    const [header, first] = lines(
      clientsCsv([
        {
          name: ' =HYPERLINK("http://x","y")',
          status: "active",
          needsDetails: true,
          siteCount: 3,
          sitesWithoutGeofence: 1,
          activeContractCount: 2,
        },
      ]),
    );
    expect(header).toBe(CLIENT_EXPORT_COLUMNS.join(","));
    expect(first).toBe(`"' =HYPERLINK(""http://x"",""y"")",Active,Needs details,3,1,2`);
  });

  it("writes one line per site with the address on one line", () => {
    const [, first] = lines(
      sitesCsv([
        {
          name: "Lekki gate",
          clientName: "Coastline",
          address: "12 Admiralty Way\nLekki Phase 1",
          state: "Lagos",
          geofence: "circle",
          radiusM: 150,
          checkpointCount: 4,
          status: "active",
          needsDetails: false,
        },
      ]),
    );
    expect(first).toBe(
      'Lekki gate,Coastline,"12 Admiralty Way, Lekki Phase 1",Lagos,150 m circle,4,Active',
    );
  });
});

describe("attendance", () => {
  const row: BoardRow = {
    assignmentId: "a1",
    shiftDate: "2026-11-25",
    startsAt: "2026-11-25T06:00:00Z",
    endsAt: "2026-11-25T18:00:00Z",
    siteId: "s1",
    siteName: "Lekki gate",
    postId: "p1",
    postName: "Gate A",
    workerId: "w1",
    workerName: "Ada Obi",
    staffId: "EMP-1",
    phone: "+2348012345678",
    phoneLast4: "5678",
    published: true,
    firstInAt: "2026-11-25T06:12:00Z",
    lastPunchKind: "in",
    lastPunchAt: "2026-11-25T06:12:00Z",
    flags: [],
    bySupervisor: false,
    status: "on_site",
    lateMinutes: 12,
    siteLastSyncAt: null,
    siteLateSyncs: 0,
  };

  it("never writes the phone, and times are in the company's zone", () => {
    const csv = attendanceCsv([row], "Africa/Lagos");
    expect(csv).not.toContain("8012345678");
    expect(csv).not.toContain("5678");
    const [, first] = lines(csv);
    expect(first).toBe(
      "Ada Obi,EMP-1,Lekki gate,Gate A,2026-11-25,07:00,19:00,On site,07:12,In 07:12,12,",
    );
  });
});

describe("timesheets and leave", () => {
  it("writes minutes, never money", () => {
    const [, first] = lines(
      timesheetsCsv(
        [
          {
            workerName: "Ada Obi",
            staffId: "EMP-1",
            workDate: "2026-11-24",
            siteName: "Lekki gate",
            postName: "Gate A",
            startsAt: "2026-11-24T06:00:00Z",
            endsAt: "2026-11-24T18:00:00Z",
            workedMinutes: 720,
            otMinutes: 30,
            lateMinutes: 0,
            earlyMinutes: 0,
            status: "approved",
            exceptions: [],
          },
        ],
        "Africa/Lagos",
      ),
    );
    expect(first).toBe(
      "Ada Obi,EMP-1,2026-11-24,Lekki gate,Gate A,07:00,19:00,720,30,0,0,Approved,",
    );
    expect(first).not.toContain("₦");
  });

  it("writes dates, type and status, never the reason", () => {
    const [header, first] = lines(
      leaveCsv([
        {
          workerName: "Ada Obi",
          staffId: "EMP-1",
          departmentName: null,
          leaveTypeName: "Annual",
          startDate: "2026-12-01",
          endDate: "2026-12-05",
          days: 5,
          status: "pending_hr",
          lineManagerStep: "approved",
          hrStep: null,
        },
      ]),
    );
    expect(header).toBe(LEAVE_EXPORT_COLUMNS.join(","));
    expect(first).toBe("Ada Obi,EMP-1,,Annual,2026-12-01,2026-12-05,5,With HR,Approved,");
  });
});

describe("payroll files", () => {
  const run: RunExportRow = {
    periodStart: "2026-10-20",
    periodEnd: "2026-11-19",
    payDate: "2026-11-25",
    kind: "regular",
    status: "approved",
    discarded: false,
    workerCount: 12,
    grossKobo: 64_231_250n,
    payeKobo: 1_000_000n,
    pensionEmployeeKobo: 500_000n,
    nhfKobo: 125_000n,
    otherDeductionsKobo: 0n,
    netKobo: 62_606_250n,
    employerCostKobo: 70_000_000n,
  };

  it("writes naira with two decimals from kobo (integer maths)", () => {
    const [header, first] = lines(runsCsv([run], { pay: true }));
    expect(header).toBe(runExportColumns(true).join(","));
    expect(first).toBe(
      "2026-10-20,2026-11-19,2026-11-25,Regular,Approved,12,642312.50,10000.00,5000.00,1250.00,0.00,626062.50,700000.00",
    );
    const [, noPay] = lines(runsCsv([run], { pay: false }));
    expect(noPay).toBe("2026-10-20,2026-11-19,2026-11-25,Regular,Approved,12");
  });

  it("writes payslips without bank or PIN details", () => {
    const slip: PayslipExportRow = {
      workerName: "Ada Obi",
      staffId: "EMP-1",
      jobTitle: "@guard",
      grossKobo: 15_000_000n,
      payeKobo: 50_000n,
      pensionEmployeeKobo: 120_000n,
      nhfKobo: 37_500n,
      otherDeductionsKobo: 0n,
      netKobo: 14_792_500n,
    };
    const [, first] = lines(payslipsCsv([slip], { pay: true }));
    expect(first).toBe("Ada Obi,EMP-1,'@guard,150000.00,500.00,1200.00,375.00,0.00,147925.00");
  });

  it("writes a remittance's payment date and amount, never its reference", () => {
    const [, first] = lines(
      remittancesCsv(
        [
          {
            runPeriodStart: "2026-10-20",
            runPeriodEnd: "2026-11-19",
            kind: "paye",
            authorityName: "Lagos",
            workerCount: 12,
            amountKobo: 1_000_000n,
            offsetsInKobo: 0n,
            outstandingKobo: 0n,
            dueDate: "2026-12-10",
            status: "paid",
            voided: false,
            paidOn: "2026-12-01",
            paidAmountKobo: 1_000_000n,
          },
        ],
        { pay: true },
      ),
    );
    expect(first).toBe(
      "2026-10-20,2026-11-19,PAYE,Lagos State IRS,12,2026-12-10,Paid,2026-12-01,10000.00,0.00,0.00,10000.00",
    );
  });
});
