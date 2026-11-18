import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type OwnerChangeEvent = "requested" | "done" | "rejected" | "withdrawn" | "joined";

export type OwnerChangeEmailProps = {
  /** The company, or null when its name can't safely go in an email (looks like a web address). */
  organisationName: string | null;
  event: OwnerChangeEvent;
  /** "Make Hauwa Bello an owner", from describeOwnerChange (names already checked). */
  summary: string;
  /** Who acted (asked, approved, rejected, withdrew, joined), or null when there is no name. */
  actorName: string | null;
  /** True when the one owner decided alone (no second approval was needed). */
  singleOwner: boolean;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

const HEADINGS: Record<OwnerChangeEvent, string> = {
  requested: "An owner change needs approval",
  done: "The owners of your company changed",
  rejected: "An owner change was rejected",
  withdrawn: "An owner change was withdrawn",
  joined: "A new owner joined",
};

export const ownerChangeSubject = (organisationName: string | null, event: OwnerChangeEvent) => {
  const where = organisationName ?? `your company on ${APP_NAME}`;
  switch (event) {
    case "requested":
      return `Owner change waiting for approval at ${where}`;
    case "done":
      return `Owners changed at ${where}`;
    case "rejected":
      return `Owner change rejected at ${where}`;
    case "withdrawn":
      return `Owner change withdrawn at ${where}`;
    case "joined":
      return `New owner at ${where}`;
  }
};

function body(event: OwnerChangeEvent, summary: string, actor: string, single: boolean): string {
  switch (event) {
    case "requested":
      return `${actor} asked: ${summary}. A different owner must approve or reject it in Settings, Team. Nothing changes until then.`;
    case "done":
      return single
        ? `${summary}: done by ${actor}, the only owner at the time.`
        : `${summary}: approved by ${actor}, so it has happened.`;
    case "rejected":
      return `${summary}: rejected by ${actor}. Nothing changed.`;
    case "withdrawn":
      return `${summary}: withdrawn by ${actor}, who asked for it. Nothing changed.`;
    case "joined":
      return `${actor} accepted an invite and is now an owner.`;
  }
}

/**
 * Sent to every owner (and a removed or demoted owner) when the owners change, or a change is
 * asked for, rejected or withdrawn (slice 1.13).
 */
export function OwnerChangeEmail({
  organisationName,
  event,
  summary,
  actorName,
  singleOwner,
  appUrl,
}: OwnerChangeEmailProps) {
  const company = organisationName ?? "your company";
  const actor = actorName ?? "An owner";
  const text = body(event, summary, actor, singleOwner);
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={text}
      reason={`You received this email because you are, or were, an owner of ${company} on ${APP_NAME}.`}
    >
      <EmailHeading>{HEADINGS[event]}</EmailHeading>
      <EmailText>Hello,</EmailText>
      <EmailText>
        At {company}: {text}
      </EmailText>
      <EmailButton href={`${appUrl}/app/settings/team`}>Open Team settings</EmailButton>
      <EmailText muted>
        Every owner gets this email. If you did not expect it, check Team settings and talk to the
        other owners.
      </EmailText>
    </EmailLayout>
  );
}

export default OwnerChangeEmail;
