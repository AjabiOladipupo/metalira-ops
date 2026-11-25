import { formatDate } from "@/lib/dates";
import { formatNaira, type Kobo } from "@/lib/money";
import { formatMultiplier } from "@/lib/payroll/rule-set";
import type { HolidayPaySettings } from "@/server/payroll/holiday-pay";

import { HolidayPayForm } from "./holiday-pay-form";

/**
 * Settings > Payroll rules, slice 5.9c: the company's public-holiday pay multiplier (adviser
 * answer 24: contract-driven, no statutory multiplier; owner decision: default 1.0x, set per
 * company) and the loss-of-office exemption on the rule set in force (adviser answer 19).
 */
export function HolidayPaySection({
  settings,
  exemptCapKobo,
  canEdit,
  minDate,
}: {
  settings: HolidayPaySettings;
  exemptCapKobo: Kobo;
  canEdit: boolean;
  minDate: string;
}) {
  return (
    <section
      aria-labelledby="holiday-pay"
      className="flex flex-col gap-3"
      data-testid="holiday-pay"
    >
      <div className="flex flex-col gap-1">
        <h2 id="holiday-pay" className="m-0 type-h2">
          Public holiday pay
        </h2>
        <p className="m-0 text-sm text-fg-muted">
          Every minute worked on a public holiday is paid at the overtime rate ×{" "}
          {formatMultiplier(settings.inForceBps)}, on top of normal pay. The law sets no multiplier:
          it follows your employment contracts. Confirm it with an employment lawyer.
        </p>
      </div>
      <dl className="m-0 flex flex-col divide-y divide-line rounded-xl border border-line">
        <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-sm font-semibold sm:w-44">In force</dt>
          <dd className="m-0 text-sm" data-testid="holiday-multiplier">
            {formatMultiplier(settings.inForceBps)}
            {settings.inForce
              ? ` since ${formatDate(settings.inForce.effectiveFrom)} · ${settings.inForce.reason}`
              : " (the starting rule)"}
          </dd>
        </div>
        {settings.scheduled.map((s) => (
          <div key={s.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-sm font-semibold sm:w-44">
              From {formatDate(s.effectiveFrom)}
            </dt>
            <dd className="m-0 text-sm">
              {formatMultiplier(s.multiplierBps)} · {s.reason}
            </dd>
          </div>
        ))}
        {settings.earlier.map((e) => (
          <div key={e.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-sm text-fg-muted sm:w-44">
              Earlier, from {formatDate(e.effectiveFrom)}
            </dt>
            <dd className="m-0 text-sm text-fg-muted">{formatMultiplier(e.multiplierBps)}</dd>
          </div>
        ))}
        <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-sm font-semibold sm:w-44">Redundancy pay exempt</dt>
          <dd className="m-0 text-sm" data-testid="loss-of-office-cap">
            Up to {formatNaira(exemptCapKobo, { whole: true })} a worker, across all such payments;
            only the excess is taxed.
          </dd>
        </div>
      </dl>
      {canEdit ? (
        <HolidayPayForm
          minDate={minDate}
          current={formatMultiplier(settings.inForceBps).replace("×", "")}
        />
      ) : null}
    </section>
  );
}
