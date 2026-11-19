"use client";

import Link from "next/link";
import { useActionState, useId, useMemo, useState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  HEADCOUNT_UNITS,
  HEADCOUNT_UNIT_LABELS,
  WEEKDAYS,
  WEEKDAY_SHORT,
  describeRow,
  formatDays,
  formatHours,
  headcountIsPriced,
  parseHeadcountInput,
  postLabel,
  previewHeadcountChange,
  weeklyHeadcount,
  type HeadcountInput,
  type HeadcountLine,
} from "@/lib/headcount";
import { parseRateLine, type RateLine, type RateLineInput } from "@/lib/rate-cards";
import {
  addHeadcountAction,
  removeHeadcountAction,
  updateHeadcountAction,
} from "@/server/business/headcount-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const EDITING = "headcount-row-being-edited";

/**
 * Adds or changes one headcount row of a draft contract. Beside the fields, a live line says
 * what the row comes to in a week at the rates the Headcount tab uses, flags a role and band
 * with no rate line, and shows the weekly total before and after: the same preview the server
 * and the ops agent's card use (`previewHeadcountChange`). Rates arrive as typed text so no
 * bigint crosses to the browser.
 */
export function HeadcountForm({
  clientId,
  contractId,
  contractType,
  headcountId,
  sites,
  initial,
  lines,
  rateLines,
  ratesLabel,
}: {
  clientId: string;
  contractId: string;
  contractType: string;
  /** Set when editing an existing row. */
  headcountId?: string;
  sites: { id: string; name: string }[];
  initial: HeadcountInput;
  /** The contract's rows as they are now. */
  lines: HeadcountLine[];
  /** The rate card the weekly total uses, or null when there is none. */
  rateLines: RateLineInput[] | null;
  ratesLabel: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    headcountId ? updateHeadcountAction : addHeadcountAction,
    null,
  );
  const [input, setInput] = useState<HeadcountInput>(initial);
  const roleList = useId();
  const bandList = useId();
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  const version = useMemo(() => {
    if (!rateLines) return null;
    const parsed: RateLine[] = rateLines.flatMap((l) => {
      const p = parseRateLine(l);
      return p.ok ? [p.line] : [];
    });
    return { lines: parsed };
  }, [rateLines]);

  const roles = useMemo(() => [...new Set((version?.lines ?? []).map((l) => l.role))], [version]);
  const bands = useMemo(
    () =>
      [...new Set((version?.lines ?? []).map((l) => l.band))].filter(
        (b) => b.toLowerCase() !== "standard",
      ),
    [version],
  );

  const parsed = useMemo(() => parseHeadcountInput(input), [input]);
  const preview = useMemo(() => {
    if (!parsed.ok) return null;
    const row: HeadcountLine = { ...parsed.line, id: headcountId ?? EDITING };
    const after = headcountId
      ? lines.map((l) => (l.id === headcountId ? row : l))
      : [...lines, row];
    const names = new Map(sites.map((s) => [s.id, s.name]));
    const change = previewHeadcountChange({
      before: lines,
      after,
      version,
      contractType,
      siteName: (id) => names.get(id) ?? "the site",
      ratesLabel,
    });
    const week = weeklyHeadcount([row], version, contractType);
    return {
      row: {
        label: `${postLabel(row)} at ${names.get(row.siteId) ?? "the site"}`,
        text: `${formatDays(row.daysOfWeek)} ${formatHours(row)} × ${row.requiredCount}: ${describeRow(week.rows[0]!, week.priced)}`,
      },
      total: change.changes[change.changes.length - 1],
    };
  }, [parsed, lines, headcountId, version, contractType, sites, ratesLabel]);

  const set =
    (key: Exclude<keyof HeadcountInput, "days">) => (event: { currentTarget: { value: string } }) =>
      setInput({ ...input, [key]: event.currentTarget.value });

  function toggleDay(day: string, on: boolean) {
    const days = on ? [...input.days, day] : input.days.filter((d) => d !== day);
    setInput({ ...input, days: [...new Set(days)].sort() });
  }

  const back = `/app/clients/${clientId}/contracts/${contractId}?tab=headcount`;
  const thisRow = preview?.row;
  const total = preview?.total;

  return (
    <form
      action={action}
      noValidate
      aria-label={headcountId ? "Change headcount row" : "Add headcount row"}
      className="flex max-w-[960px] flex-col gap-6"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contractId} />
      {headcountId ? <input type="hidden" name="headcountId" value={headcountId} /> : null}

      <section aria-labelledby="headcount-post" className="flex flex-col gap-4">
        <h2 id="headcount-post" className="m-0 type-h3">
          Post
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
          <SelectField
            label="Site"
            name="siteId"
            value={input.siteId}
            onChange={set("siteId")}
            placeholder={sites.length === 1 ? undefined : "Choose a site"}
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
            error={errors?.siteId}
          />
          <Field
            label="Post"
            name="postName"
            placeholder="Gate A"
            hint="Optional. Without one the role names the post."
            value={input.postName}
            onChange={set("postName")}
            error={errors?.postName}
          />
          <Field
            label="Role"
            name="role"
            placeholder="Guard"
            list={roleList}
            value={input.role}
            onChange={set("role")}
            error={errors?.role}
          />
          <Field
            label="Band"
            name="band"
            placeholder="Day"
            hint="Blank if the role has one rate."
            list={bandList}
            value={input.band}
            onChange={set("band")}
            error={errors?.band}
          />
          <SelectField
            label="Billed"
            name="unit"
            value={input.unit}
            onChange={set("unit")}
            options={HEADCOUNT_UNITS.map((u) => ({ value: u, label: HEADCOUNT_UNIT_LABELS[u] }))}
            error={errors?.unit}
          />
          <Field
            label="People"
            name="requiredCount"
            inputMode="numeric"
            placeholder="1"
            hint="How many people at the post at once."
            value={input.requiredCount}
            onChange={set("requiredCount")}
            error={errors?.requiredCount}
          />
        </div>
        <datalist id={roleList}>
          {roles.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <datalist id={bandList}>
          {bands.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </section>

      <section aria-labelledby="headcount-when" className="flex flex-col gap-4">
        <h2 id="headcount-when" className="m-0 type-h3">
          When
        </h2>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] font-medium">Days</legend>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 p-0">
            {WEEKDAYS.map((day) => {
              const value = String(day);
              return (
                <li key={day}>
                  <label className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-[15px]">
                    <input
                      type="checkbox"
                      name="days"
                      value={value}
                      aria-label={DAY_NAMES[day - 1]}
                      checked={input.days.includes(value)}
                      onChange={(event) => toggleDay(value, event.currentTarget.checked)}
                      className="size-4 accent-[var(--fg)]"
                    />
                    {WEEKDAY_SHORT[day - 1]}
                  </label>
                </li>
              );
            })}
          </ul>
          {errors?.days ? <p className="m-0 text-xs font-medium">{errors.days}</p> : null}
        </fieldset>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-4">
          <Field
            label="Starts"
            name="startTime"
            type="time"
            step={900}
            value={input.startTime}
            onChange={set("startTime")}
            error={errors?.startTime}
          />
          <Field
            label="Ends"
            name="endTime"
            type="time"
            step={900}
            hint="At or before the start means the next day. The same time is 24 hours."
            value={input.endTime}
            onChange={set("endTime")}
            error={errors?.endTime}
          />
        </div>
        <Field
          label="Notes"
          name="notes"
          placeholder="Armed response on call"
          value={input.notes}
          onChange={set("notes")}
          error={errors?.notes}
        />
      </section>

      <section
        aria-labelledby="headcount-preview"
        className="flex flex-col gap-3 rounded-xl border border-line p-4 sm:p-5"
      >
        <h2 id="headcount-preview" className="m-0 type-h3">
          A week of this post
        </h2>
        {preview && thisRow ? (
          <dl className="m-0 flex flex-col divide-y divide-line">
            <div className="flex flex-col gap-1 py-2.5">
              <dt className="text-sm font-medium">{thisRow.label}</dt>
              <dd className="m-0 text-sm tabular-nums" data-testid="headcount-row-preview">
                {thisRow.text}
              </dd>
            </div>
            {total ? (
              <div className="flex flex-col gap-1 py-2.5">
                <dt className="text-sm font-medium">Weekly total</dt>
                <dd className="m-0 text-sm tabular-nums" data-testid="headcount-total-preview">
                  {total.before && total.before !== total.after ? (
                    <>
                      <span className="text-fg-muted">{total.before}</span> →{" "}
                    </>
                  ) : null}
                  {total.after}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="m-0 text-sm text-fg-muted">
            Fill in the site, role, days, hours and people to see the week.
          </p>
        )}
        {headcountIsPriced(contractType) ? (
          <p className="m-0 text-xs text-fg-muted">
            Priced from the rate card by role, band and how it is billed, without VAT. Nothing is
            charged from this; invoices come later.
          </p>
        ) : (
          <p className="m-0 text-xs text-fg-muted">
            This contract bills an agreed amount, so headcount here is the staffing plan only.
          </p>
        )}
      </section>

      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          {headcountId ? "Save row" : "Add row"}
        </SubmitButton>
        <Button asChild variant="outline" className="h-11 px-4">
          <Link href={back}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

/** Takes a row off a draft contract's headcount, after a second click to confirm. */
export function RemoveHeadcountButton({
  clientId,
  contractId,
  headcountId,
  label,
}: {
  clientId: string;
  contractId: string;
  headcountId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<CompanyFormState, FormData>(
    removeHeadcountAction,
    null,
  );
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="px-0 text-sm"
        aria-label={`Remove ${label}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
    );
  }
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-3">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="headcountId" value={headcountId} />
      <span className="text-sm">Remove {label}?</span>
      <Button type="submit" variant="link" size="sm" disabled={pending} className="px-0 text-sm">
        {pending ? "Removing…" : "Yes, remove"}
      </Button>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="px-0 text-sm"
        onClick={() => setConfirming(false)}
      >
        Keep
      </Button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs font-medium">
          {state.formError}
        </span>
      ) : null}
    </form>
  );
}
