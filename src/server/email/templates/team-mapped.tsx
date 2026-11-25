import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type TeamMappedEmailProps = {
  /** The line manager's name, or null to greet without one. */
  managerName: string | null;
  /** How many of their reportees were mapped in this change. */
  count: number;
  /** The site they now work at, or null when it isn't safe to put in an email. */
  siteName: string | null;
  /** "26 Nov 2026" when everyone's change starts that day, else null ("their next shift"). */
  appliesFrom: string | null;
  organisationName: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;

export function teamMappedSubject(count: number): string {
  return `Site and projects changed for ${people(count)} on your team`;
}

/**
 * One summary to a line manager after a bulk mapping on the People list (slice U.3), instead of
 * one email per person (security review M1). A count, the site and the date only: no names,
 * staff IDs or personal data.
 */
export function TeamMappedEmail({
  managerName,
  count,
  siteName,
  appliesFrom,
  organisationName,
  appUrl,
}: TeamMappedEmailProps) {
  const openUrl = `${appUrl}/app/people`;
  const where = siteName ? ` to ${siteName}` : " to a new site";
  const when = appliesFrom ? `from ${appliesFrom}` : "from their next shift";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={teamMappedSubject(count)}
      reason={`You received this email because you are a line manager at ${organisationName} on ${APP_NAME}.`}
    >
      <EmailHeading>Team mapping changed</EmailHeading>
      <EmailText>{managerName ? `Hello ${managerName},` : "Hello,"}</EmailText>
      <EmailText>
        {people(count)} who {count === 1 ? "reports" : "report"} to you at {organisationName}{" "}
        {count === 1 ? "was" : "were"} mapped{where}, {when}. Open People to see who.
      </EmailText>
      <EmailButton href={openUrl}>Open People</EmailButton>
      <EmailText muted>
        If the button does not work, copy this link into your browser:{" "}
        <EmailLink href={openUrl}>{openUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default TeamMappedEmail;
