import { APP_NAME } from "@/lib/app";
import { EmailHeading, EmailLayout, EmailText } from "../layout";

export type TeamRemovedEmailProps = {
  organisationName: string;
  /** The former member's name, or null when their profile has none. */
  memberName: string | null;
  /** Who removed them, or null when their profile has no name. */
  removedBy: string | null;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const teamRemovedSubject = (organisationName: string) =>
  `You no longer have access to ${organisationName} on ${APP_NAME}`;

/** Sent to a manager removed from a company from Settings → Team (slice 1.12). */
export function TeamRemovedEmail({
  organisationName,
  memberName,
  removedBy,
  appUrl,
}: TeamRemovedEmailProps) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${removedBy ?? `An admin at ${organisationName}`} removed you from ${organisationName}.`}
      reason={`You received this email because you were a manager at ${organisationName} on ${APP_NAME}.`}
    >
      <EmailHeading>You have been removed from {organisationName}</EmailHeading>
      <EmailText>{memberName ? `Hello ${memberName},` : "Hello,"}</EmailText>
      <EmailText>
        {removedBy ?? `An admin at ${organisationName}`} removed you from {organisationName} on{" "}
        {APP_NAME}. You can no longer open its people, pay or settings. Your account and any other
        companies you belong to are not affected.
      </EmailText>
      <EmailText muted>
        If you think this is a mistake, ask the owner of {organisationName}.
      </EmailText>
    </EmailLayout>
  );
}

export default TeamRemovedEmail;
