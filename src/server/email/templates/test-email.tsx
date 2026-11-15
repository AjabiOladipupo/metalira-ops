import { APP_NAME } from "@/lib/app";
import { EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

export type TestEmailProps = {
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
  /** When the email was generated, shown as "15 Nov 2026, 14:05" Lagos time. */
  sentAt: Date;
};

export const testEmailSubject = `Test email from ${APP_NAME}`;

const lagosTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Manual check that sending works and the layout renders. */
export function TestEmail({ appUrl, sentAt }: TestEmailProps) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview="Sending works and the layout renders."
      reason="You received this email because someone ran the test email script."
    >
      <EmailHeading>Email is working</EmailHeading>
      <EmailText>
        This test email left {APP_NAME} on {lagosTime.format(sentAt)} Lagos time. If the logo,
        heading and this link to <EmailLink href={appUrl}>{appUrl}</EmailLink> look right, sending
        works.
      </EmailText>
    </EmailLayout>
  );
}

export default TestEmail;
