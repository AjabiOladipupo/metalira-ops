import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { PageHeader } from "@/components/page-header";
import { PageSizeSelect } from "@/components/page-size-select";
import { Pagination } from "@/components/pagination";
import { Status } from "@/components/status";
import { WorkerAvatar } from "@/components/worker-avatar";
import { canAccessHref, findNavItem } from "@/lib/nav";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  PEOPLE_PAGE_SIZE_COOKIE,
  pageWindow,
  parsePage,
  linkPageSize,
  parsePageSize,
  type PageSize,
} from "@/lib/pagination";
import { initials } from "@/lib/people";
import { canViewBankChanges, countPendingBankChanges } from "@/server/people/bank-changes";
import {
  loadMappingTargets,
  loadPeopleDirectory,
  loadWorkerFormOptions,
  type PeopleRow,
} from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../_shell/slots";
import { BankApprovalsLink } from "./_components/bank-approvals-link";
import { DepartmentTiles } from "./_components/department-tiles";
import { NotSet, plural } from "./_components/display";
import { MappingPanel, type MappingWorker } from "./_components/mapping-panel";
import { PeopleActions } from "./_components/people-actions";
import { PeopleSearch } from "./_components/people-search";

export const metadata: Metadata = { title: "People" };

const DASHBOARD = { href: "/app", label: "dashboard" };

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
          className="flex items-center gap-3 text-foreground no-underline hover:underline"
        >
          <WorkerAvatar workerId={row.id} name={row.name} size={32} />
          <span className="flex flex-col">
            <span className="font-semibold">{row.name}</span>
            <span className="text-xs text-fg-muted">
              {row.jobTitle ? `${row.jobTitle} · ` : ""}
              {row.staffId}
            </span>
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
            className="relative -my-1 inline-flex min-h-11 items-center text-foreground no-underline hover:underline"
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

interface PeopleParams {
  q?: string;
  dept?: string;
  map?: string;
  page?: number;
  size?: PageSize;
}

/**
 * /app/people with the given filters, leaving out blanks and page 1. `size` is written whenever
 * it is given: callers pass `linkPageSize(...)`, and the size picker passes its own size.
 */
function peopleHref(params: PeopleParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.dept) search.set("dept", params.dept);
  if (params.size) search.set("size", String(params.size));
  if (params.page && params.page > 1) search.set("page", String(params.page));
  if (params.map) search.set("map", params.map);
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
  // Page size: the URL first (shareable links), then the choice remembered on this device.
  const urlSize = parsePageSize(firstParam(params.size));
  const size =
    urlSize ??
    parsePageSize((await cookies()).get(PEOPLE_PAGE_SIZE_COOKIE)?.value) ??
    DEFAULT_PAGE_SIZE;
  const sizeInLinks = linkPageSize(urlSize, size) ?? undefined;
  const requestedPage = parsePage(firstParam(params.page));
  const ctx = await peoplePageContext();
  const [directory, pendingBankChanges] = await Promise.all([
    loadPeopleDirectory(ctx.supabase, ctx.organisationId, ctx.today, {
      query,
      departmentId: departmentId || undefined,
      selectedId: mapId || undefined,
    }),
    canViewBankChanges(ctx.role)
      ? countPendingBankChanges(ctx.supabase, ctx.organisationId)
      : Promise.resolve(0),
  ]);
  const actions = (
    <>
      <BankApprovalsLink count={pendingBankChanges} />
      <PeopleActions
        canEdit={ctx.canEdit}
        canInvite={canAccessHref(ctx.role, "/app/people/invites")}
      />
    </>
  );

  if (directory.activeCount === 0) {
    const item = findNavItem("/app/people");
    return (
      <>
        <PageHeader
          back={DASHBOARD}
          eyebrow="Workforce"
          title={item.label}
          description={item.description}
          actions={actions}
        />
        <EmptyState
          illustration={<Illustration name="import-people" decorative />}
          message={item.empty}
        />
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
  // Only the page being shown is rendered and sent to the browser. Search and the department
  // filter run first (and their links drop `page`), so changing either starts on page 1.
  const pages = pageWindow(directory.rows.length, requestedPage, size);
  const pageRows = directory.rows.slice(pages.from, pages.to);
  const here: PeopleParams = {
    q: query,
    dept: departmentId,
    size: sizeInLinks,
    page: pages.page,
  };
  const mapHref = ctx.canEdit ? (row: PeopleRow) => peopleHref({ ...here, map: row.id }) : null;

  return (
    <>
      <PageHeader
        back={DASHBOARD}
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
        size={sizeInLinks}
      />

      <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:flex-wrap lg:items-start">
        <section
          aria-label="Employees"
          className="flex min-w-0 flex-col gap-3 lg:flex-[999_1_560px]"
        >
          <PeopleSearch query={query} departmentId={departmentId} size={sizeInLinks} />
          {/* Search results are announced (the live region stays in the page, hidden while empty,
              so updates are read out); the full count is in the title and under the
              table ("1–25 of 162"). */}
          <p role="status" className="m-0 text-sm text-fg-muted empty:sr-only">
            {filtered ? `${plural(directory.rows.length, "employee", "employees")} found` : ""}
          </p>
          <DataTable
            caption="Employees"
            columns={columns(mapHref)}
            rows={pageRows}
            getRowId={(row) => row.id}
            selectedIds={picked ? [picked.id] : []}
            empty={
              <p className="m-0 px-4 py-8 text-center text-sm text-fg-muted">
                No employees match. <Link href="/app/people">Show everyone</Link>
              </p>
            }
          />
          {directory.rows.length > 0 ? (
            <Pagination
              label="Employee pages"
              pages={pages}
              hrefFor={(page) => peopleHref({ ...here, page })}
              sizePicker={
                <PageSizeSelect
                  value={size}
                  cookieName={PEOPLE_PAGE_SIZE_COOKIE}
                  cookiePath="/app"
                  options={PAGE_SIZES.map((option) => ({
                    size: option,
                    href: peopleHref({ ...here, size: option, page: 1 }),
                  }))}
                />
              }
            />
          ) : null}
        </section>

        {ctx.canEdit && formOptions && targets ? (
          <MappingPanel
            worker={panelRow ? toMappingWorker(panelRow) : null}
            avatar={
              panelRow ? (
                <WorkerAvatar workerId={panelRow.id} name={panelRow.name} size={48} />
              ) : undefined
            }
            options={{ ...formOptions, ...targets }}
            open={picked !== null}
            closeHref={peopleHref(here)}
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
