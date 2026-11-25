"use client";

import { Field } from "@/components/form";
import { setHolidayPayAction } from "@/server/payroll/leavers-actions";

import { TwoStepForm, valueOf } from "../../../payroll/_components/run-forms";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4";

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
      {(state) => {
        const errors = state && !state.ok ? state.fieldErrors : undefined;
        return (
          <>
            <div className={GRID}>
              <Field
                label="Multiplier on the overtime rate"
                name="multiplier"
                inputMode="decimal"
                required
                placeholder="1.5"
                defaultValue={valueOf(state, "multiplier", current)}
                hint="1.0 to 5.0. 1.0 pays holiday work at the overtime rate."
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
      }}
    </TwoStepForm>
  );
}
