import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type WorkerNoticeEmailProps = {
  /** Null when the value looks like a web address: generic wording is used instead. */
  organisationName: string | null;
  workerName: string | null;
  /** The inbox item's title, or null for generic wording. */
  title: string | null;
  /** The inbox item's text, or null: the worker reads it in the app. */
  body: string | null;
  /** Absolute URL of the item's link (an /m path) or of the inbox. */
  openUrl: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const workerNoticeSubject = (title: string | null, organisationName: string | null) =>
  title ?? (organisationName ? `A new message from ${organisationName}` : "You have a new message");

/** The email copy of a worker inbox item (slice 3.1, src/server/workforce/notify.ts). */
export function WorkerNoticeEmail({
  organisationName,
  workerName,
  title,
  body,
  openUrl,
  appUrl,
}: WorkerNoticeEmailProps) {
  const company = organisationName ?? "your company";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={title ?? `A new message from ${company}.`}
      reason={`You received this email because ${company} uses ${APP_NAME} for your shifts, leave and payslips.`}
    >
      <EmailHeading>{title ?? "You have a new message"}</EmailHeading>
      <EmailText>{workerName ? `Hello ${workerName},` : "Hello,"}</EmailText>
      {body ? (
        <EmailText>{body}</EmailText>
      ) : (
        <EmailText>{company} sent you a message. Read it in your inbox in the app.</EmailText>
      )}
      <EmailButton href={openUrl}>Open the app</EmailButton>
      <EmailText muted>It is also in your inbox in the app.</EmailText>
    </EmailLayout>
  );
}

export default WorkerNoticeEmail;
