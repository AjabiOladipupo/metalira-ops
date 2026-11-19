import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { previousSetupStep, resumeSetupSlug, setupStepHref, type SetupSlug } from "@/lib/company";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadCollectionRails } from "@/server/billing/collection-rails";
import { continueFromClients, finishSetup } from "@/server/identity/company-actions";
import { getPageSession } from "@/server/identity/session";
import {
  getActiveCompany,
  getActiveCompanyLogoUrl,
  type Company,
} from "@/server/identity/company-data";

import { BusinessForm } from "../../_company/business-form";
import { InvoicesForm } from "../../_company/invoices-form";
import { LogoForm } from "../../_company/logo-form";
import { PlanForm } from "../../_company/plan-form";
import { ImportWorkspace } from "../../people/import/_components/import-workspace";
import { SetupFrame } from "./setup-frame";
import { StepForm } from "./step-form";

/**
 * The wizard's six steps. Each page under /app/setup renders one of these inside its RouteGate
 * (owner or admin only), so the session and company are read behind a Suspense boundary.
 */

async function requireCompany(): Promise<Company> {
  const company = await getActiveCompany();
  // RouteGate has already checked the session and role; no row means RLS hid it.
  if (!company) redirect("/no-access");
  return company;
}

function backHref(slug: SetupSlug): string | undefined {
  const previous = previousSetupStep(slug);
  return previous ? setupStepHref(previous.slug) : undefined;
}

export async function ResumeSetup(): Promise<never> {
  const company = await requireCompany();
  redirect(setupStepHref(resumeSetupSlug(company.setupStep, company.setupCompletedAt !== null)));
}

export async function PlanStep() {
  const company = await requireCompany();
  return (
    <SetupFrame
      current="plan"
      company={company}
      title="Your plan"
      description="Choose the plan that fits. Pricing is not final yet, so nothing is charged."
    >
      <PlanForm mode="setup" plan={company.plan} expectedWorkers={company.expectedWorkers} />
    </SetupFrame>
  );
}

export async function BusinessStep() {
  const [company, logoUrl] = await Promise.all([requireCompany(), getActiveCompanyLogoUrl()]);
  return (
    <SetupFrame
      current="business"
      company={company}
      title="Your business"
      description="This goes on payslips, invoices and receipts."
    >
      <LogoForm logoUrl={logoUrl} companyName={company.name} />
      <BusinessForm mode="setup" company={company} backHref={backHref("business")} />
    </SetupFrame>
  );
}

export async function InvoicesStep() {
  const [company, session] = await Promise.all([requireCompany(), getPageSession()]);
  if (!session?.active) redirect("/no-access");
  const rails = await loadCollectionRails(
    await createServerSupabase(),
    company.id,
    session.active.role,
    { fromSetup: company.setupCompletedAt === null },
  );
  return (
    <SetupFrame
      current="invoices"
      company={company}
      title="Invoices and getting paid"
      description="Invoices go out from your email. Clients pay into accounts you own; Metalira never holds the money."
    >
      <InvoicesForm mode="setup" company={company} rails={rails} backHref={backHref("invoices")} />
    </SetupFrame>
  );
}

export async function ClientsStep() {
  const company = await requireCompany();
  return (
    <SetupFrame
      current="clients"
      company={company}
      title="Clients and contracts"
      description="The companies you service. Rates here price every invoice; the billing email is where those invoices go."
    >
      <div className="flex flex-col gap-3 rounded-xl border border-dashed border-line px-6 py-10 text-center">
        <p className="m-0 type-body-lg">Clients, sites and rates arrive in Phase 2.</p>
        <p className="m-0 text-sm text-fg-muted">
          Client, project and site names in your employee file are kept. New names become new
          clients you can finish later.
        </p>
      </div>
      <StepForm action={continueFromClients} backHref={setupStepHref("invoices")} />
    </SetupFrame>
  );
}

export async function EmployeesStep({ batchId }: { batchId?: string }) {
  const company = await requireCompany();
  return (
    <SetupFrame
      current="employees"
      company={company}
      title="Bring in your employees"
      description="One row per employee, with who they report to and which client and project they work on."
    >
      <ImportWorkspace path="/app/setup/employees" batchId={batchId} />
      <StepForm
        action={finishSetup}
        backHref={setupStepHref("clients")}
        continueLabel="Finish setup"
      />
    </SetupFrame>
  );
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  return words
    .slice(0, 3)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export async function ReadyStep() {
  const [company, logoUrl] = await Promise.all([requireCompany(), getActiveCompanyLogoUrl()]);
  if (company.setupCompletedAt === null)
    redirect(setupStepHref(resumeSetupSlug(company.setupStep, false)));

  return (
    <SetupFrame current="ready" company={company} title={`${company.name} is set up`}>
      <div className="flex max-w-[680px] flex-col gap-4">
        {logoUrl ? (
          // Signed URL from private Storage; see LogoForm.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt={`${company.name} logo`}
            className="size-[72px] rounded-2xl border border-line object-contain"
          />
        ) : (
          <span
            aria-hidden
            className="flex size-[72px] items-center justify-center rounded-2xl bg-foreground font-display text-2xl font-bold text-background"
          >
            {initials(company.name)}
          </span>
        )}
        <p className="m-0 text-[17px] text-fg-muted">
          Workers sign in with company code{" "}
          <strong className="font-mono tracking-wider text-foreground" data-testid="company-code">
            {company.companyCode}
          </strong>
          .{company.invoiceEmail ? ` Invoices go out from ${company.invoiceEmail}.` : null}
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Button asChild className="h-11 rounded-lg px-5">
            <Link href="/app">Go to the dashboard</Link>
          </Button>
          <Button asChild variant="outline" className="h-11 rounded-lg px-4">
            <Link href="/app/people">Add your people</Link>
          </Button>
          <Button asChild variant="outline" className="h-11 rounded-lg px-4">
            <Link href="/app/settings/company">Company settings</Link>
          </Button>
        </div>
      </div>
    </SetupFrame>
  );
}
