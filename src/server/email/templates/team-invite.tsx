import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type TeamInviteEmailProps = {
  organisationName: string;
  /** Who sent the invite, or null when their profile has no name. */
  inviterName: string | null;
  /** "HR", "Finance", "Operations manager"… */
  roleLabel: string;
  /** The address the invite is for: they must sign in or sign up with it. */
  email: string;
  /** The single-use invite link (absolute). */
  inviteUrl: string;
  /** "24 Nov 2026" */
  expiresOn: string;
  /** Absolute base URL of the app, without a trailing slash. Used for the logo. */
  appUrl: string;
};

export const teamInviteSubject = (organisationName: string) =>
  `Join ${organisationName} on ${APP_NAME}`;

/**
 * Sent to a manager invited from Settings → Team (slice 1.12). The link opens /join/<token>,
 * where they sign in or create an account with this address and accept.
 */
export function TeamInviteEmail({
  organisationName,
  inviterName,
  roleLabel,
  email,
  inviteUrl,
  expiresOn,
  appUrl,
}: TeamInviteEmailProps) {
  const who = inviterName ?? `Someone at ${organisationName}`;
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} invited you to join ${organisationName} as ${roleLabel}. The link works until ${expiresOn}.`}
      reason={`You received this email because ${who} invited ${email} to ${organisationName} on ${APP_NAME}. If you don't know them, ignore this email.`}
    >
      <EmailHeading>Join {organisationName}</EmailHeading>
      <EmailText>
        {who} invited you to join {organisationName} on {APP_NAME} as {roleLabel}.
      </EmailText>
      <EmailButton href={inviteUrl}>Accept the invite</EmailButton>
      <EmailText>
        Sign in or create an account with {email}. The invite works only for that address.
      </EmailText>
      <EmailText muted>
        The link works once, until {expiresOn}. If the button does not work, copy this link into
        your browser: <EmailLink href={inviteUrl}>{inviteUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default TeamInviteEmail;
