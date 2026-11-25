import "server-only";

import { z } from "zod";

import { lagosToday } from "@/lib/dates";
import { canReadPay, PAYROLL_READERS } from "@/lib/pay-access";
import type { ModuleId } from "@/lib/modules";
import type { ManagerRole } from "@/lib/roles";
import { CLIENT_READERS } from "@/server/business/clients";
import { listClients } from "@/server/business/clients-data";
import { LIST_EXPORT_LIMIT, NotInList, idSet, idsSchema } from "@/server/identity/bulk-selection";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";
import { loadRemittances } from "@/server/payroll/remittance-data";
import { listRuns, loadRunDetail } from "@/server/payroll/run-data";
import { loadLeaveBoard } from "@/server/people/leave-data";
import { LEAVE_READERS } from "@/server/people/leave-requests";
import { listClientSites } from "@/server/sites/sites-data";
import { BOARD_READERS, loadAttendanceBoard } from "@/server/workforce/attendance-board";
import { loadPeriodDays } from "@/server/workforce/timesheet-bulk";
import { TIMESHEET_READERS } from "@/server/workforce/timesheets";

import {
  attendanceCsv,
  clientsCsv,
  exportFileName,
  leaveCsv,
  payslipsCsv,
  remittancesCsv,
  runsCsv,
  sitesCsv,
  timesheetsCsv,
} from "./csv";

/**
 * "Export selected to CSV" on the lists (slice U.2), one `mutate()` spec per list, run by the
 * route handler src/app/app/export/route.ts (as U.1's People export):
 *
 * - Who: each list's own readers, and each file is built from the caller's own reads, so it is
 *   scoped to their company and role (a line manager gets their reportees, the board and leave
 *   lists their own scope). A ticked id the caller can't read refuses the export (MLLB2).
 * - What: the fixed columns in ./csv.ts. Never NIN, BVN, bank or account numbers, RSA PIN,
 *   phones, locations, reasons, or anything decrypted. Pay amounts only in the payroll files,
 *   whose readers are owner, hr and finance (`canReadPay`); no other list carries pay.
 * - Audit: `<list>.exported` (or `payroll.<list>_exported`) with the count only, never names,
 *   ids or the file. Not registered as capabilities, as U.1's export: a file download is a
 *   person's step.
 */

export interface ListExport {
  fileName: string;
  csv: string;
  count: number;
}

const ids = idsSchema(LIST_EXPORT_LIMIT);

export const LIST_EXPORTS = [
  "clients",
  "sites",
  "attendance",
  "timesheets",
  "leave",
  "payroll_runs",
  "payslips",
  "remittances",
] as const;
export type ListExportName = (typeof LIST_EXPORTS)[number];

/** The rows of `rows` whose id was ticked, in the list's order; refuses an id not among them. */
export function pickRows<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  sent: readonly string[],
): T[] {
  const wanted = idSet(sent);
  const visible = idSet(rows.map(idOf));
  for (const id of wanted) if (!visible.has(id)) throw new NotInList();
  const picked = rows.filter((r) => wanted.has(idOf(r).toLowerCase()));
  if (picked.length === 0) {
    throw new MutationError("invalid", "Nothing to export.", { selection: "Nothing to export." });
  }
  return picked;
}

type Ctx = MutationContext & { role: ManagerRole };

function spec<S extends z.ZodType>(options: {
  list: ListExportName;
  schema: S;
  roles: readonly ManagerRole[];
  module?: ModuleId;
  audit: { action: string; entity: string };
  build: (ctx: Ctx & { data: z.output<S> }) => Promise<{ csv: string; count: number }>;
}): MutationSpec<S, ListExport> {
  return {
    schema: options.schema,
    roles: options.roles,
    ...(options.module ? { module: options.module } : {}),
    run: async (ctx) => {
      const built = await options.build({ ...ctx, role: ctx.role as ManagerRole });
      return { ...built, fileName: exportFileName(options.list.replace("_", "-"), lagosToday()) };
    },
    // The count only: never names, ids or the file.
    event: ({ result }) => ({
      action: options.audit.action,
      entity: options.audit.entity,
      after: { count: result.count },
    }),
  };
}

export const exportClientsSpec = spec({
  list: "clients",
  schema: z.object({ list: z.literal("clients"), ids }),
  roles: CLIENT_READERS,
  audit: { action: "clients.exported", entity: "clients" },
  build: async ({ supabase, organisationId, data }) => {
    const rows = pickRows(await listClients(supabase, organisationId), (r) => r.id, data.ids);
    return {
      csv: clientsCsv(
        rows.map((r) => ({
          name: r.name,
          status: r.status === "archived" ? "archived" : "active",
          needsDetails: r.needsDetails,
          siteCount: r.siteCount,
          sitesWithoutGeofence: r.sitesWithoutGeofence,
          activeContractCount: r.activeContractCount,
        })),
      ),
      count: rows.length,
    };
  },
});

export const exportSitesSpec = spec({
  list: "sites",
  schema: z.object({ list: z.literal("sites"), clientId: z.uuid("Choose a client"), ids }),
  roles: CLIENT_READERS,
  audit: { action: "sites.exported", entity: "sites" },
  build: async ({ supabase, organisationId, data }) => {
    const { data: client, error } = await supabase
      .from("clients")
      .select("name")
      .eq("organisation_id", organisationId)
      .eq("id", data.clientId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the client (${error.code})`);
    if (!client) throw new NotInList();
    const sites = await listClientSites(supabase, organisationId, data.clientId);
    const rows = pickRows(sites, (s) => s.id, data.ids);
    return {
      csv: sitesCsv(
        rows.map((s) => ({
          name: s.name,
          clientName: client.name,
          address: s.address,
          state: s.state,
          geofence: s.geofence,
          radiusM: s.radiusM,
          checkpointCount: s.checkpointCount,
          status: s.status,
          needsDetails: s.needsDetails,
        })),
      ),
      count: rows.length,
    };
  },
});

export const exportAttendanceSpec = spec({
  list: "attendance",
  schema: z.object({ list: z.literal("attendance"), ids }),
  roles: BOARD_READERS,
  module: "shifts",
  audit: { action: "attendance.exported", entity: "shift_assignments" },
  build: async ({ supabase, organisationId, data }) => {
    const board = await loadAttendanceBoard(supabase, organisationId);
    const rows = pickRows(board.rows, (r) => r.assignmentId, data.ids);
    return { csv: attendanceCsv(rows, board.timeZone), count: rows.length };
  },
});

export const exportTimesheetsSpec = spec({
  list: "timesheets",
  schema: z.object({
    list: z.literal("timesheets"),
    period: z.iso.date("Choose a period"),
    ids,
  }),
  roles: TIMESHEET_READERS,
  module: "people",
  audit: { action: "timesheets.exported", entity: "timesheet_lines" },
  build: async ({ supabase, organisationId, data }) => {
    const { timeZone, days } = await loadPeriodDays(supabase, organisationId, data.period);
    const rows = pickRows(days, (d) => d.id, data.ids);
    return { csv: timesheetsCsv(rows, timeZone), count: rows.length };
  },
});

export const exportLeaveSpec = spec({
  list: "leave",
  schema: z.object({ list: z.literal("leave"), ids }),
  roles: LEAVE_READERS,
  module: "people",
  audit: { action: "leave.exported", entity: "leave_requests" },
  build: async ({ supabase, organisationId, data }) => {
    const board = await loadLeaveBoard(supabase, organisationId, lagosToday());
    const rows = pickRows(board.requests, (r) => r.id, data.ids);
    return {
      csv: leaveCsv(
        rows.map((r) => ({
          workerName: r.workerName,
          staffId: r.staffId,
          departmentName: r.departmentName,
          leaveTypeName: r.leaveTypeName,
          startDate: r.startDate,
          endDate: r.endDate,
          days: r.days,
          status: r.status,
          lineManagerStep: r.lineManagerStep?.decision ?? null,
          hrStep: r.hrStep?.decision ?? null,
        })),
      ),
      count: rows.length,
    };
  },
});

export const exportPayrollRunsSpec = spec({
  list: "payroll_runs",
  schema: z.object({ list: z.literal("payroll_runs"), ids }),
  roles: PAYROLL_READERS,
  module: "payroll",
  audit: { action: "payroll.runs_exported", entity: "payroll_runs" },
  build: async ({ supabase, organisationId, role, data }) => {
    const rows = pickRows(await listRuns(supabase, organisationId), (r) => r.id, data.ids);
    return {
      csv: runsCsv(
        rows.map((r) => ({
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          payDate: r.payDate,
          kind: r.kind,
          status: r.status,
          discarded: r.discardedAt !== null,
          workerCount: r.totals.workerCount,
          grossKobo: r.totals.grossKobo,
          payeKobo: r.totals.payeKobo,
          pensionEmployeeKobo: r.totals.pensionEmployeeKobo,
          nhfKobo: r.totals.nhfKobo,
          otherDeductionsKobo: r.totals.otherDeductionsKobo,
          netKobo: r.totals.netKobo,
          employerCostKobo: r.totals.employerCostKobo,
        })),
        { pay: canReadPay(role) },
      ),
      count: rows.length,
    };
  },
});

export const exportPayslipsSpec = spec({
  list: "payslips",
  schema: z.object({ list: z.literal("payslips"), runId: z.uuid("Choose a run"), ids }),
  roles: PAYROLL_READERS,
  module: "payroll",
  audit: { action: "payroll.payslips_exported", entity: "payslips" },
  build: async ({ supabase, organisationId, role, data }) => {
    const detail = await loadRunDetail(supabase, organisationId, data.runId);
    if (!detail) throw new NotInList();
    const payslips = [...detail.payslips].sort((a, b) => a.workerName.localeCompare(b.workerName));
    const rows = pickRows(payslips, (p) => p.id, data.ids);
    return {
      csv: payslipsCsv(
        rows.map((p) => ({
          workerName: p.workerName,
          staffId: p.staffId,
          jobTitle: p.jobTitle,
          grossKobo: p.grossKobo,
          payeKobo: p.payeKobo,
          pensionEmployeeKobo: p.pensionEmployeeKobo,
          nhfKobo: p.nhfKobo,
          otherDeductionsKobo: p.otherDeductionsKobo,
          netKobo: p.netKobo,
        })),
        { pay: canReadPay(role) },
      ),
      count: rows.length,
    };
  },
});

export const exportRemittancesSpec = spec({
  list: "remittances",
  schema: z.object({ list: z.literal("remittances"), ids }),
  roles: PAYROLL_READERS,
  module: "payroll",
  audit: { action: "payroll.remittances_exported", entity: "statutory_remittances" },
  build: async ({ supabase, organisationId, role, data }) => {
    const runs = await loadRemittances(supabase, organisationId, lagosToday(), { allRuns: true });
    const all = runs.flatMap((run) => run.remittances.map((r) => ({ run, r })));
    const rows = pickRows(all, (x) => x.r.id, data.ids);
    return {
      csv: remittancesCsv(
        rows.map(({ run, r }) => ({
          runPeriodStart: run.periodStart,
          runPeriodEnd: run.periodEnd,
          kind: r.kind,
          authorityName: r.authorityName,
          workerCount: r.workerCount,
          amountKobo: r.amountKobo,
          offsetsInKobo: r.offsetsInKobo,
          outstandingKobo: r.outstandingKobo,
          dueDate: r.dueDate,
          status: r.status,
          voided: r.runVoid !== null,
          paidOn: r.payment?.paidOn ?? null,
          paidAmountKobo: r.payment?.paidAmountKobo ?? null,
        })),
        { pay: canReadPay(role) },
      ),
      count: rows.length,
    };
  },
});

/** The spec for a list's export (each one validates its own input). */
export function listExportSpec(list: ListExportName): MutationSpec<z.ZodType, ListExport> {
  return pick(list) as unknown as MutationSpec<z.ZodType, ListExport>;
}

function pick(list: ListExportName) {
  switch (list) {
    case "clients":
      return exportClientsSpec;
    case "sites":
      return exportSitesSpec;
    case "attendance":
      return exportAttendanceSpec;
    case "timesheets":
      return exportTimesheetsSpec;
    case "leave":
      return exportLeaveSpec;
    case "payroll_runs":
      return exportPayrollRunsSpec;
    case "payslips":
      return exportPayslipsSpec;
    case "remittances":
      return exportRemittancesSpec;
  }
}
