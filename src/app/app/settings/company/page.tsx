import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { planName } from "@/lib/company";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadCollectionRails } from "@/server/billing/collection-rails";
import { getActiveCompany, getActiveCompanyLogoUrl } from "@/server/identity/company-data";
import { getPageSession } from "@/server/identity/session";

import { BusinessForm } from "../../_company/business-form";
import { InvoicesForm } from "../../_company/invoices-form";
import { LogoForm } from "../../_company/logo-form";
import { PlanForm } from "../../_company/plan-form";
import { RouteGate } from "../../_shell/slots";

export const metadata: Metadata = { title: "Company settings" };

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
    <section aria-labelledby={id} className="flex flex-col gap-5 border-t border-line pt-7">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="m-0 type-h2">
          {title}
        </h2>
        {description ? <p className="m-0 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** The setup wizard's forms on one page, each saved on its own. Owner and admin only. */
async function CompanySettings() {
  const [company, logoUrl, session] = await Promise.all([
    getActiveCompany(),
    getActiveCompanyLogoUrl(),
    getPageSession(),
  ]);
  if (!company || !session?.active) redirect("/no-access");
  const rails = await loadCollectionRails(
    await createServerSupabase(),
    company.id,
    session.active.role,
  );

  return (
    <>
      <PageHeader
        back={{ href: "/app/settings", label: "Settings" }}
        eyebrow="Settings"
        title="Company"
        description={`${planName(company.plan)} plan · company code ${company.companyCode}`}
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-surface p-5">
        <div className="flex flex-col gap-1">
          <span className="type-label text-fg-muted">Company code</span>
          <span
            className="font-mono text-2xl font-semibold tracking-[0.2em]"
            data-testid="company-code"
          >
            {company.companyCode}
          </span>
        </div>
        <p className="m-0 max-w-md text-sm text-fg-muted">
          Workers type this with their staff ID and PIN to sign in on their phone. It never changes.
        </p>
      </div>

      <Section
        id="business-details"
        title="Business details"
        description="This goes on payslips, invoices and receipts."
      >
        <LogoForm logoUrl={logoUrl} companyName={company.name} />
        <BusinessForm mode="settings" company={company} />
      </Section>

      <Section
        id="invoices-payments"
        title="Invoices and payments"
        description="Invoices go out from your email. Clients pay into accounts you own."
      >
        <InvoicesForm mode="settings" company={company} rails={rails} />
      </Section>

      <Section id="plan" title="Plan">
        <PlanForm mode="settings" plan={company.plan} expectedWorkers={company.expectedWorkers} />
      </Section>
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/settings/company">
      <CompanySettings />
    </RouteGate>
  );
}
