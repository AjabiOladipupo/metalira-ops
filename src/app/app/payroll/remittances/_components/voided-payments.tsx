import { formatDate, formatDateTime } from "@/lib/dates";
import { formatNaira, koboToMajorString, sumKobo } from "@/lib/money";
import type { VoidedPayment } from "@/server/payroll/remittance-resolutions";

import { OffsetPaymentForm, RecordRefundForm } from "./resolution-forms";

/**
 * Payments made against remittances a reversal voided (slice 5.7c): the money is with the
 * authority, so each is resolved as an offset against a later remittance to the same authority
 * or a refund received (with its receipt). Offset is the default (slice 5.9b; tax adviser, 24 Nov
 * 2026: authorities rarely refund cash), and the refund stays for when one comes back. The app
 * records it and keeps every record as written.
 */
export function VoidedPayments({
  payments,
  canRecord,
  today,
}: {
  payments: readonly VoidedPayment[];
  canRecord: boolean;
  today: string;
}) {
  if (payments.length === 0) return null;
  const open = payments.filter((p) => p.resolution.unresolvedKobo > 0n);
  const unresolved = sumKobo(open.map((p) => p.resolution.unresolvedKobo));
  return (
    <section
      aria-labelledby="voided-payments"
      className="flex flex-col gap-3 rounded-xl border border-foreground p-4 sm:p-5"
      data-testid="voided-payments"
    >
      <div className="flex flex-col gap-1">
        <h2 id="voided-payments" className="m-0 type-h3">
          {formatNaira(unresolved)} paid on reversed runs, still to resolve
        </h2>
        <p className="m-0 max-w-3xl text-sm text-fg-muted">
          A run was reversed after these remittances were paid, so they are voided and the money is
          with the authority. Authorities rarely refund cash, so offset it against your next
          remittance to the same authority. If the authority does send a refund, record it with its
          receipt instead.
        </p>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {payments.map((p) => (
          <li
            key={p.paymentId}
            id={`payment-${p.paymentId}`}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3 sm:p-4"
            data-testid="voided-payment"
            aria-label={p.title}
          >
            <div className="flex flex-col gap-0.5">
              <h3 className="m-0 text-base font-semibold break-words">{p.title}</h3>
              <p className="m-0 text-sm text-fg-muted">
                Paid {formatNaira(p.resolution.paidKobo)} on {formatDate(p.paidOn)} · voided:{" "}
                {p.voidReason}
              </p>
            </div>
            <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 text-sm">
              <dt className="text-fg-muted">Refunded</dt>
              <dd className="m-0 text-right tabular-nums">
                {formatNaira(p.resolution.refundedKobo)}
              </dd>
              <dt className="text-fg-muted">Offset</dt>
              <dd className="m-0 text-right tabular-nums">
                {formatNaira(p.resolution.offsetKobo)}
              </dd>
              <dt className="font-medium">Still to resolve</dt>
              <dd className="m-0 text-right font-medium tabular-nums" data-testid="unresolved">
                {formatNaira(p.resolution.unresolvedKobo)}
              </dd>
            </dl>
            {p.resolutions.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-fg-muted">
                {p.resolutions.map((r) => (
                  <li key={r.id}>
                    {r.kind === "refund"
                      ? `Refund of ${formatNaira(r.amountKobo)} received ${formatDate(r.receivedOn ?? "")}${r.reference ? ` · ref ${r.reference}` : ""}`
                      : `Offset of ${formatNaira(r.amountKobo)} against ${p.targets.find((t) => t.remittanceId === r.targetRemittanceId)?.label ?? "a later remittance"}: ${r.note ?? ""}${r.lapsed ? " (that run was reversed, so this offset no longer counts)" : ""}`}{" "}
                    · {formatDateTime(r.createdAt)}
                  </li>
                ))}
              </ul>
            ) : null}
            {canRecord && p.resolution.unresolvedKobo > 0n ? (
              <div className="flex flex-col gap-2">
                <details open className="rounded-lg border border-line px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Offset against a later remittance (usual)
                  </summary>
                  <div className="pt-3">
                    {p.targets.length > 0 ? (
                      <OffsetPaymentForm
                        paymentId={p.paymentId}
                        targets={p.targets.map((t) => ({
                          value: t.remittanceId,
                          label: t.label,
                          room: formatNaira(t.roomKobo),
                        }))}
                      />
                    ) : (
                      <p className="m-0 text-sm text-fg-muted">
                        No later remittance to the same authority is owed yet. It appears here once
                        the next run is approved.
                      </p>
                    )}
                  </div>
                </details>
                <details className="rounded-lg border border-line px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Record a refund instead
                  </summary>
                  <div className="pt-3">
                    <RecordRefundForm
                      paymentId={p.paymentId}
                      unresolved={koboToMajorString(p.resolution.unresolvedKobo)}
                      today={today}
                      minDate={p.paidOn}
                    />
                  </div>
                </details>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
