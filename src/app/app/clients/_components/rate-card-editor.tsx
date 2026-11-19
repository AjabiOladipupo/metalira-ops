"use client";

import Link from "next/link";
import { useActionState, useId, useMemo, useState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import {
  RATE_UNIT_LABELS,
  RATE_UNITS,
  diffRateLines,
  duplicateRateKeys,
  formatLineRate,
  formatOvertime,
  formatRateKey,
  formatRateSummary,
  parseRateLine,
  previewRateChange,
  type ContractDates,
  type RateCardVersion,
  type RateLine,
  type RateLineInput,
} from "@/lib/rate-cards";
import {
  addRateCardVersionAction,
  saveDraftRateCardAction,
} from "@/server/business/contract-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

/** A version as the page hands it over: amounts as typed text, so no bigint crosses the wire. */
export interface EditorVersion {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  lines: RateLineInput[];
}

const EMPTY_LINE: RateLineInput = {
  role: "",
  band: "",
  unit: "shift",
  rate: "",
  otRate: "",
  otMultiplier: "",
};

function parseAll(inputs: readonly RateLineInput[]): {
  lines: RateLine[];
  problem: string | null;
} {
  const lines: RateLine[] = [];
  for (const [index, input] of inputs.entries()) {
    const parsed = parseRateLine(input);
    if (!parsed.ok) return { lines, problem: `Line ${index + 1}: ${parsed.message}` };
    lines.push(parsed.line);
  }
  if (lines.length === 0) return { lines, problem: "Add at least one rate line" };
  const [duplicate] = duplicateRateKeys(lines);
  if (duplicate) {
    return {
      lines,
      problem: `${formatRateKey(duplicate)} is on the card twice. Give each role and band one rate.`,
    };
  }
  return { lines, problem: null };
}

function toVersion(v: EditorVersion): RateCardVersion {
  return {
    id: v.id,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
    note: v.note,
    lines: v.lines.flatMap((input) => {
      const parsed = parseRateLine(input);
      return parsed.ok ? [parsed.line] : [];
    }),
  };
}

function LineEditor({
  index,
  line,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number;
  line: RateLineInput;
  onChange: (next: RateLineInput) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const unitId = useId();
  const set = (key: keyof RateLineInput) => (event: { currentTarget: { value: string } }) =>
    onChange({ ...line, [key]: event.currentTarget.value });
  return (
    <li
      aria-label={`Rate line ${index + 1}`}
      className="flex flex-col gap-3 rounded-xl border border-line p-4"
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-3">
        <Field label="Role" placeholder="Guard" value={line.role} onChange={set("role")} />
        <Field
          label="Band"
          placeholder="Day"
          hint="Blank if the role has one rate."
          value={line.band}
          onChange={set("band")}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={unitId} className="text-[13px] font-medium">
            Per
          </label>
          <select
            id={unitId}
            value={line.unit}
            onChange={set("unit")}
            className="h-11 w-full min-w-0 rounded-lg border border-line bg-background px-3 text-[15px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            {RATE_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {RATE_UNIT_LABELS[unit]}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Rate (₦)"
          inputMode="decimal"
          placeholder="12,500"
          value={line.rate}
          onChange={set("rate")}
        />
        <Field
          label="Overtime rate an hour (₦)"
          inputMode="decimal"
          placeholder="1,600"
          value={line.otRate}
          onChange={set("otRate")}
        />
        <Field
          label="Overtime multiplier"
          inputMode="decimal"
          placeholder="1.5"
          hint="Shown when there is no hourly rate."
          value={line.otMultiplier}
          onChange={set("otMultiplier")}
        />
      </div>
      {canRemove ? (
        <div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0 text-sm"
            onClick={onRemove}
            aria-label={`Remove line ${index + 1}`}
          >
            Remove line
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The rate card editor. On a draft contract it saves the card whole ("Save rate card"). On "Change
 * rates from" it adds a dated version: before saving, the review step shows what closes, what
 * starts and which lines change (the same preview the server and the ops agent use).
 * Rates are without VAT.
 */
export function RateCardEditor({
  mode,
  clientId,
  contractId,
  contract,
  versions,
  initialLines,
  defaultFrom,
  minFrom,
  today,
}: {
  mode: "draft" | "change";
  clientId: string;
  contractId: string;
  contract: ContractDates;
  versions: EditorVersion[];
  initialLines: RateLineInput[];
  defaultFrom: string;
  minFrom: string;
  today: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    mode === "draft" ? saveDraftRateCardAction : addRateCardVersionAction,
    null,
  );
  const [lines, setLines] = useState<RateLineInput[]>(
    initialLines.length > 0 ? initialLines : [{ ...EMPTY_LINE }],
  );
  const [from, setFrom] = useState(
    state && !state.ok ? (state.values?.effectiveFrom ?? defaultFrom) : defaultFrom,
  );
  const [note, setNote] = useState("");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [problem, setProblem] = useState<string | null>(null);

  const parsedVersions = useMemo(() => versions.map(toVersion), [versions]);
  const parsed = useMemo(() => parseAll(lines), [lines]);

  const preview = useMemo(() => {
    if (parsed.problem) return null;
    if (mode === "change") {
      return previewRateChange(parsedVersions, from, today, contract, parsed.lines);
    }
    const current = parsedVersions[0] ?? null;
    const diff = diffRateLines(current?.lines ?? null, parsed.lines);
    return {
      ok: true,
      summary: `${current ? "Replaces" : "Adds"} the rate card from ${formatDate(from)}.`,
      changes: diff.changes.map((change) => ({
        label: formatRateKey(change.key),
        before: change.before ? formatLineRate(change.before) : undefined,
        after: change.after ? formatLineRate(change.after) : "Removed",
      })),
    };
  }, [parsed, parsedVersions, from, today, contract, mode]);

  function review() {
    if (!from) {
      setProblem("Choose the date the rates start");
      return;
    }
    if (parsed.problem) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    setStep("review");
  }

  const serverError = state && !state.ok ? state.formError : undefined;
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;
  const back = `/app/clients/${clientId}/contracts/${contractId}?tab=rates`;

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      {step === "edit" ? (
        <div className="flex flex-col gap-6" aria-label="Rate lines">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4">
            <Field
              label={mode === "change" ? "New rates from" : "Rates from"}
              type="date"
              min={minFrom}
              value={from}
              onChange={(event) => setFrom(event.currentTarget.value)}
              hint={
                mode === "change"
                  ? "The current rates end the day before."
                  : "Usually the contract's start date."
              }
              error={fieldErrors?.effectiveFrom}
            />
            <Field
              label="Note"
              placeholder="Rates agreed in the January review"
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
              error={fieldErrors?.note}
            />
          </div>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {lines.map((line, index) => (
              <LineEditor
                key={index}
                index={index}
                line={line}
                canRemove={lines.length > 1}
                onChange={(next) => setLines(lines.map((l, i) => (i === index ? next : l)))}
                onRemove={() => setLines(lines.filter((_, i) => i !== index))}
              />
            ))}
          </ol>
          <div>
            <Button
              type="button"
              variant="outline"
              className="h-11 px-4"
              onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
            >
              Add line
            </Button>
          </div>
          <p className="m-0 text-sm text-fg-muted">
            Rates are without VAT. VAT is added on invoices when the contract charges it.
          </p>
          <FormAlert message={problem ?? fieldErrors?.lines ?? serverError} />
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button type="button" className="h-11 px-5 text-sm" onClick={review}>
              Review
            </Button>
            <Button asChild variant="outline" className="h-11 px-4">
              <Link href={back}>Cancel</Link>
            </Button>
          </div>
        </div>
      ) : (
        <form
          action={action}
          aria-label={mode === "change" ? "Confirm rate change" : "Confirm rate card"}
          className="flex flex-col gap-5"
        >
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="contractId" value={contractId} />
          <input type="hidden" name="effectiveFrom" value={from} />
          <input type="hidden" name="note" value={note} />
          <input type="hidden" name="lines" value={JSON.stringify(lines)} />
          <section
            aria-labelledby="rate-review"
            className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
          >
            <h2 id="rate-review" className="m-0 type-h3">
              {mode === "change" ? "Check the change" : "Check the rate card"}
            </h2>
            <p className="m-0 text-[15px]" data-testid="rate-preview-summary">
              {preview?.summary}
            </p>
            {preview && preview.changes.length > 0 ? (
              <dl className="m-0 flex flex-col divide-y divide-line">
                {preview.changes.map((change, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5"
                  >
                    <dt className="text-sm font-medium">{change.label}</dt>
                    <dd className="m-0 text-sm tabular-nums">
                      {change.before ? (
                        <>
                          <span className="text-fg-muted">{change.before}</span> →{" "}
                        </>
                      ) : null}
                      {change.after}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <div className="flex flex-col gap-1 border-t border-line pt-3">
              <span className="type-label text-fg-muted">New card</span>
              <span className="text-sm">{formatRateSummary(parsed.lines)}</span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-fg-muted">
                {parsed.lines.map((line, i) => (
                  <li key={i}>
                    {formatRateKey(line)}: {formatLineRate(line)}, overtime{" "}
                    {formatOvertime(line).toLowerCase()}
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <FormAlert
            message={preview && !preview.ok ? preview.summary : (fieldErrors?.lines ?? serverError)}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            {preview?.ok ? (
              <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
                {mode === "change" ? "Save rate change" : "Save rate card"}
              </SubmitButton>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="h-11 px-4"
              onClick={() => setStep("edit")}
            >
              Back to edit
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
