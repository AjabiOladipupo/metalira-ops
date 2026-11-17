import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type StaffIdCorrectionRequestedEmailProps = {
  organisationName: string;
  workerName: string;
  oldStaffId: string;
  newStaffId: string;
  requesterName: string;
  /** Absolute link to the employee's page, where the correction is approved or rejected. */
  reviewUrl: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const staffIdCorrectionRequestedSubject = (workerName: string) =>
  `Staff ID correction for ${workerName} needs your approval`;

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
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${requesterName} asked to change ${workerName}'s staff ID from ${oldStaffId} to ${newStaffId}.`}
      reason={`You received this email because you approve staff ID corrections for ${organisationName} on ${APP_NAME}.`}
    >
      <EmailHeading>A staff ID correction needs a second person</EmailHeading>
      <EmailText>
        {requesterName} asked to change the staff ID of {workerName} from {oldStaffId} to{" "}
        {newStaffId}.
      </EmailText>
      <EmailText>
        Nothing changes until someone other than the requester approves it. Once approved,{" "}
        {workerName} signs in with {newStaffId}, and {oldStaffId} can never be given to anyone else
        in {organisationName}.
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
