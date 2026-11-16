"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";

import { IMPORTS_BUCKET, importReviewHref, type ImportPath } from "@/lib/people-import";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { checkImportUpload, startImportUpload } from "@/server/people/imports/actions";

/** Matches the validator's cap (src/server/people/import/limits.ts); the server checks again. */
const MAX_BYTES = 5 * 1024 * 1024;

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; name: string }
  | { kind: "checking"; name: string }
  | { kind: "error"; message: string };

/**
 * "2. Upload it" on the Setup board. The file goes straight from the browser to private
 * Storage (no request-size limit in between), then the server reads it back, checks every row
 * and stores the result, and the page shows the review.
 */
export function UploadCard({ path, uploadedName }: { path: ImportPath; uploadedName?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const noteId = `${inputId}-note`;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [navigating, startTransition] = useTransition();
  const busy = phase.kind === "uploading" || phase.kind === "checking" || navigating;

  async function upload(file: File) {
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setPhase({ kind: "error", message: "Upload a CSV or Excel (.xlsx) file." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setPhase({
        kind: "error",
        message: "The file is larger than 5 MB. Split it into smaller files and upload each one.",
      });
      return;
    }
    setPhase({ kind: "uploading", name: file.name });
    const started = await startImportUpload({ fileName: file.name, size: file.size });
    if (!started.ok) {
      setPhase({ kind: "error", message: started.message });
      return;
    }
    const { error } = await createBrowserSupabase()
      .storage.from(IMPORTS_BUCKET)
      .upload(started.path, file, { contentType: started.contentType, upsert: false });
    if (error) {
      setPhase({
        kind: "error",
        message: "The upload didn't finish. Check your connection and try again.",
      });
      return;
    }
    setPhase({ kind: "checking", name: file.name });
    const checked = await checkImportUpload(started.batchId);
    if (!checked.ok) {
      setPhase({ kind: "error", message: checked.message });
      return;
    }
    startTransition(() => {
      router.push(importReviewHref(path, started.batchId));
    });
    setPhase({ kind: "idle" });
  }

  const note =
    phase.kind === "uploading"
      ? `Uploading ${phase.name}…`
      : phase.kind === "checking"
        ? `Checking every row of ${phase.name}…`
        : phase.kind === "error"
          ? phase.message
          : navigating
            ? "Opening the check…"
            : uploadedName
              ? `${uploadedName} uploaded. Upload a corrected file to start again.`
              : "CSV or Excel. We check every row before anything is saved.";

  return (
    <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-2.5 rounded-xl border-[1.5px] border-dashed border-foreground p-5">
      <span className="text-base font-semibold">2. Upload it</span>
      <span
        id={noteId}
        role={phase.kind === "error" ? "alert" : "status"}
        className={
          phase.kind === "error" ? "text-sm font-medium text-foreground" : "text-sm text-fg-muted"
        }
      >
        {note}
      </span>
      <label
        htmlFor={inputId}
        aria-disabled={busy}
        className="inline-flex h-11 cursor-pointer items-center justify-center self-start rounded-lg border border-action bg-action px-[18px] text-sm font-semibold text-on-action hover:opacity-85 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-signal aria-disabled:pointer-events-none aria-disabled:opacity-50"
      >
        {busy ? "Working…" : uploadedName ? "Upload another file" : "Upload a file"}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          name="employees"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-describedby={noteId}
          disabled={busy}
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (inputRef.current) inputRef.current.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
    </div>
  );
}
