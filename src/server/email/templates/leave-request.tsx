import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type LeaveRequestEmailProps = {
  /** Which step is waiting: the line manager's (a new request) or HR's (step 1 approved). */
  step: "line_manager" | "hr";
  organisationName: string | null;
  workerName: string | null;
  leaveTypeName: string | null;
  /** "3 working days, 30 Nov to 2 Dec 2026". */
  summary: string;
  /** Absolute URL of the request on /app/leave. */
  openUrl: string;
  appUrl: string;
};

export const leaveRequestSubject = (
  step: LeaveRequestEmailProps["step"],
  workerName: string | null,
) =>
  step === "line_manager"
    ? `Leave request to decide${workerName ? ` from ${workerName}` : ""}`
    : `Leave waiting for HR${workerName ? `: ${workerName}` : ""}`;

/**
 * Tells a manager a leave request is waiting for them (slice 4.4): the line manager when a worker
 * asks, HR when the line manager approves. Names and dates only; no reasons, no personal numbers.
 */
export function LeaveRequestEmail({
  step,
  organisationName,
  workerName,
  leaveTypeName,
  summary,
  openUrl,
  appUrl,
}: LeaveRequestEmailProps) {
  const company = organisationName ?? "your company";
  const who = workerName ?? "A worker";
  const type = leaveTypeName ? `${leaveTypeName.toLowerCase()} leave` : "leave";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} asked for ${type}: ${summary}.`}
      reason={`You received this email because you approve leave at ${company} in ${APP_NAME}.`}
    >
      <EmailHeading>
        {step === "line_manager" ? "A leave request needs your decision" : "Leave waiting for HR"}
      </EmailHeading>
      <EmailText>
        {who} asked for {type}: {summary}.
      </EmailText>
      <EmailText>
        {step === "line_manager"
          ? "You decide first; HR decides after you."
          : "The line manager approved it. The balance drops when HR approves."}
      </EmailText>
      <EmailButton href={openUrl}>Open the request</EmailButton>
    </EmailLayout>
  );
}

export default LeaveRequestEmail;
