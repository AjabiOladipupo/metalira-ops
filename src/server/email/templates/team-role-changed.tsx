import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type TeamRoleChangedEmailProps = {
  /** The company, or null when its name can't safely go in an email (looks like a web address). */
  organisationName: string | null;
  /** The member's name, or null when there is none to show. */
  memberName: string | null;
  /** "HR", "Finance"… */
  oldRoleLabel: string;
  newRoleLabel: string;
  /** Who made the change, or null when there is no name to show. */
  changedBy: string | null;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const teamRoleChangedSubject = (organisationName: string | null, newRoleLabel: string) =>
  organisationName
    ? `Your role at ${organisationName} is now ${newRoleLabel}`
    : `Your role on ${APP_NAME} is now ${newRoleLabel}`;

/** Sent to a manager whose role was changed from Settings → Team (slice 1.12). */
export function TeamRoleChangedEmail({
  organisationName,
  memberName,
  oldRoleLabel,
  newRoleLabel,
  changedBy,
  appUrl,
}: TeamRoleChangedEmailProps) {
  const company = organisationName ?? "your company";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`You are now ${newRoleLabel} at ${company}, instead of ${oldRoleLabel}.`}
      reason={`You received this email because your role at ${company} on ${APP_NAME} changed.`}
    >
      <EmailHeading>Your role has changed</EmailHeading>
      <EmailText>{memberName ? `Hello ${memberName},` : "Hello,"}</EmailText>
      <EmailText>
        {changedBy ?? `An admin at ${company}`} changed your role at {company} from {oldRoleLabel}{" "}
        to {newRoleLabel}. What you can see and do in {APP_NAME} follows the new role from now on.
      </EmailText>
      <EmailButton href={`${appUrl}/app`}>Open {APP_NAME}</EmailButton>
      <EmailText muted>If you did not expect this, ask an owner of {company}.</EmailText>
    </EmailLayout>
  );
}

export default TeamRoleChangedEmail;
