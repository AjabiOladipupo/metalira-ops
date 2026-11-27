import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { countPeopleAtSites, listOffices } from "@/server/sites/sites-data";

import { RouteGate } from "../../_shell/slots";
import { clientsPageContext } from "../../clients/_components/context";
import { OfficesCard } from "../company/_components/offices-card";

export const metadata: Metadata = { title: "Your offices" };

/**
 * The company's own offices (slice 6.11) for the roles that edit sites: owner, admin and
 * ops_manager. The same card as Settings > Company > Head office, reached from Clients, since
 * Settings is closed to ops managers.
 */
async function Offices() {
  const ctx = await clientsPageContext();
  const offices = await listOffices(ctx.supabase, ctx.organisationId);
  const mapped = await countPeopleAtSites(
    ctx.supabase,
    ctx.organisationId,
    offices.map((o) => o.id),
    ctx.today,
  );
  return (
    <>
      <PageHeader
        back={{ href: "/app/clients", label: "Clients" }}
        eyebrow="Business"
        title="Your offices"
        description="Where staff who don't work at a client's site are mapped. They clock in here, and their pay is overhead, never a client's labour cost."
      />
      <OfficesCard offices={offices} mapped={mapped} canEdit={ctx.canEdit} />
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/settings/offices">
      <Offices />
    </RouteGate>
  );
}
