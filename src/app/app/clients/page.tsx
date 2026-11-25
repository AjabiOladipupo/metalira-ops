import { Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { ListSelectionBar } from "@/components/list-export";
import { PageHeader } from "@/components/page-header";
import { RowCheckbox, RowSelection, SelectAllCheckbox } from "@/components/row-selection";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findNavItem } from "@/lib/nav";
import {
  filterClients,
  listClients,
  summariseClients,
  type ClientRow,
} from "@/server/business/clients-data";

import { RouteGate } from "../_shell/slots";
import { clientsPageContext } from "./_components/context";

export const metadata: Metadata = { title: "Clients" };

const DASHBOARD = { href: "/app", label: "dashboard" };

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-NG")} ${n === 1 ? one : many}`;
}

function ClientStatus({ row }: { row: ClientRow }) {
  if (row.status === "archived") return <Status tone="pending">Archived</Status>;
  if (row.needsDetails) return <Status tone="action">Needs details</Status>;
  return <Status tone="done">Active</Status>;
}

const COLUMNS: Column<ClientRow>[] = [
  // Slice U.2: tick clients to export them.
  {
    key: "select",
    header: <SelectAllCheckbox label="Select all clients shown" />,
    className: "w-10",
    cell: (row) => <RowCheckbox rowId={row.id} label={`Select ${row.name}`} />,
  },
  {
    key: "client",
    header: "Client",
    cell: (row) => (
      <Link
        href={`/app/clients/${row.id}`}
        className="flex flex-col text-foreground no-underline hover:underline"
      >
        <span className="font-semibold">{row.name}</span>
        <span className="text-xs text-fg-muted">
          {row.primaryBillingEmail ?? "No billing contact"}
        </span>
      </Link>
    ),
  },
  { key: "sites", header: "Sites", kind: "number", cell: (row) => row.siteCount },
  {
    key: "geofence",
    header: "No geofence",
    kind: "number",
    cell: (row) => row.sitesWithoutGeofence,
  },
  {
    key: "contracts",
    header: "Active contracts",
    kind: "number",
    cell: (row) => row.activeContractCount,
  },
  { key: "status", header: "Status", cell: (row) => <ClientStatus row={row} /> },
];

function ClientSearch({ query }: { query: string }) {
  return (
    <form role="search" action="/app/clients" method="get" className="flex flex-wrap gap-2">
      <label htmlFor="client-search" className="sr-only">
        Search clients by name
      </label>
      <div className="relative min-w-0 flex-1 basis-60">
        <Search
          strokeWidth={1.75}
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted"
        />
        <Input
          id="client-search"
          type="search"
          name="q"
          defaultValue={query}
          maxLength={100}
          placeholder="Search clients by name"
          className="h-10 pl-9 text-[15px]"
        />
      </div>
      <Button type="submit" variant="outline">
        Search
      </Button>
      {query ? (
        <Button asChild variant="ghost">
          <Link href="/app/clients">Clear</Link>
        </Button>
      ) : null}
    </form>
  );
}

async function ClientsList({
  searchParams,
}: {
  searchParams: PageProps<"/app/clients">["searchParams"];
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = (raw ?? "").trim().slice(0, 100);
  const ctx = await clientsPageContext();
  const all = await listClients(ctx.supabase, ctx.organisationId);
  const summary = summariseClients(all);
  const item = findNavItem("/app/clients");
  const addAction = ctx.canEdit ? (
    <Button asChild className="h-11 px-5">
      <Link href="/app/clients/new">Add client</Link>
    </Button>
  ) : null;

  if (all.length === 0) {
    return (
      <>
        <PageHeader
          back={DASHBOARD}
          eyebrow="Business"
          title={item.label}
          description={item.description}
        />
        <EmptyState
          illustration={<Illustration name="no-clients" decorative />}
          message={item.empty}
          action={addAction}
        />
      </>
    );
  }

  const rows = filterClients(all, query);
  const details =
    summary.needsDetails === 0
      ? "all with billing details"
      : `${summary.needsDetails.toLocaleString("en-NG")} need details`;

  return (
    <>
      <PageHeader
        back={DASHBOARD}
        eyebrow="Business"
        title={`${plural(summary.active, "client", "clients")} · ${details}`}
        description={`${plural(summary.sites, "site", "sites")} across active clients${
          summary.sitesWithoutGeofence
            ? ` (${summary.sitesWithoutGeofence.toLocaleString("en-NG")} without a geofence)`
            : ""
        }${
          summary.archived ? `, ${summary.archived.toLocaleString("en-NG")} archived` : ""
        }. A client needs a billing address and a billing contact before it can be invoiced.`}
        actions={addAction}
      />
      <section aria-label="Clients" className="flex min-w-0 flex-col gap-3">
        <ClientSearch query={query} />
        <p role="status" className="m-0 text-sm text-fg-muted empty:sr-only">
          {query ? `${plural(rows.length, "client", "clients")} found` : ""}
        </p>
        {/* Keyed by the search, so another search starts with nothing ticked. */}
        <RowSelection
          key={query}
          rowIds={rows.map((row) => row.id)}
          matchingCount={rows.length}
          noun={{ one: "client", many: "clients" }}
        >
          <ListSelectionBar
            params={{ list: "clients" }}
            noun={{ one: "client", many: "clients" }}
          />
          <DataTable
            caption="Clients"
            columns={COLUMNS}
            rows={rows}
            getRowId={(row) => row.id}
            empty={
              <p className="m-0 px-4 py-8 text-center text-sm text-fg-muted">
                No clients match. <Link href="/app/clients">Show every client</Link>
              </p>
            }
          />
        </RowSelection>
      </section>
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/clients">) {
  return (
    <RouteGate href="/app/clients">
      <ClientsList searchParams={searchParams} />
    </RouteGate>
  );
}
