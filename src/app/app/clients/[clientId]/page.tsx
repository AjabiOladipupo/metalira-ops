import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { paymentTermsLabel } from "@/lib/company";
import { cn } from "@/lib/utils";
import { loadClient, type ClientDetail } from "@/server/business/clients-data";
import { CONTACT_ROLE_HINTS, CONTACT_ROLE_LABELS, CONTACT_ROLES } from "@/server/business/schemas";
import { getActiveCompany } from "@/server/identity/company-data";

import { RouteGate } from "../../_shell/slots";
import { DetailList, Section } from "../../people/_components/display";
import { AddContactForm, ClientStatusForm, ContactRowForm } from "../_components/contact-forms";
import { clientsPageContext } from "../_components/context";

export const metadata: Metadata = { title: "Client" };

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "sites", label: "Sites" },
  { id: "contracts", label: "Contracts" },
  { id: "contacts", label: "Contacts" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function parseTab(value: string | string[] | undefined): TabId {
  const raw = Array.isArray(value) ? value[0] : value;
  return TABS.find((t) => t.id === raw)?.id ?? "overview";
}

/** Underlined tab links, as on the worker profile board. Each tab is its own URL. */
function TabLinks({ clientId, current }: { clientId: string; current: TabId }) {
  return (
    <nav aria-label="Client sections" className="-mx-1 overflow-x-auto border-b border-line">
      <ul className="m-0 flex list-none gap-1 p-0 px-1">
        {TABS.map((tab) => {
          const active = tab.id === current;
          return (
            <li key={tab.id}>
              <Link
                href={
                  tab.id === "overview"
                    ? `/app/clients/${clientId}`
                    : `/app/clients/${clientId}?tab=${tab.id}`
                }
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap no-underline",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-fg-muted hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Overview({
  client,
  companyTermsDays,
  canEdit,
}: {
  client: ClientDetail;
  companyTermsDays: number;
  canEdit: boolean;
}) {
  const billing = client.contacts.find((c) => c.role === "billing" && c.isPrimary);
  return (
    <div className="flex flex-col gap-8">
      {client.needsDetails && client.status === "active" ? (
        <p
          className="m-0 rounded-lg border border-line bg-surface px-4 py-3 text-sm"
          data-testid="needs-details"
        >
          Add{" "}
          {[!client.billingAddress && "a billing address", !billing && "a billing contact"]
            .filter(Boolean)
            .join(" and ")}{" "}
          before invoicing {client.name}.
        </p>
      ) : null}
      <Section
        id="billing"
        title="Billing details"
        actions={
          canEdit ? (
            <Button asChild variant="outline" className="h-11 px-4">
              <Link href={`/app/clients/${client.id}/edit`}>Edit details</Link>
            </Button>
          ) : null
        }
      >
        <DetailList
          items={[
            { label: "Registered name", value: client.legalName },
            { label: "CAC RC number", value: client.rcNumber },
            { label: "Tax ID (TIN)", value: client.tin },
            {
              label: "Billing address",
              value: client.billingAddress ? (
                <span className="whitespace-pre-line">{client.billingAddress}</span>
              ) : null,
            },
            { label: "State", value: client.state },
            {
              label: "Payment terms",
              value:
                client.billingTermsDays === null
                  ? `Company terms (${paymentTermsLabel(companyTermsDays)})`
                  : paymentTermsLabel(client.billingTermsDays),
            },
            {
              label: "Primary billing contact",
              value: billing ? `${billing.name} · ${billing.email}` : null,
              testId: "primary-billing",
            },
          ]}
        />
      </Section>
      {client.notes ? (
        <Section id="notes" title="Notes" description="For your team only.">
          <p className="m-0 text-[15px] whitespace-pre-line">{client.notes}</p>
        </Section>
      ) : null}
      <Section id="withholding" title="Withholding tax">
        <p className="m-0 text-sm text-fg-muted">
          Set on each contract, because the rate depends on the service.
        </p>
      </Section>
      {canEdit ? (
        <Section
          id="status"
          title={client.status === "active" ? "Archive" : "Archived"}
          description={
            client.status === "active"
              ? "Archived clients leave the list but keep their sites, contracts and invoices. You can restore them."
              : "This client is archived. Restore it to work for it again."
          }
        >
          <ClientStatusForm clientId={client.id} status={client.status} />
        </Section>
      ) : null}
    </div>
  );
}

function Sites({ client }: { client: ClientDetail }) {
  if (client.sites.length === 0) {
    return <EmptyState message="No sites yet. Add the places your people work." />;
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm text-fg-muted">
        Addresses, geofences and QR checkpoints come with the site pages.
      </p>
      <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0">
        {client.sites.map((site) => (
          <li key={site.id} className="flex min-h-12 items-center justify-between gap-3 px-4">
            <span className="font-medium">{site.name}</span>
            <span className="text-sm text-fg-muted">No geofence</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Contacts({ client, canEdit }: { client: ClientDetail; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      {CONTACT_ROLES.map((role) => {
        const contacts = client.contacts.filter((c) => c.role === role);
        return (
          <Section
            key={role}
            id={`contacts-${role}`}
            title={`${CONTACT_ROLE_LABELS[role]} contacts`}
            description={CONTACT_ROLE_HINTS[role]}
          >
            {contacts.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">None yet.</p>
            ) : canEdit ? (
              contacts.map((c) => (
                <div key={c.id} className="flex flex-col gap-1">
                  {c.isPrimary ? <Status tone="done">Primary</Status> : null}
                  <ContactRowForm contact={c} roleLabel={CONTACT_ROLE_LABELS[role]} />
                </div>
              ))
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {contacts.map((c) => (
                  <li key={c.id} className="text-[15px]">
                    <span className="font-medium">{c.name}</span> · {c.email}
                    {c.isPrimary ? " · Primary" : ""}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        );
      })}
      {canEdit ? (
        <Section id="add-contact" title="Add contact">
          <AddContactForm clientId={client.id} />
        </Section>
      ) : null}
    </div>
  );
}

async function ClientPage({
  params,
  searchParams,
}: {
  params: PageProps<"/app/clients/[clientId]">["params"];
  searchParams: PageProps<"/app/clients/[clientId]">["searchParams"];
}) {
  const [{ clientId }, query] = await Promise.all([params, searchParams]);
  const tab = parseTab(query.tab);
  const ctx = await clientsPageContext();
  const [client, company] = await Promise.all([
    loadClient(ctx.supabase, ctx.organisationId, clientId),
    getActiveCompany(),
  ]);
  if (!client) notFound();

  const status =
    client.status === "archived" ? (
      <Status tone="pending">Archived</Status>
    ) : client.needsDetails ? (
      <Status tone="action">Needs details</Status>
    ) : (
      <Status tone="done">Active</Status>
    );

  return (
    <>
      <PageHeader
        back={{ href: "/app/clients", label: "Clients" }}
        eyebrow="Client"
        title={client.name}
        description={`${client.sites.length.toLocaleString("en-NG")} ${
          client.sites.length === 1 ? "site" : "sites"
        } · ${client.contacts.length.toLocaleString("en-NG")} ${
          client.contacts.length === 1 ? "contact" : "contacts"
        } · no contracts yet`}
        actions={status}
      />
      <TabLinks clientId={client.id} current={tab} />
      {tab === "overview" ? (
        <Overview
          client={client}
          companyTermsDays={company?.paymentTermsDays ?? 30}
          canEdit={ctx.canEdit}
        />
      ) : null}
      {tab === "sites" ? <Sites client={client} /> : null}
      {tab === "contracts" ? (
        <EmptyState message="No contracts yet. Contracts and rate cards are added here next." />
      ) : null}
      {tab === "contacts" ? <Contacts client={client} canEdit={ctx.canEditContacts} /> : null}
    </>
  );
}

export default function Page({ params, searchParams }: PageProps<"/app/clients/[clientId]">) {
  return (
    <RouteGate href="/app/clients/[id]">
      <ClientPage params={params} searchParams={searchParams} />
    </RouteGate>
  );
}
