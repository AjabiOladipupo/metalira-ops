"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  PAYROLL_EVIDENCE_BUCKET,
  RECEIPT_ACCEPT,
  RECEIPT_TYPE_HINT,
  checkChosenReceipt,
} from "@/lib/payroll/receipts";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { CapabilityPreview } from "@/server/capabilities/types";
import {
  offsetRemittancePaymentAction,
  previewRemittanceRefundAction,
  recordRemittanceRefundAction,
  startRefundReceiptAction,
  type RemittanceFormState,
} from "@/server/payroll/remittance-actions";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] items-start gap-4";

function PreviewCard({ preview }: { preview: CapabilityPreview }) {
  return (
    <div
      data-testid="resolution-preview"
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

type Phase =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "confirm"; preview: CapabilityPreview; sent: string }
  | { kind: "uploading" }
  | { kind: "checking" }
  | { kind: "done" }
  | { kind: "error"; message: string; field?: FieldName };

type FieldName = "file" | "receivedOn" | "amount" | "reference";

/**
 * "Record a refund" (slice 5.7c): a refund the authority sent back for a payment on a voided
 * remittance, with the date, amount, reference and receipt. "Check the refund" shows what it will
 * record; "Upload receipt and record" uploads the receipt to the private bucket at the path the
 * server gave, then the server checks its bytes and records the refund.
 */
export function RecordRefundForm({
  paymentId,
  unresolved,
  today,
  minDate,
}: {
  paymentId: string;
  /** Naira with 2 decimals, the default amount. */
  unresolved: string;
  today: string;
  minDate: string;
}) {
  const router = useRouter();
  const id = useId();
  const fileId = `${id}-file`;
  const fileNote = `${id}-file-note`;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [refreshing, startTransition] = useTransition();
  const busy =
    phase.kind === "previewing" ||
    phase.kind === "uploading" ||
    phase.kind === "checking" ||
    refreshing;

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const fields = {
      paymentId,
      receivedOn: String(data.get("receivedOn") ?? ""),
      amount: String(data.get("amount") ?? ""),
      reference: String(data.get("reference") ?? ""),
    };
    const file = data.get("receipt");
    if (!(file instanceof File) || file.size === 0 || !file.name) {
      setPhase({ kind: "error", message: "Choose the receipt file.", field: "file" });
      return;
    }
    const chosen = checkChosenReceipt(file);
    if (!chosen.ok) {
      setPhase({ kind: "error", message: chosen.message, field: "file" });
      return;
    }
    const sent = JSON.stringify({ ...fields, file: [file.name, file.size] });
    if (phase.kind !== "confirm" || phase.sent !== sent) {
      setPhase({ kind: "previewing" });
      const previewed = await previewRemittanceRefundAction(fields);
      if (!previewed.ok) {
        const errors = previewed.fieldErrors ?? {};
        const field = (["receivedOn", "amount", "reference"] as const).find((n) => errors[n]);
        setPhase({ kind: "error", message: previewed.message, field });
        return;
      }
      setPhase({ kind: "confirm", preview: previewed.preview, sent });
      return;
    }
    setPhase({ kind: "uploading" });
    const started = await startRefundReceiptAction({
      ...fields,
      fileName: file.name,
      size: file.size,
    });
    if (!started.ok) {
      setPhase({ kind: "error", message: started.message, field: "file" });
      return;
    }
    const { error } = await createBrowserSupabase()
      .storage.from(PAYROLL_EVIDENCE_BUCKET)
      .uploadToSignedUrl(started.path, started.token, file, { contentType: started.contentType });
    if (error) {
      setPhase({
        kind: "error",
        message: "The upload didn't finish. Check your connection and try again.",
        field: "file",
      });
      return;
    }
    setPhase({ kind: "checking" });
    const recorded = await recordRemittanceRefundAction({
      ...fields,
      receiptId: started.receiptId,
      fileExt: started.fileExt,
    });
    if (!recorded.ok) {
      setPhase({ kind: "error", message: recorded.message });
      return;
    }
    form.reset();
    setPhase({ kind: "done" });
    startTransition(() => router.refresh());
  }

  const fieldError = (name: FieldName) =>
    phase.kind === "error" && phase.field === name ? phase.message : undefined;
  const status =
    phase.kind === "previewing"
      ? "Checking…"
      : phase.kind === "uploading"
        ? "Uploading the receipt…"
        : phase.kind === "checking"
          ? "Checking the receipt…"
          : phase.kind === "done"
            ? "Refund recorded"
            : null;

  return (
    <form
      noValidate
      aria-label="Record a refund"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void submit(event.currentTarget);
      }}
      onChange={() => {
        if (phase.kind === "confirm" || phase.kind === "error") setPhase({ kind: "idle" });
      }}
    >
      <div className={GRID}>
        <Field
          label="Refund received on"
          name="receivedOn"
          type="date"
          required
          min={minDate}
          max={today}
          defaultValue={today}
          error={fieldError("receivedOn")}
        />
        <Field
          label="Amount refunded (₦)"
          name="amount"
          inputMode="decimal"
          required
          defaultValue={unresolved}
          error={fieldError("amount")}
        />
        <Field
          label="Bank reference (optional)"
          name="reference"
          maxLength={100}
          error={fieldError("reference")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fileId} className="text-[13px] font-medium">
          Receipt
        </label>
        <input
          id={fileId}
          type="file"
          name="receipt"
          accept={RECEIPT_ACCEPT}
          aria-describedby={fileNote}
          aria-invalid={fieldError("file") ? true : undefined}
          disabled={busy}
          className="block w-full min-w-0 rounded-lg border border-line bg-background p-2 text-sm file:mr-3 file:h-9 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
        <p
          id={fileNote}
          className={
            fieldError("file")
              ? "m-0 text-xs font-medium text-foreground"
              : "m-0 text-xs text-fg-muted"
          }
        >
          {fieldError("file") ?? `${RECEIPT_TYPE_HINT} The authority's letter or the bank credit.`}
        </p>
      </div>
      {phase.kind === "confirm" ? <PreviewCard preview={phase.preview} /> : null}
      {phase.kind === "error" && !phase.field ? <FormAlert message={phase.message} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} className="h-11 rounded-lg px-5 text-sm">
          {phase.kind === "confirm" ? "Upload receipt and record" : "Check the refund"}
        </Button>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {status}
        </p>
      </div>
    </form>
  );
}

/**
 * "Offset against a later remittance" (slice 5.7c): part or all of the payment set against a
 * later remittance to the same authority, with why (for example, what the authority agreed).
 */
export function OffsetPaymentForm({
  paymentId,
  targets,
}: {
  paymentId: string;
  targets: { value: string; label: string; room: string }[];
}) {
  const [state, formAction] = useActionState<RemittanceFormState, FormData>(
    offsetRemittancePaymentAction,
    null,
  );
  const [editedAfter, setEditedAfter] = useState<RemittanceFormState>(null);
  const preview = state?.ok ? state.preview : undefined;
  const confirming = preview !== undefined && editedAfter !== state;
  return (
    <form
      action={formAction}
      aria-label="Offset against a later remittance"
      className="flex flex-col gap-3"
      onChange={() => setEditedAfter(state)}
    >
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="intent" value={confirming ? "save" : "preview"} />
      <div key={JSON.stringify(state?.values ?? null)} className={GRID}>
        <SelectField
          label="Later remittance"
          name="targetRemittanceId"
          required
          defaultValue={state?.values?.targetRemittanceId ?? targets[0]?.value ?? ""}
          options={targets.map((t) => ({ value: t.value, label: `${t.label} (${t.room} to pay)` }))}
          error={state && !state.ok ? state.fieldErrors?.targetRemittanceId : undefined}
        />
        <Field
          label="Amount to offset (₦)"
          name="amount"
          inputMode="decimal"
          required
          defaultValue={state?.values?.amount ?? ""}
          error={state && !state.ok ? state.fieldErrors?.amount : undefined}
        />
        <Field
          label="Why (what the authority agreed)"
          name="note"
          required
          maxLength={500}
          defaultValue={state?.values?.note ?? ""}
          error={state && !state.ok ? state.fieldErrors?.note : undefined}
        />
      </div>
      {confirming && preview ? <PreviewCard preview={preview} /> : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok && state.message ? (
        <p role="status" className="m-0 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <SubmitButton pendingLabel="Working…" className="sm:w-auto sm:self-start sm:px-5">
        {confirming ? "Confirm the offset" : "Check the offset"}
      </SubmitButton>
    </form>
  );
}
