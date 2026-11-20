"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { HEADCOUNT_UNITS, HEADCOUNT_UNIT_LABELS, WEEKDAYS, WEEKDAY_SHORT } from "@/lib/headcount";
import {
  describeValues,
  formatWeek,
  parseRequirementInput,
  planAddPost,
  planClosePost,
  planRequirementChange,
  type LiveContract,
  type LivePost,
  type PostSite,
  type PostVersion,
  type RateKeyVersion,
  type RequirementInput,
} from "@/lib/live-changes";
import {
  addPostAction,
  changeRequirementAction,
  closePostAction,
} from "@/server/business/live-changes-actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

/**
 * The confirm steps for changes to a live contract (slice 2.8). Beside the fields, a live preview
 * says what closes, what starts and the weekly difference, from the same pure planners the
 * server's previews use (`src/lib/live-changes.ts`). The database checks everything again and
 * its refusal shows here when it does.
 */

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Errors = Record<string, string> | undefined;

function RequirementFields({
  value,
  onChange,
  errors,
}: {
  value: RequirementInput;
  onChange: (next: RequirementInput) => void;
  errors: Errors;
}) {
  function toggleDay(day: string, on: boolean) {
    const days = on ? [...value.days, day] : value.days.filter((d) => d !== day);
    onChange({ ...value, days: [...new Set(days)].sort() });
  }
  return (
    <>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-[13px] font-medium">Days</legend>
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 p-0">
          {WEEKDAYS.map((day) => {
            const v = String(day);
            return (
              <li key={day}>
                <label className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-[15px]">
                  <input
                    type="checkbox"
                    name="days"
                    value={v}
                    aria-label={DAY_NAMES[day - 1]}
                    checked={value.days.includes(v)}
                    onChange={(event) => toggleDay(v, event.currentTarget.checked)}
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
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,160px),1fr))] gap-4">
        <Field
          label="Starts"
          name="startTime"
          type="time"
          step={900}
          value={value.startTime}
          onChange={(e) => onChange({ ...value, startTime: e.currentTarget.value })}
          error={errors?.startTime}
        />
        <Field
          label="Ends"
          name="endTime"
          type="time"
          step={900}
          hint="At or before the start means the next day."
          value={value.endTime}
          onChange={(e) => onChange({ ...value, endTime: e.currentTarget.value })}
          error={errors?.endTime}
        />
        <Field
          label="People"
          name="requiredCount"
          inputMode="numeric"
          hint="How many at the post at once."
          value={value.requiredCount}
          onChange={(e) => onChange({ ...value, requiredCount: e.currentTarget.value })}
          error={errors?.requiredCount}
        />
      </div>
    </>
  );
}

function Preview({
  id,
  title,
  lines,
  refusal,
  testId,
}: {
  id: string;
  title: string;
  lines: { label: string; value: string }[] | null;
  refusal: string | null;
  testId: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-xl border border-line p-4 sm:p-5"
      data-testid={testId}
    >
      <h2 id={id} className="m-0 type-h3">
        {title}
      </h2>
      {refusal ? (
        <p className="m-0 text-sm" data-testid={`${testId}-refusal`}>
          {refusal}
        </p>
      ) : lines ? (
        <dl className="m-0 flex flex-col divide-y divide-line">
          {lines.map((line) => (
            <div key={line.label} className="flex flex-col gap-1 py-2.5">
              <dt className="text-sm font-medium">{line.label}</dt>
              <dd className="m-0 text-sm tabular-nums">{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="m-0 text-sm text-fg-muted">Fill in the date, days, hours and people.</p>
      )}
    </section>
  );
}

function Actions({ submit, pending, back }: { submit: string; pending: string; back: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
      <SubmitButton pendingLabel={pending} className="w-auto px-5">
        {submit}
      </SubmitButton>
      <Button asChild variant="outline" className="h-11 px-4">
        <Link href={back}>Cancel</Link>
      </Button>
    </div>
  );
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "Change headcount from": one post's days, hours and people from a date. */
export function ChangeRequirementForm({
  clientId,
  contract,
  post,
  versions,
  today,
  initial,
  initialFrom,
  back,
}: {
  clientId: string;
  contract: LiveContract & { id: string };
  post: LivePost;
  versions: PostVersion[];
  today: string;
  initial: RequirementInput;
  initialFrom: string;
  back: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(changeRequirementAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const [from, setFrom] = useState(state?.values?.from ?? initialFrom);
  const [input, setInput] = useState<RequirementInput>(initial);
  const [note, setNote] = useState(state?.values?.note ?? "");

  const plan = useMemo(() => {
    if (!ISO.test(from)) return null;
    const parsed = parseRequirementInput(input);
    if (!parsed.ok) return null;
    return planRequirementChange({ contract, post, versions, today, from, next: parsed.values });
  }, [from, input, contract, post, versions, today]);

  const lines = plan?.ok
    ? [
        plan.closes
          ? {
              label: `Now (from ${formatDate(plan.closes.effectiveFrom)})`,
              value: `${describeValues(plan.before)}, ends ${formatDate(plan.closes.effectiveToAfter)}`,
            }
          : {
              label: `Scheduled from ${formatDate(from)}`,
              value: `${describeValues(plan.before)}, replaced`,
            },
        {
          label: `From ${formatDate(from)}${plan.starts.effectiveTo ? ` to ${formatDate(plan.starts.effectiveTo)}` : ""}`,
          value: describeValues(plan.after),
        },
        {
          label: "A week of this post",
          value: `${formatWeek(plan.week.before)} → ${formatWeek(plan.week.after)}`,
        },
      ]
    : null;

  return (
    <form
      action={action}
      noValidate
      aria-label="Change headcount"
      className="flex max-w-[960px] flex-col gap-6"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contract.id} />
      <input type="hidden" name="postId" value={post.id} />
      <Field
        label="From"
        name="from"
        type="date"
        min={today}
        max={post.closedOn ?? contract.endDate ?? undefined}
        value={from}
        onChange={(e) => setFrom(e.currentTarget.value)}
        hint="The first day the new numbers apply. Days before it keep the current ones."
        error={errors?.from}
        required
      />
      <RequirementFields value={input} onChange={setInput} errors={errors} />
      <Field
        label="Note"
        name="note"
        maxLength={500}
        placeholder="Client asked for a second guard at night"
        hint="Optional. Kept with the change."
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
        error={errors?.note}
      />
      <Preview
        id="change-preview"
        title="What changes"
        lines={lines}
        refusal={plan && !plan.ok ? plan.reason : null}
        testId="change-preview"
      />
      {plan?.ok ? (
        <p className="m-0 text-sm font-medium" data-testid="change-summary">
          {plan.summary}
        </p>
      ) : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <Actions submit="Save change" pending="Saving…" back={back} />
    </form>
  );
}

/** "Add post": a new post on a live contract from a date. */
export function AddPostForm({
  clientId,
  contract,
  today,
  sites,
  openPostNames,
  rates,
  initialFrom,
  back,
}: {
  clientId: string;
  contract: LiveContract & { id: string; clientArchived: boolean };
  today: string;
  sites: PostSite[];
  openPostNames: Record<string, string[]>;
  rates: RateKeyVersion[];
  initialFrom: string;
  back: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(addPostAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const v = state?.values;
  const onContract = sites.filter((s) => s.onContract);
  const [siteId, setSiteId] = useState(v?.siteId ?? (onContract.length === 1 ? onContract[0]!.id : ""));
  const [postName, setPostName] = useState(v?.postName ?? "");
  const [role, setRole] = useState(v?.role ?? "");
  const [band, setBand] = useState(v?.band ?? "");
  const [unit, setUnit] = useState(v?.unit ?? (contract.type === "per_visit" ? "visit" : "shift"));
  const [from, setFrom] = useState(v?.from ?? initialFrom);
  const [note, setNote] = useState(v?.note ?? "");
  const [input, setInput] = useState<RequirementInput>({
    days: ["1", "2", "3", "4", "5", "6", "7"],
    startTime: "06:00",
    endTime: "18:00",
    requiredCount: "1",
  });
  const site = sites.find((s) => s.id === siteId) ?? null;

  const plan = useMemo(() => {
    if (!ISO.test(from) || !site || !role.trim()) return null;
    const parsed = parseRequirementInput(input);
    if (!parsed.ok) return null;
    return planAddPost({
      contract,
      today,
      input: {
        ...parsed.values,
        siteId: site.id,
        postName,
        role,
        band,
        unit: unit as (typeof HEADCOUNT_UNITS)[number],
        from,
      },
      site,
      addSite: !site.onContract,
      clientArchived: contract.clientArchived,
      openPostNames: openPostNames[site.id] ?? [],
      rates,
    });
  }, [from, site, role, band, unit, postName, input, contract, today, openPostNames, rates]);

  const lines = plan?.ok
    ? [
        ...(plan.siteAdded ? [{ label: "Contract sites", value: `Adds ${plan.siteName}` }] : []),
        { label: `${plan.name} at ${plan.siteName}`, value: `Opens ${formatDate(from)}` },
        { label: "A week of this post", value: formatWeek(plan.week) },
      ]
    : null;

  const roles = [...new Set(rates.flatMap((r) => r.lines.map((l) => l.role)))];
  const bands = [
    ...new Set(rates.flatMap((r) => r.lines.map((l) => l.band)).filter((b) => b !== "standard")),
  ];

  return (
    <form action={action} noValidate aria-label="Add post" className="flex max-w-[960px] flex-col gap-6">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contract.id} />
      <input type="hidden" name="addSite" value={site && !site.onContract ? "true" : "false"} />
      <section aria-labelledby="post-where" className="flex flex-col gap-4">
        <h2 id="post-where" className="m-0 type-h3">
          Where and who
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
          <SelectField
            label="Site"
            name="siteId"
            value={siteId}
            onChange={(e) => setSiteId(e.currentTarget.value)}
            placeholder="Choose a site"
            options={sites.map((s) => ({
              value: s.id,
              label: s.onContract ? s.name : `${s.name} (adds it to the contract)`,
            }))}
            error={errors?.siteId}
          />
          <Field
            label="Post"
            name="postName"
            placeholder="Gate C"
            hint="Optional. Without one the role names the post."
            value={postName}
            onChange={(e) => setPostName(e.currentTarget.value)}
            error={errors?.postName}
          />
          <Field
            label="Role"
            name="role"
            placeholder="Guard"
            list="post-roles"
            value={role}
            onChange={(e) => setRole(e.currentTarget.value)}
            error={errors?.role}
          />
          <Field
            label="Band"
            name="band"
            placeholder="Night"
            hint="Blank if the role has one rate."
            list="post-bands"
            value={band}
            onChange={(e) => setBand(e.currentTarget.value)}
            error={errors?.band}
          />
          <SelectField
            label="Billed"
            name="unit"
            value={unit}
            onChange={(e) => setUnit(e.currentTarget.value)}
            options={HEADCOUNT_UNITS.map((u) => ({ value: u, label: HEADCOUNT_UNIT_LABELS[u] }))}
            error={errors?.unit}
          />
          <Field
            label="From"
            name="from"
            type="date"
            min={today}
            max={contract.endDate ?? undefined}
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value)}
            error={errors?.from}
            required
          />
        </div>
        <datalist id="post-roles">
          {roles.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <datalist id="post-bands">
          {bands.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </section>
      <section aria-labelledby="post-when" className="flex flex-col gap-4">
        <h2 id="post-when" className="m-0 type-h3">
          When
        </h2>
        <RequirementFields value={input} onChange={setInput} errors={errors} />
        <Field
          label="Note"
          name="note"
          maxLength={500}
          placeholder="New gate opened by the client"
          hint="Optional. Kept with the change."
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          error={errors?.note}
        />
      </section>
      <Preview
        id="add-post-preview"
        title="What changes"
        lines={lines}
        refusal={plan && !plan.ok ? plan.reason : null}
        testId="add-post-preview"
      />
      {plan?.ok ? (
        <p className="m-0 text-sm font-medium" data-testid="add-post-summary">
          {plan.summary}
        </p>
      ) : null}
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <Actions submit="Add post" pending="Adding…" back={back} />
    </form>
  );
}

/** "Close post": the last day staffed and why. */
export function ClosePostForm({
  clientId,
  contract,
  post,
  versions,
  today,
  back,
}: {
  clientId: string;
  contract: LiveContract & { id: string };
  post: LivePost;
  versions: PostVersion[];
  today: string;
  back: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(closePostAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const [lastDay, setLastDay] = useState(state?.values?.lastDay ?? today);
  const [reason, setReason] = useState(state?.values?.reason ?? "");
  const plan = useMemo(
    () =>
      ISO.test(lastDay)
        ? planClosePost({ contract, post, versions, today, lastDay, reason: reason || "-" })
        : null,
    [lastDay, reason, contract, post, versions, today],
  );
  return (
    <form
      action={action}
      noValidate
      aria-label="Close post"
      className="flex max-w-[720px] flex-col gap-6"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="contractId" value={contract.id} />
      <input type="hidden" name="postId" value={post.id} />
      <Field
        label="Last day staffed"
        name="lastDay"
        type="date"
        min={today}
        value={lastDay}
        onChange={(e) => setLastDay(e.currentTarget.value)}
        hint="The post is staffed up to and including this day."
        error={errors?.lastDay}
        required
      />
      <Field
        label="Reason"
        name="reason"
        maxLength={500}
        placeholder="Client closed the night gate"
        hint="Seen by owners, admins, finance and ops managers only."
        value={reason}
        onChange={(e) => setReason(e.currentTarget.value)}
        error={errors?.reason}
        required
      />
      <Preview
        id="close-preview"
        title="What changes"
        lines={
          plan?.ok
            ? [
                { label: post.name, value: plan.summary },
                {
                  label: "A week of this post",
                  value: `${formatWeek(plan.week.before)} → none`,
                },
              ]
            : null
        }
        refusal={plan && !plan.ok ? plan.reason : null}
        testId="close-preview"
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <Actions submit="Close post" pending="Closing…" back={back} />
    </form>
  );
}
