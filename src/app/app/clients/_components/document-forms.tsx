"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  CONTRACT_DOCS_BUCKET,
  DOCUMENT_ACCEPT,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_TYPE_HINT,
  checkChosenFile,
  type DocumentKind,
} from "@/lib/contract-documents";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  confirmContractDocumentUpload,
  removeContractDocumentAction,
  startContractDocumentUpload,
} from "@/server/business/contract-document-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

const KIND_OPTIONS = DOCUMENT_KINDS.map((kind) => ({
  value: kind,
  label: DOCUMENT_KIND_LABELS[kind],
}));

type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "checking" }
  | { kind: "done"; title: string }
  | { kind: "error"; message: string; field?: "file" | "title" | "kind" };

/**
 * Upload a document to a contract. The file goes straight from the browser to the private
 * bucket (no request-size limit in between) at the path the server gave for a pending row;
 * then the server reads it back, checks its type from its bytes and puts it on file.
 */
export function DocumentUploadForm({
  clientId,
  contractId,
  defaultKind,
}: {
  clientId: string;
  contractId: string;
  defaultKind: DocumentKind;
}) {
  const router = useRouter();
  const fileId = useId();
  const fileNoteId = `${fileId}-note`;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [refreshing, startTransition] = useTransition();
  const busy = phase.kind === "uploading" || phase.kind === "checking" || refreshing;

  async function upload(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0 || !file.name) {
      setPhase({ kind: "error", message: "Choose a file to upload.", field: "file" });
      return;
    }
    const checked = checkChosenFile(file);
    if (!checked.ok) {
      setPhase({ kind: "error", message: checked.message, field: "file" });
      return;
    }
    setPhase({ kind: "uploading" });
    const started = await startContractDocumentUpload({
      contractId,
      kind: String(data.get("kind") ?? ""),
      title: String(data.get("title") ?? ""),
      fileName: file.name,
      size: file.size,
    });
    if (!started.ok) {
      const field = started.fieldErrors?.title
        ? "title"
        : started.fieldErrors?.kind
          ? "kind"
          : "file";
      setPhase({ kind: "error", message: started.message, field });
      return;
    }
    const { error } = await createBrowserSupabase()
      .storage.from(CONTRACT_DOCS_BUCKET)
      .upload(started.path, file, { contentType: started.contentType, upsert: false });
    if (error) {
      // The pending row is rejected by the daily sweep; a new upload starts afresh.
      setPhase({
        kind: "error",
        message: "The upload didn't finish. Check your connection and try again.",
        field: "file",
      });
      return;
    }
    setPhase({ kind: "checking" });
    const confirmed = await confirmContractDocumentUpload({
      documentId: started.documentId,
      clientId,
    });
    if (!confirmed.ok) {
      setPhase({ kind: "error", message: confirmed.message, field: "file" });
      return;
    }
    form.reset();
    setPhase({ kind: "done", title: String(data.get("title") ?? "").trim() || file.name });
    startTransition(() => router.refresh());
  }

  const fileNote =
    phase.kind === "error" && phase.field === "file" ? phase.message : DOCUMENT_TYPE_HINT;
  const status =
    phase.kind === "uploading"
      ? "Uploading…"
      : phase.kind === "checking"
        ? "Checking the file…"
        : phase.kind === "done"
          ? `${phase.title} uploaded`
          : null;

  return (
    <form
      noValidate
      aria-label="Upload a document"
      className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void upload(event.currentTarget);
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-semibold">Upload a document</h3>
        <p className="m-0 text-sm text-fg-muted">
          Signed contract, SLA, amendments, purchase orders or insurance. Only owners, admins,
          finance and ops managers can open them.
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
        <SelectField
          label="Kind"
          name="kind"
          options={KIND_OPTIONS}
          defaultValue={defaultKind}
          error={phase.kind === "error" && phase.field === "kind" ? phase.message : undefined}
        />
        <Field
          label="Title"
          name="title"
          placeholder="Coastline guarding contract, signed"
          hint="Leave blank to use the file name."
          maxLength={200}
          error={phase.kind === "error" && phase.field === "title" ? phase.message : undefined}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fileId} className="text-[13px] font-medium">
          File
        </label>
        <input
          id={fileId}
          type="file"
          name="file"
          accept={DOCUMENT_ACCEPT}
          aria-describedby={fileNoteId}
          aria-invalid={phase.kind === "error" && phase.field === "file" ? true : undefined}
          disabled={busy}
          className="block w-full min-w-0 rounded-lg border border-line bg-background p-2 text-sm file:mr-3 file:h-9 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
        <p
          id={fileNoteId}
          className={
            phase.kind === "error" && phase.field === "file"
              ? "m-0 text-xs font-medium text-foreground"
              : "m-0 text-xs text-fg-muted"
          }
        >
          {fileNote}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} className="h-11 rounded-lg px-5 text-sm">
          {busy ? "Working…" : "Upload"}
        </Button>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {status}
        </p>
      </div>
    </form>
  );
}

/** "Remove" on a document: asks why, then marks it removed. The file stops opening at once. */
export function RemoveDocumentForm({
  clientId,
  contractId,
  documentId,
  title,
}: {
  clientId: string;
  contractId: string;
  documentId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<CompanyFormState, FormData>(
    removeContractDocumentAction,
    null,
  );
  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="h-11 px-4"
        aria-label={`Remove ${title}`}
        onClick={() => setOpen(true)}
      >
        Remove
      </Button>
    );
  }
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      action={action}
      noValidate
      aria-label={`Remove ${title}`}
      className="flex w-full flex-col gap-3 rounded-xl border border-line bg-surface p-4"
    >
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contractId} />
      <Field
        label="Why is it being removed?"
        name="reason"
        required
        maxLength={500}
        placeholder="Uploaded the unsigned draft by mistake"
        hint="Kept with the record. The file can't be opened once removed."
        defaultValue={state && !state.ok ? (state.values?.reason ?? "") : ""}
        error={errors?.reason}
      />
      <FormAlert message={state && !state.ok && !errors?.reason ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Removing…" className="w-auto px-5">
          Remove document
        </SubmitButton>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4"
          onClick={() => setOpen(false)}
        >
          Keep it
        </Button>
      </div>
    </form>
  );
}
