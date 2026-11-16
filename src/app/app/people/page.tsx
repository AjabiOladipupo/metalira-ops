import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { findNavItem } from "@/lib/nav";
import { canViewBankChanges, countPendingBankChanges } from "@/server/people/bank-changes";
import { loadPeopleDirectory, type PeopleRow } from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../_shell/slots";
import { BankApprovalsLink } from "./_components/bank-approvals-link";
import { DepartmentTiles } from "./_components/department-tiles";
import { NotSet, plural } from "./_components/display";
import { PeopleActions } from "./_components/people-actions";
import { PeopleSearch } from "./_components/people-search";

export const metadata: Metadata = { title: "People" };

const COLUMNS: Column<PeopleRow>[] = [
  {
    key: "employee",
    header: "Employee",
    cell: (row) => (
      <Link
        href={`/app/people/${row.id}`}
        className="flex flex-col text-foreground no-underline hover:underline"
      >
        <span className="font-semibold">{row.name}</span>
        <span className="text-xs text-fg-muted">
          {row.jobTitle ? `${row.jobTitle} · ` : ""}
          {row.staffId}
        </span>
      </Link>
    ),
  },
  { key: "department", header: "Department", cell: (row) => row.departmentName ?? <NotSet /> },
  { key: "manager", header: "Line manager", cell: (row) => row.lineManagerName ?? <NotSet /> },
  {
    key: "site",
    header: "Site",
    cell: (row) => (row.siteNames.length ? row.siteNames.join(", ") : <NotSet />),
  },
  {
    key: "projects",
    header: "Projects",
    className: "min-w-40 whitespace-normal",
    cell: (row) => (row.projectNames.length ? row.projectNames.join(", ") : <NotSet />),
  },
  {
    key: "mapping",
    header: "Mapping",
    cell: (row) =>
      row.mapped ? (
        <Status tone="done">Mapped</Status>
      ) : (
        <Status tone="pending" className="font-semibold">
          Incomplete
        </Status>
      ),
  },
];

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

async function PeopleList({
  searchParams,
}: {
  searchParams: PageProps<"/app/people">["searchParams"];
}) {
  const params = await searchParams;
  const query = firstParam(params.q).slice(0, 100);
  const departmentId = firstParam(params.dept).slice(0, 64);
  const ctx = await peoplePageContext();
  const [directory, pendingBankChanges] = await Promise.all([
    loadPeopleDirectory(ctx.supabase, ctx.organisationId, ctx.today, {
      query,
      departmentId: departmentId || undefined,
    }),
    canViewBankChanges(ctx.role)
      ? countPendingBankChanges(ctx.supabase, ctx.organisationId)
      : Promise.resolve(0),
  ]);
  const actions = (
    <>
      <BankApprovalsLink count={pendingBankChanges} />
      <PeopleActions canEdit={ctx.canEdit} />
    </>
  );

  if (directory.activeCount === 0) {
    const item = findNavItem("/app/people");
    return (
      <>
        <PageHeader
          eyebrow="Workforce"
          title={item.label}
          description={item.description}
          actions={actions}
        />
        <EmptyState illustration={<Illustration name="import-people" />} message={item.empty} />
      </>
    );
  }

  const unmapped =
    directory.unmappedCount === 0
      ? "all mapped"
      : `${directory.unmappedCount.toLocaleString("en-NG")} not fully mapped`;
  const filtered = Boolean(query || departmentId);

  return (
    <>
      <PageHeader
        eyebrow="People and mapping"
        title={`${plural(directory.activeCount, "employee", "employees")} · ${unmapped}`}
        description="Every employee needs a department, a line manager and a site. Line managers approve their reportees' leave and timesheets; projects decide whose hours count toward which client."
        actions={actions}
      />

      <DepartmentTiles
        departments={directory.departments}
        activeCount={directory.activeCount}
        noDepartmentCount={directory.noDepartmentCount}
        selected={departmentId}
        query={query}
      />

      <section aria-label="Employees" className="flex min-w-0 flex-col gap-3">
        <PeopleSearch query={query} departmentId={departmentId} />
        <p role="status" className="m-0 text-sm text-fg-muted">
          {filtered
            ? `${plural(directory.rows.length, "employee", "employees")} found`
            : `Showing all ${plural(directory.rows.length, "employee", "employees")}`}
        </p>
        <DataTable
          caption="Employees"
          columns={COLUMNS}
          rows={directory.rows}
          getRowId={(row) => row.id}
          empty={
            <p className="m-0 px-4 py-8 text-center text-sm text-fg-muted">
              No employees match. <Link href="/app/people">Show everyone</Link>
            </p>
          }
        />
      </section>
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/people">) {
  return (
    <RouteGate href="/app/people">
      <PeopleList searchParams={searchParams} />
    </RouteGate>
  );
}
