"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useTransition } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { workerMessages } from "@/lib/messages/worker";
import { askHrAboutPayslipAction, downloadMyPayslipAction } from "@/server/payroll/payslip-actions";

const copy = workerMessages.payslips;
const BUTTON =
  "inline-flex h-[52px] w-full items-center justify-center rounded-xl text-base font-semibold disabled:opacity-60";

/** The month switcher in the top bar: one payslip per month, newest first. */
export function MonthSwitcher({
  current,
  options,
}: {
  current: string;
  options: { id: string; month: string }[];
}) {
  const router = useRouter();
  const id = useId();
  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={id} className="sr-only">
        {copy.month}
      </label>
      <select
        id={id}
        value={current}
        onChange={(e) => router.push(`/m/payslips?p=${encodeURIComponent(e.target.value)}`)}
        className="h-10 max-w-40 rounded-lg border border-line bg-background px-2.5 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        data-testid="payslip-month"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.month}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * "Download PDF": asks the server for a 60-second link to the worker's own PDF (audited), then
 * opens it as a download. The link is never kept or shown.
 */
export function DownloadPdfButton({ payslipId, ready }: { payslipId: string; ready: boolean }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        className={`${BUTTON} bg-foreground text-background`}
        disabled={pending}
        aria-disabled={pending}
        data-testid="payslip-download"
        onClick={() =>
          start(async () => {
            setMessage(null);
            const link = await downloadMyPayslipAction({ payslipId });
            if (link.ok) window.location.assign(link.url);
            else setMessage(link.message);
          })
        }
      >
        {pending ? copy.downloading : copy.download}
      </button>
      {message ? (
        <p role="alert" className="m-0 text-[13px] text-fg-muted">
          {message}
        </p>
      ) : !ready ? (
        <p className="m-0 text-[13px] text-fg-muted">{copy.pdfNotReady}</p>
      ) : null}
    </div>
  );
}

function AskHrForm({ payslipId }: { payslipId: string }) {
  const [state, action] = useActionState(askHrAboutPayslipAction, null);
  const id = useId();
  if (state?.ok) {
    return (
      <p
        role="status"
        data-testid="ask-hr-sent"
        className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px] font-semibold"
      >
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} noValidate className="flex flex-col gap-3">
      <input type="hidden" name="payslipId" value={payslipId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {copy.question}
        </label>
        <textarea
          id={id}
          name="question"
          rows={4}
          required
          maxLength={400}
          aria-describedby={`${id}-hint`}
          className="min-h-28 w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
        <p id={`${id}-hint`} className="m-0 text-xs text-fg-muted">
          {copy.questionHint}
        </p>
      </div>
      <FormAlert message={state && !state.ok ? state.message : undefined} />
      <SubmitButton size="lg" pendingLabel={copy.sending}>
        {copy.send}
      </SubmitButton>
    </form>
  );
}

/** "Ask HR": a bottom sheet with one question about this payslip, sent to HR. */
export function AskHrButton({ payslipId, month }: { payslipId: string; month: string }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className={`${BUTTON} border border-foreground bg-background text-foreground`}
          data-testid="payslip-ask-hr"
        >
          {copy.askHr}
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-xl px-4 pb-6">
        <SheetHeader className="px-0">
          <SheetTitle className="font-display text-lg font-bold">{copy.askTitle(month)}</SheetTitle>
          <SheetDescription className="text-sm text-fg-muted">{copy.askNote}</SheetDescription>
        </SheetHeader>
        <AskHrForm key={payslipId} payslipId={payslipId} />
      </SheetContent>
    </Sheet>
  );
}
