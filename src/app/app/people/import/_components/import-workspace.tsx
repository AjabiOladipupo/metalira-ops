import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { IMPORT_TEMPLATE_HREF, importProblemsHref, type ImportPath } from "@/lib/people-import";
import {
  getImportBatchView,
  PREVIEW_ROWS,
  type ImportBatchView,
  type PreviewRow,
} from "@/server/people/imports/data";

import { CancelForm, CommitForm, FixButton } from "./review-forms";
import { UploadCard } from "./upload-card";

/**
 * The import on the Setup board's step 5 and on /app/people/import: the template, the upload,
 * and once a file is checked, the review (counts, rows needing attention with one-click fixes,
 * a preview of ready rows) and "Import N employees". `batchId` comes from `?batch=`.
 */
export async function ImportWorkspace({
  path,
  batchId,
}: {
  path: ImportPath;
  batchId: string | undefined;
}) {
  const view = batchId ? await getImportBatchView(batchId) : null;
  const live = view && view.status !== "cancelled" ? view : null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-2.5 rounded-xl border border-line p-5">
          <span className="text-base font-semibold">1. Fill the template</span>
          <span className="text-sm text-fg-muted">
            32 columns: identity, job, department, line manager ID, client, project, site, shift,
            pay, bank, tax, pension and next of kin. The first 15 are enough to start; pay and bank
            columns are needed before the first payroll.
          </span>
          <Button asChild variant="outline" className="h-11 self-start rounded-lg px-4">
            <a href={IMPORT_TEMPLATE_HREF} download>
              Download template (.csv)
            </a>
          </Button>
        </div>
        <UploadCard path={path} uploadedName={live?.fileName} />
      </div>

      {batchId && !view ? (
        <p role="alert" className="m-0 text-sm font-medium">
          That import wasn&apos;t found. Upload the file again.
        </p>
      ) : null}
      {view?.status === "cancelled" ? (
        <p role="status" className="m-0 text-sm text-fg-muted">
          That import was cancelled. Upload the file again to start over.
        </p>
      ) : null}
      {live ? <ImportReview view={live} path={path} /> : null}
    </div>
  );
}

function Tile({
  label,
  value,
  emphasis = false,
  testId,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={
        emphasis
          ? "rounded-xl border-[1.5px] border-foreground p-3.5"
          : "rounded-xl bg-surface p-3.5"
      }
    >
      <div className={emphasis ? "type-label text-foreground" : "type-label text-fg-muted"}>
        {label}
      </div>
      <div className="font-display text-[28px] font-bold" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const PREVIEW_COLUMNS: Column<PreviewRow>[] = [
  {
    key: "name",
    header: "Employee",
    cell: (row) => <span className="font-semibold">{row.name}</span>,
  },
  { key: "job", header: "Job", cell: (row) => row.jobTitle },
  { key: "manager", header: "Line manager", cell: (row) => row.lineManager || "None" },
  { key: "client", header: "Client · project", cell: (row) => row.clientProject || "None" },
  { key: "site", header: "Site", cell: (row) => row.site || "None" },
  {
    key: "pay",
    header: "Pay",
    cell: (row) => (
      <span className="flex flex-col">
        <span>{row.pay}</span>
        {row.flags.length > 0 ? (
          <span className="type-caption text-fg-muted">{row.flags.join(" · ")}</span>
        ) : null}
      </span>
    ),
  },
];

function ImportReview({ view, path }: { view: ImportBatchView; path: ImportPath }) {
  if (view.fileProblems.length > 0) {
    return (
      <section
        aria-label="File problems"
        className="flex flex-col gap-3 rounded-xl border border-line p-5"
      >
        <h2 className="m-0 type-h3">{view.fileName} couldn&apos;t be checked</h2>
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm">
          {view.fileProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        <p className="m-0 text-sm text-fg-muted">Fix the file and upload it again.</p>
      </section>
    );
  }

  const committed = view.status === "committed";
  const ready = Math.max(view.rowsReady - view.rowsAttention, 0);
  const needFixing = view.rowsHeld + view.rowsAttention;
  const newNames = view.newNames;
  const newParts = newNames
    ? [
        newNames.clients > 0 ? plural(newNames.clients, "client", "clients") : null,
        newNames.projects > 0 ? plural(newNames.projects, "project", "projects") : null,
        newNames.sites > 0 ? plural(newNames.sites, "site", "sites") : null,
        newNames.departments > 0 ? plural(newNames.departments, "department", "departments") : null,
      ].filter((part): part is string => part !== null)
    : [];

  return (
    <div className="flex flex-col gap-5">
      {committed ? (
        <div
          role="status"
          className="flex flex-col gap-1.5 rounded-xl bg-surface p-5"
          data-testid="import-result"
        >
          <span className="text-[17px] font-semibold">
            {plural(view.rowsImported, "employee", "employees")} imported from {view.fileName}
          </span>
          <span className="text-sm text-fg-muted">
            {view.importedMapped} mapped to a department, line manager and site.
            {view.rowsHeld > 0
              ? ` ${plural(view.rowsHeld, "row is", "rows are")} held back to fix and import later.`
              : null}
          </span>
          <Link href="/app/people" className="self-start text-sm font-medium">
            Go to People
          </Link>
        </div>
      ) : null}

      <section
        aria-label="Import check"
        className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
      >
        <Tile label="Rows" value={String(view.rowsTotal)} testId="import-rows" />
        {committed ? (
          <Tile label="Imported" value={String(view.rowsImported)} testId="import-imported" />
        ) : null}
        <Tile label="Ready" value={String(ready)} testId="import-ready" />
        <Tile label="Need fixing" value={String(needFixing)} emphasis testId="import-need-fixing" />
        {view.foundLine ? (
          <div className="rounded-xl bg-surface p-3.5">
            <div className="type-label text-fg-muted">Found</div>
            <div className="text-sm leading-normal" data-testid="import-found">
              {view.foundLine}
            </div>
          </div>
        ) : null}
      </section>

      {!committed &&
      (newParts.length > 0 || view.needsPayDetails > 0 || view.fileNotes.length > 0) ? (
        <div className="flex flex-col gap-1 text-sm text-fg-muted">
          {newParts.length > 0 ? (
            <p className="m-0">
              New names become new clients you can finish later: {newParts.join(", ")}.
            </p>
          ) : null}
          {view.needsPayDetails > 0 ? (
            <p className="m-0">
              {plural(view.needsPayDetails, "employee imports", "employees import")} without full
              pay or bank details, marked as needing pay details before payroll.
            </p>
          ) : null}
          {view.fileNotes.map((note) => (
            <p key={note} className="m-0">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {view.attention.length > 0 ? (
        <section aria-label="Rows that need attention" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 type-h3">
              {plural(view.attention.length, "row needs", "rows need")} attention
            </h2>
            <Button asChild variant="outline" className="h-9 rounded-lg px-3">
              <a href={importProblemsHref(view.id)} download>
                Download problems (.csv)
              </a>
            </Button>
          </div>
          <ul className="m-0 list-none overflow-hidden rounded-xl border border-line p-0">
            {view.attention.map((row) => (
              <li
                key={row.rowNumber}
                data-testid={`import-row-${row.rowNumber}`}
                className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <span className="flex-[0_0_70px] text-sm font-semibold">Row {row.rowNumber}</span>
                <span className="flex min-w-0 flex-[1_1_300px] flex-col gap-1 text-sm">
                  {row.problems.map((problem) => (
                    <span key={problem.message}>{problem.message}</span>
                  ))}
                  {row.warnings.map((warning) => (
                    <span key={warning.message}>{warning.message}</span>
                  ))}
                  {row.name || row.staffId ? (
                    <span className="type-caption text-fg-muted">
                      {[row.name, row.staffId].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-wrap gap-2">
                  {row.status === "held" ? (
                    row.problems.some((p) => p.fixLabel) ? (
                      row.problems.flatMap((problem) =>
                        problem.fixLabel ? (
                          <FixButton
                            key={problem.fixLabel}
                            batchId={view.id}
                            rowNumber={row.rowNumber}
                            label={problem.fixLabel}
                          />
                        ) : (
                          []
                        ),
                      )
                    ) : (
                      <Status tone="action">Fix in the file</Status>
                    )
                  ) : (
                    row.warnings.map((warning) =>
                      warning.appliedFix ? (
                        <Status key={warning.appliedFix} tone="done">
                          Applied: {warning.appliedFix}
                        </Status>
                      ) : null,
                    )
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.preview.length > 0 ? (
        <section aria-label="Ready to import" className="flex flex-col gap-2">
          <h2 className="m-0 type-h3">Ready to import</h2>
          <DataTable
            columns={PREVIEW_COLUMNS}
            rows={view.preview}
            getRowId={(row) => String(row.rowNumber)}
            caption="Employees ready to import"
          />
          {view.rowsReady > PREVIEW_ROWS ? (
            <p className="m-0 type-caption text-fg-muted">
              First {view.preview.length} of {view.rowsReady} ready rows.
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
        <CommitForm batchId={view.id} count={view.rowsReady} />
        {!committed ? <CancelForm batchId={view.id} returnTo={path} /> : null}
      </div>
    </div>
  );
}
