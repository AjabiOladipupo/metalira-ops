import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type StaffIdCorrectionRequestedEmailProps = {
  /** Null when the value looks like a web address: generic wording is used instead. */
  organisationName: string | null;
  workerName: string | null;
  oldStaffId: string | null;
  newStaffId: string | null;
  requesterName: string | null;
  /** Absolute link to the employee's page, where the correction is approved or rejected. */
  reviewUrl: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const staffIdCorrectionRequestedSubject = (workerName: string | null) =>
  workerName
    ? `Staff ID correction for ${workerName} needs your approval`
    : "A staff ID correction needs your approval";

/** Sent to the owner, admins and HR (never the requester) when a staff ID correction is raised. */
export function StaffIdCorrectionRequestedEmail({
  organisationName,
  workerName,
  oldStaffId,
  newStaffId,
  requesterName,
  reviewUrl,
  appUrl,
}: StaffIdCorrectionRequestedEmailProps) {
  const who = requesterName ?? "A manager";
  const worker = workerName ?? "an employee";
  const change = oldStaffId && newStaffId ? ` from ${oldStaffId} to ${newStaffId}` : "";
  const company = organisationName ?? "your company";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} asked to change the staff ID of ${worker}${change}.`}
      reason={`You received this email because you approve staff ID corrections for ${company} on ${APP_NAME}.`}
    >
      <EmailHeading>A staff ID correction needs a second person</EmailHeading>
      <EmailText>
        {who} asked to change the staff ID of {worker}
        {change}.
      </EmailText>
      <EmailText>
        Nothing changes until someone other than the requester approves it. Once approved, the
        employee signs in with the new ID, and the old one can never be given to anyone else in{" "}
        {company}.
      </EmailText>
      <EmailButton href={reviewUrl}>Review the correction</EmailButton>
      <EmailText muted>
        If the button does not work, copy this link into your browser:{" "}
        <EmailLink href={reviewUrl}>{reviewUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default StaffIdCorrectionRequestedEmail;
