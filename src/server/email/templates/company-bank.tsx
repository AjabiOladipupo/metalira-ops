import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailLink, EmailText } from "../layout";

/**
 * Emails about the company's own collection bank account (slice 2.3): to approvers when a
 * request is raised, and to every owner and finance user when it is approved and when clients'
 * invoices start to show it. The account is named by its bank and last four digits only. Names
 * that are null were left out because they look like a web address (`emailDisplayName`).
 */

type Common = {
  /** Null: the company's name looked like a web address, so generic wording is used. */
  organisationName: string | null;
  /** Null when left out, as above. */
  bankName: string | null;
  /** Last four digits of the account number. */
  last4: string;
  /** Absolute base URL of the app, without a trailing slash. */
  appUrl: string;
};

const company = (name: string | null) => name ?? "your company";
const account = (bankName: string | null, last4: string) =>
  bankName ? `the ${bankName} account ending ${last4}` : `the account ending ${last4}`;

function ReviewLink({ appUrl, label }: { appUrl: string; label: string }) {
  const url = `${appUrl}/app/settings/bank-account`;
  return (
    <>
      <EmailButton href={url}>{label}</EmailButton>
      <EmailText muted>
        If the button does not work, copy this link into your browser:{" "}
        <EmailLink href={url}>{url}</EmailLink>
      </EmailText>
    </>
  );
}

export const companyBankRequestedSubject = (organisationName: string | null) =>
  organisationName
    ? `${organisationName}: a new bank account for client payments needs your approval`
    : "A new bank account for client payments needs your approval";

/** To each owner and finance user other than the requester. */
export function CompanyBankRequestedEmail({
  organisationName,
  requesterName,
  bankName,
  last4,
  appUrl,
}: Common & { requesterName: string | null }) {
  const who = requesterName ?? "Someone in your company";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${who} asked clients to pay into ${account(bankName, last4)}.`}
      reason={`You received this email because you approve bank account changes for ${company(organisationName)} on ${APP_NAME}.`}
    >
      <EmailHeading>A new collection account needs a second person</EmailHeading>
      <EmailText>
        {who} asked to make {account(bankName, last4)} the account clients pay{" "}
        {company(organisationName)}&apos;s invoices into.
      </EmailText>
      <EmailText>
        Nothing changes until an owner or finance user other than the requester approves it. After
        approval it waits 72 hours before invoices show it. If you don&apos;t recognise this
        request, reject it.
      </EmailText>
      <ReviewLink appUrl={appUrl} label="Review the request" />
    </EmailLayout>
  );
}

export const companyBankApprovedSubject = (last4: string) =>
  `New collection account ending ${last4} approved: in use in 72 hours`;

/** To every owner and finance user when a second person approves. */
export function CompanyBankApprovedEmail({
  organisationName,
  bankName,
  last4,
  appliesAt,
  appUrl,
}: Common & { appliesAt: string }) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`Invoices show ${account(bankName, last4)} from ${appliesAt}.`}
      reason={`You received this email because you are an owner or finance user of ${company(organisationName)} on ${APP_NAME}.`}
    >
      <EmailHeading>A new collection account was approved</EmailHeading>
      <EmailText>
        {account(bankName, last4).replace(/^the/, "The")} was approved as the account clients pay{" "}
        {company(organisationName)}&apos;s invoices into. For your safety it takes effect on{" "}
        {appliesAt} Lagos time, 72 hours after approval. Until then invoices show the current
        account.
      </EmailText>
      <EmailText>
        If nobody at your company asked for this, an owner or finance user can stop it before it
        takes effect.
      </EmailText>
      <ReviewLink appUrl={appUrl} label="See the change" />
    </EmailLayout>
  );
}

export const companyBankAppliedSubject = (last4: string) =>
  `Clients now pay into the account ending ${last4}`;

/** To every owner and finance user when the account takes effect (or the first one is added). */
export function CompanyBankAppliedEmail({
  organisationName,
  bankName,
  last4,
  appliedAt,
  appUrl,
}: Common & { appliedAt: string }) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`Invoices show ${account(bankName, last4)} from ${appliedAt}.`}
      reason={`You received this email because you are an owner or finance user of ${company(organisationName)} on ${APP_NAME}.`}
    >
      <EmailHeading>Your collection account has changed</EmailHeading>
      <EmailText>
        Since {appliedAt} Lagos time, invoices from {company(organisationName)} ask clients to pay
        into {account(bankName, last4)}.
      </EmailText>
      <EmailText>
        If nobody at your company asked for this, tell your clients not to pay into it and raise a
        change straight away.
      </EmailText>
      <ReviewLink appUrl={appUrl} label="See the account" />
    </EmailLayout>
  );
}
