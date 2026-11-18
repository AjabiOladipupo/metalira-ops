import type { Metadata } from "next";
import Link from "next/link";
import { cache, Suspense } from "react";

import { Illustration } from "@/components/illustration";
import { Status, type StatusTone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { WorkerAvatar } from "@/components/worker-avatar";
import { formatDate, formatDateTime, lagosToday } from "@/lib/dates";
import { maskAccount } from "@/lib/mask";
import { workerMessages } from "@/lib/messages/worker";
import { myProfileSections, type ProfileSection } from "@/lib/worker-profile";
import type { WorkerChangeRequestStatus } from "@/lib/worker-requests";
import { signOutWorker } from "@/server/identity/worker-actions";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import type { BankChangeStatus } from "@/server/people/bank-changes";
import { loadMyProfile, type MyBankChange, type MyChangeRequest } from "@/server/people/my-profile";

import { WorkerTopBar } from "../../_components/worker-top-bar";
import { MeTabs } from "./me-tabs";

export const metadata: Metadata = { title: "Me" };

const copy = workerMessages.me;
const topics = workerMessages.change.topics;

/** The Lagos calendar day of a moment, as "14 Nov 2026". */
const sentDate = (at: string) => formatDate(lagosToday(new Date(at)));

function Rows({ section }: { section: ProfileSection }) {
  return (
    <section aria-labelledby={`me-${section.id}`} className="flex flex-col">
      <h2 id={`me-${section.id}`} className="m-0 mb-0.5 type-label text-fg-muted">
        {section.title}
      </h2>
      <dl className="m-0">
        {section.rows.map((row) => (
          <div
            key={row.label}
            className="flex justify-between gap-3 border-b border-line py-2.5 text-[15px]"
          >
            <dt className="shrink-0 text-fg-muted">{row.label}</dt>
            <dd
              className={
                row.value
                  ? "m-0 min-w-0 text-right font-medium break-words"
                  : "m-0 text-right text-fg-muted"
              }
              data-testid={row.testId}
            >
              {row.value ?? copy.notSet}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const BANK_TONE: Record<BankChangeStatus, StatusTone | null> = {
  pending: "pending",
  approved: "partial",
  applied: "done",
  rejected: null,
  cancelled: null,
};

function bankStatusText(change: MyBankChange): string {
  if (change.status === "approved") {
    return copy.bankStatus.approved(
      change.appliesAfter ? formatDateTime(change.appliesAfter) : sentDate(change.createdAt),
    );
  }
  return copy.bankStatus[change.status];
}

const REQUEST_TONE: Record<WorkerChangeRequestStatus, StatusTone | null> = {
  open: "pending",
  done: "done",
  declined: null,
};

function StatusLine({ tone, text }: { tone: StatusTone | null; text: string }) {
  return tone ? (
    <Status tone={tone} className="whitespace-normal">
      {text}
    </Status>
  ) : (
    <span className="text-sm text-fg-muted">{text}</span>
  );
}

function Requests({
  bankChanges,
  requests,
}: {
  bankChanges: MyBankChange[];
  requests: MyChangeRequest[];
}) {
  if (bankChanges.length === 0 && requests.length === 0) {
    return (
      <section
        aria-labelledby="me-requests"
        data-testid="my-requests-empty"
        className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="me-requests" className="m-0 type-label text-fg-muted">
            {copy.requests}
          </h2>
          <p className="m-0 text-sm text-fg-muted">{copy.noRequests}</p>
        </div>
        <Illustration name="worker-profile" size="worker" decorative />
      </section>
    );
  }
  return (
    <section aria-labelledby="me-requests" className="flex flex-col gap-2">
      <h2 id="me-requests" className="m-0 type-label text-fg-muted">
        {copy.requests}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {bankChanges.map((change) => (
          <li
            key={change.id}
            data-testid="my-bank-change"
            data-status={change.status}
            className="flex flex-col gap-1 rounded-xl border border-line px-4 py-3"
          >
            <span className="text-[15px] font-medium break-words">
              {copy.bankRequest(change.bankName, maskAccount(change.last4))}
            </span>
            <StatusLine tone={BANK_TONE[change.status]} text={bankStatusText(change)} />
            <span className="text-xs text-fg-muted">{copy.sentOn(sentDate(change.createdAt))}</span>
          </li>
        ))}
        {requests.map((request) => (
          <li
            key={request.id}
            data-testid="my-change-request"
            data-status={request.status}
            className="flex flex-col gap-1 rounded-xl border border-line px-4 py-3"
          >
            <span className="text-[15px] font-medium">{topics[request.topic]}</span>
            <span className="text-sm break-words whitespace-pre-line">{request.details}</span>
            <StatusLine
              tone={REQUEST_TONE[request.status]}
              text={copy.requestStatus[request.status]}
            />
            {request.resolutionNote ? (
              <span className="text-sm break-words text-fg-muted">
                {copy.hrNote(request.resolutionNote)}
              </span>
            ) : null}
            <span className="text-xs text-fg-muted">
              {copy.sentOn(sentDate(request.createdAt))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The signed-in worker and their profile, read once per request for the header and panel. */
const loadMe = cache(async () => {
  const session = await requireWorkerPageSession();
  return { session, me: await loadMyProfile(session) };
});

/** Avatar, name and "job title · staff ID". */
async function MeHeader() {
  const { session, me } = await loadMe();
  if (!me) {
    return <p className="m-0 px-4 text-[15px] text-fg-muted">{workerMessages.home.unlinked}</p>;
  }
  const { profile } = me;
  return (
    <div className="flex items-center gap-3.5 px-4 pt-2 pb-3">
      <WorkerAvatar workerId={session.workerId} name={profile.name} size={56} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-display text-[22px] leading-tight font-bold break-words">
          {profile.name}
        </span>
        <span className="text-sm text-fg-muted">
          {profile.jobTitle ? (
            <>
              {profile.jobTitle}
              {workerMessages.separator}
              <span className="whitespace-nowrap">{profile.staffId}</span>
            </>
          ) : (
            <span className="whitespace-nowrap">{copy.staffIdOnly(profile.staffId)}</span>
          )}
        </span>
      </span>
    </div>
  );
}

/** The Profile tab's rows, requests, "Request a change" and sign out. */
async function ProfilePanel() {
  const { me } = await loadMe();
  if (!me) return null;
  const { profile } = me;
  const sections = myProfileSections({
    departmentName: profile.departmentName,
    lineManager: { isSet: me.hasLineManager, name: profile.lineManagerName },
    siteNames: profile.siteNames,
    projectNames: profile.projectNames,
    startDate: profile.startDate,
    employmentType: profile.employmentType,
    bankName: profile.bankName,
    bankAccountLast4: profile.bankAccountLast4,
    pfaName: profile.pfaName,
    rsaPinOnFile: profile.rsaPinOnFile,
    rsaPinLast4: profile.rsaPinLast4,
    taxState: profile.taxState,
    annualRentDeclared: profile.annualRentDeclared,
    ninOnFile: profile.ninOnFile,
    phone: profile.phone,
    nextOfKinName: profile.nextOfKinName,
    nextOfKinPhone: profile.nextOfKinPhone,
  });

  return (
    <>
      {sections.map((section) => (
        <Rows key={section.id} section={section} />
      ))}
      <Requests bankChanges={me.bankChanges} requests={me.requests} />
      <Button asChild variant="outline" className="h-[52px] rounded-xl text-base">
        <Link href="/m/me/change">{copy.requestChange}</Link>
      </Button>
      <p className="m-0 text-[13px] text-fg-muted">{copy.bankNote}</p>
      <form action={signOutWorker} className="pt-2">
        <Button type="submit" variant="ghost" className="h-11 w-full rounded-lg">
          {copy.signOut}
        </Button>
      </form>
    </>
  );
}

/**
 * Me, from the WkProfile board (slice 1.10): work, pay and pension, identity and contact, all
 * read with the worker's own session and shown masked. Queries open in Phase 4; until then the
 * tab shows an empty state. The tab bar is static, so it is part of the prerendered shell; only
 * the header and the profile panel wait for the session.
 */
export default function MePage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }}>
          <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
        </WorkerTopBar>
      </div>
      <Suspense
        fallback={
          <div aria-hidden className="flex items-center gap-3.5 px-4 pt-2 pb-3">
            <span className="size-14 rounded-full bg-surface" />
            <span className="h-6 w-44 rounded bg-surface" />
          </div>
        }
      >
        <MeHeader />
      </Suspense>
      <MeTabs>
        <Suspense fallback={<span aria-hidden className="h-64 w-full rounded bg-surface" />}>
          <ProfilePanel />
        </Suspense>
      </MeTabs>
    </main>
  );
}
