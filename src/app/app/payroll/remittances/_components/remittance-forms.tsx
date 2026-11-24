"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  PAYROLL_EVIDENCE_BUCKET,
  RECEIPT_ACCEPT,
  RECEIPT_TYPE_HINT,
  checkChosenReceipt,
} from "@/lib/payroll/receipts";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { CapabilityPreview } from "@/server/capabilities/types";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  previewRemittancePaymentAction,
  recordRemittancePaymentAction,
  remittanceReceiptLinkAction,
  setRemittanceDueDaysAction,
  startRemittanceReceiptAction,
  voidRemittancePaymentAction,
  type RemittanceFormState,
} from "@/server/payroll/remittance-actions";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] items-start gap-4";

function PreviewCard({ preview }: { preview: CapabilityPreview }) {
  return (
    <div
      data-testid="remittance-preview"
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

/** Opens a 60-second link made on the server (the link is never kept or logged). */
function useFileLink() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function open(
    make: () => Promise<{ ok: true; url: string } | { ok: false; message: string }>,
  ) {
    setBusy(true);
    setMessage(null);
    const result = await make();
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    window.location.assign(result.url);
  }
  return { busy, message, open };
}

export function ReceiptLinkButton({ paymentId }: { paymentId: string }) {
  const { busy, message, open } = useFileLink();
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        className="cursor-pointer self-start border-0 bg-transparent p-0 text-sm font-semibold text-signal underline-offset-2 hover:underline disabled:opacity-60"
        onClick={() => void open(() => remittanceReceiptLinkAction({ paymentId }))}
      >
        {busy ? "Opening…" : "View receipt"}
      </button>
      {message ? (
        <span role="alert" className="text-xs font-medium">
          {message}
        </span>
      ) : null}
    </span>
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

type FieldName = "file" | "paidOn" | "amount" | "reference" | "amountDiffers";

/**
 * "Record payment": the date, amount, reference and receipt; "Check the payment" shows what it
 * will record; "Upload receipt and record" sends the receipt straight to the private bucket at
 * the path the server gave, then the server checks it from its bytes and records the payment.
 */
export function RecordPaymentForm({
  remittanceId,
  amountDue,
  today,
  minDate,
}: {
  remittanceId: string;
  /** Naira with 2 decimals, the default amount. */
  amountDue: string;
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

  function details(form: HTMLFormElement) {
    const data = new FormData(form);
    return {
      fields: {
        remittanceId,
        paidOn: String(data.get("paidOn") ?? ""),
        amount: String(data.get("amount") ?? ""),
        reference: String(data.get("reference") ?? ""),
        amountDiffers: data.get("amountDiffers") === "on",
      },
      file: data.get("receipt"),
    };
  }

  async function submit(form: HTMLFormElement) {
    const { fields, file } = details(form);
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
      const previewed = await previewRemittancePaymentAction(fields);
      if (!previewed.ok) {
        const errors = previewed.fieldErrors ?? {};
        const field = (["paidOn", "amount", "reference", "amountDiffers"] as const).find(
          (name) => errors[name],
        );
        setPhase({ kind: "error", message: previewed.message, field });
        return;
      }
      setPhase({ kind: "confirm", preview: previewed.preview, sent });
      return;
    }

    setPhase({ kind: "uploading" });
    const started = await startRemittanceReceiptAction({
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
    const recorded = await recordRemittancePaymentAction({
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
            ? "Payment recorded"
            : null;

  return (
    <form
      noValidate
      aria-label="Record payment"
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
          label="Paid on"
          name="paidOn"
          type="date"
          required
          min={minDate}
          max={today}
          defaultValue={today}
          error={fieldError("paidOn")}
        />
        <Field
          label="Amount paid (₦)"
          name="amount"
          inputMode="decimal"
          required
          defaultValue={amountDue}
          error={fieldError("amount")}
        />
        <Field
          label="Bank reference (optional)"
          name="reference"
          maxLength={100}
          error={fieldError("reference")}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="amountDiffers"
            className="mt-0.5 size-4 shrink-0"
            aria-invalid={fieldError("amountDiffers") ? true : undefined}
          />
          <span>The amount paid differs from the amount due</span>
        </label>
        {fieldError("amountDiffers") ? (
          <p role="alert" className="m-0 text-xs font-medium">
            {fieldError("amountDiffers")}
          </p>
        ) : (
          <p className="m-0 text-xs text-fg-muted">
            Tick only to record a part payment or an overpayment as it is. It shows as part paid or
            overpaid, never as paid.
          </p>
        )}
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
          {fieldError("file") ?? `${RECEIPT_TYPE_HINT} The bank's or the authority's receipt.`}
        </p>
      </div>
      {phase.kind === "confirm" ? <PreviewCard preview={phase.preview} /> : null}
      {phase.kind === "error" && !phase.field ? <FormAlert message={phase.message} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} className="h-11 rounded-lg px-5 text-sm">
          {phase.kind === "confirm" ? "Upload receipt and record" : "Check the payment"}
        </Button>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {status}
        </p>
      </div>
    </form>
  );
}

/** "Void this record": a reason, the preview, then the void. */
export function VoidPaymentForm({ paymentId }: { paymentId: string }) {
  const [state, formAction] = useActionState<RemittanceFormState, FormData>(
    voidRemittancePaymentAction,
    null,
  );
  const [editedAfter, setEditedAfter] = useState<RemittanceFormState>(null);
  const preview = state?.ok ? state.preview : undefined;
  const confirming = preview !== undefined && editedAfter !== state;
  return (
    <form
      action={formAction}
      aria-label="Void the payment record"
      className="flex flex-col gap-3"
      onChange={() => setEditedAfter(state)}
    >
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="intent" value={confirming ? "save" : "preview"} />
      <div key={JSON.stringify(state?.values ?? null)} className="contents">
        <Field
          label="Why is the record wrong?"
          name="reason"
          required
          maxLength={500}
          defaultValue={state?.values?.reason ?? ""}
          error={state && !state.ok ? state.fieldErrors?.reason : undefined}
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
        {confirming ? "Confirm and void" : "Void this record"}
      </SubmitButton>
    </form>
  );
}

const DUE_FIELDS = [
  { name: "paye", label: "PAYE" },
  { name: "nhf", label: "NHF" },
  { name: "nsitf", label: "NSITF" },
  { name: "itf", label: "ITF" },
] as const;

/** Settings > Payroll rules: the company's own due day for each kind, or none. */
export function RemitDueDaysForm({
  values,
}: {
  values: Record<(typeof DUE_FIELDS)[number]["name"], number | null>;
}) {
  const [state, formAction] = useActionState<CompanyFormState, FormData>(
    setRemittanceDueDaysAction,
    null,
  );
  return (
    <form action={formAction} aria-label="Remittance due days" className="flex flex-col gap-4">
      <div key={JSON.stringify(state?.values ?? null)} className={GRID}>
        {DUE_FIELDS.map((f) => (
          <Field
            key={f.name}
            label={`${f.label} due day`}
            name={f.name}
            type="number"
            min={1}
            max={28}
            inputMode="numeric"
            placeholder="None"
            defaultValue={state?.values?.[f.name] ?? values[f.name]?.toString() ?? ""}
            error={state && !state.ok ? state.fieldErrors?.[f.name] : undefined}
          />
        ))}
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok && state.message ? (
        <p role="status" className="m-0 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start sm:px-5">
        Save due days
      </SubmitButton>
    </form>
  );
}
