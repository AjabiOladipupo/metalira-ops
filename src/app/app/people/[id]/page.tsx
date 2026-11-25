import { Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { Suspense } from "react";

import { BackLink } from "@/components/back-link";
import { DataTable, type Column } from "@/components/data-table";
import { NameCheckStatus, TestLookupBadge } from "@/components/name-check";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { WorkerAvatar } from "@/components/worker-avatar";
import { matchPersonName } from "@/lib/bank-name-match";
import { bankFromName } from "@/lib/banks";
import { addDays, firstOfNextMonth, formatDate, formatDateTime } from "@/lib/dates";
import { DEFAULT_REPLY_DAYS, replyByRange, summariseQueries } from "@/lib/queries";
import { maskAccount, maskRsaPin, ninStatus } from "@/lib/mask";
import { formatNaira, koboToMajorString, type Kobo } from "@/lib/money";
import {
  EMPLOYMENT_TYPE_LABELS,
  PAY_PERIOD,
  PAY_TYPE_LABELS,
  currentPayVersion,
  payHeadline,
  payVersionState,
} from "@/lib/people";
import type { SignInCredential } from "@/lib/pin-lockout";
import { ROLE_LABELS, type ManagerRole } from "@/lib/roles";
import { loadPayRateEarliestStart } from "@/server/payroll/run-data";
import { sendAppliedBankChangeNotices } from "@/server/people/bank-change-notices";
import {
  applyDueBankChanges,
  canViewBankChanges,
  loadBankChangeViewer,
  loadBankChanges,
  type BankChangeView,
  type BankChangeViewer,
} from "@/server/people/bank-changes";
import { loadChangeRequests, type ChangeRequestView } from "@/server/people/change-requests";
import type { PayRateVersion } from "@/server/people/pay-rates";
import { loadWorkerProfile, type WorkerProfile } from "@/server/people/people-data";
import { HR_FILE_READERS, loadWorkerQueries, type QueryView } from "@/server/people/queries";
import { peoplePageContext, type PeoplePageContext } from "@/server/people/page-context";
import { canSeePii } from "@/server/people/pii-access";
import {
  NEW_PIN_ROLES,
  SIGN_IN_UNLOCKERS,
  loadSignInCredential,
} from "@/server/people/sign-in-status";
import {
  isStaffIdCorrector,
  loadStaffIdCorrections,
  type StaffIdCorrectionView,
} from "@/server/people/staff-id-corrections";

import { RouteGate } from "../../_shell/slots";
import { BankChangeCard } from "../_components/bank-change-card";
import { BankChangeRequestForm, CheckBankDetails } from "../_components/bank-change-forms";
import { CancelPayButton } from "../_components/cancel-pay-button";
import { ChangeRequestCard } from "../_components/change-request-card";
import { DetailList, NotSet, Section } from "../_components/display";
import { TaxReliefsSection } from "../_components/tax-reliefs";
import { EndEmploymentForm } from "../_components/end-employment-form";
import { HrFileQueries } from "../_components/hr-file";
import { HrFileLeave } from "../_components/hr-file-leave";
import { PayChangeForm } from "../_components/pay-change-form";
import { RevealValue } from "../_components/reveal-value";
import { SignInPanel } from "../_components/sign-in-panel";
import { StaffIdCorrectionCard, type StaffIdViewer } from "../_components/staff-id-correction-card";
import { StaffIdCorrectionForm } from "../_components/staff-id-forms";

export const metadata: Metadata = { title: "Employee" };

/** Roles that see the worker's phone sign-in status (RLS narrows line managers to reportees). */
const SIGN_IN_VIEWERS: readonly ManagerRole[] = SIGN_IN_UNLOCKERS;

const has = (roles: readonly ManagerRole[], role: ManagerRole) => roles.includes(role);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(kobo: Kobo | null): string | null {
  return kobo === null ? null : formatNaira(kobo);
}

function payBreakdown(rate: PayRateVersion): string {
  if (rate.payType !== "monthly")
    return `${formatNaira(payHeadline(rate))} ${PAY_PERIOD[rate.payType]}`;
  const parts = [`${formatNaira(rate.basic ?? 0n)} basic`];
  if (rate.housing) parts.push(`${formatNaira(rate.housing)} housing`);
  if (rate.transport) parts.push(`${formatNaira(rate.transport)} transport`);
  if (rate.otherAllowances) parts.push(`${formatNaira(rate.otherAllowances)} other`);
  return parts.join(" + ");
}

function PayHistory({
  versions,
  today,
  canEdit,
}: {
  versions: PayRateVersion[];
  today: string;
  canEdit: boolean;
}) {
  const latestId = versions.at(-1)?.id;
  const columns: Column<PayRateVersion>[] = [
    { key: "from", header: "From", cell: (v) => formatDate(v.effectiveFrom) },
    {
      key: "to",
      header: "To",
      cell: (v) => (v.effectiveTo ? formatDate(v.effectiveTo) : <NotSet>Open</NotSet>),
    },
    { key: "type", header: "Pay type", cell: (v) => PAY_TYPE_LABELS[v.payType] },
    {
      key: "amount",
      header: "Amount",
      kind: "money",
      cell: (v) => `${formatNaira(payHeadline(v))} ${PAY_PERIOD[v.payType]}`,
    },
    {
      key: "detail",
      header: "Made up of",
      className: "min-w-56 whitespace-normal",
      cell: (v) => payBreakdown(v),
    },
    {
      key: "state",
      header: "Status",
      cell: (v) => {
        const state = payVersionState(v, today);
        if (state === "current") return <Status tone="done">Current</Status>;
        if (state === "scheduled") {
          return (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Status tone="pending">Scheduled</Status>
              {canEdit && v.id === latestId ? (
                <CancelPayButton
                  payRateId={v.id}
                  label={`Cancel pay change from ${formatDate(v.effectiveFrom)}`}
                />
              ) : null}
            </span>
          );
        }
        return <span className="text-fg-muted">Ended</span>;
      },
    },
  ];
  return (
    <DataTable
      caption="Pay history"
      columns={columns}
      rows={[...versions].reverse()}
      getRowId={(v) => v.id}
      className="pay-history"
    />
  );
}

function amountsForForm(rate: PayRateVersion | null): Partial<Record<string, string>> {
  if (!rate) return {};
  const str = (kobo: Kobo | null) => (kobo === null ? undefined : koboToMajorString(kobo));
  return {
    basic: str(rate.basic),
    housing: str(rate.housing),
    transport: str(rate.transport),
    otherAllowances: str(rate.otherAllowances),
    dailyRate: str(rate.dailyRate),
    hourlyRate: str(rate.hourlyRate),
  };
}

function Profile({
  worker,
  ctx,
  bankChanges,
  viewer,
  changeRequests,
  credential,
  corrections,
  staffIdViewer,
  queries,
  payFloor,
}: {
  worker: WorkerProfile;
  ctx: Awaited<ReturnType<typeof peoplePageContext>>;
  /** This worker's bank-detail changes, newest first (empty for roles that can't see them). */
  bankChanges: BankChangeView[];
  viewer: BankChangeViewer;
  /** Changes the employee asked for from the worker app (empty for roles that can't see them). */
  changeRequests: ChangeRequestView[];
  /** The worker's phone login, for roles that see it (null otherwise or when none). */
  credential: SignInCredential | null;
  /** Staff ID corrections for this worker, newest first (owner, admin and hr only). */
  corrections: StaffIdCorrectionView[];
  staffIdViewer: StaffIdViewer;
  /** The HR file's queries, or null for roles that don't see the HR file. */
  queries: QueryView[] | null;
  /** The earliest start for a new pay version (decision 17), or null for "today". */
  payFloor: string | null;
}) {
  const { today, canEdit, canSeePay, canEditPay, role } = ctx;
  const active = worker.status === "active";
  // Line managers see their own reportees (slice 1.11): job, contact and sign-in, no pay.
  const limited = role === "line_manager";
  const pendingCorrection = corrections.find((c) => c.status === "pending") ?? null;
  const current = currentPayVersion(worker.payRates, today);
  const latest = worker.payRates.at(-1) ?? null;
  // A new version starts after the latest one, and never before the floor: today until payroll
  // posts, then back to the day after the latest posted pay period (Phase 1 decision 17).
  const floor = payFloor ?? today;
  const minFrom =
    latest && latest.effectiveFrom >= floor ? addDays(latest.effectiveFrom, 1) : floor;
  const nextMonth = firstOfNextMonth(today);
  const defaultFrom = nextMonth > minFrom ? nextMonth : minFrom;

  return (
    <>
      <div className="flex flex-col gap-4">
        {limited ? null : <BackLink href="/app/people" label="People" className="-my-2" />}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4 sm:items-center">
            <WorkerAvatar workerId={worker.id} name={worker.name} size={56} />
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="m-0 type-h1 break-words">{worker.name}</h1>
              <p className="m-0 type-body-lg text-fg-muted" data-testid="worker-staff-id">
                {worker.jobTitle ? `${worker.jobTitle} · ` : ""}
                {worker.staffId}
              </p>
            </div>
          </div>
          {canEdit && active ? (
            <Button asChild variant="outline" className="h-10 rounded-lg">
              <Link href={`/app/people/${worker.id}/edit`}>
                <Pencil strokeWidth={1.75} aria-hidden />
                Edit details
              </Link>
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {active ? (
            <Status tone="done">Active</Status>
          ) : (
            <Status tone="pending">
              Left on {worker.endDate ? formatDate(worker.endDate) : "an earlier date"}
            </Status>
          )}
          {worker.mapped ? (
            <Status tone="done">Mapped</Status>
          ) : (
            <Status tone="pending" className="font-semibold">
              Mapping incomplete
            </Status>
          )}
          {worker.needsPayDetails && !limited ? (
            <Status tone="action">Needs pay details before payroll</Status>
          ) : null}
          {worker.supervisorClockIn ? <Status tone="pending">Supervisor clock-in</Status> : null}
        </div>
      </div>

      {changeRequests.length > 0 ? (
        <Section
          id="change-requests"
          title="Requests from the employee"
          description="Sent from the worker app. Change the record yourself, then mark the request done or decline it."
        >
          {changeRequests.map((request) => (
            <ChangeRequestCard key={request.id} request={request} canResolve={canEdit} />
          ))}
        </Section>
      ) : null}

      <Section id="job" title="Job and mapping">
        <DetailList
          items={[
            { label: "Department", value: worker.departmentName },
            { label: "Line manager", value: worker.lineManagerName },
            { label: "Site", value: worker.siteNames.join(", ") },
            { label: "Projects", value: worker.projectNames.join(", ") },
            { label: "Employment type", value: EMPLOYMENT_TYPE_LABELS[worker.employmentType] },
            { label: "Start date", value: formatDate(worker.startDate) },
            ...(worker.endDate ? [{ label: "End date", value: formatDate(worker.endDate) }] : []),
          ]}
        />
      </Section>

      <Section id="contact" title="Identity and contact">
        <DetailList
          items={[
            { label: "Staff ID", value: worker.staffId, testId: "staff-id" },
            { label: "Phone", value: worker.phone },
            { label: "Email", value: worker.email },
          ]}
        />
        {corrections.map((correction) => (
          <StaffIdCorrectionCard
            key={correction.id}
            correction={correction}
            viewer={staffIdViewer}
            showWorker={false}
          />
        ))}
        {canEdit && active && !pendingCorrection ? (
          <StaffIdCorrectionForm workerId={worker.id} currentStaffId={worker.staffId} />
        ) : null}
      </Section>

      {has(SIGN_IN_VIEWERS, role) ? (
        <Section
          id="sign-in"
          title="Phone sign-in"
          description="Company code, staff ID and a 6-digit PIN."
        >
          <SignInPanel
            workerId={worker.id}
            credential={credential}
            canUnlock={active && has(SIGN_IN_UNLOCKERS, role)}
            canSendInvite={active && has(NEW_PIN_ROLES, role)}
            now={new Date()}
          />
        </Section>
      ) : null}

      {queries ? (
        <HrFileSection
          worker={worker}
          queries={queries}
          today={today}
          viewerUserId={ctx.userId}
          self={staffIdViewer.ownWorkerIds.includes(worker.id)}
          supabase={ctx.supabase}
          organisationId={ctx.organisationId}
        />
      ) : null}

      {limited ? null : (
        <>
          {/* Owner decision, 23 Nov 2026: pay amounts for owner, hr and finance only. */}
          {canSeePay ? (
            <Section
              id="pay"
              title="Pay"
              description="Each change is a dated version. Versions already in force are never edited."
            >
              {worker.payRates.length === 0 ? (
                <p className="m-0 text-sm text-fg-muted">
                  No pay on record yet. Payroll skips this employee until pay is added.
                </p>
              ) : (
                <>
                  <DetailList
                    items={[
                      {
                        label: "Current pay",
                        value: current
                          ? `${formatNaira(payHeadline(current))} ${PAY_PERIOD[current.payType]}`
                          : "None in force today",
                        testId: "current-pay",
                      },
                      {
                        label: "Pay type",
                        value: current ? PAY_TYPE_LABELS[current.payType] : null,
                      },
                      {
                        label: "In force since",
                        value: current ? formatDate(current.effectiveFrom) : null,
                      },
                    ]}
                  />
                  <PayHistory
                    versions={worker.payRates}
                    today={today}
                    canEdit={canEditPay && active}
                  />
                </>
              )}
              {canEditPay && active ? (
                <PayChangeForm
                  workerId={worker.id}
                  defaultPayType={(current ?? latest)?.payType ?? "monthly"}
                  defaultAmounts={amountsForForm(current ?? latest)}
                  defaultFrom={
                    worker.payRates.length === 0 && worker.startDate > today
                      ? worker.startDate
                      : defaultFrom
                  }
                  minFrom={worker.payRates.length === 0 ? worker.startDate : minFrom}
                />
              ) : null}
            </Section>
          ) : null}

          {/* Slice 5.9a: opening balance, reliefs with proof, NHF number (owner, hr, finance). */}
          {canSeePay ? (
            <Suspense fallback={<p className="m-0 text-sm text-fg-muted">Loading tax records…</p>}>
              <TaxReliefsSection workerId={worker.id} ctx={ctx} active={active} />
            </Suspense>
          ) : null}

          <Section
            id="bank"
            title="Bank details"
            description="Changes need a second person to approve, then wait 72 hours before payouts use them."
            actions={
              canViewBankChanges(role) ? (
                <Link href="/app/people/approvals" className="text-sm">
                  All bank changes
                </Link>
              ) : null
            }
          >
            <DetailList
              items={[
                { label: "Bank", value: worker.bankName },
                { label: "Account name", value: worker.accountName },
                {
                  label: "Account number",
                  value: worker.bankAccountLast4 ? (
                    <RevealValue
                      workerId={worker.id}
                      field="bank_account"
                      masked={maskAccount(worker.bankAccountLast4)}
                      canReveal={canSeePii(role, "bank_account")}
                      testId="bank-account"
                    />
                  ) : null,
                },
                ...(worker.bankAccountLast4
                  ? [
                      {
                        label: "Account name check",
                        value: <BankCheckSummary worker={worker} />,
                      },
                    ]
                  : []),
              ]}
            />
            {canEdit && active && worker.bankAccountLast4 ? (
              <CheckBankDetails
                workerId={worker.id}
                defaultBankCode={worker.bankCode ?? bankFromName(worker.bankName)?.code ?? ""}
                bankFixed={worker.bankCode !== null}
              />
            ) : null}
            {bankChanges.map((change) => (
              <BankChangeCard key={change.id} change={change} viewer={viewer} showWorker={false} />
            ))}
            {canEdit && active ? (
              bankChanges.some((c) => c.status === "pending" || c.status === "approved") ? (
                <p className="m-0 text-sm text-fg-muted">
                  A new change can be raised once this one is applied, rejected or withdrawn.
                </p>
              ) : (
                <BankChangeRequestForm workerId={worker.id} />
              )
            ) : null}
          </Section>

          <Section id="tax" title="Tax and pension">
            <DetailList
              items={[
                {
                  label: "NIN",
                  value: worker.ninOnFile ? (
                    <span className="inline-flex flex-wrap items-center gap-x-3">
                      <span>{ninStatus(true)}</span>
                      {canSeePii(role, "nin") ? (
                        <RevealValue
                          workerId={worker.id}
                          field="nin"
                          masked=""
                          canReveal
                          testId="nin"
                        />
                      ) : null}
                    </span>
                  ) : (
                    ninStatus(false)
                  ),
                },
                { label: "TIN", value: worker.tin },
                { label: "Tax state", value: worker.taxState },
                { label: "Pension fund (PFA)", value: worker.pfaName },
                {
                  label: "RSA PIN",
                  value: worker.rsaPinOnFile ? (
                    <RevealValue
                      workerId={worker.id}
                      field="rsa_pin"
                      masked={maskRsaPin(worker.rsaPinLast4) || "On file"}
                      canReveal={canSeePii(role, "rsa_pin")}
                      testId="rsa-pin"
                    />
                  ) : null,
                },
                { label: "National Housing Fund", value: worker.nhfOptIn ? "Contributes" : "No" },
                { label: "Annual rent declared", value: money(worker.annualRentDeclared) },
              ]}
            />
          </Section>

          <Section id="next-of-kin" title="Next of kin">
            <DetailList
              items={[
                { label: "Name", value: worker.nextOfKinName },
                { label: "Phone", value: worker.nextOfKinPhone },
              ]}
            />
          </Section>
        </>
      )}

      {canEdit && active ? (
        <Section
          id="end"
          title="End employment"
          description="Closes their site and project assignments on the last working day. The record and pay history stay."
        >
          <EndEmploymentForm workerId={worker.id} today={today} />
        </Section>
      ) : null}

      <p className="m-0 text-xs text-fg-muted">
        You are viewing as {ROLE_LABELS[role]}.{" "}
        {canSeePii(role, "bank_account") || canSeePii(role, "nin")
          ? "Showing personal data in full is recorded in the audit log."
          : "Personal data is masked for your role."}
      </p>
    </>
  );
}

async function WorkerPage({ params }: { params: PageProps<"/app/people/[id]">["params"] }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await peoplePageContext();
  // A change whose 72-hour hold has ended takes effect before the bank details are shown.
  await applyDueBankChanges(ctx.supabase, ctx.organisationId);
  // And the worker hears about it now, not at the next daily cron run.
  after(() => sendAppliedBankChangeNotices(ctx.organisationId));
  // A line manager loads only what their page shows: no bank, tax, pension or next of kin.
  const worker = await loadWorkerProfile(ctx.supabase, ctx.organisationId, id, ctx.today, {
    viewer: ctx.role === "line_manager" ? "line_manager" : "manager",
    seePay: ctx.canSeePay,
  });
  if (!worker) notFound();
  const [bankChanges, viewer, changeRequests, credential, corrections] = await Promise.all([
    canViewBankChanges(ctx.role)
      ? loadBankChanges(ctx.supabase, ctx.organisationId, { workerId: id, limit: 5 })
      : Promise.resolve([]),
    loadBankChangeViewer(
      ctx.supabase,
      ctx.organisationId,
      ctx.userId,
      ctx.role,
      canSeePii(ctx.role, "bank_account"),
    ),
    ctx.canEdit ? loadChangeRequests(ctx.supabase, ctx.organisationId, id) : Promise.resolve([]),
    has(SIGN_IN_VIEWERS, ctx.role)
      ? loadSignInCredential(ctx.supabase, ctx.organisationId, id)
      : Promise.resolve(null),
    isStaffIdCorrector(ctx.role)
      ? loadStaffIdCorrections(ctx.supabase, ctx.organisationId, { workerId: id, limit: 10 })
      : Promise.resolve([]),
  ]);
  // The HR file (slice 4.6): RLS gives a line manager only their current reportees' queries
  // and the ones they raised.
  const [queries, payFloor] = await Promise.all([
    has(HR_FILE_READERS, ctx.role)
      ? loadWorkerQueries(ctx.supabase, ctx.organisationId, id)
      : Promise.resolve(null),
    ctx.canEditPay
      ? loadPayRateEarliestStart(ctx.supabase, ctx.organisationId)
      : Promise.resolve(null),
  ]);
  return (
    <Profile
      worker={worker}
      ctx={ctx}
      bankChanges={bankChanges}
      viewer={viewer}
      changeRequests={changeRequests}
      credential={credential}
      corrections={corrections}
      staffIdViewer={{
        userId: ctx.userId,
        canDecide: isStaffIdCorrector(ctx.role),
        ownWorkerIds: viewer.ownWorkerIds,
      }}
      queries={queries}
      payFloor={payFloor}
    />
  );
}

/**
 * The HR file (slice 4.6, owner decision 10): queries with their replies, leave history and
 * balance (slice 4.4), and timesheet exception counts with slices 4.2 and 4.3, in the
 * placeholders below. A section of the person page, not a sub-route, so line managers keep
 * exactly the two People routes they may open (tests/unit/nav.test.ts).
 */
function HrFileSection({
  worker,
  queries,
  today,
  viewerUserId,
  self,
  supabase,
  organisationId,
}: {
  supabase: PeoplePageContext["supabase"];
  organisationId: string;
  worker: WorkerProfile;
  queries: QueryView[];
  today: string;
  viewerUserId: string;
  /** The viewer's own worker record: no raising or closing queries about yourself. */
  self: boolean;
}) {
  const counts = summariseQueries(queries, today);
  const range = replyByRange(today);
  const parts = [`${counts.total} ${counts.total === 1 ? "query" : "queries"}`];
  if (counts.open > 0) parts.push(`${counts.open} open`);
  if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`);
  return (
    <Section
      id="hr-file"
      title="HR file"
      description={`${parts.join(" · ")}. Kept for the record: queries are never deleted, only closed or withdrawn.`}
    >
      <HrFileQueries
        queries={queries}
        today={today}
        viewerUserId={viewerUserId}
        canRaise={!self && worker.status === "active"}
        canAct={!self}
        workerId={worker.id}
        workerName={worker.name}
        replyBy={{ ...range, default: addDays(today, DEFAULT_REPLY_DAYS) }}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3">
        <Suspense fallback={<span aria-hidden className="block h-24 rounded-xl bg-surface" />}>
          <HrFileLeave
            supabase={supabase}
            organisationId={organisationId}
            workerId={worker.id}
            today={today}
          />
        </Suspense>
        <p
          data-testid="hr-file-timesheet-placeholder"
          className="m-0 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-fg-muted"
        >
          Timesheet exceptions by period: coming soon.
        </p>
      </div>
    </Section>
  );
}

/** The last bank check of the details on file, compared with the employee's name now. */
function BankCheckSummary({ worker }: { worker: WorkerProfile }) {
  if (!worker.bankCheck) {
    return (
      <span className="flex flex-col gap-1">
        <NameCheckStatus status="not_checked" />
        <span className="text-xs text-fg-muted">
          Saved without a check with the bank (for example, imported).
        </span>
      </span>
    );
  }
  const check = matchPersonName(worker.bankCheck.accountName, worker);
  return (
    <span className="flex flex-col gap-1" data-testid="worker-bank-check">
      <span className="flex flex-wrap items-center gap-2">
        <NameCheckStatus status={check.result} />
        {worker.bankCheck.test ? <TestLookupBadge /> : null}
      </span>
      <span className="text-xs text-fg-muted">
        The bank gave {worker.bankCheck.accountName} on {formatDateTime(worker.bankCheck.at)}.
      </span>
    </span>
  );
}

export default function Page({ params }: PageProps<"/app/people/[id]">) {
  return (
    <RouteGate href="/app/people/[id]">
      <WorkerPage params={params} />
    </RouteGate>
  );
}
