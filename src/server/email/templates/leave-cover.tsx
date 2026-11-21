import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type LeaveCoverEmailProps = {
  organisationName: string | null;
  workerName: string | null;
  /** "4 to 6 Nov 2026". */
  range: string;
  /** "3 shifts at Apapa Warehouse 3". */
  opened: string;
  /** "Gate A · Day, 4 to 6 Nov". */
  detail: string;
  /** Absolute URL of the roster week of the first shift. */
  rosterUrl: string;
  appUrl: string;
};

export const leaveCoverSubject = (count: number, workerName: string | null) =>
  `${count} ${count === 1 ? "shift" : "shifts"} to cover${workerName ? `: ${workerName} is on leave` : ""}`;

/**
 * Tells ops that approved leave opened shifts (slice 4.5, owner decision 8): one email per
 * approval, naming the count and the sites. Names, posts and dates only; no reasons, no personal
 * numbers.
 */
export function LeaveCoverEmail({
  organisationName,
  workerName,
  range,
  opened,
  detail,
  rosterUrl,
  appUrl,
}: LeaveCoverEmailProps) {
  const company = organisationName ?? "your company";
  const who = workerName ?? "A worker";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${opened} to cover: ${who} is on approved leave ${range}.`}
      reason={`You received this email because you build rosters at ${company} in ${APP_NAME}.`}
    >
      <EmailHeading>Shifts to cover</EmailHeading>
      <EmailText>
        {who} is on approved leave {range}. That opens {opened}.
      </EmailText>
      <EmailText>{detail}.</EmailText>
      <EmailText>They are in the Uncovered tray on the roster, with suggestions.</EmailText>
      <EmailButton href={rosterUrl}>Open the roster</EmailButton>
    </EmailLayout>
  );
}

export default LeaveCoverEmail;
