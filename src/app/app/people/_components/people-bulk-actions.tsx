"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Field, FormAlert, SelectField } from "@/components/form";
import { SelectionBar, type RowSelectionValue } from "@/components/row-selection";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDate } from "@/lib/dates";
import { peopleFilterParams, type PeopleFilters } from "@/lib/people-filters";
import type { BulkEndPreview, BulkProblem, BulkReassignPreview } from "@/server/people/bulk";
import {
  bulkEndEmploymentAction,
  bulkSetDepartmentAction,
  bulkSetLineManagerAction,
  previewBulkEndEmploymentAction,
  previewBulkReassignAction,
} from "@/server/people/bulk-actions";

/** What the server needs for a selection: the ticked ids, or the filters to re-run. */
type SelectionInput =
  { kind: "ids"; ids: string[] } | { kind: "filters"; filters: Record<string, string> };

function toInput(value: RowSelectionValue, filters: PeopleFilters): SelectionInput {
  return value.mode === "ids"
    ? { kind: "ids", ids: [...value.ids] }
    : { kind: "filters", filters: Object.fromEntries(peopleFilterParams(filters)) };
}

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;
const shifts = (n: number) =>
  n === 0 ? "No future shifts" : `${n} future ${n === 1 ? "shift" : "shifts"} left uncovered`;

export const FINAL_PAY_NOTE = "Final pay will be prorated in the next payroll.";

type Option = { value: string; label: string };

/**
 * The People list's action bar (slice U.1): End employment, Change line manager and Change
 * department for owner, admin and hr; Export selected to CSV for everyone who reads the list.
 * Each write shows a preview first and confirms on a second step.
 */
export function PeopleBulkActions({
  canManage,
  filters,
  lineManagers,
  departments,
  today,
}: {
  canManage: boolean;
  filters: PeopleFilters;
  lineManagers: readonly Option[];
  departments: readonly Option[];
  today: string;
}) {
  const [open, setOpen] = useState<null | "end" | "line_manager" | "department">(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <SelectionBar label="Bulk actions">
        {(value, clear) => {
          const selection = toInput(value, filters);
          const done = (message: string) => {
            setOpen(null);
            setNotice(message);
            clear();
          };
          return (
            <>
              {canManage ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 rounded-lg lg:h-9"
                    onClick={() => setOpen("end")}
                  >
                    End employment
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 rounded-lg lg:h-9"
                    onClick={() => setOpen("line_manager")}
                  >
                    Change line manager
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 rounded-lg lg:h-9"
                    onClick={() => setOpen("department")}
                  >
                    Change department
                  </Button>
                </>
              ) : null}
              <ExportButton selection={selection} onDone={setNotice} />
              {canManage ? (
                <>
                  <EndEmploymentSheet
                    open={open === "end"}
                    onOpenChange={(o) => setOpen(o ? "end" : null)}
                    selection={selection}
                    today={today}
                    onDone={done}
                  />
                  <ReassignSheet
                    change="line_manager"
                    open={open === "line_manager"}
                    onOpenChange={(o) => setOpen(o ? "line_manager" : null)}
                    selection={selection}
                    options={lineManagers}
                    onDone={done}
                  />
                  <ReassignSheet
                    change="department"
                    open={open === "department"}
                    onOpenChange={(o) => setOpen(o ? "department" : null)}
                    selection={selection}
                    options={departments}
                    onDone={done}
                  />
                </>
              ) : null}
            </>
          );
        }}
      </SelectionBar>
      {/* One live region, kept in the page and hidden while empty, so the result is read out. */}
      <p
        role="status"
        className="m-0 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm empty:hidden"
      >
        {notice ?? ""}
      </p>
    </>
  );
}

function ExportButton({
  selection,
  onDone,
}: {
  selection: SelectionInput;
  onDone: (message: string) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 rounded-lg lg:h-9"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            // A route handler, so the file goes out with no-store and as an attachment.
            let response: Response;
            try {
              response = await fetch("/app/people/export", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ selection }),
              });
            } catch {
              setError("The file couldn't be made. Try again in a minute.");
              return;
            }
            if (!response.ok) {
              setError((await response.text()) || "The file couldn't be made.");
              return;
            }
            const count = Number(response.headers.get("x-export-count") ?? "0");
            const name =
              /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
              "people.csv";
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            document.body.append(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            onDone(`Exported ${people(count)}.`);
          })
        }
      >
        {pending ? "Exporting…" : "Export CSV"}
      </Button>
      {error ? (
        <p role="alert" className="m-0 w-full text-sm font-medium">
          {error}
        </p>
      ) : null}
    </>
  );
}

function Problems({ problems }: { problems: readonly BulkProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul aria-label="People who can't be changed" className="m-0 flex list-none flex-col gap-1 p-0">
      {problems.map((p) => (
        <li key={p.workerId} className="text-sm">
          <span className="font-semibold">{p.name ?? "Unknown employee"}</span>
          {p.staffId ? <span className="text-fg-muted"> · {p.staffId}</span> : null}
          <span>: {p.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function SheetFrame({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="pr-12">
          <SheetTitle className="type-h3">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

function EndEmploymentSheet({
  open,
  onOpenChange,
  selection,
  today,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: SelectionInput;
  today: string;
  onDone: (message: string) => void;
}) {
  const router = useRouter();
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkEndPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [problems, setProblems] = useState<BulkProblem[]>([]);
  const [pending, start] = useTransition();

  const reset = () => {
    setPreview(null);
    setError(null);
    setFieldErrors({});
    setProblems([]);
  };
  const refused = preview?.people.filter((p) => p.refusal) ?? [];

  return (
    <SheetFrame
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="End employment"
      description="One last working day and one reason for everyone selected, up to 200 at a time. Nothing is deleted."
    >
      {preview === null ? (
        <form
          noValidate
          aria-label="End employment for the selected people"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            start(async () => {
              reset();
              if (reason.trim().length < 3) {
                setFieldErrors({ reason: "Give a reason for ending their employment" });
                return;
              }
              const result = await previewBulkEndEmploymentAction({ selection, endDate });
              if (!result.ok) {
                setError(result.message);
                setFieldErrors(result.fieldErrors ?? {});
                return;
              }
              setPreview(result.value);
            });
          }}
        >
          <Field
            label="Last working day"
            type="date"
            required
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            error={fieldErrors.endDate}
          />
          <Field
            label="Reason"
            required
            maxLength={500}
            hint="Kept in the audit log for each person."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={fieldErrors.reason}
          />
          <FormAlert message={error ?? fieldErrors.selection ?? undefined} />
          <Button type="submit" className="h-11 rounded-lg" disabled={pending}>
            {pending ? "Checking…" : "Preview"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm" data-testid="bulk-end-summary">
            {refused.length > 0
              ? `${people(refused.length)} of ${preview.people.length} can't be ended. Take them out of the selection, or change the date, and preview again.`
              : `Ends employment for ${people(preview.people.length)} on ${formatDate(preview.endDate)}.`}
          </p>
          <ul
            aria-label="What ending employment leaves"
            className="m-0 flex list-none flex-col p-0"
          >
            {preview.people.map((p) => (
              <li
                key={p.workerId}
                className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0"
              >
                <span className="text-sm font-semibold">
                  {p.name ?? "Unknown employee"}
                  {p.staffId ? (
                    <span className="font-normal text-fg-muted"> · {p.staffId}</span>
                  ) : null}
                </span>
                {p.refusal ? (
                  <span className="text-sm font-medium">{p.refusal}</span>
                ) : (
                  <>
                    <span className="text-[13px] text-fg-muted">{shifts(p.futureShifts)}</span>
                    <span className="text-[13px] text-fg-muted">
                      {p.leaveApproved + p.leavePending === 0
                        ? "No leave after the date"
                        : `Leave after the date: ${p.leaveApproved} approved, ${p.leavePending} pending`}
                    </span>
                    <span className="text-[13px] text-fg-muted">{FINAL_PAY_NOTE}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <Problems problems={problems} />
          <FormAlert message={error ?? undefined} />
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-lg"
              onClick={reset}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              className="h-11 rounded-lg"
              disabled={pending || refused.length > 0}
              onClick={() =>
                start(async () => {
                  setError(null);
                  setProblems([]);
                  const result = await bulkEndEmploymentAction({
                    selection,
                    endDate,
                    reason,
                    expectedDigest: preview.selection.digest,
                  });
                  if (!result.ok) {
                    // The list changed since the preview: back to the first step to preview again.
                    if (result.changed) setPreview(null);
                    setError(result.message);
                    setProblems(result.problems ?? []);
                    return;
                  }
                  setPreview(null);
                  setReason("");
                  onDone(result.message ?? "Done.");
                  router.refresh();
                })
              }
            >
              {pending
                ? "Ending…"
                : `End employment for ${people(preview.people.length - refused.length)}`}
            </Button>
          </div>
        </div>
      )}
    </SheetFrame>
  );
}

function ReassignSheet({
  change,
  open,
  onOpenChange,
  selection,
  options,
  onDone,
}: {
  change: "line_manager" | "department";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: SelectionInput;
  options: readonly Option[];
  onDone: (message: string) => void;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState("");
  const [preview, setPreview] = useState<BulkReassignPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<BulkProblem[]>([]);
  const [pending, start] = useTransition();
  const isManager = change === "line_manager";
  const field = isManager ? "lineManager" : "departmentId";

  const reset = () => {
    setPreview(null);
    setError(null);
    setProblems([]);
  };
  const blocked = preview ? preview.people.some((p) => p.refusal) || preview.notFound > 0 : false;

  return (
    <SheetFrame
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={isManager ? "Change line manager" : "Change department"}
      description={
        isManager
          ? "One line manager for everyone selected. They approve these people's leave and timesheets from now on."
          : "One department for everyone selected."
      }
    >
      {preview === null ? (
        <form
          noValidate
          aria-label={isManager ? "Choose a line manager" : "Choose a department"}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            start(async () => {
              reset();
              if (!choice) {
                setError(isManager ? "Choose a line manager." : "Choose a department.");
                return;
              }
              const result = await previewBulkReassignAction({
                change,
                selection,
                [field]: choice,
              });
              if (!result.ok) {
                setError(result.fieldErrors?.[field] ?? result.message);
                return;
              }
              setPreview(result.value);
            });
          }}
        >
          <SelectField
            label={isManager ? "New line manager" : "New department"}
            options={options}
            placeholder={isManager ? "Choose a line manager" : "Choose a department"}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          />
          <FormAlert message={error ?? undefined} />
          <Button type="submit" className="h-11 rounded-lg" disabled={pending}>
            {pending ? "Checking…" : "Preview"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm">
            {blocked
              ? "Some of the people selected can't be changed. Take them out of the selection and preview again."
              : `Sets the ${preview.field.toLowerCase()} of ${people(preview.people.length)} to ${preview.to}.`}
          </p>
          <ul aria-label="Before and after" className="m-0 flex list-none flex-col p-0">
            {preview.people.map((p) => (
              <li
                key={p.workerId}
                className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0"
              >
                <span className="text-sm font-semibold">
                  {p.name}
                  <span className="font-normal text-fg-muted"> · {p.staffId}</span>
                </span>
                <span className="text-[13px] text-fg-muted">
                  {p.refusal ?? `${p.before ?? "Not set"} → ${preview.to}`}
                </span>
              </li>
            ))}
          </ul>
          {preview.notFound > 0 ? (
            <p className="m-0 text-sm font-medium">
              {people(preview.notFound)} selected can&apos;t be found in this company.
            </p>
          ) : null}
          <Problems problems={problems} />
          <FormAlert message={error ?? undefined} />
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-lg"
              onClick={reset}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              className="h-11 rounded-lg"
              disabled={pending || blocked}
              onClick={() =>
                start(async () => {
                  setError(null);
                  setProblems([]);
                  const expectedDigest = preview.selection.digest;
                  const result = isManager
                    ? await bulkSetLineManagerAction({
                        selection,
                        lineManager: choice,
                        expectedDigest,
                      })
                    : await bulkSetDepartmentAction({
                        selection,
                        departmentId: choice,
                        expectedDigest,
                      });
                  if (!result.ok) {
                    if (result.changed) setPreview(null);
                    setError(result.message);
                    setProblems(result.problems ?? []);
                    return;
                  }
                  setPreview(null);
                  setChoice("");
                  onDone(result.message ?? "Done.");
                  router.refresh();
                })
              }
            >
              {pending ? "Saving…" : `Change for ${people(preview.people.length)}`}
            </Button>
          </div>
        </div>
      )}
    </SheetFrame>
  );
}
