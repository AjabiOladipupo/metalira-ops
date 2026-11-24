"use client";

import { useActionState, useState, useTransition } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import { downloadPayslipAction, publishPayslipsAction } from "@/server/payroll/payslip-actions";

/** "PDF" on a payslip row: a 60-second link (audited), opened as a download. */
export function PayslipPdfButton({
  payslipId,
  workerName,
}: {
  payslipId: string;
  workerName: string;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        className="inline-flex h-9 items-center rounded-lg border border-line px-3 text-sm font-medium text-foreground hover:bg-surface disabled:opacity-60"
        disabled={pending}
        aria-label={`Download ${workerName}'s payslip PDF`}
        data-testid="payslip-pdf"
        onClick={() =>
          start(async () => {
            setMessage(null);
            const link = await downloadPayslipAction({ payslipId });
            if (link.ok) window.location.assign(link.url);
            else setMessage(link.message);
          })
        }
      >
        {pending ? "Opening…" : "PDF"}
      </button>
      {message ? (
        <span role="alert" className="text-xs whitespace-normal text-fg-muted">
          {message}
        </span>
      ) : null}
    </span>
  );
}

/** "Finish publishing": makes the PDFs and notices a release left out. Safe to press again. */
export function PublishPayslipsForm({ runId }: { runId: string }) {
  const [state, action] = useActionState(publishPayslipsAction, null);
  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-xl border border-foreground bg-surface p-4"
      data-testid="publish-payslips"
    >
      <input type="hidden" name="runId" value={runId} />
      <p className="m-0 text-sm">
        Some payslips have no PDF or notice yet. Finish publishing makes the missing ones; nothing
        already made or sent is repeated.
      </p>
      {state?.ok ? (
        <p role="status" className="m-0 text-sm font-semibold">
          {state.message}
        </p>
      ) : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="max-w-60">
        <SubmitButton pendingLabel="Publishing…">Finish publishing</SubmitButton>
      </div>
    </form>
  );
}
