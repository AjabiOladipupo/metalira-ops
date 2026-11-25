"use client";

import { useState, useTransition } from "react";

import { Field, FormAlert, SelectField } from "@/components/form";
import {
  confirmSupplementAction,
  downloadBankFileAction,
  downloadSupplementAction,
  makeBankFileAction,
  makeSupplementAction,
  releaseRunAction,
} from "@/server/payroll/payout-actions";

import { TwoStepForm, valueOf } from "./run-forms";

/**
 * "Make file" (owner or finance): format, and, when it replaces the current file, a reason and,
 * if the current file was downloaded, the statement that it wasn't uploaded to the bank.
 */
export function MakeBankFileForm({
  runId,
  formats,
  replaces,
  downloadedNote,
}: {
  runId: string;
  formats: { value: string; label: string }[];
  replaces: boolean;
  /** "The current file was downloaded by … at …", when it was. */
  downloadedNote: string | null;
}) {
  return (
    <TwoStepForm
      action={makeBankFileAction}
      hidden={{ runId }}
      label={replaces ? "Make a new bank file" : "Make the bank file"}
      previewLabel={replaces ? "Preview the new file" : "Preview the file"}
      confirmLabel={replaces ? "Make the new file" : "Make the file"}
      pendingLabel="Checking bank details…"
    >
      {(state) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-start gap-4">
            <SelectField
              label="Bank file format"
              name="format"
              required
              defaultValue={valueOf(state, "format", formats[0]?.value ?? "")}
              options={formats}
              error={state && !state.ok ? state.fieldErrors?.format : undefined}
            />
            {replaces ? (
              <Field
                label="Why replace the current file"
                name="voidReason"
                required
                maxLength={420}
                placeholder="Two workers' bank changes ended their hold"
                defaultValue={valueOf(state, "voidReason")}
                error={state && !state.ok ? state.fieldErrors?.voidReason : undefined}
              />
            ) : null}
          </div>
          {replaces && downloadedNote ? (
            <div className="flex flex-col gap-2 rounded-lg border border-foreground p-3">
              <p className="m-0 text-sm font-medium">{downloadedNote}</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="notUploaded"
                  defaultChecked={valueOf(state, "notUploaded") === "on"}
                  className="mt-0.5 size-4 shrink-0 accent-foreground"
                />
                I confirm the current file was not uploaded to the bank. (If it was, don&apos;t
                replace it: the workers in it would be paid twice.)
              </label>
            </div>
          ) : null}
        </div>
      )}
    </TwoStepForm>
  );
}

/**
 * "I uploaded it to the bank" (owner or finance; never whoever prepared the run or made the
 * file). Names the file the person checked, by id and SHA-256.
 */
export function ReleaseRunForm({
  runId,
  batchId,
  fileSha256,
  today,
  minDate,
}: {
  runId: string;
  batchId: string;
  fileSha256: string;
  /** Today in Lagos: the default and latest upload date (slice 5.9b). */
  today: string;
  /** The run's approval day: the earliest upload date. */
  minDate: string;
}) {
  return (
    <TwoStepForm
      action={releaseRunAction}
      hidden={{ runId, batchId, fileSha256 }}
      label="Release the run"
      previewLabel="I uploaded it to the bank"
      confirmLabel="Confirm and release"
      pendingLabel="Releasing…"
    >
      {(state) => (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-start gap-4">
          <Field
            label="Date you uploaded it to the bank"
            name="uploadedOn"
            type="date"
            required
            min={minDate}
            max={today}
            defaultValue={valueOf(state, "uploadedOn", today)}
            hint="Pension is due 7 working days from this date."
            error={state && !state.ok ? state.fieldErrors?.uploadedOn : undefined}
          />
        </div>
      )}
    </TwoStepForm>
  );
}

/**
 * "Download": asks the server for a 60-second link and opens it straight away. After release a
 * reason is needed, and the copy says the file is already paid.
 */
export function DownloadBankFileButton({
  batchId,
  released,
  supplementary = false,
}: {
  /** The bank file's id, or the supplementary file's when `supplementary`. */
  batchId: string;
  /** Already paid (the run released, or the supplementary file confirmed): a reason is needed. */
  released: boolean;
  supplementary?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-col gap-2">
      {released ? (
        <>
          <p className="m-0 text-sm font-semibold">
            Already paid: do not upload this file to the bank again.
          </p>
          <Field
            label="Why do you need the file again"
            name="reason"
            maxLength={500}
            placeholder="The bank asked for a copy for its records"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </>
      ) : null}
      <button
        type="button"
        disabled={pending || (released && reason.trim() === "")}
        onClick={() =>
          start(async () => {
            setError(undefined);
            const result = supplementary
              ? await downloadSupplementAction(
                  released ? { supplementId: batchId, reason } : { supplementId: batchId },
                )
              : await downloadBankFileAction(released ? { batchId, reason } : { batchId });
            if (result.ok) window.location.assign(result.url);
            else setError(result.message);
          })
        }
        className="inline-flex h-11 items-center justify-center rounded-lg border border-foreground bg-foreground px-5 text-sm font-semibold text-background disabled:opacity-60 sm:self-start"
      >
        {pending ? "Opening…" : released ? "Download a copy (already paid)" : "Download the file"}
      </button>
      <FormAlert message={error} />
      <p className="m-0 text-[13px] text-fg-muted">
        The link works for 60 seconds. Every download is recorded.
      </p>
    </div>
  );
}

/**
 * "Make a supplementary file" (owner or finance; slice 5.7c): pays the workers the released run's
 * file left out whose bank details are now in force. When it replaces a waiting supplementary
 * file: a reason and, if that file was downloaded, the statement that it wasn't uploaded.
 */
export function MakeSupplementForm({
  runId,
  formats,
  replaces,
  downloadedNote,
}: {
  runId: string;
  formats: { value: string; label: string }[];
  replaces: boolean;
  /** "The current supplementary file was downloaded by … at …", when it was. */
  downloadedNote: string | null;
}) {
  return (
    <TwoStepForm
      action={makeSupplementAction}
      hidden={{ runId }}
      label="Make a supplementary file"
      previewLabel={replaces ? "Preview a new supplementary file" : "Make a supplementary file"}
      confirmLabel={replaces ? "Make the new file" : "Make the file"}
      pendingLabel="Checking bank details…"
    >
      {(state) => (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-start gap-4">
            <SelectField
              label="Bank file format"
              name="format"
              required
              defaultValue={valueOf(state, "format", formats[0]?.value ?? "")}
              options={formats}
              error={state && !state.ok ? state.fieldErrors?.format : undefined}
            />
            {replaces ? (
              <Field
                label="Why replace the waiting file"
                name="voidReason"
                required
                maxLength={420}
                placeholder="Another worker's bank change ended its hold"
                defaultValue={valueOf(state, "voidReason")}
                error={state && !state.ok ? state.fieldErrors?.voidReason : undefined}
              />
            ) : null}
          </div>
          {replaces && downloadedNote ? (
            <div className="flex flex-col gap-2 rounded-lg border border-foreground p-3">
              <p className="m-0 text-sm font-medium">{downloadedNote}</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="notUploaded"
                  defaultChecked={valueOf(state, "notUploaded") === "on"}
                  className="mt-0.5 size-4 shrink-0 accent-foreground"
                />
                I confirm the waiting supplementary file was not uploaded to the bank. (If it was,
                confirm it instead: the workers in it would be paid twice.)
              </label>
            </div>
          ) : null}
        </div>
      )}
    </TwoStepForm>
  );
}

/**
 * "I uploaded it to the bank" for a supplementary file (owner or finance; never whoever made it
 * or prepared the run). Names the file by id and SHA-256.
 */
export function ConfirmSupplementForm({
  runId,
  supplementId,
  fileSha256,
}: {
  runId: string;
  supplementId: string;
  fileSha256: string;
}) {
  return (
    <TwoStepForm
      action={confirmSupplementAction}
      hidden={{ runId, supplementId, fileSha256 }}
      label="Confirm the supplementary file"
      previewLabel="I uploaded it to the bank"
      confirmLabel="Confirm it went to the bank"
      pendingLabel="Confirming…"
    />
  );
}
