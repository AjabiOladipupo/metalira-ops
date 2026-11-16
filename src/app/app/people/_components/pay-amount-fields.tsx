"use client";

import { Field } from "@/components/form";
import type { PayType } from "@/lib/people";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4";

const FIELDS: Record<PayType, { name: string; label: string; hint?: string }[]> = {
  monthly: [
    { name: "basic", label: "Basic monthly" },
    { name: "housing", label: "Housing monthly", hint: "Blank means none." },
    { name: "transport", label: "Transport monthly", hint: "Blank means none." },
    { name: "otherAllowances", label: "Other allowances monthly", hint: "Blank means none." },
  ],
  daily: [{ name: "dailyRate", label: "Daily rate" }],
  hourly: [{ name: "hourlyRate", label: "Hourly rate" }],
};

/**
 * The amounts a pay type needs, in naira as typed ("105,000" or "105000.50"). The server parses
 * them to kobo exactly; nothing here does arithmetic. Only the current type's inputs exist, so
 * a switched type never sends stale amounts.
 */
export function PayAmountFields({
  payType,
  defaults,
  errors,
}: {
  payType: PayType;
  defaults: Partial<Record<string, string>>;
  errors?: Partial<Record<string, string>>;
}) {
  return (
    <div className={GRID}>
      {FIELDS[payType].map((field) => (
        <Field
          key={`${payType}-${field.name}`}
          label={field.label}
          name={field.name}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          hint={field.hint ?? "In naira."}
          defaultValue={defaults[field.name] ?? ""}
          error={errors?.[field.name]}
        />
      ))}
    </div>
  );
}
