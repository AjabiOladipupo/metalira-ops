import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type StaffIdChangedEmailProps = {
  /** Null when the value looks like a web address: generic wording is used instead. */
  organisationName: string | null;
  workerName: string | null;
  /** Null when it looks like a web address: the worker is sent to Me to read it. */
  newStaffId: string | null;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const staffIdChangedSubject = (organisationName: string | null) =>
  organisationName
    ? `Your staff ID at ${organisationName} has changed`
    : "Your staff ID has changed";

/** Sent to the worker when a correction to their staff ID is approved (slice 1.11). */
export function StaffIdChangedEmail({
  organisationName,
  workerName,
  newStaffId,
  appUrl,
}: StaffIdChangedEmailProps) {
  const signInUrl = `${appUrl}/m/sign-in`;
  const company = organisationName ?? "your company";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={
        newStaffId ? `Your new staff ID is ${newStaffId}.` : "Your staff ID has been corrected."
      }
      reason={`You received this email because ${company} uses ${APP_NAME} for your shifts, leave and payslips.`}
    >
      <EmailHeading>Your staff ID has changed</EmailHeading>
      <EmailText>{workerName ? `Hello ${workerName},` : "Hello,"}</EmailText>
      {newStaffId ? (
        <EmailText>
          {company} corrected your staff ID. Your new staff ID is{" "}
          <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{newStaffId}</span>.
        </EmailText>
      ) : (
        <EmailText>
          {company} corrected your staff ID. You can see the new one under Me in the app.
        </EmailText>
      )}
      <EmailText>
        Sign in with your company code, your new staff ID and your PIN. Your PIN has not changed. If
        you are already signed in on your phone, you stay signed in.
      </EmailText>
      <EmailButton href={signInUrl}>Open the app</EmailButton>
      <EmailText muted>If you did not expect this, tell HR at {company}.</EmailText>
    </EmailLayout>
  );
}

export default StaffIdChangedEmail;
