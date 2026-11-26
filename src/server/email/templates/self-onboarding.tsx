import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type SelfOnboardingInviteEmailProps = {
  /** The company, or null when its name can't safely go in an email (looks like a web address). */
  organisationName: string | null;
  /** Who sent the invite, or null when there is no name to show. */
  inviterName: string | null;
  /** "Guard", "HR"… */
  roleLabel: string;
  /** The address the invite is for. */
  email: string;
  /** The single-use onboarding link (absolute). */
  inviteUrl: string;
  /** "24 Nov 2026" */
  expiresOn: string;
  /** Absolute base URL of the app, without a trailing slash. Used for the logo. */
  appUrl: string;
};

export const selfOnboardingInviteSubject = (organisationName: string | null) =>
  organisationName
    ? `${organisationName} invites you to fill in your details`
    : `You are invited to fill in your details on ${APP_NAME}`;

/**
 * Sent to someone invited from People > Onboard (slice U.4). The link opens /onboard/<token>,
 * where they fill in their own details for the role the inviter chose.
 */
export function SelfOnboardingInviteEmail({
  organisationName,
  inviterName,
  roleLabel,
  email,
  inviteUrl,
  expiresOn,
  appUrl,
}: SelfOnboardingInviteEmailProps) {
  const company = organisationName ?? "their company";
  const who = inviterName ?? (organisationName ? `Someone at ${organisationName}` : "A manager");
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} invited you to join ${company} as ${roleLabel}. Fill in your details by ${expiresOn}.`}
      reason={`You received this email because ${who} invited ${email} to ${company} on ${APP_NAME}. If you don't know them, ignore this email.`}
    >
      <EmailHeading>
        {organisationName ? `Join ${organisationName}` : "Join your team"}
      </EmailHeading>
      <EmailText>
        {who} invited you to join {company} as {roleLabel}. Fill in your own details on the next
        page; HR checks them before you start.
      </EmailText>
      <EmailButton href={inviteUrl}>Fill in my details</EmailButton>
      <EmailText muted>
        The link works once, until {expiresOn}, and only for {email}. If the button does not work,
        copy this link into your browser: <EmailLink href={inviteUrl}>{inviteUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export type SelfOnboardingApprovedEmailProps = {
  organisationName: string | null;
  roleLabel: string;
  /** The manager app's sign-in page (absolute). */
  signInUrl: string;
  appUrl: string;
};

export const selfOnboardingApprovedSubject = (organisationName: string | null) =>
  organisationName
    ? `You can now sign in to ${organisationName}`
    : `You can now sign in on ${APP_NAME}`;

/** To a manager whose details were approved: their access is open. */
export function SelfOnboardingApprovedEmail({
  organisationName,
  roleLabel,
  signInUrl,
  appUrl,
}: SelfOnboardingApprovedEmailProps) {
  const company = organisationName ?? "your company";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`Your details were approved. You are now ${roleLabel} at ${company}.`}
      reason={`You received this email because you sent your details to ${company} on ${APP_NAME}.`}
    >
      <EmailHeading>You are in</EmailHeading>
      <EmailText>
        Your details were approved. You are now {roleLabel} at {company}.
      </EmailText>
      <EmailButton href={signInUrl}>Sign in</EmailButton>
    </EmailLayout>
  );
}

export default SelfOnboardingInviteEmail;
