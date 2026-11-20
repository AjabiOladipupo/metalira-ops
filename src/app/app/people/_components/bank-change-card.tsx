import Link from "next/link";

import { NameCheckDetails } from "@/components/name-check";
import { Status } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import { maskAccount } from "@/lib/mask";
import type { BankChangeView, BankChangeViewer } from "@/server/people/bank-changes";

import { BankChangeDecision, BankChangeWithdraw } from "./bank-change-forms";
import { RevealValue } from "./reveal-value";

function StatusChip({ change, viewer }: { change: BankChangeView; viewer: BankChangeViewer }) {
  switch (change.status) {
    case "pending":
      return canDecide(change, viewer) ? (
        <Status tone="action">Waiting for your approval</Status>
      ) : (
        <Status tone="pending">Waiting for approval</Status>
      );
    case "approved":
      return <Status tone="partial">Approved, on hold</Status>;
    case "applied":
      return <Status tone="done">In use</Status>;
    case "rejected":
      return <span className="text-sm text-fg-muted">Rejected</span>;
    case "cancelled":
      return (
        <span className="text-sm text-fg-muted">{change.decidedAt ? "Stopped" : "Withdrawn"}</span>
      );
  }
}

function canDecide(change: BankChangeView, viewer: BankChangeViewer): boolean {
  return (
    change.status === "pending" &&
    viewer.isApprover &&
    change.requestedBy !== viewer.userId &&
    !viewer.ownWorkerIds.includes(change.workerId)
  );
}

function holdRunning(change: BankChangeView, viewer: BankChangeViewer): boolean {
  return (
    change.status === "approved" &&
    change.appliesAfter !== null &&
    Date.parse(change.appliesAfter) > Date.parse(viewer.now)
  );
}

function Outcome({ change }: { change: BankChangeView }) {
  const by = change.decidedByName ?? "someone";
  const when = change.decidedAt ? formatDateTime(change.decidedAt) : null;
  switch (change.status) {
    case "pending":
      return (
        <p className="m-0 text-sm text-fg-muted">
          Waiting for someone other than {change.requestedByName} to approve it. Nothing changes
          until then.
        </p>
      );
    case "approved":
      return (
        <p className="m-0 text-sm" data-testid="bank-change-hold">
          Approved by {by} on {when}. Takes effect on{" "}
          {change.appliesAfter ? formatDateTime(change.appliesAfter) : "the end of the hold"}; until
          then payouts use the current account.
        </p>
      );
    case "applied":
      return (
        <p className="m-0 text-sm text-fg-muted">
          Approved by {by} on {when}. In use since{" "}
          {change.appliesAfter ? formatDateTime(change.appliesAfter) : "the end of the hold"}.
        </p>
      );
    case "rejected":
      return (
        <p className="m-0 text-sm text-fg-muted">
          Rejected by {by} on {when}.
        </p>
      );
    case "cancelled":
      return (
        <p className="m-0 text-sm text-fg-muted">
          {change.decidedAt ? "Stopped during the hold" : "Withdrawn"} by {by}
          {change.cancelledAt ? ` on ${formatDateTime(change.cancelledAt)}` : ""}.
        </p>
      );
  }
}

/**
 * One bank-detail change: the new account (masked, with a reveal for roles that may see account
 * numbers), what it replaces, who raised and decided it, and what the viewer may do next.
 */
export function BankChangeCard({
  change,
  viewer,
  showWorker,
}: {
  change: BankChangeView;
  viewer: BankChangeViewer;
  showWorker: boolean;
}) {
  const decide = canDecide(change, viewer);
  const stoppable = viewer.isApprover && holdRunning(change, viewer);
  const ownRequest = change.status === "pending" && change.requestedBy === viewer.userId;

  return (
    <article
      aria-label={`Bank change for ${change.workerName}`}
      data-testid="bank-change"
      data-status={change.status}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        {showWorker ? (
          <Link
            href={`/app/people/${change.workerId}`}
            className="flex min-w-0 flex-col text-foreground no-underline hover:underline"
          >
            <span className="font-semibold break-words">{change.workerName}</span>
            <span className="text-xs text-fg-muted">{change.staffId}</span>
          </Link>
        ) : (
          <span className="font-semibold">
            {change.status === "pending" || change.status === "approved"
              ? "Change in progress"
              : "Earlier change"}
          </span>
        )}
        <StatusChip change={change} viewer={viewer} />
      </div>

      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">New account</dt>
          <dd className="m-0 flex flex-col gap-0.5 text-[15px] break-words">
            <span>
              {change.bankName} · {change.accountName}
            </span>
            <RevealValue
              workerId={change.workerId}
              bankChangeId={change.id}
              field="bank_account"
              masked={maskAccount(change.last4)}
              canReveal={viewer.canRevealAccount}
              testId="bank-change-account"
            />
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Replaces</dt>
          <dd className="m-0 text-[15px] break-words">
            {change.previousLast4 ? (
              <>
                {change.previousBankName ?? "Bank"}{" "}
                <span className="font-mono tabular-nums">{maskAccount(change.previousLast4)}</span>
              </>
            ) : (
              <span className="text-fg-muted">No bank details on file</span>
            )}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Raised by</dt>
          <dd className="m-0 text-[15px] break-words">
            {change.raisedByWorker
              ? `${change.workerName}, from their phone`
              : change.requestedByName}
            <span className="block text-xs text-fg-muted">{formatDateTime(change.createdAt)}</span>
          </dd>
        </div>
        {change.reason ? (
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="type-label text-fg-muted">Reason</dt>
            <dd className="m-0 text-[15px] break-words">{change.reason}</dd>
          </div>
        ) : null}
        {change.decisionNote ? (
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="type-label text-fg-muted">Note</dt>
            <dd className="m-0 text-[15px] break-words">{change.decisionNote}</dd>
          </div>
        ) : null}
      </dl>

      {change.status === "pending" || change.nameCheck.status !== "not_checked" ? (
        <NameCheckDetails check={change.nameCheck} />
      ) : null}

      <Outcome change={change} />

      {decide ? (
        <BankChangeDecision
          changeId={change.id}
          decisions={["approve", "reject"]}
          label={`Decide ${change.workerName}'s bank change`}
          unchecked={change.nameCheck.status === "not_checked"}
        />
      ) : null}
      {ownRequest ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sm text-fg-muted">
            You raised this request, so someone else approves it.
          </p>
          <BankChangeWithdraw changeId={change.id} />
        </div>
      ) : null}
      {stoppable ? (
        <BankChangeDecision
          changeId={change.id}
          decisions={["stop"]}
          label={`Stop ${change.workerName}'s bank change`}
        />
      ) : null}
    </article>
  );
}
