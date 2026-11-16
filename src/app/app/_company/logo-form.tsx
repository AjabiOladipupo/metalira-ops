"use client";

import { ImageIcon } from "lucide-react";
import { useActionState, useId, useRef } from "react";

import { uploadLogo } from "@/server/identity/company-actions";

/**
 * Logo upload, as on the Setup board: preview, the rules, and one button. Choosing a file
 * uploads it straight away. The server checks the bytes (PNG or plain SVG, under 1 MB) whatever
 * the browser says the file is.
 */
export function LogoForm({
  logoUrl,
  companyName,
}: {
  logoUrl: string | null;
  companyName: string;
}) {
  const [state, action, pending] = useActionState(uploadLogo, null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputId = useId();
  const noteId = `${inputId}-note`;
  const error = state && !state.ok ? (state.fieldErrors?.logo ?? state.formError) : undefined;
  const note = pending
    ? "Uploading…"
    : (error ?? (state?.ok ? state.message : "PNG or SVG, square works best, under 1 MB."));

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-center gap-5 rounded-xl border border-dashed border-fg-muted p-5"
    >
      {logoUrl ? (
        // A short-lived signed URL from private Storage: next/image would cache it past expiry.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={`${companyName} logo`}
          className="size-[88px] rounded-xl border border-line bg-background object-contain"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-[88px] items-center justify-center rounded-xl bg-surface text-fg-muted"
        >
          <ImageIcon strokeWidth={1.75} className="size-7" />
        </span>
      )}
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1.5">
        <span className="text-[15px] font-semibold">Business logo</span>
        <span
          id={noteId}
          role={error ? "alert" : "status"}
          className={error ? "text-xs font-medium text-foreground" : "text-xs text-fg-muted"}
        >
          {note}
        </span>
      </div>
      <label
        htmlFor={inputId}
        aria-disabled={pending}
        className="inline-flex h-11 cursor-pointer items-center justify-center rounded-lg border border-line bg-background px-4 text-sm font-medium hover:bg-surface has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-signal aria-disabled:pointer-events-none aria-disabled:opacity-50"
      >
        {logoUrl ? "Replace logo" : "Upload logo"}
        <input
          id={inputId}
          type="file"
          name="logo"
          accept="image/png,image/svg+xml,.png,.svg"
          aria-describedby={noteId}
          className="sr-only"
          onChange={(event) => {
            if (event.currentTarget.files?.length) formRef.current?.requestSubmit();
          }}
        />
      </label>
    </form>
  );
}
