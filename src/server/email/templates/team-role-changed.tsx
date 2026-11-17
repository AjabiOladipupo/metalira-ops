import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type TeamRoleChangedEmailProps = {
  organisationName: string;
  /** The member's name, or null when their profile has none. */
  memberName: string | null;
  /** "HR", "Finance"… */
  oldRoleLabel: string;
  newRoleLabel: string;
  /** Who made the change, or null when their profile has no name. */
  changedBy: string | null;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const teamRoleChangedSubject = (organisationName: string, newRoleLabel: string) =>
  `Your role at ${organisationName} is now ${newRoleLabel}`;

/** Sent to a manager whose role was changed from Settings → Team (slice 1.12). */
export function TeamRoleChangedEmail({
  organisationName,
  memberName,
  oldRoleLabel,
  newRoleLabel,
  changedBy,
  appUrl,
}: TeamRoleChangedEmailProps) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`You are now ${newRoleLabel} at ${organisationName}, instead of ${oldRoleLabel}.`}
      reason={`You received this email because your role at ${organisationName} on ${APP_NAME} changed.`}
    >
      <EmailHeading>Your role has changed</EmailHeading>
      <EmailText>{memberName ? `Hello ${memberName},` : "Hello,"}</EmailText>
      <EmailText>
        {changedBy ?? `An admin at ${organisationName}`} changed your role at {organisationName}{" "}
        from {oldRoleLabel} to {newRoleLabel}. What you can see and do in {APP_NAME} follows the new
        role from now on.
      </EmailText>
      <EmailButton href={`${appUrl}/app`}>Open {APP_NAME}</EmailButton>
      <EmailText muted>If you did not expect this, ask the owner of {organisationName}.</EmailText>
    </EmailLayout>
  );
}

export default TeamRoleChangedEmail;
