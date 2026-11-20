import { APP_NAME } from "@/lib/app";
import { EmailHeading, EmailLayout, EmailText } from "../layout";

/**
 * The welcome email a client's ops and billing contacts get when a contract goes live (slice
 * 2.7, owner decision). It names the company, the contract, the sites, the go-live date and the
 * address invoices come from. Never bank details: those appear on invoices only. Names that are
 * null were left out because they look like a web address (`emailDisplayName`); the reply-to is
 * the company's invoice address.
 */

export interface ContractWelcomeProps {
  /** Null: generic wording. */
  organisationName: string | null;
  contactName: string | null;
  contractName: string | null;
  reference: string;
  /** Site names; any that look like a web address are left out by the sender. */
  sites: string[];
  /** "1 Dec 2026". */
  goLiveDate: string;
  /** The company's invoice address, or null when it has none (then no sender line). */
  invoiceEmail: string | null;
  appUrl: string;
}

const company = (name: string | null) => name ?? "Your service provider";

export const contractWelcomeSubject = (organisationName: string | null, goLiveDate: string) =>
  organisationName
    ? `${organisationName}: your contract starts on ${goLiveDate}`
    : `Your contract starts on ${goLiveDate}`;

export function ContractWelcomeEmail({
  organisationName,
  contactName,
  contractName,
  reference,
  sites,
  goLiveDate,
  invoiceEmail,
  appUrl,
}: ContractWelcomeProps) {
  const contract = contractName ? `${contractName} (${reference})` : `contract ${reference}`;
  const siteLine =
    sites.length === 0
      ? null
      : sites.length === 1
        ? `It covers ${sites[0]}.`
        : `It covers ${sites.length} sites: ${sites.join(", ")}.`;
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${company(organisationName)} starts work on ${contract} on ${goLiveDate}.`}
      reason={`You received this email because you are a contact for this contract with ${organisationName ?? "your service provider"}. It was sent through ${APP_NAME}.`}
    >
      <EmailHeading>Your contract starts on {goLiveDate}</EmailHeading>
      <EmailText>{contactName ? `Hello ${contactName},` : "Hello,"}</EmailText>
      <EmailText>
        {company(organisationName)} has set up {contract} and starts work on {goLiveDate}.
        {siteLine ? ` ${siteLine}` : ""}
      </EmailText>
      {invoiceEmail ? (
        <EmailText>
          Invoices will come from {invoiceEmail}. Reply to this email with any questions.
        </EmailText>
      ) : (
        <EmailText>Reply to this email with any questions.</EmailText>
      )}
      <EmailText muted>
        Payment details appear on each invoice only. If anyone sends you different bank details by
        email, check with {company(organisationName)} by phone before paying.
      </EmailText>
    </EmailLayout>
  );
}
