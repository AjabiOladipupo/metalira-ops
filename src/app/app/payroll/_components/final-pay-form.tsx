"use client";

import { useState } from "react";

import { Field, SelectField } from "@/components/form";
import { koboToMajorString, parseNairaToKobo, toKobo, type Kobo } from "@/lib/money";
import {
  FINAL_PAY_ITEMS,
  FINAL_PAY_ITEM_TYPES,
  LEAVE_IN_LIEU_MIN_SERVICE_MONTHS,
  basicDailyRateText,
  basicDaysAmount,
  isFinalPayItemType,
  serviceMonths,
  type FinalPayItemType,
  type FinalPayPrefill,
} from "@/lib/payroll/final-pay";
import { addFinalPayItemAction } from "@/server/payroll/leavers-actions";
import type { RunFormState } from "@/server/payroll/run-actions";

import { TwoStepForm, valueOf } from "./run-forms";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-start gap-4";

/** A worker's pre-fill figures, kobo as digit strings (they cross to the browser). */
export interface FinalPayWorker {
  id: string;
  name: string;
  staffId: string;
  startDate: string;
  endDate: string;
  basicMonthlyKobo: string | null;
  divisorDays: number;
  annualBalanceDays: number | null;
  exemptCapKobo: string;
  exemptUsedKobo: string;
}

function prefillOf(w: FinalPayWorker): FinalPayPrefill {
  return {
    workerId: w.id,
    startDate: w.startDate,
    endDate: w.endDate,
    basicMonthlyKobo: w.basicMonthlyKobo === null ? null : toKobo(w.basicMonthlyKobo),
    divisorDays: w.divisorDays,
    annualBalanceDays: w.annualBalanceDays,
    exemptCapKobo: toKobo(w.exemptCapKobo),
    exemptUsedKobo: toKobo(w.exemptUsedKobo),
  };
}

/** "12000.00" → kobo, or null while the field doesn't hold an amount. */
function koboOf(text: string): Kobo | null {
  try {
    return parseNairaToKobo(text);
  } catch {
    return null;
  }
}

function computed(type: FinalPayItemType, days: string, p: FinalPayPrefill | null): Kobo | null {
  if (!p || !FINAL_PAY_ITEMS[type].byDays || p.basicMonthlyKobo === null) return null;
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 366) return null;
  return basicDaysAmount(n, p.basicMonthlyKobo, p.divisorDays);
}

function Fields({ state, workers }: { state: RunFormState; workers: FinalPayWorker[] }) {
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const [workerId, setWorkerId] = useState(
    valueOf(state, "workerId", workers.length === 1 ? (workers[0]?.id ?? "") : ""),
  );
  const startType = valueOf(state, "itemType", "leave_in_lieu");
  const [type, setType] = useState<FinalPayItemType>(
    isFinalPayItemType(startType) ? startType : "leave_in_lieu",
  );
  const worker = workers.find((w) => w.id === workerId) ?? null;
  const prefill = worker ? prefillOf(worker) : null;
  const defaultDays = (t: FinalPayItemType, p: FinalPayPrefill | null) =>
    t === "leave_in_lieu" && p?.annualBalanceDays && p.annualBalanceDays > 0
      ? String(p.annualBalanceDays)
      : "";
  const [days, setDays] = useState(valueOf(state, "days", defaultDays(type, prefill)));
  const firstAmount = computed(type, days, prefill);
  const [amount, setAmount] = useState(
    valueOf(state, "amount", firstAmount === null ? "" : koboToMajorString(firstAmount)),
  );
  const [amountEdited, setAmountEdited] = useState(state?.values?.amount !== undefined);
  const [settlement, setSettlement] = useState(valueOf(state, "partOfSettlement") === "on");

  const rule = FINAL_PAY_ITEMS[type];
  const prefilled = computed(type, days, prefill);
  const refill = (t: FinalPayItemType, d: string, p: FinalPayPrefill | null) => {
    if (amountEdited) return;
    const c = computed(t, d, p);
    setAmount(c === null ? "" : koboToMajorString(c));
  };
  const amountKobo = koboOf(amount);
  const daysChanged =
    type === "leave_in_lieu" &&
    (prefill?.annualBalanceDays === null || Number(days) !== prefill?.annualBalanceDays);
  const amountChanged = rule.byDays && (prefilled === null || amountKobo !== prefilled);
  const needsChange = rule.byDays && (daysChanged || amountChanged);
  const rate = prefill ? basicDailyRateText(prefill) : null;
  const months = prefill ? serviceMonths(prefill.startDate, prefill.endDate) : null;

  return (
    <>
      <div className={GRID}>
        <SelectField
          label="Worker"
          name="workerId"
          required
          placeholder="Choose a worker"
          value={workerId}
          onChange={(e) => {
            const id = e.target.value;
            setWorkerId(id);
            const w = workers.find((x) => x.id === id);
            const p = w ? prefillOf(w) : null;
            const d = defaultDays(type, p);
            setDays(d);
            refill(type, d, p);
          }}
          options={workers.map((w) => ({
            value: w.id,
            label: w.staffId ? `${w.name} · ${w.staffId}` : w.name,
          }))}
          error={errors?.workerId}
        />
        <SelectField
          label="Item"
          name="itemType"
          required
          value={type}
          onChange={(e) => {
            const t = isFinalPayItemType(e.target.value) ? e.target.value : "leave_in_lieu";
            setType(t);
            const d = defaultDays(t, prefill);
            setDays(d);
            setAmountEdited(false);
            const c = computed(t, d, prefill);
            setAmount(c === null ? "" : koboToMajorString(c));
          }}
          options={FINAL_PAY_ITEM_TYPES.map((t) => ({ value: t, label: FINAL_PAY_ITEMS[t].label }))}
          error={errors?.itemType}
        />
        {rule.byDays ? (
          <Field
            label={type === "leave_in_lieu" ? "Untaken leave days" : "Notice days"}
            name="days"
            type="number"
            min={1}
            max={366}
            inputMode="numeric"
            required
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              refill(type, e.target.value, prefill);
            }}
            hint={
              type === "leave_in_lieu"
                ? prefill?.annualBalanceDays === null || prefill === null
                  ? "No annual leave balance on file: enter the days."
                  : `Annual leave balance: ${prefill.annualBalanceDays} days.`
                : "Working days: 1 week is 5, 1 month is 20."
            }
            error={errors?.days}
          />
        ) : null}
        <Field
          label="Amount (₦)"
          name="amount"
          inputMode="decimal"
          required
          placeholder="50,000"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setAmountEdited(true);
          }}
          hint={
            rule.byDays
              ? prefilled !== null
                ? `Pre-filled: days × ${rate ?? "basic daily rate"}.`
                : "No pre-fill for a daily or hourly pay rate: enter the amount."
              : rule.calculation
          }
          error={errors?.amount}
        />
      </div>
      <div
        className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm"
        data-testid="final-pay-rule"
      >
        <p className="m-0 font-medium">{rule.owed}</p>
        <p className="m-0 text-fg-muted">
          {rule.calculation} {rule.tax}
        </p>
        {type === "leave_in_lieu" &&
        months !== null &&
        months < LEAVE_IN_LIEU_MIN_SERVICE_MONTHS ? (
          <p className="m-0 font-medium">
            {months} months&apos; service: not owed by law. Pay it only if the contract says so.
          </p>
        ) : null}
      </div>
      {type === "notice_in_lieu" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="partOfSettlement"
            checked={settlement}
            onChange={(e) => setSettlement(e.target.checked)}
            className="size-4 accent-foreground"
          />
          Part of a redundancy or loss-of-office settlement (shares the exemption)
        </label>
      ) : null}
      {needsChange ? (
        <Field
          label="Reason for the change"
          name="changeReason"
          required
          maxLength={500}
          placeholder="Two leave days taken in October, not yet on the balance"
          defaultValue={valueOf(state, "changeReason")}
          hint="The days or amount differ from the pre-filled figure."
          error={errors?.changeReason}
        />
      ) : null}
      <Field
        label="Reason"
        name="reason"
        required
        maxLength={500}
        placeholder="Resigned; last day 5 October"
        defaultValue={valueOf(state, "reason")}
        error={errors?.reason}
      />
    </>
  );
}

/** A final-pay run's typed items (slice 5.9c, adviser answer 19). */
export function AddFinalPayItemForm({
  runId,
  workers,
}: {
  runId: string;
  workers: FinalPayWorker[];
}) {
  return (
    <TwoStepForm
      action={addFinalPayItemAction}
      hidden={{ runId }}
      label="Add a final-pay item"
      previewLabel="Preview"
      confirmLabel="Add and recalculate"
      pendingLabel="Working it out…"
    >
      {(state) => <Fields state={state} workers={workers} />}
    </TwoStepForm>
  );
}
