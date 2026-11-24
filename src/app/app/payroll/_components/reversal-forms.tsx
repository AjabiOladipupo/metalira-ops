"use client";

import { Field, SelectField } from "@/components/form";
import { returnRunAction } from "@/server/payroll/run-actions";
import {
  addCorrectionAction,
  approveReversalAction,
  reverseRunAction,
} from "@/server/payroll/reversal-actions";

import { TwoStepForm, valueOf } from "./run-forms";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4";

/** "I confirm the file wasn't uploaded", shown when a downloaded bank file would be voided. */
function NotUploaded({
  state,
  downloaded,
}: {
  state: Parameters<typeof valueOf>[0];
  downloaded: boolean;
}) {
  const error = state && !state.ok ? state.fieldErrors?.notUploaded : undefined;
  if (!downloaded && !error) return null;
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        name="notUploaded"
        defaultChecked={valueOf(state, "notUploaded") === "on"}
        className="mt-0.5 size-4 shrink-0 accent-foreground"
      />
      <span>
        The bank file was downloaded. I confirm it wasn&apos;t uploaded to the bank.
        {error ? <span className="block text-fg-muted">{error}</span> : null}
      </span>
    </label>
  );
}

/** "Reverse this run" (Finance or the owner): a reason, the preview, then the request. */
export function ReverseRunForm({ runId, downloaded }: { runId: string; downloaded: boolean }) {
  return (
    <TwoStepForm
      action={reverseRunAction}
      hidden={{ runId }}
      label="Reverse this run"
      previewLabel="Preview the reversal"
      confirmLabel="Ask for the reversal"
      pendingLabel="Working it out…"
    >
      {(state) => (
        <>
          <Field
            label="Reason"
            name="reason"
            required
            maxLength={500}
            placeholder="Overtime at Apapa was approved twice"
            defaultValue={valueOf(state, "reason")}
            error={state && !state.ok ? state.fieldErrors?.reason : undefined}
          />
          <NotUploaded state={state} downloaded={downloaded} />
        </>
      )}
    </TwoStepForm>
  );
}

/** "Approve the reversal" (Finance or the owner, never whoever asked for it). */
export function ApproveReversalForm({ runId, downloaded }: { runId: string; downloaded: boolean }) {
  return (
    <TwoStepForm
      action={approveReversalAction}
      hidden={{ runId }}
      label="Approve the reversal"
      previewLabel="Check and approve"
      confirmLabel="Confirm and reverse the run"
      pendingLabel="Reversing…"
    >
      {(state) => <NotUploaded state={state} downloaded={downloaded} />}
    </TwoStepForm>
  );
}

/** "Decline" a waiting reversal: 5.2's return, with a reason. A declined reversal stays a draft. */
export function DeclineReversalForm({ runId }: { runId: string }) {
  return (
    <TwoStepForm
      action={returnRunAction}
      hidden={{ runId }}
      label="Decline the reversal"
      previewLabel="Decline"
      confirmLabel="Confirm and decline"
      pendingLabel="Declining…"
    >
      {(state) => (
        <Field
          label="Reason"
          name="reason"
          required
          maxLength={500}
          placeholder="The run is right; correct one payslip next month instead"
          defaultValue={valueOf(state, "reason")}
          error={state && !state.ok ? state.fieldErrors?.reason : undefined}
        />
      )}
    </TwoStepForm>
  );
}

/** "Correct a released payslip" (HR or the owner, a draft run). */
export function AddCorrectionForm({
  runId,
  payslips,
}: {
  runId: string;
  payslips: { id: string; label: string }[];
}) {
  return (
    <TwoStepForm
      action={addCorrectionAction}
      hidden={{ runId }}
      label="Correct a released payslip"
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
                label="Payslip it corrects"
                name="payslipId"
                required
                placeholder="Choose a released payslip"
                defaultValue={valueOf(state, "payslipId")}
                options={payslips.map((p) => ({ value: p.id, label: p.label }))}
                error={errors?.payslipId}
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
                placeholder="October overtime underpaid"
                defaultValue={valueOf(state, "label")}
                error={errors?.label}
              />
              <Field
                label="Amount (₦)"
                name="amount"
                inputMode="decimal"
                required
                placeholder="4,500"
                defaultValue={valueOf(state, "amount")}
                error={errors?.amount}
              />
            </div>
            <Field
              label="Reason"
              name="reason"
              required
              maxLength={500}
              placeholder="6 hours of 3 Oct overtime were left out"
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
            {errors?.repeat || valueOf(state, "repeat") === "on" ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="repeat"
                  defaultChecked={valueOf(state, "repeat") === "on"}
                  className="mt-0.5 size-4 shrink-0 accent-foreground"
                />
                <span>This is a further correction of that payslip, not the same one again.</span>
              </label>
            ) : null}
          </>
        );
      }}
    </TwoStepForm>
  );
}
