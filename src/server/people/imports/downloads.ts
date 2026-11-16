import { TEMPLATE_COLUMNS } from "../import/columns";
import { formatCsv } from "../import/csv";

/**
 * The two CSV downloads of the import screens. Both go through `formatCsv()`, which escapes
 * cells that a spreadsheet app would run as formulas (src/server/README.md).
 */

/** The empty template: the 32 columns of fixtures/employee_import_template.csv. */
export function importTemplateCsv(): string {
  return formatCsv([[...TEMPLATE_COLUMNS]]);
}

export interface ProblemRowInput {
  rowNumber: number;
  staffId: string;
  name: string;
  status: string;
  problems: readonly { message: string; fixLabel: string | null }[];
  warnings: readonly { message: string; appliedFix: string | null }[];
}

export const PROBLEMS_HEADER = [
  "Row",
  "Staff ID",
  "Name",
  "Status",
  "Problem",
  "Suggested fix",
] as const;

/**
 * "Download problems (.csv)": one line per problem holding a row back, and one per warning
 * listed for attention on a row that imports. Messages never carry personal data (the
 * validator writes them that way), and the file holds nothing else from the row.
 */
export function importProblemsCsv(rows: readonly ProblemRowInput[]): string {
  const lines: string[][] = [[...PROBLEMS_HEADER]];
  for (const row of rows) {
    for (const problem of row.problems) {
      lines.push([
        String(row.rowNumber),
        row.staffId,
        row.name,
        "Held back",
        problem.message,
        problem.fixLabel ?? "",
      ]);
    }
    for (const warning of row.warnings) {
      lines.push([
        String(row.rowNumber),
        row.staffId,
        row.name,
        "Imports with the fix applied",
        warning.message,
        warning.appliedFix ?? "",
      ]);
    }
  }
  return formatCsv(lines);
}

/** A download name for the problems file, from the uploaded file's name. */
export function problemsFileName(uploadName: string): string {
  const base = uploadName
    .replace(/\.(csv|xlsx)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base.slice(0, 80) || "import"}-problems.csv`;
}
