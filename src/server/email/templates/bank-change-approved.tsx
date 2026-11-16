import { APP_NAME } from "@/lib/app";
import { EmailHeading, EmailLayout, EmailText } from "../layout";

export type BankChangeApprovedEmailProps = {
  organisationName: string;
  workerName: string;
  /** Last four digits of the new account number. */
  last4: string;
  /** When the new account takes effect, as "19 Nov 2026, 14:05" (Lagos time). */
  appliesAt: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const bankChangeApprovedSubject = (organisationName: string) =>
  `Your new bank account with ${organisationName} is approved`;

/** Sent to the worker when a second person approves a change to their bank details. */
export function BankChangeApprovedEmail({
  organisationName,
  workerName,
  last4,
  appliesAt,
  appUrl,
}: BankChangeApprovedEmailProps) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`Your pay moves to the account ending ${last4} on ${appliesAt}.`}
      reason={`You received this email because ${organisationName} changed your bank details on ${APP_NAME}.`}
    >
      <EmailHeading>Your new bank account is approved</EmailHeading>
      <EmailText>Hello {workerName},</EmailText>
      <EmailText>
        {organisationName} approved a change to your bank details: the account ending {last4}. For
        your safety it takes effect on {appliesAt} Lagos time, 72 hours after approval. Until then
        your pay goes to your current account.
      </EmailText>
      <EmailText>
        If you did not ask for this change, tell HR at {organisationName} straight away. They can
        stop it before it takes effect.
      </EmailText>
    </EmailLayout>
  );
}

export default BankChangeApprovedEmail;
