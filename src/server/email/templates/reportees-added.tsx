import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type ReporteesAddedEmailProps = {
  /** The line manager's name, or null to greet without one. */
  managerName: string | null;
  /** How many people now report to them from this change. */
  count: number;
  organisationName: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;

export function reporteesAddedSubject(count: number): string {
  return `You're now line manager for ${people(count)}`;
}

/**
 * One summary to a new line manager after a bulk change on the People list (slice U.1), instead
 * of one email per person. A count only: no names, staff IDs or personal data.
 */
export function ReporteesAddedEmail({
  managerName,
  count,
  organisationName,
  appUrl,
}: ReporteesAddedEmailProps) {
  const openUrl = `${appUrl}/app/people`;
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={reporteesAddedSubject(count)}
      reason={`You received this email because you were made a line manager at ${organisationName} on ${APP_NAME}.`}
    >
      <EmailHeading>New reportees</EmailHeading>
      <EmailText>{managerName ? `Hello ${managerName},` : "Hello,"}</EmailText>
      <EmailText>
        {people(count)} now {count === 1 ? "reports" : "report"} to you at {organisationName}. You
        approve their leave and timesheets.
      </EmailText>
      <EmailButton href={openUrl}>Open People</EmailButton>
      <EmailText muted>
        If the button does not work, copy this link into your browser:{" "}
        <EmailLink href={openUrl}>{openUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default ReporteesAddedEmail;
