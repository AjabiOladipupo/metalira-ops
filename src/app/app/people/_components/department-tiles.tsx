import Link from "next/link";

import { cn } from "@/lib/utils";
import { NO_DEPARTMENT, type DepartmentSummary } from "@/server/people/people-data";

import { plural } from "./display";

function Tile({
  href,
  label,
  count,
  note,
  selected,
}: {
  href: string;
  label: string;
  count: number;
  note: string;
  selected: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex h-full flex-col items-start gap-1 rounded-xl border px-4 py-3.5 no-underline transition-colors",
          selected
            ? "border-foreground bg-foreground text-background hover:text-background"
            : "border-line bg-background text-foreground hover:border-foreground hover:text-foreground",
        )}
      >
        <span className="type-label text-inherit">{label}</span>
        <span className="font-heading text-[25px] leading-tight font-bold tabular-nums">
          {count.toLocaleString("en-NG")}
        </span>
        <span className="text-[13px] opacity-80">{note}</span>
      </Link>
    </li>
  );
}

/** Department tiles as filters (People board): count and head, plus All and No department. */
export function DepartmentTiles({
  departments,
  activeCount,
  noDepartmentCount,
  selected,
  hrefFor,
}: {
  departments: DepartmentSummary[];
  activeCount: number;
  noDepartmentCount: number;
  selected: string;
  /**
   * The link for a department filter (blank for all). It keeps the search, the other filters
   * and the page size, and drops the page, so it starts at 1.
   */
  hrefFor: (departmentId: string) => string;
}) {
  return (
    <nav aria-label="Departments">
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3 p-0">
        <Tile
          href={hrefFor("")}
          label="All"
          count={activeCount}
          note={plural(departments.length, "department", "departments")}
          selected={!selected}
        />
        {departments.map((d) => (
          <Tile
            key={d.id}
            href={hrefFor(d.id)}
            label={d.name}
            count={d.count}
            note={d.headName ? `Head: ${d.headName}` : "No head set"}
            selected={selected === d.id}
          />
        ))}
        {noDepartmentCount > 0 ? (
          <Tile
            href={hrefFor(NO_DEPARTMENT)}
            label="No department"
            count={noDepartmentCount}
            note="Needs a department"
            selected={selected === NO_DEPARTMENT}
          />
        ) : null}
      </ul>
    </nav>
  );
}
