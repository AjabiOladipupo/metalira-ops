"use client";

import { useActionState } from "react";

import { Field } from "@/components/form";
import { PLANS } from "@/lib/company";
import { cn } from "@/lib/utils";
import { savePlan } from "@/server/identity/company-actions";

import { CompanyFormFooter, fieldValue, type CompanyFormMode } from "./form-footer";

/**
 * Plan step: records the plan and expected headcount only. No prices, estimates or limits are
 * shown until pricing is final, and nothing is charged (Metalira billing is Phase 9).
 */
export function PlanForm({
  mode,
  plan,
  expectedWorkers,
  backHref,
}: {
  mode: CompanyFormMode;
  plan: string;
  expectedWorkers: number | null;
  backHref?: string;
}) {
  const [state, action] = useActionState(savePlan, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const defaults = {
    plan: fieldValue(state, "plan", plan === "trial" ? "ops_suite" : plan),
    expectedWorkers: fieldValue(state, "expectedWorkers", expectedWorkers),
  };

  return (
    <form key={JSON.stringify(defaults)} action={action} noValidate className="flex flex-col gap-6">
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-3 text-[13px] font-medium">Plan</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((option) => (
            <label
              key={option.id}
              className={cn(
                "flex cursor-pointer flex-col gap-1.5 rounded-xl border border-line bg-background p-4 text-foreground",
                "has-checked:border-foreground has-checked:bg-foreground has-checked:text-background",
                "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-signal",
              )}
            >
              <input
                type="radio"
                name="plan"
                value={option.id}
                defaultChecked={defaults.plan === option.id}
                className="sr-only"
              />
              <span className="font-display text-lg font-bold">{option.name}</span>
              <span className="text-[13px] opacity-85">{option.summary}</span>
            </label>
          ))}
        </div>
        {errors?.plan ? <p className="m-0 text-xs font-medium">{errors.plan}</p> : null}
      </fieldset>

      <div className="flex flex-col gap-4 rounded-xl border border-line p-5 sm:flex-row sm:items-end">
        <Field
          label="Workers you expect each month"
          name="expectedWorkers"
          type="number"
          inputMode="numeric"
          min={1}
          max={1000000}
          required
          defaultValue={defaults.expectedWorkers}
          error={errors?.expectedWorkers}
          className="sm:w-56"
        />
        <p className="m-0 text-[13px] text-fg-muted sm:flex-1">
          Pricing is not final yet, so nothing is charged and no worker limit applies. You can
          change plan at any time.
        </p>
      </div>

      <CompanyFormFooter mode={mode} state={state} backHref={backHref} />
    </form>
  );
}
