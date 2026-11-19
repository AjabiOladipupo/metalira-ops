"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";

import { Field } from "@/components/form";
import { NameCheckStatus, TestLookupBadge } from "@/components/name-check";
import { Button } from "@/components/ui/button";
import { NEAR_REASON_MIN, type NameMatchResult } from "@/lib/bank-name-match";
import { bankByCode, searchBanks, type Bank } from "@/lib/banks";
import { cn } from "@/lib/utils";

/**
 * Bank picker, account number and the bank's account name (slice 2.3b). Used wherever bank
 * details are entered: the company account, adding an employee, a bank change (HR and the worker
 * app), and "Check bank details".
 *
 * The person picks a bank and types the 10-digit number; the account name is looked up from the
 * bank network by the server (`lookup`) and shown read-only, with how it compares with the
 * expected name. A close match asks for a reason; no match can't be sent. The form sends
 * `bankCode`, `bankAccountNumber`, `bankLookupId` and `nameCheckReason`; the server takes the
 * name from the lookup, never from the browser.
 */

export type BankLookupResult =
  | {
      ok: true;
      lookupId: string;
      bankCode: string;
      bankName: string;
      accountName: string;
      test: boolean;
      result: NameMatchResult;
      expected: string;
    }
  | { ok: false; message: string; field?: "bankCode" | "bankAccountNumber" };

export type BankLookupState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; result: Extract<BankLookupResult, { ok: true }> }
  | { status: "error"; message: string };

const INPUT =
  "w-full min-w-0 rounded-lg border border-line bg-background px-3 text-[15px] text-foreground placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-foreground";

// ---------------------------------------------------------------------------
// Bank picker (combobox)
// ---------------------------------------------------------------------------

export function BankPicker({
  label,
  name,
  value,
  onChange,
  error,
  hint,
  inputSize = "md",
}: {
  label: string;
  /** Name of the hidden input that carries the bank code. */
  name: string;
  value: string;
  onChange: (code: string) => void;
  error?: string;
  hint?: string;
  inputSize?: "md" | "lg";
}) {
  const id = useId();
  const listId = `${id}-list`;
  const noteId = `${id}-note`;
  const selected = bankByCode(value);
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const options = useMemo(
    () => (open && query === (selected?.name ?? "") ? searchBanks("") : searchBanks(query)),
    [open, query, selected],
  );
  const note = error ?? hint;

  function choose(bank: Bank) {
    onChange(bank.code);
    setQuery(bank.name);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.children[active] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <input type="hidden" name={name} value={value} />
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        placeholder="Search banks"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && options[active] ? `${listId}-${options[active].code}` : undefined
        }
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={cn(INPUT, inputSize === "lg" ? "h-[52px] text-base" : "h-11")}
        value={query}
        onFocus={(event) => {
          setOpen(true);
          setActive(0);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
          if (value) onChange("");
        }}
        onBlur={() => {
          setOpen(false);
          // Typed text that isn't a bank goes back to the chosen bank (or stays empty).
          setQuery(bankByCode(value)?.name ?? "");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (event.key === "Enter" && open) {
            const bank = options[active];
            if (bank) {
              event.preventDefault();
              choose(bank);
            }
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-background py-1 shadow-md"
        >
          {options.length === 0 ? (
            <li className="px-3 py-2 text-sm text-fg-muted">No bank matches “{query}”.</li>
          ) : (
            options.map((bank, index) => (
              <li
                key={bank.code}
                id={`${listId}-${bank.code}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(bank);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-[15px]",
                  index === active && "bg-surface",
                )}
              >
                <span>{bank.name}</span>
                <span className="font-mono text-xs text-fg-muted tabular-nums">{bank.code}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
      {note ? (
        <p
          id={noteId}
          className={cn("m-0 text-xs", error ? "font-medium text-foreground" : "text-fg-muted")}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

export function BankAccountFields({
  lookup,
  labelPrefix = "",
  defaultBankCode = "",
  errors,
  defaultReason = "",
  inputSize = "md",
  onStateChange,
  whose = "the right",
}: {
  /** Looks the account up on the server (a Server Action bound to the form's context). */
  lookup: (input: { bankCode: string; bankAccountNumber: string }) => Promise<BankLookupResult>;
  /** "New " on a bank change. */
  labelPrefix?: string;
  defaultBankCode?: string;
  errors?: Partial<Record<string, string>>;
  defaultReason?: string;
  inputSize?: "md" | "lg";
  onStateChange?: (state: BankLookupState) => void;
  /** Whose name the account should be in, for the no-match sentence ("the employee's"). */
  whose?: string;
}) {
  const [bankCode, setBankCode] = useState(defaultBankCode);
  const [number, setNumber] = useState("");
  const [state, setStateRaw] = useState<BankLookupState>({ status: "idle" });
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [, startTransition] = useTransition();
  const sequence = useRef(0);
  const reasonId = useId();

  function setState(next: BankLookupState) {
    setStateRaw(next);
    onStateChange?.(next);
  }

  const digits = number.replace(/[\s-]/g, "");
  const ready = bankCode !== "" && /^\d{10}$/.test(digits);

  function check(code = bankCode, account = digits) {
    if (!code || !/^\d{10}$/.test(account)) return;
    const ticket = ++sequence.current;
    setFieldError(null);
    setState({ status: "checking" });
    startTransition(async () => {
      let result: BankLookupResult;
      try {
        result = await lookup({ bankCode: code, bankAccountNumber: account });
      } catch {
        result = { ok: false, message: "The account couldn't be checked. Try again in a minute." };
      }
      // A newer check (the bank or number changed meanwhile) wins.
      if (ticket !== sequence.current) return;
      if (result.ok) {
        setState({ status: "done", result });
      } else {
        setState({ status: "error", message: result.message });
        if (result.field) setFieldError({ field: result.field, message: result.message });
      }
    });
  }

  function reset() {
    sequence.current += 1;
    setFieldError(null);
    if (state.status !== "idle") setState({ status: "idle" });
  }

  const done = state.status === "done" ? state.result : null;
  const bankError =
    (fieldError?.field === "bankCode" ? fieldError.message : undefined) ?? errors?.bankCode;
  const numberError =
    (fieldError?.field === "bankAccountNumber" ? fieldError.message : undefined) ??
    (state.status === "idle" ? errors?.bankAccountNumber : undefined);

  return (
    <div className="flex flex-col gap-4" data-testid="bank-account-fields">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
        <BankPicker
          label={labelPrefix ? `${labelPrefix}bank` : "Bank"}
          name="bankCode"
          value={bankCode}
          inputSize={inputSize}
          error={bankError}
          onChange={(code) => {
            setBankCode(code);
            reset();
            if (code && /^\d{10}$/.test(digits)) check(code, digits);
          }}
        />
        <Field
          label={labelPrefix ? `${labelPrefix}account number` : "Account number"}
          name="bankAccountNumber"
          inputMode="numeric"
          autoComplete="off"
          placeholder="10 digits"
          maxLength={14}
          inputSize={inputSize}
          value={number}
          error={numberError}
          hint={bankCode ? undefined : "Choose the bank first."}
          onChange={(event) => {
            const next = event.target.value;
            setNumber(next);
            reset();
            const nextDigits = next.replace(/[\s-]/g, "");
            if (bankCode && /^\d{10}$/.test(nextDigits)) check(bankCode, nextDigits);
          }}
        />
      </div>

      <input type="hidden" name="bankLookupId" value={done?.lookupId ?? ""} />

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.status === "checking" ? (
          <p className="m-0 inline-flex items-center gap-2 text-sm text-fg-muted" role="status">
            <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden />
            Checking the account name with the bank…
          </p>
        ) : null}

        {state.status === "error" ? (
          <div className="flex flex-wrap items-center gap-3" data-testid="bank-lookup-error">
            <p className="m-0 text-sm font-medium">{state.message}</p>
            {ready ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 rounded-lg"
                onClick={() => check()}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}

        {done ? (
          <div
            className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-3"
            data-testid="bank-lookup-result"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="type-label text-fg-muted">Account name from the bank</span>
              {done.test ? <TestLookupBadge /> : null}
            </div>
            <p className="m-0 text-[15px] font-semibold break-words" data-testid="bank-lookup-name">
              {done.accountName}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <NameCheckStatus status={done.result} />
              {done.result !== "match" ? (
                <span className="text-sm text-fg-muted">Expected: {done.expected}</span>
              ) : null}
            </div>
            {done.result === "no_match" ? (
              <p className="m-0 text-sm" role="alert">
                This account belongs to someone else, so it can&apos;t be used. Use an account in{" "}
                {whose} name.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {done?.result === "near" ? (
        <Field
          key={reasonId}
          label="Why is this the right account?"
          name="nameCheckReason"
          hint={`The names are close but not the same. At least ${NEAR_REASON_MIN} characters; the approver sees it.`}
          maxLength={500}
          defaultValue={defaultReason}
          error={errors?.nameCheckReason}
          required
          minLength={NEAR_REASON_MIN}
        />
      ) : (
        <input type="hidden" name="nameCheckReason" value="" />
      )}
    </div>
  );
}
