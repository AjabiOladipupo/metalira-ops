"use client";

import { useActionState, useState } from "react";

import { Field, FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  addRuleSetVersionAction,
  confirmRuleSetAction,
  type RuleSetFormState,
} from "@/server/payroll/rule-sets-actions";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4";

export interface BandField {
  index: number;
  /** "First", "Next" or "Above ₦50,000,000" for the open band. */
  label: string;
  open: boolean;
}

/** What the user typed (kept across the preview and refusals), else the saved value. */
function value(state: RuleSetFormState, name: string, saved: string | undefined): string {
  return state?.values?.[name] ?? saved ?? "";
}

/**
 * "Add a version": every rate and amount from the version before, a start date (tomorrow or
 * later), a name and a reason. The first press previews the figures that change (the SQL dry
 * run); "Save version" then adds it. Editing anything after the preview hides "Save version"
 * until it is previewed again.
 */
export function AddVersionForm({
  saved,
  bands,
  minDate,
  adviserLine,
}: {
  saved: Record<string, string>;
  bands: BandField[];
  minDate: string;
  adviserLine: string;
}) {
  const [state, action] = useActionState<RuleSetFormState, FormData>(addRuleSetVersionAction, null);
  const [editedAfter, setEditedAfter] = useState<RuleSetFormState>(null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const preview = state?.ok ? state.preview : undefined;
  const showSave = preview !== undefined && !preview.unchanged && editedAfter !== state;
  const v = (name: string) => value(state, name, saved[name]);

  return (
    <form
      action={action}
      aria-label="Add a version of the payroll rules"
      className="flex flex-col gap-6"
      onChange={() => setEditedAfter(state)}
    >
      {["bandCount", "pensionBase", "nhfBase", "dailyWorkersExempt", "publicHolidayMode"].map(
        (name) => (
          <input key={name} type="hidden" name={name} value={saved[name] ?? ""} />
        ),
      )}

      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="mb-3 type-h3">The version</legend>
        <div className={GRID}>
          <Field
            label="Name"
            name="name"
            required
            maxLength={60}
            defaultValue={v("name")}
            error={errors?.name}
          />
          <Field
            label="Starts"
            name="effectiveFrom"
            type="date"
            required
            min={minDate}
            defaultValue={v("effectiveFrom")}
            hint="Tomorrow or later. A run uses the version in force on its pay date."
            error={errors?.effectiveFrom}
          />
        </div>
        <Field
          label="Reason"
          name="reason"
          required
          maxLength={500}
          placeholder="Tax adviser's advice of 3 Dec 2026"
          defaultValue={v("reason")}
          error={errors?.reason}
        />
        <Field
          label="Source (optional)"
          name="sourceLabel"
          maxLength={200}
          placeholder="Finance Act 2027, s.4"
          defaultValue={v("sourceLabel")}
          error={errors?.sourceLabel}
        />
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="mb-3 type-h3">PAYE bands, a year</legend>
        {bands.map((band) => (
          <div key={band.index} className={GRID} data-testid={`band-${band.index}`}>
            {band.open ? (
              <p className="m-0 self-center text-sm font-medium">{band.label}</p>
            ) : (
              <Field
                label={`${band.label} (₦)`}
                name={`band${band.index}Width`}
                inputMode="decimal"
                required
                defaultValue={v(`band${band.index}Width`)}
                error={errors?.[`band${band.index}Width`]}
              />
            )}
            <Field
              label="Rate (%)"
              name={`band${band.index}Rate`}
              inputMode="decimal"
              required
              defaultValue={v(`band${band.index}Rate`)}
              error={errors?.[`band${band.index}Rate`]}
            />
          </div>
        ))}
        <div className={GRID}>
          <Field
            label="Rent relief (% of declared rent)"
            name="rentReliefRate"
            inputMode="decimal"
            required
            defaultValue={v("rentReliefRate")}
            error={errors?.rentReliefRate}
          />
          <Field
            label="Rent relief cap (₦ a year)"
            name="rentReliefCap"
            inputMode="decimal"
            required
            defaultValue={v("rentReliefCap")}
            error={errors?.rentReliefCap}
          />
        </div>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="mb-3 type-h3">Pension, NHF and levies</legend>
        <div className={GRID}>
          <Field
            label="Employee pension (%)"
            name="pensionEmployeeRate"
            inputMode="decimal"
            required
            defaultValue={v("pensionEmployeeRate")}
            error={errors?.pensionEmployeeRate}
          />
          <Field
            label="Employer pension (%)"
            name="pensionEmployerRate"
            inputMode="decimal"
            required
            defaultValue={v("pensionEmployerRate")}
            error={errors?.pensionEmployerRate}
          />
          <Field
            label="NHF (% of basic)"
            name="nhfRate"
            inputMode="decimal"
            required
            defaultValue={v("nhfRate")}
            error={errors?.nhfRate}
          />
          <Field
            label="NSITF (%)"
            name="nsitfRate"
            inputMode="decimal"
            required
            defaultValue={v("nsitfRate")}
            error={errors?.nsitfRate}
          />
          <Field
            label="ITF (%)"
            name="itfRate"
            inputMode="decimal"
            required
            defaultValue={v("itfRate")}
            error={errors?.itfRate}
          />
          <Field
            label="ITF from how many staff"
            name="itfMinStaff"
            inputMode="numeric"
            required
            defaultValue={v("itfMinStaff")}
            error={errors?.itfMinStaff}
          />
        </div>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
        <legend className="mb-3 type-h3">Pay policy</legend>
        <div className={GRID}>
          <Field
            label="Overtime rate (× normal hourly)"
            name="overtimeMultiplier"
            inputMode="decimal"
            required
            defaultValue={v("overtimeMultiplier")}
            error={errors?.overtimeMultiplier}
          />
          <Field
            label="Off-day work pays (minutes)"
            name="offDayPaidMinutes"
            inputMode="numeric"
            required
            defaultValue={v("offDayPaidMinutes")}
            error={errors?.offDayPaidMinutes}
          />
        </div>
      </fieldset>

      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok && state.message ? (
        <p role="status" className="m-0 text-sm">
          {state.message}
        </p>
      ) : null}

      {preview ? (
        <section
          aria-label="What changes"
          className="flex flex-col gap-3 rounded-xl border border-line p-4"
        >
          <p className="m-0 text-[15px] font-medium" data-testid="rule-set-preview">
            {preview.summary}
          </p>
          {preview.changes.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {preview.changes.map((c) => (
                <li
                  key={c.label}
                  className="flex flex-col gap-0.5 rounded-lg border border-line p-3 sm:flex-row sm:items-baseline sm:gap-3"
                >
                  <span className="shrink-0 text-sm font-semibold sm:w-56">{c.label}</span>
                  <span className="text-sm">
                    {c.before ? <span className="text-fg-muted">{c.before} → </span> : null}
                    {c.after}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {editedAfter === state ? (
            <p className="m-0 text-sm text-fg-muted">
              You changed a figure. Preview again before saving.
            </p>
          ) : null}
        </section>
      ) : null}

      <p className="m-0 rounded-lg bg-surface px-3 py-2.5 text-[13px] font-medium">{adviserLine}</p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          type="submit"
          name="intent"
          value="preview"
          variant={showSave ? "outline" : "default"}
          className="h-11 sm:px-5"
        >
          {preview ? "Preview again" : "Preview changes"}
        </Button>
        {showSave ? (
          <Button type="submit" name="intent" value="save" className="h-11 sm:px-5">
            Save version
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The owner records the tax adviser's confirmation of the version in force, once. */
export function ConfirmAdviserForm({
  ruleSetId,
  name,
}: {
  ruleSetId: string | null;
  name: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(confirmRuleSetAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      action={action}
      aria-label={`Record the tax adviser's confirmation of ${name}`}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="ruleSetId" value={ruleSetId ?? ""} />
      <Field
        label="Who confirmed the figures, and when"
        name="note"
        required
        maxLength={500}
        placeholder="Confirmed by our tax adviser on 2 Dec 2026"
        defaultValue={state && !state.ok ? (state.values?.note ?? "") : ""}
        error={errors?.note}
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      {state?.ok ? (
        <p role="status" className="m-0 text-sm">
          {state.message}
        </p>
      ) : null}
      <SubmitButton pendingLabel="Recording…" className="sm:w-auto sm:self-start sm:px-5">
        Record the adviser&apos;s confirmation
      </SubmitButton>
    </form>
  );
}
