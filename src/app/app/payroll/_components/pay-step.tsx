import { Status } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import { formatNaira, type Kobo } from "@/lib/money";
import { LEFT_OUT_LABEL, maskedLast4 } from "@/lib/payroll/payout";
import { cn } from "@/lib/utils";
import { bankFormat, bankFormatOptions } from "@/server/payroll/bank-formats";
import { loadPayoutDetail } from "@/server/payroll/payouts-data";
import type { RunDetail } from "@/server/payroll/run-data";
import { peoplePageContext } from "@/server/people/page-context";

import { DownloadBankFileButton, MakeBankFileForm, ReleaseRunForm } from "./pay-forms";

const naira = (k: Kobo) => formatNaira(k, { whole: true });
const TH = "px-3 py-2.5 text-left font-semibold whitespace-nowrap";
const THN = "px-3 py-2.5 text-right font-semibold whitespace-nowrap";
const TD = "px-3 py-3 whitespace-nowrap";
const TDN = "px-3 py-3 text-right tabular-nums whitespace-nowrap";

const workers = (n: number) => `${n} ${n === 1 ? "worker" : "workers"}`;

/**
 * The run's Pay step (slice 5.4, the Payroll board's "payment file"): make the bank file with its
 * control totals (count, total, SHA-256), download it (owner and finance, 60-second link), then
 * "I uploaded it to the bank" releases the run. HR sees the totals and masked last 4 digits.
 */
export async function PayStep({ d, canMake }: { d: RunDetail; canMake: boolean }) {
  const { run } = d;
  const posted = run.status === "approved" || run.status === "released";
  if (!posted) {
    return (
      <section aria-labelledby="pay" className="flex max-w-3xl flex-col gap-3">
        <h2 id="pay" className="m-0 type-h2">
          Pay
        </h2>
        <p className="m-0 text-[15px] text-fg-muted">
          The bank file is made once a second person in Finance approves the run. Metalira never
          holds the money: the company uploads the file to its own bank.
        </p>
      </section>
    );
  }

  const ctx = await peoplePageContext();
  const workerNames = new Map(d.payslips.map((p) => [p.workerId, p.workerName] as const));
  const payout = await loadPayoutDetail(ctx.supabase, ctx.organisationId, run.id, workerNames, [
    run.releasedBy,
  ]);
  const { active } = payout;
  const voided = payout.batches.filter((b) => b.status === "voided");
  const paid = payout.items.filter((i) => i.status === "pending");
  const leftOut = payout.items.filter((i) => i.status === "left_out");
  const person = (id: string | null) =>
    (id && (payout.people.get(id) ?? d.names.get(id))) || "a manager";
  const released = run.status === "released";

  return (
    <section aria-labelledby="pay" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pay" className="m-0 type-h2">
          {released ? "Paid and released" : active ? "Bank file ready" : "Make the bank file"}
        </h2>
        <span className="text-[13px] text-fg-muted">
          Net pay {naira(run.totals.netKobo)} to {workers(run.totals.workerCount)}
        </span>
      </div>
      <p className="m-0 max-w-3xl text-[15px] text-fg-muted">
        Upload the file to the company&apos;s own bank as a bulk payment. Metalira never holds or
        moves the money. Check the control totals against what your bank shows before you approve it
        there.
      </p>

      {active ? (
        <div className="flex flex-col gap-3" data-testid="bank-file">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-3">
            <div className="flex flex-col gap-1.5 rounded-xl border border-line p-4">
              <span className="type-label text-fg-muted">Workers in the file</span>
              <span className="font-heading text-xl font-medium" data-testid="bank-file-count">
                {active.itemCount}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 rounded-xl border border-line p-4">
              <span className="type-label text-fg-muted">Total</span>
              <span className="font-heading text-xl font-medium" data-testid="bank-file-total">
                {naira(active.totalKobo)}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 rounded-xl border border-line p-4">
              <span className="type-label text-fg-muted">Left out</span>
              <span className="font-heading text-xl font-medium">
                {active.leftOutCount}
                {active.leftOutCount > 0 ? (
                  <span className="text-sm font-normal text-fg-muted">
                    {" "}
                    · {naira(active.leftOutKobo)}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-xl border border-line p-4 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-fg-muted">SHA-256</dt>
            <dd className="m-0 font-mono text-[13px] break-all" data-testid="bank-file-sha">
              {active.fileSha256}
            </dd>
            <dt className="text-fg-muted">Format</dt>
            <dd className="m-0">{bankFormat(active.bankFormat)?.label ?? active.bankFormat}</dd>
            <dt className="text-fg-muted">Made</dt>
            <dd className="m-0">
              by {person(active.madeBy)} · {formatDateTime(active.createdAt)}
            </dd>
          </dl>
          {canMake ? <DownloadBankFileButton batchId={active.id} /> : null}

          <div className="relative overflow-x-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-sm" aria-label="Workers in the bank file">
              <thead className="bg-surface">
                <tr>
                  <th className={TH}>Worker</th>
                  <th className={TH}>Bank</th>
                  <th className={TH}>Account</th>
                  <th className={THN}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {paid.map((i) => (
                  <tr key={i.id} className="border-t border-line" data-testid="bank-file-row">
                    <td className={TD}>
                      <span className="flex flex-col">
                        <span className="font-semibold">{i.workerName}</span>
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
                {leftOut.map((i) => (
                  <tr key={i.id} className="border-t border-line text-fg-muted">
                    <td className={cn(TD, "font-semibold")}>{i.workerName}</td>
                    <td className="px-3 py-3" colSpan={3}>
                      {i.leftOutReason ? LEFT_OUT_LABEL[i.leftOutReason] : "Not in this file"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="m-0 rounded-xl border border-line p-4 text-sm">
          No bank file yet.{" "}
          {canMake
            ? "Make it below: each account number is checked against its last 4 digits first."
            : "Finance or an owner makes it."}
        </p>
      )}

      {released ? (
        <p
          role="status"
          className="m-0 flex flex-wrap items-center gap-2 rounded-xl border border-line p-4 text-sm"
          data-testid="released-note"
        >
          <Status tone="done">Released</Status>
          <span>
            by {person(run.releasedBy)}
            {run.releasedAt ? ` · ${formatDateTime(run.releasedAt)}` : ""}. The bank file went to
            the bank and stays as it is.
          </span>
        </p>
      ) : null}

      {!released && canMake ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-5">
          <h3 className="m-0 type-h3">{active ? "Replace the file" : "Make the file"}</h3>
          <p className="m-0 text-sm text-fg-muted">
            {active
              ? "Only if something changed: the current file is voided with your reason and can't be downloaded again."
              : "Pays each worker's net pay to the bank details in force now. Workers HR left out for missing details or a bank change in its hold are listed as not in this file."}
          </p>
          <MakeBankFileForm runId={run.id} formats={bankFormatOptions()} replaces={!!active} />
        </div>
      ) : null}

      {!released && canMake && active ? (
        <div
          className="flex flex-col gap-3 rounded-xl border border-line p-5"
          data-testid="release-panel"
        >
          <h3 className="m-0 type-h3">After you upload it</h3>
          <p className="m-0 text-sm text-fg-muted">
            Confirm the file went to the bank. This releases the run: workers can see their
            payslips, and the file can&apos;t be replaced. Someone who prepared or changed the run
            can&apos;t release it.
          </p>
          <ReleaseRunForm runId={run.id} />
        </div>
      ) : null}

      {voided.length > 0 ? (
        <section aria-labelledby="voided-files" className="flex flex-col gap-2">
          <h3 id="voided-files" className="m-0 type-h3">
            Replaced files
          </h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {voided.map((b) => (
              <li key={b.id} className="rounded-lg border border-line px-3 py-2.5 text-sm">
                <span className="block">
                  {workers(b.itemCount)} · {naira(b.totalKobo)} · made by {person(b.madeBy)},{" "}
                  {formatDateTime(b.createdAt)}
                </span>
                <span className="block text-fg-muted">
                  Voided by {person(b.voidedBy)}
                  {b.voidedAt ? ` · ${formatDateTime(b.voidedAt)}` : ""}: {b.voidReason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
