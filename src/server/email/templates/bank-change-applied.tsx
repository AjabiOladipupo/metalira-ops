import { APP_NAME } from "@/lib/app";
import { EmailHeading, EmailLayout, EmailText } from "../layout";

export type BankChangeAppliedEmailProps = {
  organisationName: string;
  workerName: string;
  /** Last four digits of the new account number. */
  last4: string;
  /** When the new account took effect, as "19 Nov 2026, 14:05" (Lagos time). */
  appliedAt: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const bankChangeAppliedSubject = (last4: string) =>
  `Your pay now goes to the account ending ${last4}`;

/** Sent to the worker when the 72-hour hold ends and the new account takes effect. */
export function BankChangeAppliedEmail({
  organisationName,
  workerName,
  last4,
  appliedAt,
  appUrl,
}: BankChangeAppliedEmailProps) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`From ${appliedAt}, ${organisationName} pays you into the account ending ${last4}.`}
      reason={`You received this email because ${organisationName} changed your bank details on ${APP_NAME}.`}
    >
      <EmailHeading>Your new bank account is in use</EmailHeading>
      <EmailText>Hello {workerName},</EmailText>
      <EmailText>
        From {appliedAt} Lagos time, {organisationName} pays you into the account ending {last4}.
      </EmailText>
      <EmailText>
        If you did not ask for this change, tell HR at {organisationName} straight away.
      </EmailText>
    </EmailLayout>
  );
}

export default BankChangeAppliedEmail;
