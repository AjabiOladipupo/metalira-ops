import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { findNavItem } from "@/lib/nav";
import { initials } from "@/lib/people";
import {
  loadMappingTargets,
  loadPeopleDirectory,
  loadWorkerFormOptions,
  type PeopleRow,
} from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../_shell/slots";
import { DepartmentTiles } from "./_components/department-tiles";
import { NotSet, plural } from "./_components/display";
import { MappingPanel, type MappingWorker } from "./_components/mapping-panel";
import { PeopleActions } from "./_components/people-actions";
import { PeopleSearch } from "./_components/people-search";

export const metadata: Metadata = { title: "People" };

function MappingStatus({ row }: { row: PeopleRow }) {
  return row.mapped ? (
    <Status tone="done">Mapped</Status>
  ) : (
    <Status tone="pending" className="font-semibold">
      Incomplete
    </Status>
  );
}

/**
 * The table columns. For people who can change mappings, the status opens the mapping panel for
 * that employee (`?map=<id>`, keeping the search and department filter).
 */
function columns(mapHref: ((row: PeopleRow) => string) | null): Column<PeopleRow>[] {
  return [
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
        mapHref ? (
          <Link
            href={mapHref(row)}
            scroll={false}
            className="inline-flex min-h-9 items-center text-foreground no-underline hover:underline"
          >
            <MappingStatus row={row} />
            <span className="sr-only">, change mapping for {row.name}</span>
          </Link>
        ) : (
          <MappingStatus row={row} />
        ),
    },
  ];
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** /app/people with the given filters, leaving out blanks. */
function peopleHref(params: { q?: string; dept?: string; map?: string }): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `/app/people?${text}` : "/app/people";
}

function toMappingWorker(row: PeopleRow): MappingWorker {
  return {
    id: row.id,
    name: row.name,
    initials: initials(row),
    jobTitle: row.jobTitle,
    staffId: row.staffId,
    departmentId: row.departmentId,
    lineManager: row.lineManager,
    siteIds: row.siteIds,
    projectIds: row.projectIds,
    changesFrom: row.changesFrom,
  };
}

async function PeopleList({
  searchParams,
}: {
  searchParams: PageProps<"/app/people">["searchParams"];
}) {
  const params = await searchParams;
  const query = firstParam(params.q).slice(0, 100);
  const departmentId = firstParam(params.dept).slice(0, 64);
  const mapId = firstParam(params.map).slice(0, 64);
  const ctx = await peoplePageContext();
  const directory = await loadPeopleDirectory(ctx.supabase, ctx.organisationId, ctx.today, {
    query,
    departmentId: departmentId || undefined,
    selectedId: mapId || undefined,
  });

  if (directory.activeCount === 0) {
    const item = findNavItem("/app/people");
    return (
      <>
        <PageHeader
          eyebrow="Workforce"
          title={item.label}
          description={item.description}
          actions={<PeopleActions canEdit={ctx.canEdit} />}
        />
        <EmptyState illustration={<Illustration name="import-people" />} message={item.empty} />
      </>
    );
  }

  // The panel maps the employee picked from the table; until one is picked, the right-hand
  // column (desktop only) starts on the first employee still to map.
  const picked = ctx.canEdit ? directory.selected : null;
  const panelRow = ctx.canEdit
    ? (picked ?? directory.rows.find((row) => !row.mapped) ?? directory.rows[0] ?? null)
    : null;
  const [formOptions, targets] = panelRow
    ? await Promise.all([
        loadWorkerFormOptions(ctx.supabase, ctx.organisationId, panelRow.id),
        loadMappingTargets(ctx.supabase, ctx.organisationId),
      ])
    : [null, null];

  const unmapped =
    directory.unmappedCount === 0
      ? "all mapped"
      : `${directory.unmappedCount.toLocaleString("en-NG")} not fully mapped`;
  const filtered = Boolean(query || departmentId);
  const mapHref = ctx.canEdit
    ? (row: PeopleRow) => peopleHref({ q: query, dept: departmentId, map: row.id })
    : null;

  return (
    <>
      <PageHeader
        eyebrow="People and mapping"
        title={`${plural(directory.activeCount, "employee", "employees")} · ${unmapped}`}
        description="Every employee needs a department, a line manager and a site. Line managers approve their reportees' leave and timesheets; projects decide whose hours count toward which client."
        actions={<PeopleActions canEdit={ctx.canEdit} />}
      />

      <DepartmentTiles
        departments={directory.departments}
        activeCount={directory.activeCount}
        noDepartmentCount={directory.noDepartmentCount}
        selected={departmentId}
        query={query}
      />

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Employees" className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
          <PeopleSearch query={query} departmentId={departmentId} />
          <p role="status" className="m-0 text-sm text-fg-muted">
            {filtered
              ? `${plural(directory.rows.length, "employee", "employees")} found`
              : `Showing all ${plural(directory.rows.length, "employee", "employees")}`}
          </p>
          <DataTable
            caption="Employees"
            columns={columns(mapHref)}
            rows={directory.rows}
            getRowId={(row) => row.id}
            selectedIds={picked ? [picked.id] : []}
            empty={
              <p className="m-0 px-4 py-8 text-center text-sm text-fg-muted">
                No employees match. <Link href="/app/people">Show everyone</Link>
              </p>
            }
          />
        </section>

        {ctx.canEdit && formOptions && targets ? (
          <MappingPanel
            worker={panelRow ? toMappingWorker(panelRow) : null}
            options={{ ...formOptions, ...targets }}
            open={picked !== null}
            closeHref={peopleHref({ q: query, dept: departmentId })}
          />
        ) : null}
      </div>
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
