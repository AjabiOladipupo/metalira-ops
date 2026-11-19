"use client";

import { Eye, EyeOff } from "lucide-react";
import { useActionState, useRef, useState, useTransition } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  previewCompanyBankRequest,
  type CompanyBankPreview,
  type CompanyBankState,
} from "@/lib/company-bank";
import type { Role } from "@/lib/roles";
import {
  decideCompanyBankAction,
  revealCompanyBankAccount,
  requestCompanyBankAction,
  withdrawCompanyBankAction,
} from "@/server/billing/company-bank-actions";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4";

/**
 * Add or change the account clients pay into. Two steps: the details, then a confirm step that
 * shows what will change and when (`previewCompanyBankRequest`, the same pure function Lira's
 * confirmation card will use). The account number is never sent back after a refusal.
 */
export function CompanyBankRequestForm({
  role,
  state: bankState,
  hasAccount,
}: {
  role: Role;
  state: CompanyBankState;
  hasAccount: boolean;
}) {
  const [state, action] = useActionState(requestCompanyBankAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<Extract<CompanyBankPreview, { ok: true }> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // After a refusal, go back to the details so the error shows beside its field.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    setPreview(null);
  }
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const typed = state && !state.ok ? state.values : undefined;

  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium" data-testid="company-bank-sent">
        {state.message}
      </p>
    );
  }

  function review() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const text = (key: string) => {
      const value = data.get(key);
      return typeof value === "string" ? value : "";
    };
    const result = previewCompanyBankRequest(
      {
        bankName: text("bankName"),
        accountName: text("accountName"),
        accountNumber: text("bankAccountNumber"),
      },
      role,
      bankState,
    );
    if (result.ok) {
      setProblem(null);
      setPreview(result);
    } else {
      setProblem(result.reason);
    }
  }

  const title = hasAccount ? "Change the account" : "Add your bank account";
  const first = preview?.mode === "first_account";

  return (
    <form
      ref={formRef}
      key={JSON.stringify(typed ?? null)}
      action={action}
      noValidate
      aria-label={title}
      className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-semibold">{title}</h3>
        <p className="m-0 text-sm text-fg-muted">
          Your company&apos;s own business account. Clients pay invoices into it by transfer;
          Metalira never holds the money.
        </p>
      </div>
      <div className={preview ? "hidden" : "flex flex-col gap-4"}>
        <div className={GRID}>
          <Field
            label="Bank name"
            name="bankName"
            defaultValue={typed?.bankName ?? ""}
            error={errors?.bankName}
          />
          <Field
            label="Account name"
            name="accountName"
            hint="As the bank shows it."
            defaultValue={typed?.accountName ?? ""}
            error={errors?.accountName}
          />
          <Field
            label="Account number"
            name="bankAccountNumber"
            inputMode="numeric"
            autoComplete="off"
            placeholder="10 digits"
            maxLength={14}
            error={errors?.bankAccountNumber}
          />
        </div>
        <Field
          label="Reason"
          name="reason"
          hint="Optional. Shown to the approver, for example “Moved collections to GTBank”."
          maxLength={500}
          defaultValue={typed?.reason ?? ""}
          error={errors?.reason}
        />
        <FormAlert message={problem ?? (state && !state.ok ? state.formError : undefined)} />
        <div>
          <Button type="button" onClick={review} className="h-11 rounded-lg px-5">
            Review
          </Button>
        </div>
      </div>

      {preview ? (
        <div className="flex flex-col gap-4" data-testid="company-bank-preview">
          <dl className="m-0 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <dt className="type-label text-fg-muted">New account</dt>
              <dd className="m-0 text-[15px] break-words">{preview.newAccount}</dd>
            </div>
            {preview.replaces ? (
              <div className="flex flex-col gap-1">
                <dt className="type-label text-fg-muted">Replaces</dt>
                <dd className="m-0 text-[15px] break-words">{preview.replaces}</dd>
              </div>
            ) : null}
          </dl>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
            {preview.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel="Sending…" className="w-auto px-5">
              {first ? "Add account" : "Send for approval"}
            </SubmitButton>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreview(null)}
              className="h-11 rounded-lg px-4"
            >
              Edit
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

type DecisionKind = "approve" | "reject" | "stop";

const DECISION_LABEL: Record<DecisionKind, string> = {
  approve: "Approve",
  reject: "Reject",
  stop: "Stop this change",
};

/**
 * What a second person can do: approve or reject while it waits, or stop it during the hold.
 * The database refuses the requester even if these buttons were shown to them.
 */
export function CompanyBankDecision({
  accountId,
  decisions,
}: {
  accountId: string;
  decisions: readonly DecisionKind[];
}) {
  const [state, action, pending] = useActionState(decideCompanyBankAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium" data-testid="company-bank-decided">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} aria-label="Decide this request" className="flex flex-col gap-3">
      <input type="hidden" name="accountId" value={accountId} />
      <Field
        label="Note"
        name="note"
        hint="Optional. Kept with the decision."
        maxLength={500}
        className="max-w-md"
      />
      <div className="flex flex-wrap items-center gap-2">
        {decisions.map((decision) => (
          <Button
            key={decision}
            type="submit"
            name="decision"
            value={decision}
            variant={decision === "approve" ? "default" : "outline"}
            disabled={pending}
            className="h-10 rounded-lg"
          >
            {DECISION_LABEL[decision]}
          </Button>
        ))}
        {pending ? (
          <span role="status" className="text-sm text-fg-muted">
            Saving…
          </span>
        ) : null}
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
    </form>
  );
}

/** The requester takes back a request nobody has decided yet. */
export function CompanyBankWithdraw({ accountId }: { accountId: string }) {
  const [state, action, pending] = useActionState(withdrawCompanyBankAction, null);
  if (state?.ok) {
    return (
      <p role="status" className="m-0 text-sm font-medium">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <div>
        <Button type="submit" variant="outline" disabled={pending} className="h-10 rounded-lg">
          {pending ? "Withdrawing…" : "Withdraw request"}
        </Button>
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
    </form>
  );
}

/**
 * The masked number with a Show button for owner and finance. The full number is fetched only
 * on request, from the server, which checks the role and writes `pii.reveal` to the audit log.
 */
export function CompanyBankNumber({
  accountId,
  masked,
  canReveal,
}: {
  accountId: string;
  masked: string;
  canReveal: boolean;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function show() {
    setMessage(null);
    startTransition(async () => {
      const result = await revealCompanyBankAccount({ accountId });
      if (result.ok) {
        if (result.value === null) setMessage("Nothing on file.");
        else setValue(result.value);
      } else {
        setMessage(result.message);
      }
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono tabular-nums" data-testid="company-bank-number">
        {value ?? masked}
      </span>
      {canReveal ? (
        value === null ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={show}
            disabled={pending}
            aria-label="Show account number"
          >
            <Eye strokeWidth={1.75} aria-hidden />
            {pending ? "Showing…" : "Show"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => setValue(null)}
            aria-label="Hide account number"
          >
            <EyeOff strokeWidth={1.75} aria-hidden />
            Hide
          </Button>
        )
      ) : null}
      {message ? (
        <span role="status" className="text-xs text-fg-muted">
          {message}
        </span>
      ) : null}
    </span>
  );
}
