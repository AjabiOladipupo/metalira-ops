"use client";

import { useState, useTransition } from "react";

import { Field, FormAlert, SelectField } from "@/components/form";
import {
  downloadBankFileAction,
  makeBankFileAction,
  releaseRunAction,
} from "@/server/payroll/payout-actions";

import { TwoStepForm, valueOf } from "./run-forms";

/** "Make file" (owner or finance): format, and a reason when it replaces the current file. */
export function MakeBankFileForm({
  runId,
  formats,
  replaces,
}: {
  runId: string;
  formats: { value: string; label: string }[];
  replaces: boolean;
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
              maxLength={500}
              placeholder="Two workers' bank changes ended their hold"
              defaultValue={valueOf(state, "voidReason")}
              error={state && !state.ok ? state.fieldErrors?.voidReason : undefined}
            />
          ) : null}
        </div>
      )}
    </TwoStepForm>
  );
}

/** "I uploaded it to the bank" (owner or finance, never whoever prepared the run). */
export function ReleaseRunForm({ runId }: { runId: string }) {
  return (
    <TwoStepForm
      action={releaseRunAction}
      hidden={{ runId }}
      label="Release the run"
      previewLabel="I uploaded it to the bank"
      confirmLabel="Confirm and release"
      pendingLabel="Releasing…"
    />
  );
}

/** "Download": asks the server for a 60-second link and opens it straight away. */
export function DownloadBankFileButton({ batchId }: { batchId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(undefined);
            const result = await downloadBankFileAction({ batchId });
            if (result.ok) window.location.assign(result.url);
            else setError(result.message);
          })
        }
        className="inline-flex h-11 items-center justify-center rounded-lg border border-foreground bg-foreground px-5 text-sm font-semibold text-background disabled:opacity-60 sm:self-start"
      >
        {pending ? "Opening…" : "Download the file"}
      </button>
      <FormAlert message={error} />
      <p className="m-0 text-[13px] text-fg-muted">
        The link works for 60 seconds. Every download is recorded.
      </p>
    </div>
  );
}
