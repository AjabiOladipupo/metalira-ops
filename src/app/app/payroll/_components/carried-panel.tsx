import { formatDate } from "@/lib/dates";
import { formatNaira, type Kobo } from "@/lib/money";
import { runMonth } from "@/lib/payroll/run-format";
import type { CarriedDeductions } from "@/server/payroll/carried-data";

const naira = (k: Kobo) => formatNaira(k, { whole: false });
const TH = "px-3 py-2 text-left font-semibold whitespace-nowrap";
const THN = "px-3 py-2 text-right font-semibold whitespace-nowrap";
const TD = "px-3 py-2.5 whitespace-nowrap";
const TDN = "px-3 py-2.5 text-right tabular-nums whitespace-nowrap";

const workers = (n: number) => `${n} ${n === 1 ? "worker" : "workers"}`;

/**
 * Carried deductions (slice 5.7c, open question 6): deductions a payslip couldn't fit without
 * taking net pay below ₦0, carried to the next run and settled there first. Each worker's running
 * balance across posted runs, newest balance first; the entries open per worker.
 */
export function CarriedPanel({ data }: { data: CarriedDeductions }) {
  if (data.workers.length === 0 && data.notCarried.length === 0) return null;
  const owing = data.workers.filter((w) => w.balanceKobo > 0n);
  return (
    <section
      aria-labelledby="carried"
      className="flex flex-col gap-3 rounded-xl border border-line p-5"
      data-testid="carried-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="carried" className="m-0 type-h3">
          {naira(data.outstandingKobo)} carried deductions outstanding
        </h2>
        <span className="text-[13px] text-fg-muted">
          {workers(owing.length)} still owe · {workers(data.workers.length)} carried one
        </span>
      </div>
      <p className="m-0 max-w-3xl text-sm text-fg-muted">
        Net pay never goes below ₦0. What a payslip couldn&apos;t take is carried to the next run
        and taken there first, after statutory deductions. Whether the law caps deductions from
        wages is a question for your tax adviser.
      </p>
      {data.notCarried.length > 0 ? (
        <div
          className="flex flex-col gap-1.5 rounded-lg border border-foreground px-3 py-2.5 text-sm"
          data-testid="instalments-not-carried"
        >
          <p className="m-0 font-semibold">
            {data.notCarried.length} recurring{" "}
            {data.notCarried.length === 1 ? "instalment" : "instalments"} not carried: the
            worker&apos;s final pay had already posted
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {data.notCarried.map((n) => (
              <li key={`${n.seriesId}-${n.instalment}`}>
                {n.workerName} · instalment {n.instalment} of {n.of} · {naira(n.amountKobo)} ·{" "}
                {formatDate(n.at.slice(0, 10))}
              </li>
            ))}
          </ul>
          <p className="m-0 text-fg-muted">
            Settle each with the worker, or with a correction run if anything is still owed.
          </p>
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {data.workers.map((w) => (
          <li key={w.workerId} className="rounded-lg border border-line">
            <details>
              <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-3 py-2.5 text-sm">
                <span>
                  <span className="font-semibold">{w.workerName}</span>
                  {w.staffId ? <span className="text-fg-muted"> · {w.staffId}</span> : null}
                </span>
                <span className="tabular-nums" data-testid="carried-balance">
                  {w.balanceKobo > 0n ? `${naira(w.balanceKobo)} still owed` : "Settled"}
                </span>
              </summary>
              <div className="relative overflow-x-auto border-t border-line">
                <table
                  className="w-full border-collapse text-sm"
                  aria-label={`Carried deductions for ${w.workerName}`}
                >
                  <thead className="bg-surface">
                    <tr>
                      <th className={TH}>Run</th>
                      <th className={THN}>Brought forward</th>
                      <th className={THN}>Taken</th>
                      <th className={THN}>Added</th>
                      <th className={THN}>Carried forward</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.entries.map((e) => (
                      <tr key={e.runId} className="border-t border-line">
                        <td className={TD}>
                          {runMonth(e.periodEnd)}
                          <span className="block text-xs text-fg-muted">
                            paid {formatDate(e.payDate)}
                            {e.mismatch ? " · took more than this list carried" : ""}
                          </span>
                        </td>
                        <td className={TDN}>{naira(e.broughtKobo)}</td>
                        <td className={TDN}>{naira(e.settledKobo)}</td>
                        <td className={TDN}>{naira(e.addedKobo)}</td>
                        <td className={TDN}>{naira(e.carriedKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
