import { Status } from "@/components/status";
import { formatDate } from "@/lib/dates";
import { formatNaira, koboToMajorString, type Kobo } from "@/lib/money";
import type { ManagerRole } from "@/lib/roles";
import {
  DOCUMENT_LABELS,
  RELIEF_LABELS,
  canWriteTaxRecords,
  loadWorkerTaxRecords,
  type ReliefView,
} from "@/server/payroll/tax-records";
import type { PeoplePageContext } from "@/server/people/page-context";

import { DetailList, Section } from "./display";
import {
  DeclareReliefForm,
  NhfNumberForm,
  OpeningBalanceForm,
  ProofLinkButton,
  ProofUploadForm,
  VerifyReliefForm,
} from "./tax-relief-forms";

/**
 * The worker's "Tax and reliefs" section (slice 5.9a, the tax adviser's answers): this tax year's
 * opening balance, relief declarations with their proofs and verification, and the NHF number on
 * file. Owner, hr and finance see it; owner and hr change it. Loaded on its own (Suspense), so the
 * person page waits for none of it.
 */

const money = (k: Kobo) => formatNaira(k, { whole: k % 100n === 0n });
const monthOf = (iso: string) =>
  new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

function statusOf(r: ReliefView) {
  if (r.status === "verified") return <Status tone="done">Verified</Status>;
  if (r.status === "rejected") return <Status tone="action">Rejected</Status>;
  return <Status tone="pending">Not verified</Status>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line p-4">
      <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export async function TaxReliefsSection({
  workerId,
  ctx,
  active,
}: {
  workerId: string;
  ctx: Pick<PeoplePageContext, "supabase" | "organisationId" | "today" | "role">;
  active: boolean;
}) {
  const taxYear = Number(ctx.today.slice(0, 4));
  const records = await loadWorkerTaxRecords(ctx.supabase, ctx.organisationId, workerId, taxYear);
  const canEdit = canWriteTaxRecords(ctx.role as ManagerRole) && active;
  const o = records.opening;
  const verified = records.reliefs.filter((r) => r.status === "verified").length;

  return (
    <Section
      id="tax"
      title="Tax and reliefs"
      description={`${taxYear} tax year · ${records.reliefs.length} ${records.reliefs.length === 1 ? "relief" : "reliefs"} declared, ${verified} verified. PAYE counts a relief only once its proof is verified.`}
    >
      <Card title={`Opening balance for ${taxYear}`}>
        {o ? (
          <>
            <DetailList
              items={[
                { label: "Covers to", value: monthOf(o.asOfMonth) },
                { label: "Gross pay to date", value: money(o.grossKobo) },
                { label: "Chargeable pay to date", value: money(o.chargeableKobo) },
                { label: "PAYE withheld to date", value: money(o.payeKobo) },
                { label: "Pension to date", value: money(o.pensionKobo) },
              ]}
            />
            <p className="m-0 text-[13px] text-fg-muted">
              Recorded {formatDate(o.createdAt.slice(0, 10))}
              {o.corrections > 0
                ? ` · ${o.corrections} earlier ${o.corrections === 1 ? "row" : "rows"} kept`
                : ""}
              . Reason: {o.reason}
            </p>
          </>
        ) : (
          <p className="m-0 text-sm text-fg-muted">
            None. Add one only when this worker was paid in {taxYear} before your first payroll in
            Metalira, so year-to-date PAYE starts from the right figures.
          </p>
        )}
        {canEdit ? (
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-signal">
              {o ? "Correct the opening balance" : "Add an opening balance"}
            </summary>
            <div className="mt-3">
              <OpeningBalanceForm
                workerId={workerId}
                taxYear={taxYear}
                current={{
                  id: o?.id ?? null,
                  asOfMonth: o ? o.asOfMonth.slice(0, 7) : "",
                  gross: o ? koboToMajorString(o.grossKobo) : "",
                  chargeable: o ? koboToMajorString(o.chargeableKobo) : "",
                  paye: o ? koboToMajorString(o.payeKobo) : "",
                  pension: o ? koboToMajorString(o.pensionKobo) : "",
                }}
              />
            </div>
          </details>
        ) : null}
      </Card>

      <Card title="Reliefs">
        {records.reliefs.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            None declared for {taxYear}. Rent relief is 20% of the annual rent, capped at
            ₦500,000; NHIS and life assurance count as declared.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {records.reliefs.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {money(r.annualKobo)} a year · {RELIEF_LABELS[r.kind]}
                  </span>
                  {statusOf(r)}
                </div>
                {r.statusNote ? (
                  <p className="m-0 text-[13px] text-fg-muted">Note: {r.statusNote}</p>
                ) : null}
                {r.proofs.length > 0 ? (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {r.proofs.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                        <span>{DOCUMENT_LABELS[p.documentKind]}</span>
                        <span className="text-[13px] text-fg-muted">
                          {p.fileExt.toUpperCase()} · {formatDate(p.createdAt.slice(0, 10))}
                        </span>
                        <ProofLinkButton proofId={p.id} label="Open" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 text-[13px] text-fg-muted">
                    No proof yet.{" "}
                    {r.kind === "rent"
                      ? "Add the tenancy agreement, receipts and payment record."
                      : "Add the statement, policy or receipts."}
                  </p>
                )}
                {canEdit ? (
                  <details>
                    <summary className="cursor-pointer text-sm font-semibold text-signal">
                      Add proof or verify
                    </summary>
                    <div className="mt-3 flex flex-col gap-4">
                      <ProofUploadForm declarationId={r.id} workerId={workerId} kind={r.kind} />
                      {r.proofs.length > 0 ? (
                        <VerifyReliefForm declarationId={r.id} workerId={workerId} />
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-signal">
              Declare or correct a relief
            </summary>
            <div className="mt-3">
              <DeclareReliefForm
                workerId={workerId}
                taxYear={taxYear}
                current={Object.fromEntries(records.reliefs.map((r) => [r.kind, r.id]))}
              />
            </div>
          </details>
        ) : null}
      </Card>

      <Card title="NHF number">
        <p className="m-0 text-sm">
          {records.nhfLast4 ? (
            <>
              On file, ending <span className="font-mono">••••{records.nhfLast4}</span>
            </>
          ) : (
            <span className="text-fg-muted">
              Not on file. NHF is taken only from workers who opted in and have a number on file.
            </span>
          )}
        </p>
        {canEdit ? (
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-signal">
              {records.nhfLast4 ? "Change or remove" : "Add the NHF number"}
            </summary>
            <div className="mt-3">
              <NhfNumberForm workerId={workerId} onFile={records.nhfLast4 !== null} />
            </div>
          </details>
        ) : null}
      </Card>
    </Section>
  );
}
