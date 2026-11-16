import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type WelcomeOwnerEmailProps = {
  ownerName: string;
  organisationName: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const welcomeOwnerSubject = (organisationName: string) =>
  `${organisationName} is set up on ${APP_NAME}`;

/** Sent once to the owner who signed up, after their organisation is created. */
export function WelcomeOwnerEmail({ ownerName, organisationName, appUrl }: WelcomeOwnerEmailProps) {
  const openUrl = `${appUrl}/app`;
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${organisationName} is ready. Three steps get your team running.`}
      reason={`You received this email because you created the ${organisationName} account on ${APP_NAME}.`}
    >
      <EmailHeading>Your company is set up</EmailHeading>
      <EmailText>Hello {ownerName},</EmailText>
      <EmailText>
        {organisationName} now has a {APP_NAME} account, and you are its owner. Three steps get your
        team running:
      </EmailText>
      <EmailText>
        1. Finish your company details: departments, pay cycle and pay day.
        <br />
        2. Add your people, one at a time or from a spreadsheet.
        <br />
        3. Invite your managers so they can approve timesheets and leave.
      </EmailText>
      <EmailButton href={openUrl}>Open {APP_NAME}</EmailButton>
      <EmailText muted>
        If the button does not work, copy this link into your browser:{" "}
        <EmailLink href={openUrl}>{openUrl}</EmailLink>
      </EmailText>
    </EmailLayout>
  );
}

export default WelcomeOwnerEmail;
