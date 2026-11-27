import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { planName } from "@/lib/company";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadCollectionRails } from "@/server/billing/collection-rails";
import { loadAttendanceSettings } from "@/server/identity/attendance-settings";
import { getActiveCompany, getActiveCompanyLogoUrl } from "@/server/identity/company-data";
import { getPageSession } from "@/server/identity/session";
import { countPeopleAtSites, listOffices } from "@/server/sites/sites-data";

import { AttendanceForm } from "../../_company/attendance-form";
import { BusinessForm } from "../../_company/business-form";
import { InvoicesForm } from "../../_company/invoices-form";
import { LogoForm } from "../../_company/logo-form";
import { ModulesForm } from "../../_company/modules-form";
import { PlanForm } from "../../_company/plan-form";
import { RouteGate } from "../../_shell/slots";
import { clientsPageContext } from "../../clients/_components/context";
import { OfficesCard } from "./_components/offices-card";

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
  const supabase = await createServerSupabase();
  const [rails, attendance, offices, ctx] = await Promise.all([
    loadCollectionRails(supabase, company.id, session.active.role),
    loadAttendanceSettings(company.id),
    listOffices(supabase, company.id),
    clientsPageContext(),
  ]);
  const mapped = await countPeopleAtSites(
    supabase,
    company.id,
    offices.map((o) => o.id),
    ctx.today,
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
        id="head-office"
        title="Head office"
        description="Where staff who don't work at a client's site are mapped: HR, finance, operations and admin. They clock in here, and their pay is overhead, never a client's labour cost."
      >
        <OfficesCard offices={offices} mapped={mapped} canEdit={ctx.canEdit} />
      </Section>

      <Section
        id="invoices-payments"
        title="Invoices and payments"
        description="Invoices go out from your email. Clients pay into accounts you own."
      >
        <InvoicesForm mode="settings" company={company} rails={rails} />
      </Section>

      <Section
        id="modules"
        title="Modules"
        description="Switch off the parts of the app your business doesn't use. Nothing is deleted, and turning a part back on shows everything again."
      >
        <ModulesForm key={JSON.stringify(company.modules)} modules={company.modules} />
      </Section>

      {/* Late and no-show rules belong to Shifts: hidden while it is switched off (slice 3.0). */}
      {attendance && company.modules.shifts ? (
        <Section
          id="attendance"
          title="Attendance"
          description="When a clock-in counts as late, and when a missing one counts as a no-show."
        >
          <AttendanceForm settings={attendance} />
        </Section>
      ) : null}

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
