import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type TeamInviteEmailProps = {
  /** The company, or null when its name can't safely go in an email (looks like a web address). */
  organisationName: string | null;
  /** Who sent the invite, or null when there is no name to show. */
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

export const teamInviteSubject = (organisationName: string | null) =>
  organisationName
    ? `Join ${organisationName} on ${APP_NAME}`
    : `You are invited to join a team on ${APP_NAME}`;

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
  const company = organisationName ?? "their company";
  const who = inviterName ?? (organisationName ? `Someone at ${organisationName}` : "A manager");
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} invited you to join ${company} as ${roleLabel}. The link works until ${expiresOn}.`}
      reason={`You received this email because ${who} invited ${email} to ${company} on ${APP_NAME}. If you don't know them, ignore this email.`}
    >
      <EmailHeading>
        {organisationName ? `Join ${organisationName}` : "Join your team"}
      </EmailHeading>
      <EmailText>
        {who} invited you to join {company} on {APP_NAME} as {roleLabel}.
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
