"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Field, SelectField } from "@/components/form";
import { PAYMENT_TERMS, invoiceNumberPreview } from "@/lib/company";
import { saveInvoices } from "@/server/identity/company-actions";
import type { Company } from "@/server/identity/company-data";

import { CompanyFormFooter, fieldValue, type CompanyFormMode } from "./form-footer";

const TERMS_OPTIONS = PAYMENT_TERMS.map((t) => ({ value: String(t.days), label: t.label }));
const VAT_OPTIONS = [
  { value: "yes", label: "Registered, charge 7.5%" },
  { value: "no", label: "Not registered" },
];

/** A "Where clients pay" card, as listed by src/server/billing/collection-rails.ts. */
export interface RailCard {
  id: string;
  name: string;
  body: string;
  /** The account in use, masked, or "No account yet". */
  status: string;
  connected: boolean;
  /** A request waiting for approval or on hold, in words. */
  waiting: string | null;
  /** Where to add, change or review it; null for roles that can't. */
  action: { href: string; label: string } | null;
}

export type InvoiceSettings = Pick<
  Company,
  "invoiceEmail" | "invoiceNumberStart" | "paymentTermsDays" | "vatRegistered" | "autoEmailReceipts"
>;

/** Invoices step: sender address, numbering, terms, VAT, and where clients pay. */
export function InvoicesForm({
  mode,
  company,
  rails,
  backHref,
}: {
  mode: CompanyFormMode;
  company: InvoiceSettings;
  rails: readonly RailCard[];
  backHref?: string;
}) {
  const [state, action] = useActionState(saveInvoices, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const defaults = {
    invoiceEmail: fieldValue(state, "invoiceEmail", company.invoiceEmail),
    invoiceNumberStart: fieldValue(state, "invoiceNumberStart", company.invoiceNumberStart),
    paymentTermsDays: fieldValue(state, "paymentTermsDays", company.paymentTermsDays),
    vatRegistered: fieldValue(state, "vatRegistered", company.vatRegistered ? "yes" : "no"),
    autoEmailReceipts:
      state && !state.ok ? state.values?.autoEmailReceipts === "on" : company.autoEmailReceipts,
  };
  const start = Number.parseInt(defaults.invoiceNumberStart, 10);
  // Settings nests this form under its own h2.
  const RailsHeading = mode === "settings" ? "h3" : "h2";

  return (
    <form key={JSON.stringify(defaults)} action={action} noValidate className="flex flex-col gap-6">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
        <Field
          label="Invoice email"
          name="invoiceEmail"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          hint="Invoices are sent from this address, replies come here, and you get a copy of each one."
          defaultValue={defaults.invoiceEmail}
          error={errors?.invoiceEmail}
        />
        <Field
          label="Invoice number starts at"
          name="invoiceNumberStart"
          type="number"
          inputMode="numeric"
          min={1}
          required
          hint={
            Number.isSafeInteger(start) && start > 0
              ? `Your first invoice will be ${invoiceNumberPreview(start)}.`
              : undefined
          }
          defaultValue={defaults.invoiceNumberStart}
          error={errors?.invoiceNumberStart}
        />
        <SelectField
          label="Payment terms"
          name="paymentTermsDays"
          options={TERMS_OPTIONS}
          defaultValue={defaults.paymentTermsDays}
          error={errors?.paymentTermsDays}
        />
        <SelectField
          label="VAT"
          name="vatRegistered"
          options={VAT_OPTIONS}
          defaultValue={defaults.vatRegistered}
          error={errors?.vatRegistered}
        />
      </div>

      <section aria-labelledby="where-clients-pay" className="flex flex-col gap-3">
        <RailsHeading id="where-clients-pay" className="m-0 type-h3">
          Where clients pay
        </RailsHeading>
        <p className="m-0 text-sm text-fg-muted">
          Clients pay into accounts you own. Metalira never holds the money.
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3">
          {rails.map((rail) => (
            <div
              key={rail.id}
              data-testid={`rail-${rail.id}`}
              className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line p-[18px]"
            >
              <span className="text-base font-semibold">{rail.name}</span>
              <span className="text-sm text-fg-muted">{rail.body}</span>
              <span
                className="inline-flex min-w-0 items-start gap-2 text-sm font-medium break-words"
                data-testid="rail-status"
              >
                <span
                  aria-hidden
                  className={`mt-1.5 inline-block size-2 shrink-0 rounded-full border-[1.5px] border-foreground${rail.connected ? "bg-foreground" : ""}`}
                />
                <span className="min-w-0">{rail.status}</span>
              </span>
              {rail.waiting ? (
                <span className="text-sm break-words text-fg-muted" data-testid="rail-waiting">
                  {rail.waiting}
                </span>
              ) : null}
              {rail.action ? (
                <Link
                  href={rail.action.href}
                  className="text-sm font-medium text-foreground underline"
                >
                  {rail.action.label}
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <label className="flex items-center gap-2.5 text-[15px]">
        <input
          type="checkbox"
          name="autoEmailReceipts"
          defaultChecked={defaults.autoEmailReceipts}
          className="size-[18px] accent-foreground"
        />
        Email a receipt to the client as soon as a payment is matched
      </label>

      <CompanyFormFooter mode={mode} state={state} backHref={backHref} />
    </form>
  );
}
