import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type WorkerInviteEmailProps = {
  firstName: string;
  organisationName: string;
  companyCode: string;
  staffId: string;
  /** The single-use invite link (absolute). */
  inviteUrl: string;
  /** "14 Nov 2026" */
  expiresOn: string;
  /** Absolute base URL of the app, without a trailing slash. Used for the logo. */
  appUrl: string;
};

export const workerInviteSubject = (organisationName: string) =>
  `Set your PIN for ${organisationName} on ${APP_NAME}`;

/**
 * Sent to a worker who has an email address (owner decision 5). The link opens
 * /m/invite/<token>, where they confirm who they are and set a 6-digit PIN.
 */
export function WorkerInviteEmail({
  firstName,
  organisationName,
  companyCode,
  staffId,
  inviteUrl,
  expiresOn,
  appUrl,
}: WorkerInviteEmailProps) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`Set a PIN to see your shifts, leave and payslips. The link works until ${expiresOn}.`}
      reason={`You received this email because ${organisationName} added you as a worker on ${APP_NAME}. If that is not you, ignore this email.`}
    >
      <EmailHeading>Set your PIN</EmailHeading>
      <EmailText>Hello {firstName},</EmailText>
      <EmailText>
        {organisationName} uses {APP_NAME} for clock-in, leave and payslips. Open the link on your
        phone and choose a 6-digit PIN.
      </EmailText>
      <EmailButton href={inviteUrl}>Set your PIN</EmailButton>
      <EmailText>
        To sign in later you need your company code {companyCode}, your staff ID {staffId} and your
        PIN.
      </EmailText>
      <EmailText muted>
        The link works once, until {expiresOn}. If the button does not work, copy this link into
        your phone&apos;s browser: <EmailLink href={inviteUrl}>{inviteUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default WorkerInviteEmail;
