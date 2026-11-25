"use client";

import { useState } from "react";

import { Field } from "@/components/form";
import { formatNaira } from "@/lib/money";
import { holidayHourExample, parseMultiplierBps } from "@/lib/payroll/holiday-pay";
import { setHolidayPayAction } from "@/server/payroll/leavers-actions";
import type { RunFormState } from "@/server/payroll/run-actions";

import { TwoStepForm, valueOf } from "../../../payroll/_components/run-forms";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4";
const whole = (k: bigint) => formatNaira(k, { whole: true });

/** "₦750 normal + ₦1,125 extra = ₦1,875 an hour", or null for a multiplier not yet valid. */
function workedHour(input: string): string | null {
  const bps = parseMultiplierBps(input);
  if (bps === null) return null;
  const h = holidayHourExample(bps);
  return `${whole(h.normal)} normal + ${whole(h.extra)} extra = ${whole(h.total)} an hour`;
}

function Fields({
  state,
  current,
  minDate,
}: {
  state: RunFormState;
  current: string;
  minDate: string;
}) {
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const [multiplier, setMultiplier] = useState(valueOf(state, "multiplier", current));
  const worked = workedHour(multiplier);
  return (
    <>
      <div className={GRID}>
        <Field
          label="Extra pay for holiday work (× hourly rate, on top of normal pay)"
          name="multiplier"
          inputMode="decimal"
          required
          placeholder="1.5"
          value={multiplier}
          onChange={(e) => setMultiplier(e.target.value)}
          hint="1.0 to 5.0."
          error={errors?.multiplier}
        />
        <Field
          label="From"
          name="effectiveFrom"
          type="date"
          required
          min={minDate}
          defaultValue={valueOf(state, "effectiveFrom", minDate)}
          hint="Tomorrow or later."
          error={errors?.effectiveFrom}
        />
      </div>
      <p className="m-0 text-sm" data-testid="holiday-worked">
        {worked
          ? `At ₦750 an hour: ${worked}.`
          : "Enter a multiplier from 1.0 to 5.0 to see an hour worked out."}
      </p>
      <Field
        label="Reason"
        name="reason"
        required
        maxLength={500}
        placeholder="New guard contracts pay public holidays at 1.5 times"
        defaultValue={valueOf(state, "reason")}
        error={errors?.reason}
      />
    </>
  );
}

/**
 * Settings > Payroll rules: a new holiday pay multiplier from tomorrow or later (slice 5.9c).
 * The first press previews it; the second saves it.
 */
export function HolidayPayForm({ minDate, current }: { minDate: string; current: string }) {
  return (
    <TwoStepForm
      action={setHolidayPayAction}
      hidden={{}}
      label="Set the holiday pay rate"
      previewLabel="Preview"
      confirmLabel="Save the rate"
      pendingLabel="Working it out…"
    >
      {(state) => <Fields state={state} current={current} minDate={minDate} />}
    </TwoStepForm>
  );
}
