import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { getActiveCompany } from "@/server/identity/company-data";

import { RouteGate } from "../../_shell/slots";
import { ClientForm } from "../_components/client-form";

export const metadata: Metadata = { title: "Add client" };

async function NewClient() {
  const company = await getActiveCompany();
  return (
    <>
      <PageHeader
        back={{ href: "/app/clients", label: "Clients" }}
        eyebrow="Clients"
        title="Add client"
        description="Only the name is needed now. Invoices need a billing address and a billing contact."
      />
      <ClientForm mode="create" companyTermsDays={company?.paymentTermsDays ?? 30} />
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/clients/new">
      <NewClient />
    </RouteGate>
  );
}
