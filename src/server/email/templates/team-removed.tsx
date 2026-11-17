import { APP_NAME } from "@/lib/app";
import { EmailHeading, EmailLayout, EmailText } from "../layout";

export type TeamRemovedEmailProps = {
  /** The company, or null when its name can't safely go in an email (looks like a web address). */
  organisationName: string | null;
  /** The former member's name, or null when there is none to show. */
  memberName: string | null;
  /** Who removed them, or null when there is no name to show. */
  removedBy: string | null;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const teamRemovedSubject = (organisationName: string | null) =>
  organisationName
    ? `You no longer have access to ${organisationName} on ${APP_NAME}`
    : `You no longer have access to a company on ${APP_NAME}`;

/** Sent to a manager removed from a company from Settings → Team (slice 1.12). */
export function TeamRemovedEmail({
  organisationName,
  memberName,
  removedBy,
  appUrl,
}: TeamRemovedEmailProps) {
  const company = organisationName ?? "a company";
  const who = removedBy ?? (organisationName ? `An admin at ${organisationName}` : "An admin");
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} removed you from ${company}.`}
      reason={`You received this email because you were a manager at ${company} on ${APP_NAME}.`}
    >
      <EmailHeading>
        {organisationName
          ? `You have been removed from ${organisationName}`
          : "You have been removed"}
      </EmailHeading>
      <EmailText>{memberName ? `Hello ${memberName},` : "Hello,"}</EmailText>
      <EmailText>
        {who} removed you from {company} on {APP_NAME}. You can no longer open its people, pay or
        settings. Your account and any other companies you belong to are not affected.
      </EmailText>
      <EmailText muted>If you think this is a mistake, ask the owner of {company}.</EmailText>
    </EmailLayout>
  );
}

export default TeamRemovedEmail;
