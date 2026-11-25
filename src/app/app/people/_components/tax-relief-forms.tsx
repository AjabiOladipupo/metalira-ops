"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { PAYROLL_LINK_SECONDS, checkChosenReceipt, RECEIPT_ACCEPT } from "@/lib/payroll/receipts";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { CapabilityPreview } from "@/server/capabilities/types";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  declareReliefAction,
  importOpeningBalancesAction,
  recordOpeningBalanceAction,
  recordReliefProofAction,
  reliefProofLinkAction,
  setItfTurnoverAction,
  setNhfNumberAction,
  startReliefProofAction,
  verifyReliefAction,
  type TaxFormState,
} from "@/server/payroll/tax-records-actions";

/**
 * Payroll tax records on screen (slice 5.9a): the worker's opening balance, reliefs with their
 * proofs and verification, the NHF number, and on Settings > Payroll rules the ITF turnover
 * switch and the opening-balance import. Money writes preview first; the second press confirms.
 * Proof files go straight to the private store through a one-path upload token, then the server
 * checks them.
 */

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] items-start gap-4";
const RELIEF_PROOFS_BUCKET = "payroll-relief-proofs";

function PreviewCard({ preview }: { preview: CapabilityPreview }) {
  return (
    <div
      data-testid="tax-record-preview"
      className="flex flex-col gap-3 rounded-xl border border-foreground bg-surface p-4"
    >
      <p className="m-0 text-sm font-semibold">{preview.summary}</p>
      {preview.changes.length > 0 ? (
        <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 text-sm">
          {preview.changes.map((c) => (
            <div key={c.label} className="contents">
              <dt className="text-fg-muted">{c.label}</dt>
              <dd className="m-0 text-right break-words tabular-nums">
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

type Action = (prev: TaxFormState, formData: FormData) => Promise<TaxFormState>;

/**
 * A form that previews on the first press and saves on the second. Editing after the preview
 * goes back to previewing.
 */
function PreviewSaveForm({
  action,
  label,
  hidden,
  children,
  previewLabel,
  saveLabel,
}: {
  action: Action;
  label: string;
  hidden: Record<string, string>;
  children: (state: TaxFormState) => React.ReactNode;
  previewLabel: string;
  saveLabel: string;
}) {
  const [state, formAction] = useActionState<TaxFormState, FormData>(action, null);
  const [editedAfter, setEditedAfter] = useState<TaxFormState>(null);
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
      <div key={JSON.stringify(state?.values ?? null)} className="contents">
        {children(state)}
      </div>
      {confirming && preview ? <PreviewCard preview={preview} /> : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok && state.message ? (
        <p role="status" className="m-0 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <SubmitButton pendingLabel="Working…" className="sm:w-auto sm:self-start sm:px-5">
        {confirming ? saveLabel : previewLabel}
      </SubmitButton>
    </form>
  );
}

const err = (state: TaxFormState, name: string) =>
  state && !state.ok ? state.fieldErrors?.[name] : undefined;
const val = (state: TaxFormState, name: string, fallback = "") =>
  state?.values?.[name] ?? fallback;

export interface OpeningDefaults {
  id: string | null;
  asOfMonth: string;
  gross: string;
  chargeable: string;
  paye: string;
  pension: string;
}

/** "Record opening balance" (or correct the one in force). */
export function OpeningBalanceForm({
  workerId,
  taxYear,
  current,
}: {
  workerId: string;
  taxYear: number;
  current: OpeningDefaults;
}) {
  return (
    <PreviewSaveForm
      action={recordOpeningBalanceAction}
      label="Opening balance"
      hidden={{ workerId, taxYear: String(taxYear), supersedesId: current.id ?? "" }}
      previewLabel={current.id ? "Check the correction" : "Check the opening balance"}
      saveLabel="Confirm and save"
    >
      {(state) => (
        <>
          <div className={GRID}>
            <Field
              label="Covers to the end of"
              name="asOfMonth"
              type="month"
              required
              min={`${taxYear}-01`}
              max={`${taxYear}-12`}
              defaultValue={val(state, "asOfMonth", current.asOfMonth)}
              error={err(state, "asOfMonth")}
            />
            <Field
              label="Gross pay to date (₦)"
              name="gross"
              inputMode="decimal"
              required
              defaultValue={val(state, "gross", current.gross)}
              error={err(state, "gross")}
            />
            <Field
              label="Chargeable pay to date (₦)"
              name="chargeable"
              inputMode="decimal"
              required
              hint="Taxable pay less pension and NHF"
              defaultValue={val(state, "chargeable", current.chargeable)}
              error={err(state, "chargeable")}
            />
            <Field
              label="PAYE withheld to date (₦)"
              name="paye"
              inputMode="decimal"
              required
              defaultValue={val(state, "paye", current.paye)}
              error={err(state, "paye")}
            />
            <Field
              label="Pension to date (₦)"
              name="pension"
              inputMode="decimal"
              required
              defaultValue={val(state, "pension", current.pension)}
              error={err(state, "pension")}
            />
          </div>
          <Field
            label="Reason"
            name="reason"
            required
            maxLength={500}
            placeholder="From the previous payroll provider's year-to-date report"
            defaultValue={val(state, "reason")}
            error={err(state, "reason")}
          />
        </>
      )}
    </PreviewSaveForm>
  );
}

const RELIEF_OPTIONS = [
  { value: "rent", label: "Rent (annual rent)" },
  { value: "nhis", label: "NHIS or NHIA contributions" },
  { value: "life_assurance", label: "Life assurance or deferred annuity premiums" },
] as const;

/** "Declare a relief", or correct the one in force for its kind. */
export function DeclareReliefForm({
  workerId,
  taxYear,
  current,
}: {
  workerId: string;
  taxYear: number;
  /** The declaration in force per kind, to supersede. */
  current: Partial<Record<string, string>>;
}) {
  const [kind, setKind] = useState("rent");
  return (
    <PreviewSaveForm
      action={declareReliefAction}
      label="Declare a relief"
      hidden={{ workerId, taxYear: String(taxYear), supersedesId: current[kind] ?? "" }}
      previewLabel="Check the relief"
      saveLabel="Confirm and save"
    >
      {(state) => (
        <>
          <div className={GRID}>
            <SelectField
              label="Relief"
              name="kind"
              options={RELIEF_OPTIONS}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              error={err(state, "kind")}
            />
            <Field
              label={kind === "rent" ? "Annual rent (₦)" : "Yearly amount (₦)"}
              name="amount"
              inputMode="decimal"
              required
              defaultValue={val(state, "amount")}
              error={err(state, "amount")}
            />
          </div>
          <Field
            label="Reason"
            name="reason"
            required
            maxLength={500}
            placeholder="Declared by the worker for this tax year"
            defaultValue={val(state, "reason")}
            error={err(state, "reason")}
          />
          {current[kind] ? (
            <p className="m-0 text-[13px] text-fg-muted">
              This replaces the one on file for this relief; it counts again once its proof is
              verified.
            </p>
          ) : null}
        </>
      )}
    </PreviewSaveForm>
  );
}

/** "Verify" or "Reject" a relief's proof. */
export function VerifyReliefForm({
  declarationId,
  workerId,
}: {
  declarationId: string;
  workerId: string;
}) {
  return (
    <PreviewSaveForm
      action={verifyReliefAction}
      label="Verify the proof"
      hidden={{ declarationId, workerId }}
      previewLabel="Check the decision"
      saveLabel="Confirm"
    >
      {(state) => (
        <div className={GRID}>
          <SelectField
            label="Decision"
            name="decision"
            options={[
              { value: "verified", label: "Proof checked: verify" },
              { value: "rejected", label: "Proof not good enough: reject" },
            ]}
            defaultValue={val(state, "decision", "verified")}
            error={err(state, "decision")}
          />
          <Field
            label="Note (needed to reject)"
            name="note"
            maxLength={500}
            defaultValue={val(state, "note")}
            error={err(state, "note")}
          />
        </div>
      )}
    </PreviewSaveForm>
  );
}

const DOCUMENT_OPTIONS = {
  rent: [
    { value: "tenancy_agreement", label: "Tenancy agreement" },
    { value: "rent_receipt", label: "Rent receipt" },
    { value: "payment_record", label: "Payment record" },
    { value: "other", label: "Other proof" },
  ],
  nhis: [
    { value: "contribution_statement", label: "Contribution statement" },
    { value: "payment_record", label: "Payment record" },
    { value: "other", label: "Other proof" },
  ],
  life_assurance: [
    { value: "policy_document", label: "Policy document" },
    { value: "premium_receipt", label: "Premium receipt" },
    { value: "payment_record", label: "Payment record" },
    { value: "other", label: "Other proof" },
  ],
} as const;

/** "Add proof": a PDF, PNG or JPEG of 10 MB or less, checked by the server. */
export function ProofUploadForm({
  declarationId,
  workerId,
  kind,
}: {
  declarationId: string;
  workerId: string;
  kind: "rent" | "nhis" | "life_assurance";
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get("file");
    const documentKind = String(data.get("documentKind") ?? "");
    setError(null);
    if (!(file instanceof File) || file.size === 0 || !file.name) {
      setError("Choose the file.");
      return;
    }
    const chosen = checkChosenReceipt(file);
    if (!chosen.ok) {
      setError(chosen.message);
      return;
    }
    setBusy(true);
    setStatus("Uploading the file…");
    const started = await startReliefProofAction({
      declarationId,
      documentKind,
      fileName: file.name,
      size: file.size,
    });
    if (!started.ok) {
      setBusy(false);
      setStatus(null);
      setError(started.message);
      return;
    }
    const { error: uploadError } = await createBrowserSupabase()
      .storage.from(RELIEF_PROOFS_BUCKET)
      .uploadToSignedUrl(started.path, started.token, file, { contentType: started.contentType });
    if (uploadError) {
      setBusy(false);
      setStatus(null);
      setError("The upload didn't finish. Check your connection and try again.");
      return;
    }
    setStatus("Checking the file…");
    const recorded = await recordReliefProofAction({
      declarationId,
      documentKind,
      proofId: started.proofId,
      fileExt: started.fileExt,
      workerId,
    });
    setBusy(false);
    if (!recorded.ok) {
      setStatus(null);
      setError(recorded.message);
      return;
    }
    form.reset();
    setStatus("Proof added. Verify it when you've checked it.");
    startTransition(() => router.refresh());
  }

  return (
    <form
      noValidate
      aria-label="Add proof"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void submit(event.currentTarget);
      }}
    >
      <div className={GRID}>
        <SelectField label="What it is" name="documentKind" options={DOCUMENT_OPTIONS[kind]} />
        <Field
          label="File"
          name="file"
          type="file"
          accept={RECEIPT_ACCEPT}
          hint="PDF, PNG or JPEG, 10 MB or less"
        />
      </div>
      <FormAlert message={error ?? undefined} />
      {status ? (
        <p role="status" className="m-0 text-sm font-medium">
          {status}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-11 cursor-pointer items-center justify-center rounded-lg border border-line bg-background px-5 text-sm font-semibold disabled:opacity-60 sm:self-start"
      >
        {busy ? "Working…" : "Add proof"}
      </button>
    </form>
  );
}

/** "Open": a link that works for 60 seconds, made on the server and audited. */
export function ProofLinkButton({ proofId, label }: { proofId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        title={`Opens for ${PAYROLL_LINK_SECONDS} seconds`}
        className="cursor-pointer self-start border-0 bg-transparent p-0 text-sm font-semibold text-signal underline-offset-2 hover:underline disabled:opacity-60"
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          const result = await reliefProofLinkAction({ proofId });
          setBusy(false);
          if (!result.ok) setMessage(result.message);
          else window.location.assign(result.url);
        }}
      >
        {busy ? "Opening…" : label}
      </button>
      {message ? (
        <span role="alert" className="text-xs font-medium">
          {message}
        </span>
      ) : null}
    </span>
  );
}

/** "NHF number": set or remove; the number is never shown back in full. */
export function NhfNumberForm({ workerId, onFile }: { workerId: string; onFile: boolean }) {
  const [state, formAction] = useActionState<CompanyFormState, FormData>(setNhfNumberAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form action={formAction} aria-label="NHF number" className="flex flex-col gap-3">
      <input type="hidden" name="workerId" value={workerId} />
      <div key={JSON.stringify(state?.values ?? null)} className={GRID}>
        <Field
          label={onFile ? "New NHF number (leave empty to remove)" : "NHF number"}
          name="nhfNumber"
          autoComplete="off"
          maxLength={20}
          error={errors?.nhfNumber}
        />
        <Field
          label="Reason"
          name="reason"
          required
          maxLength={500}
          defaultValue={state && !state.ok ? (state.values?.reason ?? "") : ""}
          error={errors?.reason}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok && state.message ? (
        <p role="status" className="m-0 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start sm:px-5">
        {onFile ? "Change NHF number" : "Save NHF number"}
      </SubmitButton>
    </form>
  );
}

/** Settings > Payroll rules: the company's ITF turnover switch. */
export function ItfTurnoverForm({ value }: { value: boolean }) {
  return (
    <PreviewSaveForm
      action={setItfTurnoverAction}
      label="ITF turnover"
      hidden={{}}
      previewLabel="Check the change"
      saveLabel="Confirm and save"
    >
      {(state) => (
        <>
          <SelectField
            label="Turnover"
            name="value"
            options={[
              { value: "false", label: "Under ₦50 million: ITF from 5 employees" },
              { value: "true", label: "₦50 million or more: ITF whatever the headcount" },
            ]}
            defaultValue={val(state, "value", value ? "true" : "false")}
            error={err(state, "value")}
          />
          <Field
            label="Reason"
            name="reason"
            required
            maxLength={500}
            placeholder="Audited accounts for 2025"
            defaultValue={val(state, "reason")}
            error={err(state, "reason")}
          />
        </>
      )}
    </PreviewSaveForm>
  );
}

/** Settings > Payroll rules: import opening balances at go-live from pasted rows. */
export function ImportOpeningForm({ taxYear }: { taxYear: number }) {
  return (
    <PreviewSaveForm
      action={importOpeningBalancesAction}
      label="Import opening balances"
      hidden={{ taxYear: String(taxYear) }}
      previewLabel="Check the import"
      saveLabel="Confirm and import"
    >
      {(state) => (
        <>
          <Field
            label="Covers to the end of"
            name="asOfMonth"
            type="month"
            required
            min={`${taxYear}-01`}
            max={`${taxYear}-12`}
            defaultValue={val(state, "asOfMonth")}
            error={err(state, "asOfMonth")}
            className="sm:max-w-xs"
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="opening-rows" className="text-[13px] font-medium">
              Rows: staff ID, gross, chargeable pay, PAYE, pension (₦, one worker a line)
            </label>
            <textarea
              id="opening-rows"
              name="rows"
              required
              rows={6}
              spellCheck={false}
              placeholder={"MLS-0001, 1080000, 993600, 50940, 86400\nMLS-0002, 1215000, 1117800, 77670, 97200"}
              defaultValue={val(state, "rows")}
              aria-invalid={err(state, "rows") ? true : undefined}
              className="w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2 font-mono text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-foreground"
            />
            {err(state, "rows") ? (
              <p className="m-0 text-xs font-medium">{err(state, "rows")}</p>
            ) : null}
          </div>
          <Field
            label="Reason"
            name="reason"
            required
            maxLength={500}
            placeholder="Year to date from the previous payroll provider"
            defaultValue={val(state, "reason")}
            error={err(state, "reason")}
          />
        </>
      )}
    </PreviewSaveForm>
  );
}
