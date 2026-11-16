"use client";

import Link from "next/link";

import { FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import type { CompanyFormState } from "@/server/identity/company-form-state";

export type CompanyFormMode = "setup" | "settings";

/**
 * The bottom of a company form. In the wizard: Back on the left, Continue on the right, above a
 * rule, as on the Setup board; Continue sends `advance=yes`. In settings: Save changes and a
 * short confirmation.
 */
export function CompanyFormFooter({
  mode,
  state,
  backHref,
  continueLabel = "Continue",
  saveLabel = "Save changes",
}: {
  mode: CompanyFormMode;
  state: CompanyFormState;
  backHref?: string;
  continueLabel?: string;
  saveLabel?: string;
}) {
  const formError = state && !state.ok ? state.formError : undefined;

  if (mode === "setup") {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert message={formError} />
        <input type="hidden" name="advance" value="yes" />
        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          {backHref ? (
            <Button asChild variant="outline" className="h-11 rounded-lg px-4">
              <Link href={backHref}>Back</Link>
            </Button>
          ) : (
            <span />
          )}
          <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
            {continueLabel}
          </SubmitButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FormAlert message={formError} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          {saveLabel}
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </div>
  );
}

/** Value to show in an input: what the user just typed after a refusal, else the saved value. */
export function fieldValue(
  state: CompanyFormState,
  name: string,
  saved: string | number | null | undefined,
): string {
  const typed = state && !state.ok ? state.values?.[name] : undefined;
  if (typed !== undefined) return typed;
  return saved === null || saved === undefined ? "" : String(saved);
}
