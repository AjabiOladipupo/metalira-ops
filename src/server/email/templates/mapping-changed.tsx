import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type MappingChangedEmailProps = {
  /** The line manager's name, or null to greet without one. */
  managerName: string | null;
  workerName: string;
  staffId: string;
  organisationName: string;
  /** True when this person has just become the worker's line manager. */
  reportsToYou: boolean;
  /** One line per changed field: "Site: Lekki Estate Gate B (was Apapa Warehouse 3)". */
  changes: string[];
  /** "17 Nov 2026" when site or project changes start on a later day, else null. */
  appliesFrom: string | null;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export function mappingChangedSubject(workerName: string, reportsToYou: boolean): string {
  return reportsToYou ? `${workerName} now reports to you` : `${workerName}'s work details changed`;
}

/**
 * Sent to a worker's line manager when the worker's mapping changes (slice 1.6): they become the
 * line manager, or the department, site or projects change. Names and work details only, never
 * personal data.
 */
export function MappingChangedEmail({
  managerName,
  workerName,
  staffId,
  organisationName,
  reportsToYou,
  changes,
  appliesFrom,
  appUrl,
}: MappingChangedEmailProps) {
  const openUrl = `${appUrl}/app/people`;
  const lead = reportsToYou
    ? `${workerName} (${staffId}) now reports to you at ${organisationName}. You approve their leave and timesheets.`
    : `${workerName} (${staffId}), who reports to you at ${organisationName}, has new work details.`;
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={mappingChangedSubject(workerName, reportsToYou)}
      reason={`You received this email because you are ${workerName}'s line manager at ${organisationName} on ${APP_NAME}.`}
    >
      <EmailHeading>{reportsToYou ? "A new reportee" : "Work details changed"}</EmailHeading>
      <EmailText>{managerName ? `Hello ${managerName},` : "Hello,"}</EmailText>
      <EmailText>{lead}</EmailText>
      {changes.length > 0 ? (
        <EmailText>
          {changes.map((line, index) => (
            <span key={line}>
              {index > 0 ? <br /> : null}
              {line}
            </span>
          ))}
        </EmailText>
      ) : null}
      {appliesFrom ? (
        <EmailText>Site and project changes apply from {appliesFrom}, the next shift.</EmailText>
      ) : null}
      <EmailButton href={openUrl}>Open People</EmailButton>
      <EmailText muted>
        If the button does not work, copy this link into your browser:{" "}
        <EmailLink href={openUrl}>{openUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default MappingChangedEmail;
