import { Status } from "@/components/status";
import { NAME_MATCH_LABEL, type NameMatchResult } from "@/lib/bank-name-match";

/**
 * How the bank's account name compared with the expected name (slice 2.3b): a word and a dot,
 * as every status. Match is done; close match and no match need attention; not checked is
 * pending.
 */
export function NameCheckStatus({
  status,
  className,
}: {
  status: NameMatchResult | "not_checked";
  className?: string;
}) {
  const tone = status === "match" ? "done" : status === "not_checked" ? "pending" : "action";
  return (
    <Status tone={tone} className={className}>
      <span data-testid="name-check-status" data-status={status}>
        {NAME_MATCH_LABEL[status]}
      </span>
    </Status>
  );
}

/** Marks a name that came from the test resolver (never in production). */
export function TestLookupBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted"
      data-testid="test-lookup"
    >
      Test lookup
    </span>
  );
}

export interface NameCheckDetailsProps {
  status: NameMatchResult | "not_checked";
  expected: string | null;
  reason: string | null;
  test: boolean;
}

/**
 * The check on a request card, for the approver: the result, the name it was compared with
 * when they differ, and the requester's reason for a close match.
 */
export function NameCheckDetails({ check }: { check: NameCheckDetailsProps }) {
  return (
    <div className="flex flex-col gap-1" data-testid="name-check">
      <span className="type-label text-fg-muted">Account name check</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <NameCheckStatus status={check.status} />
        {check.test ? <TestLookupBadge /> : null}
        {check.status !== "match" && check.status !== "not_checked" && check.expected ? (
          <span className="text-sm text-fg-muted">Expected: {check.expected}</span>
        ) : null}
      </div>
      {check.status === "not_checked" ? (
        <p className="m-0 text-sm text-fg-muted">
          The account name wasn&apos;t checked with the bank. Confirm it from a bank letter or
          statement before approving.
        </p>
      ) : null}
      {check.reason ? (
        <p className="m-0 text-sm break-words" data-testid="name-check-reason">
          <span className="text-fg-muted">Why it&apos;s the right account: </span>
          {check.reason}
        </p>
      ) : null}
    </div>
  );
}
