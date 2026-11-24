import type { SupabaseClient } from "@supabase/supabase-js";

import { Status } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import { formatNaira, sumKobo, type Kobo } from "@/lib/money";
import { LEFT_OUT_LABEL, maskedLast4 } from "@/lib/payroll/payout";
import { summariseSupplement, WAITING_LABEL, type WaitingReason } from "@/lib/payroll/supplement";
import { cn } from "@/lib/utils";
import { bankFormat, bankFormatOptions } from "@/server/payroll/bank-formats";
import type { PayoutItemRow } from "@/server/payroll/payouts-data";
import { loadSupplementPlan, loadSupplements } from "@/server/payroll/supplements";
import type { Database } from "@/types/db";

import { ConfirmSupplementForm, DownloadBankFileButton, MakeSupplementForm } from "./pay-forms";

const naira = (k: Kobo) => formatNaira(k, { whole: true });
const workers = (n: number) => `${n} ${n === 1 ? "worker" : "workers"}`;
const TH = "px-3 py-2.5 text-left font-semibold whitespace-nowrap";
const THN = "px-3 py-2.5 text-right font-semibold whitespace-nowrap";
const TD = "px-3 py-3 whitespace-nowrap";
const TDN = "px-3 py-3 text-right tabular-nums whitespace-nowrap";

/**
 * Workers a released run's bank file left out (slice 5.7c, carried from 5.4): listed as
 * outstanding with their net pay until a supplementary file pays them. Finance or an owner makes
 * a supplementary file for those whose bank details are now in force, downloads it (a 60-second
 * link, audited) and confirms it went to the bank; someone else than its maker confirms. HR sees
 * the list, the control totals and masked last 4 digits.
 */
export async function SupplementSection({
  supabase,
  organisationId,
  runId,
  leftOut,
  netOf,
  canMake,
  names,
}: {
  supabase: SupabaseClient<Database>;
  organisationId: string;
  runId: string;
  /** The run's bank file's left-out items. */
  leftOut: readonly PayoutItemRow[];
  netOf: ReadonlyMap<string, Kobo>;
  canMake: boolean;
  /** Managers' names the page already knows, by user id. */
  names: ReadonlyMap<string, string>;
}) {
  const detail = await loadSupplements(supabase, organisationId, runId);
  const people = new Map(names);
  const unknown = [
    ...new Set(
      [
        ...detail.files.flatMap((f) => [f.madeBy, f.confirmedBy, f.voidedBy]),
        ...detail.downloads.map((d) => d.actorId),
      ].filter((id): id is string => typeof id === "string" && !people.has(id)),
    ),
  ];
  if (unknown.length > 0) {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", unknown);
    for (const p of data ?? []) if (p.full_name) people.set(p.user_id, p.full_name);
  }
  const person = (id: string | null) => (id && people.get(id)) || "a manager";
  const confirmedPaid = new Set(
    detail.items
      .filter(
        (i) =>
          i.status === "pending" &&
          detail.files.some((f) => f.id === i.supplementId && f.status === "confirmed"),
      )
      .map((i) => i.payslipId),
  );
  const inWaiting = new Set(
    detail.active
      ? detail.items
          .filter((i) => i.supplementId === detail.active!.id && i.status === "pending")
          .map((i) => i.payslipId)
      : [],
  );
  const outstanding = leftOut.filter(
    (i) =>
      i.leftOutReason !== "nothing_to_pay" &&
      (netOf.get(i.payslipId) ?? 0n) > 0n &&
      !confirmedPaid.has(i.payslipId),
  );
  // Owner and finance read whose details are ready now (the plan); hr sees the list only.
  const plan = canMake
    ? summariseSupplement((await loadSupplementPlan(supabase, organisationId, runId)).rows)
    : null;
  const waitingOf = new Map<string, WaitingReason>(
    (plan?.waiting ?? []).map((w) => [w.row.payslipId, w.reason] as const),
  );
  const readyIds = new Set((plan?.ready ?? []).map((r) => r.payslipId));
  const outstandingKobo = sumKobo(outstanding.map((i) => netOf.get(i.payslipId) ?? 0n));
  const active = detail.active;
  const activeDownload = active
    ? (detail.downloads.find((d) => d.supplementId === active.id) ?? null)
    : null;
  const downloadedNote = activeDownload
    ? `The current supplementary file was downloaded by ${person(activeDownload.actorId)} at ${formatDateTime(activeDownload.downloadedAt)}.`
    : null;
  const confirmed = detail.files.filter((f) => f.status === "confirmed");
  const voided = detail.files.filter((f) => f.status === "voided");
  const activeItems = active ? detail.items.filter((i) => i.supplementId === active.id) : [];
  const nameOf = new Map(leftOut.map((i) => [i.payslipId, i.workerName] as const));

  if (outstanding.length === 0 && detail.files.length === 0) return null;

  const statusOf = (payslipId: string, item: PayoutItemRow): string => {
    if (inWaiting.has(payslipId)) return "In the waiting supplementary file";
    if (readyIds.has(payslipId)) return "Bank details in force · ready for a supplementary file";
    const waiting = waitingOf.get(payslipId);
    if (waiting) return WAITING_LABEL[waiting];
    return item.leftOutReason ? LEFT_OUT_LABEL[item.leftOutReason] : "Not in the run's file";
  };

  return (
    <section
      aria-labelledby="outstanding"
      className="flex flex-col gap-4 rounded-xl border border-foreground p-4 sm:p-5"
      data-testid="outstanding"
    >
      <div className="flex flex-col gap-1">
        <h3 id="outstanding" className="m-0 type-h3">
          {outstanding.length} outstanding · {naira(outstandingKobo)}
        </h3>
        <p className="m-0 text-sm text-fg-muted">
          Left out of the run&apos;s bank file, so not paid by it. Their payslips stand. Once their
          bank details are in force, pay them with a supplementary file: each is paid once, never by
          two files.
        </p>
      </div>

      {outstanding.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
          {outstanding.map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
              data-testid="outstanding-row"
            >
              <span>
                <span className="font-semibold">{i.workerName}</span> ·{" "}
                {naira(netOf.get(i.payslipId) ?? 0n)}
              </span>
              <span className="text-fg-muted">{statusOf(i.payslipId, i)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {active ? (
        <div className="flex flex-col gap-3" data-testid="supplementary-file">
          <h4 className="m-0 text-sm font-semibold">Supplementary file waiting for the bank</h4>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3">
            <div className="flex flex-col gap-1.5 rounded-xl border border-line p-4">
              <span className="type-label text-fg-muted">Workers in the file</span>
              <span className="font-heading text-xl font-medium" data-testid="supplementary-count">
                {active.itemCount}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 rounded-xl border border-line p-4">
              <span className="type-label text-fg-muted">Total</span>
              <span className="font-heading text-xl font-medium" data-testid="supplementary-total">
                {naira(active.totalKobo)}
              </span>
            </div>
          </div>
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-xl border border-line p-4 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-fg-muted">SHA-256</dt>
            <dd className="m-0 font-mono text-[13px] break-all" data-testid="supplementary-sha">
              {active.fileSha256}
            </dd>
            <dt className="text-fg-muted">Format</dt>
            <dd className="m-0">{bankFormat(active.bankFormat)?.label ?? active.bankFormat}</dd>
            <dt className="text-fg-muted">Made</dt>
            <dd className="m-0">
              by {person(active.madeBy)} · {formatDateTime(active.createdAt)}
            </dd>
          </dl>
          {downloadedNote ? <p className="m-0 text-sm">{downloadedNote}</p> : null}
          {canMake ? (
            <DownloadBankFileButton batchId={active.id} released={false} supplementary />
          ) : null}
          <div className="relative overflow-x-auto rounded-xl border border-line">
            <table
              className="w-full border-collapse text-sm"
              aria-label="Workers in the supplementary file"
            >
              <thead className="bg-surface">
                <tr>
                  <th className={TH}>Worker</th>
                  <th className={TH}>Bank</th>
                  <th className={TH}>Account</th>
                  <th className={THN}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {activeItems.map((i) => (
                  <tr key={i.id} className="border-t border-line" data-testid="supplementary-row">
                    <td className={TD}>
                      <span className="flex flex-col">
                        <span className="font-semibold">
                          {nameOf.get(i.payslipId) ?? "A worker"}
                        </span>
                        <span className="text-xs text-fg-muted">{i.accountName}</span>
                      </span>
                    </td>
                    <td className={TD}>
                      {i.bankName}
                      <span className="block text-xs text-fg-muted">Code {i.bankCode}</span>
                    </td>
                    <td className={cn(TD, "tabular-nums")}>{maskedLast4(i.bankAccountLast4)}</td>
                    <td className={TDN}>{naira(i.amountKobo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canMake ? (
            <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
              <h4 className="m-0 text-sm font-semibold">After you upload it</h4>
              <p className="m-0 text-sm text-fg-muted">
                Confirm the supplementary file went to the bank. Someone who prepared or changed the
                run, or made this file, can&apos;t confirm it, and it must have been downloaded.
              </p>
              <ConfirmSupplementForm
                runId={runId}
                supplementId={active.id}
                fileSha256={active.fileSha256}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {canMake && plan && (plan.ready.length > 0 || active) ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
          <h4 className="m-0 text-sm font-semibold">
            {active ? "Replace the waiting file" : "Make a supplementary file"}
          </h4>
          <p className="m-0 text-sm text-fg-muted">
            {plan.ready.length > 0
              ? `${workers(plan.ready.length)} ready: ${naira(plan.readyKobo)}, each their net pay, to the bank details in force now.`
              : "Nobody else is ready yet."}{" "}
            {active
              ? "Only if something changed: the waiting file is voided with your reason and can't be downloaded again."
              : ""}
          </p>
          <MakeSupplementForm
            runId={runId}
            formats={bankFormatOptions()}
            replaces={!!active}
            downloadedNote={downloadedNote}
          />
        </div>
      ) : null}

      {confirmed.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="m-0 text-sm font-semibold">Supplementary files paid</h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {confirmed.map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-sm"
              >
                <Status tone="done">Uploaded</Status>
                <span>
                  {workers(f.itemCount)} · {naira(f.totalKobo)} · made by {person(f.madeBy)},
                  confirmed by {person(f.confirmedBy)}
                  {f.confirmedAt ? ` · ${formatDateTime(f.confirmedAt)}` : ""}
                </span>
                {canMake ? (
                  <details className="w-full">
                    <summary className="cursor-pointer text-fg-muted">Download a copy</summary>
                    <div className="pt-2">
                      <DownloadBankFileButton batchId={f.id} released supplementary />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {voided.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="m-0 text-sm font-semibold">Replaced supplementary files</h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {voided.map((f) => (
              <li key={f.id} className="rounded-lg border border-line px-3 py-2.5 text-sm">
                <span className="block">
                  {workers(f.itemCount)} · {naira(f.totalKobo)} · made by {person(f.madeBy)},{" "}
                  {formatDateTime(f.createdAt)}
                </span>
                <span className="block text-fg-muted">
                  Voided by {person(f.voidedBy)}
                  {f.voidedAt ? ` · ${formatDateTime(f.voidedAt)}` : ""}: {f.voidReason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
