import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { NameCheckDetails } from "@/components/name-check";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { NO_ACCESS_PATH } from "@/lib/auth/routes";
import { holdCountdown } from "@/lib/company-bank";
import { formatDateTime } from "@/lib/dates";
import { maskAccount } from "@/lib/mask";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  applyDueCompanyBank,
  companyBankState,
  companyBankViewer,
  loadCompanyBank,
  type CompanyBankView,
  type CompanyBankViewer,
} from "@/server/billing/company-bank";
import { sendCompanyBankNotices } from "@/server/billing/company-bank-notices";
import { getActiveCompany } from "@/server/identity/company-data";
import { getPageSession } from "@/server/identity/session";

import { RouteGate } from "../../_shell/slots";
import {
  CompanyBankDecision,
  CompanyBankNumber,
  CompanyBankRequestForm,
  CompanyBankWithdraw,
} from "./_components/company-bank-forms";

export const metadata: Metadata = { title: "Company bank account" };

function StatusChip({ account, viewer }: { account: CompanyBankView; viewer: CompanyBankViewer }) {
  switch (account.status) {
    case "pending":
      return viewer.isApprover && account.requestedBy !== viewer.userId ? (
        <Status tone="action">Waiting for your approval</Status>
      ) : (
        <Status tone="pending">Waiting for approval</Status>
      );
    case "approved":
      return account.appliesAfter && Date.parse(account.appliesAfter) > Date.parse(viewer.now) ? (
        <Status tone="partial">Approved, on hold</Status>
      ) : (
        <Status tone="done">In use</Status>
      );
    case "active":
      return <Status tone="done">In use</Status>;
    case "retired":
      return <span className="text-sm text-fg-muted">Replaced</span>;
    case "rejected":
      return <span className="text-sm text-fg-muted">Rejected</span>;
    case "cancelled":
      return (
        <span className="text-sm text-fg-muted">{account.decidedAt ? "Stopped" : "Withdrawn"}</span>
      );
  }
}

function Outcome({ account, viewer }: { account: CompanyBankView; viewer: CompanyBankViewer }) {
  const by = account.decidedByName ?? "someone";
  const when = account.decidedAt ? formatDateTime(account.decidedAt) : null;
  const requested = `Requested by ${account.requestedByName} on ${formatDateTime(account.createdAt)}.`;
  switch (account.status) {
    case "pending":
      return (
        <p className="m-0 text-sm text-fg-muted">
          {requested} Waiting for an owner or finance user other than {account.requestedByName}.
          Nothing changes until then.
        </p>
      );
    case "approved": {
      const left = account.appliesAfter ? holdCountdown(account.appliesAfter, viewer.now) : null;
      return (
        <p className="m-0 text-sm" data-testid="company-bank-hold">
          {requested} Approved by {by} on {when}.{" "}
          {left && account.appliesAfter
            ? `Takes effect on ${formatDateTime(account.appliesAfter)} (${left.toLowerCase()}); until then invoices show the current account.`
            : "The hold has ended; invoices show this account."}
        </p>
      );
    }
    case "active":
    case "retired":
      return (
        <p className="m-0 text-sm text-fg-muted">
          {account.singleApprover
            ? `Added by ${account.requestedByName} on ${formatDateTime(account.createdAt)} as the first account, before setup was finished (no second approver; audited).`
            : `${requested} Approved by ${by} on ${when}.`}
          {account.activatedAt ? ` In use from ${formatDateTime(account.activatedAt)}` : ""}
          {account.retiredAt ? ` to ${formatDateTime(account.retiredAt)}.` : "."}
        </p>
      );
    case "rejected":
      return (
        <p className="m-0 text-sm text-fg-muted">
          {requested} Rejected by {by} on {when}.
        </p>
      );
    case "cancelled":
      return (
        <p className="m-0 text-sm text-fg-muted">
          {requested} {account.decidedAt ? "Stopped during the hold" : "Withdrawn"} by {by}
          {account.cancelledAt ? ` on ${formatDateTime(account.cancelledAt)}` : ""}.
        </p>
      );
  }
}

function AccountCard({
  account,
  viewer,
  heading,
}: {
  account: CompanyBankView;
  viewer: CompanyBankViewer;
  heading: string;
}) {
  const holdRunning =
    account.status === "approved" &&
    account.appliesAfter !== null &&
    Date.parse(account.appliesAfter) > Date.parse(viewer.now);
  const decide =
    account.status === "pending" && viewer.isApprover && account.requestedBy !== viewer.userId;
  const own = account.status === "pending" && account.requestedBy === viewer.userId;
  const decisions = decide
    ? (["approve", "reject"] as const)
    : holdRunning && viewer.isApprover
      ? (["stop"] as const)
      : null;

  return (
    <article
      aria-label={heading}
      data-testid="company-bank-account"
      data-status={account.status}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-line p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <span className="font-semibold">{heading}</span>
        <StatusChip account={account} viewer={viewer} />
      </div>
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Bank</dt>
          <dd className="m-0 text-[15px] break-words">{account.bankName}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Account name</dt>
          <dd className="m-0 text-[15px] break-words">{account.accountName}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">Account number</dt>
          <dd className="m-0 text-[15px]">
            <CompanyBankNumber
              accountId={account.id}
              masked={maskAccount(account.last4)}
              canReveal={viewer.canReveal}
            />
          </dd>
        </div>
      </dl>
      {account.status === "pending" || account.nameCheck.status !== "not_checked" ? (
        <NameCheckDetails check={account.nameCheck} />
      ) : null}
      {account.reason ? (
        <p className="m-0 text-sm break-words">
          <span className="text-fg-muted">Reason: </span>
          {account.reason}
        </p>
      ) : null}
      <Outcome account={account} viewer={viewer} />
      {account.decisionNote ? (
        <p className="m-0 text-sm break-words">
          <span className="text-fg-muted">Note: </span>
          {account.decisionNote}
        </p>
      ) : null}
      {decisions ? <CompanyBankDecision accountId={account.id} decisions={decisions} /> : null}
      {own ? <CompanyBankWithdraw accountId={account.id} /> : null}
    </article>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4 border-t border-line pt-6">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="m-0 type-h3">
          {title}
        </h2>
        {description ? <p className="m-0 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

async function CompanyBankPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const [session, company, params] = await Promise.all([
    getPageSession(),
    getActiveCompany(),
    searchParams,
  ]);
  if (!session?.active || !company) redirect(NO_ACCESS_PATH);
  const { organisationId, role } = session.active;
  const supabase = await createServerSupabase();

  // Accounts whose hold has ended take effect before anything is shown (pg_cron does this too).
  await applyDueCompanyBank(supabase, organisationId);
  // Every email due for this company, including requests or approvals made outside the app.
  after(() => sendCompanyBankNotices(organisationId));

  const now = new Date();
  const detail = await loadCompanyBank(supabase, organisationId, now);
  const viewer = companyBankViewer(session.user.id, role, now);
  const state = companyBankState(detail, company.setupCompletedAt !== null);
  const fromSetup = params.from === "setup" && company.setupCompletedAt === null;

  const current = detail.current;
  const open = detail.open;
  const earlier = detail.history.filter((a) => a.id !== current?.id && a.id !== open?.id);

  return (
    <>
      <PageHeader
        back={
          fromSetup
            ? { href: "/app/setup/invoices", label: "setup" }
            : { href: "/app/settings", label: "Settings" }
        }
        eyebrow="Settings"
        title="Where clients pay"
        description={
          current
            ? `Invoices ask clients to pay into ${current.label}.`
            : "No bank account yet. Add the business account clients should pay into."
        }
      />

      <p className="m-0 max-w-2xl text-sm text-fg-muted">
        Your own business account. Clients pay invoices into it by transfer and you match payments
        from bank statements; Metalira never holds or moves the money. A new or changed account
        needs an owner or finance user other than the requester to approve it, then waits 72 hours
        before invoices show it.
      </p>

      <Section id="in-use" title="In use">
        {current ? (
          <AccountCard account={current} viewer={viewer} heading="Account in use" />
        ) : (
          <p className="m-0 text-sm text-fg-muted" data-testid="company-bank-none">
            No account in use yet.
          </p>
        )}
      </Section>

      {open ? (
        <Section
          id="waiting"
          title={open.status === "pending" ? "Waiting for approval" : "On hold"}
          description={
            open.status === "pending"
              ? "Check the account against your bank's own letter or statement before you approve."
              : "Approved, and waiting out the 72 hours. Stop it here if nobody at your company asked for it."
          }
        >
          <AccountCard account={open} viewer={viewer} heading="New account" />
        </Section>
      ) : null}

      {viewer.canRequest && !open ? (
        <Section id="change" title={current ? "Change the account" : "Add an account"}>
          <CompanyBankRequestForm role={role} state={state} hasAccount={current !== null} />
        </Section>
      ) : null}

      {earlier.length > 0 ? (
        <Section
          id="history"
          title="History"
          description="Every account and request, newest first."
        >
          <div className="flex flex-col gap-3">
            {earlier.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                viewer={viewer}
                heading="Earlier request"
              />
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  return (
    <RouteGate href="/app/settings/bank-account">
      <CompanyBankPage searchParams={searchParams} />
    </RouteGate>
  );
}
