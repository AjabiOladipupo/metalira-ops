import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Status } from "@/components/status";
import { WorkerAvatar } from "@/components/worker-avatar";
import { DEFAULT_PAGE_SIZE, pageWindow } from "@/lib/pagination";
import type { TeamMember } from "@/server/people/team";

import { NotSet, plural } from "./display";
import { PeopleSearch } from "./people-search";

/** The line manager's empty state (owner decision, 21 Nov 2026). */
export const TEAM_EMPTY = "No one reports to you yet.";

function fullName(m: TeamMember): string {
  return `${m.firstName} ${m.lastName}`;
}

/** Name or staff ID, case-insensitive. */
export function matchesQuery(m: TeamMember, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fullName(m).toLowerCase().includes(q) || m.staffId.toLowerCase().includes(q);
}

const COLUMNS: Column<TeamMember>[] = [
  {
    key: "employee",
    header: "Employee",
    cell: (m) => (
      <Link
        href={`/app/people/${m.id}`}
        className="flex items-center gap-3 text-foreground no-underline hover:underline"
      >
        <WorkerAvatar workerId={m.id} name={fullName(m)} size={32} />
        <span className="flex flex-col">
          <span className="font-semibold">{fullName(m)}</span>
          <span className="text-xs text-fg-muted">
            {m.jobTitle ? `${m.jobTitle} · ` : ""}
            {m.staffId}
          </span>
        </span>
      </Link>
    ),
  },
  { key: "department", header: "Department", cell: (m) => m.departmentName ?? <NotSet /> },
  {
    key: "status",
    header: "Status",
    cell: (m) =>
      m.status === "active" ? (
        <Status tone="done">Active</Status>
      ) : (
        <Status tone="pending">Ended</Status>
      ),
  },
  {
    key: "site",
    header: "Site",
    cell: (m) => (m.siteNames.length ? m.siteNames.join(", ") : <NotSet />),
  },
  {
    key: "phone",
    header: "Phone",
    cell: (m) => (m.phone ? <a href={`tel:${m.phone}`}>{m.phone}</a> : <NotSet />),
  },
  {
    key: "email",
    header: "Email",
    cell: (m) => (m.email ? <a href={`mailto:${m.email}`}>{m.email}</a> : <NotSet />),
  },
];

/**
 * The People list for a line manager (slice 4.0b): only their reportees, from
 * public.my_reportees, with safe columns. No add, import, invite, mapping or department
 * filter: line managers change nothing here, and every write action still refuses them.
 */
export function TeamPeopleList({
  members,
  query,
  requestedPage,
}: {
  members: readonly TeamMember[];
  query: string;
  requestedPage: number;
}) {
  const back = { href: "/app", label: "dashboard" };
  if (members.length === 0) {
    return (
      <>
        <PageHeader
          back={back}
          eyebrow="Workforce"
          title="People"
          description="The people who report to you."
        />
        <EmptyState
          illustration={<Illustration name="import-people" decorative />}
          message={TEAM_EMPTY}
        />
      </>
    );
  }

  const active = members.filter((m) => m.status === "active").length;
  const rows = members.filter((m) => matchesQuery(m, query));
  const pages = pageWindow(rows.length, requestedPage, DEFAULT_PAGE_SIZE);
  const pageRows = rows.slice(pages.from, pages.to);
  const hrefFor = (page: number) => {
    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (page > 1) search.set("page", String(page));
    const text = search.toString();
    return text ? `/app/people?${text}` : "/app/people";
  };

  return (
    <>
      <PageHeader
        back={back}
        eyebrow="Your team"
        title={`${plural(members.length, "person reports", "people report")} to you · ${active.toLocaleString("en-NG")} active`}
        description="Only the people who report to you are listed. Open someone to see their sites or unlock their phone sign-in."
      />
      <section aria-label="Employees" className="flex min-w-0 flex-col gap-3">
        <PeopleSearch query={query} departmentId="" />
        <p role="status" className="m-0 text-sm text-fg-muted empty:sr-only">
          {query ? `${plural(rows.length, "employee", "employees")} found` : ""}
        </p>
        <DataTable
          caption="Employees"
          columns={COLUMNS}
          rows={pageRows}
          getRowId={(m) => m.id}
          empty={
            <p className="m-0 px-4 py-8 text-center text-sm text-fg-muted">
              No employees match. <Link href="/app/people">Show everyone</Link>
            </p>
          }
        />
        {rows.length > 0 ? (
          <Pagination label="Employee pages" pages={pages} hrefFor={hrefFor} />
        ) : null}
      </section>
    </>
  );
}
