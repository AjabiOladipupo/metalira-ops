import Link from "next/link";

import { Status } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import type { StaffIdCorrectionView } from "@/server/people/staff-id-corrections";

import { StaffIdDecision, StaffIdWithdraw } from "./staff-id-forms";

export interface StaffIdViewer {
  userId: string;
  /** Owner, admin or hr: may raise and decide corrections. */
  canDecide: boolean;
  /** Worker records linked to the viewer's own login: nobody decides their own staff ID. */
  ownWorkerIds: readonly string[];
}

function decidable(correction: StaffIdCorrectionView, viewer: StaffIdViewer): boolean {
  return (
    correction.status === "pending" &&
    viewer.canDecide &&
    correction.requestedBy !== viewer.userId &&
    !viewer.ownWorkerIds.includes(correction.workerId)
  );
}

function outcome(correction: StaffIdCorrectionView): string {
  const by = correction.decidedByName ?? "someone";
  const when = correction.decidedAt ? ` on ${formatDateTime(correction.decidedAt)}` : "";
  switch (correction.status) {
    case "pending":
      return `Waiting for someone other than ${correction.requestedByName} to approve it. Nothing changes until then.`;
    case "approved":
      return `Approved by ${by}${when}. ${correction.oldStaffId} can't be used again.`;
    case "rejected":
      return `Rejected by ${by}${when}.`;
    case "cancelled":
      return `Withdrawn by ${by}${when}.`;
  }
}

/**
 * One staff ID correction: old and new ID, the reason, who raised and decided it, and what the
 * viewer may do. The buttons are a convenience: the database refuses the requester and the
 * worker themselves whatever the page shows.
 */
export function StaffIdCorrectionCard({
  correction,
  viewer,
  showWorker,
}: {
  correction: StaffIdCorrectionView;
  viewer: StaffIdViewer;
  showWorker: boolean;
}) {
  const decide = decidable(correction, viewer);
  const own = correction.status === "pending" && correction.requestedBy === viewer.userId;
  return (
    <article
      aria-label={`Staff ID correction for ${correction.workerName}`}
      data-testid="staff-id-correction"
      data-status={correction.status}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        {showWorker ? (
          <Link
            href={`/app/people/${correction.workerId}#contact`}
            className="font-semibold break-words text-foreground no-underline hover:underline"
          >
            {correction.workerName}
          </Link>
        ) : (
          <span className="font-semibold">Staff ID correction</span>
        )}
        {correction.status === "pending" ? (
          decide ? (
            <Status tone="action">Waiting for your approval</Status>
          ) : (
            <Status tone="pending">Waiting for approval</Status>
          )
        ) : correction.status === "approved" ? (
          <Status tone="done">Applied</Status>
        ) : (
          <span className="text-sm text-fg-muted">
            {correction.status === "rejected" ? "Rejected" : "Withdrawn"}
          </span>
        )}
      </div>

      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Change</dt>
          <dd className="m-0 font-mono text-[15px] break-words" data-testid="staff-id-change">
            {correction.oldStaffId} → {correction.newStaffId}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Reason</dt>
          <dd className="m-0 text-[15px] break-words">{correction.reason}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Raised by</dt>
          <dd className="m-0 text-[15px] break-words">
            {correction.requestedByName}
            <span className="block text-xs text-fg-muted">
              {formatDateTime(correction.createdAt)}
            </span>
          </dd>
        </div>
        {correction.decisionNote ? (
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="type-label text-fg-muted">Note</dt>
            <dd className="m-0 text-[15px] break-words">{correction.decisionNote}</dd>
          </div>
        ) : null}
      </dl>

      <p className="m-0 text-sm text-fg-muted">{outcome(correction)}</p>

      {decide ? (
        <StaffIdDecision
          correctionId={correction.id}
          label={`Decide ${correction.workerName}'s staff ID correction`}
        />
      ) : null}
      {own ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sm text-fg-muted">
            You raised this correction, so someone else approves it.
          </p>
          <StaffIdWithdraw correctionId={correction.id} />
        </div>
      ) : null}
    </article>
  );
}
