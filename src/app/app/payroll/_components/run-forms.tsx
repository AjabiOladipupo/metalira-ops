"use client";

import { useActionState, useState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import type { CapabilityPreview } from "@/server/capabilities/types";
import {
  acknowledgeAnomaliesAction,
  addAdjustmentAction,
  approveRunAction,
  carryInstalmentAction,
  createOffCycleRunAction,
  createRunAction,
  discardOffCycleRunAction,
  recalculateRunAction,
  removeAdjustmentAction,
  returnRunAction,
  submitRunAction,
  type RunFormState,
} from "@/server/payroll/run-actions";

type Action = (prev: RunFormState, formData: FormData) => Promise<RunFormState>;

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4";

/** What the change will do, shown before the confirm press. */
function PreviewCard({ preview }: { preview: CapabilityPreview }) {
  return (
    <div
      data-testid="run-preview"
      className="flex flex-col gap-3 rounded-xl border border-foreground bg-surface p-4"
    >
      <p className="m-0 text-sm font-semibold">{preview.summary}</p>
      {preview.changes.length > 0 ? (
        <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 text-sm">
          {preview.changes.map((c) => (
            <div key={c.label} className="contents">
              <dt className="text-fg-muted">{c.label}</dt>
              <dd className="m-0 text-right tabular-nums">
                {c.before !== undefined ? (
                  <span className="text-fg-muted">{c.before} → </span>
                ) : null}
                {c.after}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * A money write in two presses: the first shows the preview (worked out on the server without
 * writing), the second confirms. Editing a field after the preview asks for a fresh one.
 */
export function TwoStepForm({
  action,
  hidden,
  label,
  previewLabel,
  confirmLabel,
  pendingLabel,
  children,
  buttonClass = "sm:w-auto sm:self-start sm:px-5",
}: {
  action: Action;
  hidden: Record<string, string>;
  label: string;
  previewLabel: string;
  confirmLabel: string;
  pendingLabel: string;
  children?: (state: RunFormState) => React.ReactNode;
  buttonClass?: string;
}) {
  const [state, formAction] = useActionState<RunFormState, FormData>(action, null);
  const [editedAfter, setEditedAfter] = useState<RunFormState>(null);
  const preview = state?.ok ? state.preview : undefined;
  const confirming = preview !== undefined && editedAfter !== state;
  return (
    <form
      action={formAction}
      aria-label={label}
      className="flex flex-col gap-4"
      onChange={() => setEditedAfter(state)}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="intent" value={confirming ? "save" : "preview"} />
      {/* React resets a form after its action, to the defaults the inputs mounted with; remount
          the fields with what was sent, so the confirm press sends what the preview showed. */}
      <div key={JSON.stringify(state?.values ?? null)} className="contents">
        {children?.(state)}
      </div>
      {confirming && preview ? <PreviewCard preview={preview} /> : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok && state.message ? (
        <p role="status" className="m-0 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <SubmitButton pendingLabel={pendingLabel} className={buttonClass}>
        {confirming ? confirmLabel : previewLabel}
      </SubmitButton>
    </form>
  );
}

export const valueOf = (state: RunFormState, name: string, fallback = "") =>
  state?.values?.[name] ?? fallback;

export function CreateRunForm({
  periods,
}: {
  periods: { value: string; label: string; payDate: string }[];
}) {
  return (
    <TwoStepForm
      action={createRunAction}
      hidden={{}}
      label="Prepare a payroll run"
      previewLabel="Preview the run"
      confirmLabel="Prepare the run"
      pendingLabel="Working it out…"
    >
      {(state) => (
        <div className={GRID}>
          <SelectField
            label="Pay period"
            name="periodStart"
            required
            defaultValue={valueOf(state, "periodStart", periods[0]?.value ?? "")}
            options={periods.map((p) => ({ value: p.value, label: p.label }))}
            error={state && !state.ok ? state.fieldErrors?.periodStart : undefined}
          />
          <Field
            label="Pay date (optional)"
            name="payDate"
            type="date"
            defaultValue={valueOf(state, "payDate")}
            hint="Leave empty for the company's pay day."
            error={state && !state.ok ? state.fieldErrors?.payDate : undefined}
          />
        </div>
      )}
    </TwoStepForm>
  );
}

export function RecalculateForm({ runId }: { runId: string }) {
  return (
    <TwoStepForm
      action={recalculateRunAction}
      hidden={{ runId }}
      label="Recalculate the run"
      previewLabel="Recalculate"
      confirmLabel="Save the new figures"
      pendingLabel="Working it out…"
    />
  );
}

export function AddAdjustmentForm({
  runId,
  workers,
  oneOffOnly = false,
}: {
  runId: string;
  workers: { id: string; name: string; staffId: string }[];
  /** An off-cycle run (slice 5.7b) takes one-off items only. */
  oneOffOnly?: boolean;
}) {
  return (
    <TwoStepForm
      action={addAdjustmentAction}
      hidden={{ runId }}
      label="Add an earning or deduction"
      previewLabel="Preview"
      confirmLabel="Add and recalculate"
      pendingLabel="Working it out…"
    >
      {(state) => {
        const errors = state && !state.ok ? state.fieldErrors : undefined;
        return (
          <>
            <div className={GRID}>
              <SelectField
                label="Worker"
                name="workerId"
                required
                placeholder="Choose a worker"
                defaultValue={valueOf(state, "workerId")}
                options={workers.map((w) => ({
                  value: w.id,
                  label: w.staffId ? `${w.name} · ${w.staffId}` : w.name,
                }))}
                error={errors?.workerId}
              />
              <SelectField
                label="Kind"
                name="kind"
                required
                defaultValue={valueOf(state, "kind", "earning")}
                options={[
                  { value: "earning", label: "Earning (taxed)" },
                  { value: "deduction", label: "Deduction (after tax)" },
                ]}
                error={errors?.kind}
              />
              <Field
                label="Item"
                name="label"
                required
                maxLength={80}
                placeholder="Supervisor allowance"
                defaultValue={valueOf(state, "label")}
                error={errors?.label}
              />
              <Field
                label="Amount (₦)"
                name="amount"
                inputMode="decimal"
                required
                placeholder="15,000"
                defaultValue={valueOf(state, "amount")}
                error={errors?.amount}
              />
              {oneOffOnly ? (
                <input type="hidden" name="instalments" value="1" />
              ) : (
                <Field
                  label="Instalments"
                  name="instalments"
                  type="number"
                  min={1}
                  max={60}
                  defaultValue={valueOf(state, "instalments", "1")}
                  hint="1 for a one-off; 3 for a repayment over 3 runs."
                  error={errors?.instalments}
                />
              )}
            </div>
            <Field
              label="Reason"
              name="reason"
              required
              maxLength={500}
              placeholder="Acting supervisor at Lekki, October"
              defaultValue={valueOf(state, "reason")}
              error={errors?.reason}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="pensionable"
                defaultChecked={valueOf(state, "pensionable") === "on"}
                className="size-4 accent-foreground"
              />
              Counts toward pension (earnings only)
            </label>
          </>
        );
      }}
    </TwoStepForm>
  );
}

export function CarryInstalmentForm({
  runId,
  seriesId,
  label,
}: {
  runId: string;
  seriesId: string;
  label: string;
}) {
  return (
    <TwoStepForm
      action={carryInstalmentAction}
      hidden={{ runId, seriesId }}
      label={label}
      previewLabel="Carry next instalment"
      confirmLabel="Carry and recalculate"
      pendingLabel="Working it out…"
    />
  );
}

export function RemoveAdjustmentForm({
  adjustmentId,
  label,
}: {
  adjustmentId: string;
  label: string;
}) {
  return (
    <TwoStepForm
      action={removeAdjustmentAction}
      hidden={{ adjustmentId }}
      label={`Remove ${label}`}
      previewLabel="Remove"
      confirmLabel="Remove and recalculate"
      pendingLabel="Working it out…"
    >
      {(state) => (
        <Field
          label="Reason for removing"
          name="reason"
          required
          maxLength={500}
          defaultValue={valueOf(state, "reason")}
          error={state && !state.ok ? state.fieldErrors?.reason : undefined}
        />
      )}
    </TwoStepForm>
  );
}

export interface AnomalyItem {
  id: string;
  title: string;
  body: string;
  severity: "blocking" | "warning";
  acknowledged: boolean;
}

export function AcknowledgeForm({
  runId,
  anomalies,
  canAcknowledge,
}: {
  runId: string;
  anomalies: AnomalyItem[];
  canAcknowledge: boolean;
}) {
  const [state, formAction] = useActionState<RunFormState, FormData>(
    acknowledgeAnomaliesAction,
    null,
  );
  const open = anomalies.filter((a) => a.severity === "warning" && !a.acknowledged).length;
  return (
    <form action={formAction} aria-label="Acknowledge anomalies" className="flex flex-col gap-3">
      <input type="hidden" name="runId" value={runId} />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {anomalies.map((a) => (
          <li key={a.id}>
            <label
              data-testid="anomaly"
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3.5"
            >
              {a.severity === "blocking" ? (
                <span
                  aria-hidden="true"
                  className="mt-1 inline-block size-[18px] shrink-0 rounded-full border-2 border-signal bg-signal"
                />
              ) : (
                <input
                  type="checkbox"
                  name="anomalyId"
                  value={a.id}
                  defaultChecked={a.acknowledged}
                  disabled={a.acknowledged || !canAcknowledge}
                  className="mt-0.5 size-[18px] shrink-0 accent-foreground"
                />
              )}
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px] font-semibold">
                  {a.title}
                  {a.severity === "blocking" ? " · blocks the run" : ""}
                  {a.acknowledged ? " · acknowledged" : ""}
                </span>
                <span className="text-sm text-fg-muted">{a.body}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok && state.message ? (
        <p role="status" className="m-0 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      {canAcknowledge && open > 0 ? (
        <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start sm:px-5">
          Acknowledge ticked
        </SubmitButton>
      ) : null}
    </form>
  );
}

export function SubmitRunForm({ runId }: { runId: string }) {
  return (
    <TwoStepForm
      action={submitRunAction}
      hidden={{ runId }}
      label="Submit to Finance"
      previewLabel="Submit to Finance"
      confirmLabel="Confirm and submit"
      pendingLabel="Submitting…"
    />
  );
}

export function ReturnRunForm({ runId }: { runId: string }) {
  return (
    <TwoStepForm
      action={returnRunAction}
      hidden={{ runId }}
      label="Return to HR"
      previewLabel="Return to HR"
      confirmLabel="Confirm and return"
      pendingLabel="Returning…"
    >
      {(state) => (
        <Field
          label="Reason"
          name="reason"
          required
          maxLength={500}
          placeholder="Night overtime at Apapa isn't approved yet"
          defaultValue={valueOf(state, "reason")}
          error={state && !state.ok ? state.fieldErrors?.reason : undefined}
        />
      )}
    </TwoStepForm>
  );
}

export function ApproveRunForm({ runId }: { runId: string }) {
  return (
    <TwoStepForm
      action={approveRunAction}
      hidden={{ runId }}
      label="Approve the run"
      previewLabel="Check and approve"
      confirmLabel="Confirm and approve"
      pendingLabel="Checking the inputs…"
    />
  );
}

export interface OffCycleWorkerOption {
  id: string;
  name: string;
  staffId: string;
  /** "Last day 5 Oct 2026", "Started 1 Oct 2026", or null. */
  note: string | null;
}

/**
 * "New off-cycle run" (slice 5.7b): why, the pay period and pay date, the workers (ticked from a
 * list you can filter by name or staff ID) and HR's reason. Two presses: the preview works the run
 * out for the ticked workers; the second creates it.
 */
export function OffCycleRunForm({
  periods,
  reasons,
  workers,
  defaultPayDate,
}: {
  periods: { value: string; label: string }[];
  reasons: { value: string; label: string; hint: string }[];
  workers: OffCycleWorkerOption[];
  defaultPayDate: string;
}) {
  const [filter, setFilter] = useState("");
  const [reason, setReason] = useState(reasons[0]?.value ?? "");
  const needle = filter.trim().toLowerCase();
  return (
    <TwoStepForm
      action={createOffCycleRunAction}
      hidden={{}}
      label="New off-cycle run"
      previewLabel="Preview the off-cycle run"
      confirmLabel="Prepare the off-cycle run"
      pendingLabel="Working it out…"
    >
      {(state) => {
        const errors = state && !state.ok ? state.fieldErrors : undefined;
        const ticked = new Set(valueOf(state, "workerIds").split(",").filter(Boolean));
        const chosenReason = valueOf(state, "reason", reason);
        return (
          <>
            <div className={GRID}>
              <SelectField
                label="Why off-cycle"
                name="reason"
                required
                defaultValue={chosenReason}
                onChange={(e) => setReason(e.currentTarget.value)}
                options={reasons.map((r) => ({ value: r.value, label: r.label }))}
                hint={reasons.find((r) => r.value === reason)?.hint}
                error={errors?.reason}
              />
              <SelectField
                label="Pay period"
                name="periodStart"
                required
                defaultValue={valueOf(state, "periodStart", periods[0]?.value ?? "")}
                options={periods}
                hint="For a final pay, the period holding the worker's last day."
                error={errors?.periodStart}
              />
              <Field
                label="Pay date"
                name="payDate"
                type="date"
                required
                defaultValue={valueOf(state, "payDate", defaultPayDate)}
                hint="In the period, or up to 45 days after it."
                error={errors?.payDate}
              />
            </div>
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-1.5 text-[13px] font-medium">Workers</legend>
              <input
                type="search"
                aria-label="Filter workers by name or staff ID"
                placeholder="Filter by name or staff ID"
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                className="h-11 w-full rounded-lg border border-line bg-background px-3 text-[15px]"
              />
              <ul
                data-testid="off-cycle-workers"
                className="m-0 flex max-h-72 list-none flex-col overflow-y-auto rounded-lg border border-line p-0"
              >
                {workers.map((w) => {
                  const shown =
                    needle === "" ||
                    w.name.toLowerCase().includes(needle) ||
                    w.staffId.toLowerCase().includes(needle);
                  return (
                    <li
                      key={w.id}
                      className={shown ? "border-b border-line last:border-b-0" : "hidden"}
                    >
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          name="workerIds"
                          value={w.id}
                          defaultChecked={ticked.has(w.id)}
                          className="size-[18px] shrink-0 accent-foreground"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="font-medium">
                            {w.name}
                            {w.staffId ? (
                              <span className="text-fg-muted"> · {w.staffId}</span>
                            ) : null}
                          </span>
                          {w.note ? <span className="text-xs text-fg-muted">{w.note}</span> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {errors?.workerIds ? (
                <p className="m-0 text-xs font-medium">{errors.workerIds}</p>
              ) : null}
            </fieldset>
            <Field
              label="Reason"
              name="note"
              required
              maxLength={500}
              placeholder="Resigned, last day 5 October"
              defaultValue={valueOf(state, "note")}
              error={errors?.note}
            />
          </>
        );
      }}
    </TwoStepForm>
  );
}

export function DiscardOffCycleForm({ runId }: { runId: string }) {
  return (
    <TwoStepForm
      action={discardOffCycleRunAction}
      hidden={{ runId }}
      label="Discard this off-cycle run"
      previewLabel="Discard"
      confirmLabel="Confirm and discard"
      pendingLabel="Discarding…"
    >
      {(state) => (
        <Field
          label="Reason"
          name="reason"
          required
          maxLength={500}
          placeholder="Paid in the regular run instead"
          defaultValue={valueOf(state, "reason")}
          error={state && !state.ok ? state.fieldErrors?.reason : undefined}
        />
      )}
    </TwoStepForm>
  );
}
