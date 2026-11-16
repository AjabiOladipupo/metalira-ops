import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type BankChangeRequestedEmailProps = {
  organisationName: string;
  workerName: string;
  staffId: string;
  /** Who raised the request, or null when the worker raised it themselves. */
  requesterName: string | null;
  /** Last four digits of the new account number. */
  last4: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const bankChangeRequestedSubject = (workerName: string) =>
  `Bank change for ${workerName} needs your approval`;

/** Sent to the owner, HR and finance (never the requester) when a bank change is raised. */
export function BankChangeRequestedEmail({
  organisationName,
  workerName,
  staffId,
  requesterName,
  last4,
  appUrl,
}: BankChangeRequestedEmailProps) {
  const reviewUrl = `${appUrl}/app/people/approvals`;
  const who = requesterName ?? `${workerName} (from their own phone)`;
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} asked to pay ${workerName} into an account ending ${last4}.`}
      reason={`You received this email because you approve bank changes for ${organisationName} on ${APP_NAME}.`}
    >
      <EmailHeading>A bank change needs a second person</EmailHeading>
      <EmailText>
        {who} asked to change the bank details of {workerName} ({staffId}) to an account ending{" "}
        {last4}.
      </EmailText>
      <EmailText>
        Nothing changes until someone other than the requester approves it. After approval the new
        account waits 72 hours before payouts use it, and {workerName} is told by email.
      </EmailText>
      <EmailButton href={reviewUrl}>Review bank changes</EmailButton>
      <EmailText muted>
        If the button does not work, copy this link into your browser:{" "}
        <EmailLink href={reviewUrl}>{reviewUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default BankChangeRequestedEmail;
