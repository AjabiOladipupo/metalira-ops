import { APP_NAME } from "@/lib/app";
import { EmailHeading, EmailLayout, EmailText } from "../layout";

export type SignInPausedEmailProps = {
  /** Null when the value looks like a web address: generic wording is used instead. */
  organisationName: string | null;
  /** The wrong-PIN cap that was reached. */
  cap: number;
  /** How long new sign-ins are paused, in minutes. */
  minutes: number;
  /** When sign-ins open again, already formatted in Lagos time. */
  until: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

export const signInPausedSubject = (organisationName: string | null) =>
  organisationName
    ? `Phone sign-ins paused at ${organisationName} after many wrong PINs`
    : "Phone sign-ins paused after many wrong PINs";

/**
 * Sent to every owner and HR user when the company reaches its cap on wrong PINs (owner decision 18):
 * at most once per company per window, at the first refused sign-in.
 */
export function SignInPausedEmail({
  organisationName,
  cap,
  minutes,
  until,
  appUrl,
}: SignInPausedEmailProps) {
  const company = organisationName ?? "your company";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${cap} wrong PINs in ${minutes} minutes: new phone sign-ins are paused until ${until}.`}
      reason={`You received this email because you are an owner or in HR at ${company} on ${APP_NAME}.`}
    >
      <EmailHeading>Phone sign-ins are paused for {minutes} minutes</EmailHeading>
      <EmailText>
        Someone typed {cap} wrong PINs for {company}&apos;s company code in the last {minutes}{" "}
        minutes. That can be someone guessing PINs, so new phone sign-ins for your company are
        paused until {until}.
      </EmailText>
      <EmailText>
        Workers who are already signed in on their phones are not affected. Nobody was locked out by
        this pause, and sign-ins open again on their own.
      </EmailText>
      <EmailText>
        If it keeps happening, someone may be trying to get into your workers&apos; accounts. Check
        the audit log, and consider giving your company code only to your own staff.
      </EmailText>
    </EmailLayout>
  );
}

export default SignInPausedEmail;
