import Link from "next/link";
import { redirect } from "next/navigation";

import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { previousSetupStep, resumeSetupSlug, setupStepHref, type SetupSlug } from "@/lib/company";
import { createServerSupabase } from "@/lib/supabase/server";
import { COLLECTION_RAILS } from "@/server/billing/collection-rails";
import { listSetupClients, type SetupClientRow } from "@/server/business/clients-data";
import { continueFromClients, finishSetup } from "@/server/identity/company-actions";
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
import { QuickAddClientForm } from "./quick-add-client";
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
  const company = await requireCompany();
  return (
    <SetupFrame
      current="invoices"
      company={company}
      title="Invoices and getting paid"
      description="Invoices go out from your email. Clients pay into accounts you own; Metalira never holds the money."
    >
      <InvoicesForm
        mode="setup"
        company={company}
        rails={COLLECTION_RAILS}
        backHref={backHref("invoices")}
      />
    </SetupFrame>
  );
}

function SetupClientsTable({ rows }: { rows: SetupClientRow[] }) {
  return (
    <DataTable
      caption="Clients added"
      columns={[
        { key: "client", header: "Client", cell: (row) => <strong>{row.name}</strong> },
        {
          key: "email",
          header: "Billing email",
          cell: (row) => row.billingEmail ?? <span className="text-fg-muted">Not set</span>,
        },
        {
          key: "site",
          header: "Site",
          cell: (row) =>
            row.siteNames.length ? (
              row.siteNames.join(", ")
            ) : (
              <span className="text-fg-muted">Not set</span>
            ),
        },
        {
          key: "rate",
          header: "Rate",
          cell: () => <span className="text-fg-muted">Add a contract</span>,
        },
      ]}
      rows={rows}
      getRowId={(row) => row.id}
      empty={
        <p className="m-0 px-4 py-6 text-center text-sm text-fg-muted">
          No clients yet. Add the first company you work for, or skip this step.
        </p>
      }
    />
  );
}

export async function ClientsStep() {
  const company = await requireCompany();
  const clients = await listSetupClients(await createServerSupabase(), company.id);
  return (
    <SetupFrame
      current="clients"
      company={company}
      title="Clients and contracts"
      description="The companies you service. The billing email is where invoices go; rates come with each contract."
    >
      <QuickAddClientForm />
      <SetupClientsTable rows={clients} />
      <p className="m-0 text-sm text-fg-muted">
        Client, project and site names in your employee file are kept. New names become clients you
        can finish later under Clients.
      </p>
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
