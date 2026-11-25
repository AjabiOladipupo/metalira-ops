import Link from "next/link";

import { Button } from "@/components/ui/button";
import { PAY_TYPE_LABELS } from "@/lib/people";
import {
  APP_ROLES,
  APP_ROLE_LABELS,
  NONE,
  PAY_TYPES,
  PEOPLE_STATUSES,
  PEOPLE_STATUS_LABELS,
  activeFilterCount,
  type PeopleFilters,
} from "@/lib/people-filters";
import type { FilterOption, PeopleFilterOptions } from "@/server/people/people-data";

import { FilterDisclosure } from "./filter-disclosure";

const SELECT =
  "h-10 w-full min-w-0 rounded-lg border border-line bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

function FilterSelect({
  name,
  label,
  value,
  options,
  any = "Any",
}: {
  name: string;
  label: string;
  value: string;
  options: readonly FilterOption[];
  any?: string | null;
}) {
  const id = `people-filter-${name}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value} className={SELECT}>
        {any !== null ? <option value="">{any}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The People list filters (slice U.1): a plain GET form, so a filtered list is a shareable URL.
 * It keeps the search and page size and leaves out the page, so new filters start on page 1.
 * Filters combine with AND; "Clear filters" keeps only the search and page size.
 */
export function PeopleFiltersForm({
  filters,
  options,
  departments,
  size,
  showDepartment = true,
}: {
  filters: PeopleFilters;
  options: PeopleFilterOptions;
  departments: readonly FilterOption[];
  size?: number;
  showDepartment?: boolean;
}) {
  const active = activeFilterCount(filters);
  const clear = new URLSearchParams();
  if (filters.q) clear.set("q", filters.q);
  if (size) clear.set("size", String(size));
  const clearHref = clear.size ? `/app/people?${clear.toString()}` : "/app/people";
  const statuses = PEOPLE_STATUSES.filter((s) => s !== "invited" || options.invited);

  return (
    <FilterDisclosure
      active={active}
      clear={active > 0 ? <Link href={clearHref}>Clear filters</Link> : null}
    >
      <form
        action="/app/people"
        method="get"
        aria-label="Filter employees"
        className="flex flex-col gap-3 rounded-xl border border-line p-4"
      >
        {filters.q ? <input type="hidden" name="q" value={filters.q} /> : null}
        {size ? <input type="hidden" name="size" value={size} /> : null}
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          <FilterSelect
            name="site"
            label="Site"
            value={filters.site}
            options={[...options.sites, { value: NONE, label: "No site" }]}
          />
          <FilterSelect
            name="manager"
            label="Line manager"
            value={filters.manager}
            options={[...options.lineManagers, { value: NONE, label: "No line manager" }]}
          />
          <FilterSelect
            name="title"
            label="Job title"
            value={filters.title}
            options={[...options.jobTitles, { value: NONE, label: "No job title" }]}
          />
          <FilterSelect
            name="role"
            label="App access"
            value={filters.role}
            options={APP_ROLES.map((r) => ({ value: r, label: APP_ROLE_LABELS[r] }))}
          />
          {showDepartment ? (
            <FilterSelect
              name="dept"
              label="Department"
              value={filters.dept}
              options={[...departments, { value: NONE, label: "No department" }]}
            />
          ) : null}
          {options.payTypes ? (
            <FilterSelect
              name="type"
              label="Employment type"
              value={filters.type}
              options={PAY_TYPES.map((t) => ({ value: t, label: PAY_TYPE_LABELS[t] }))}
            />
          ) : null}
          <FilterSelect
            name="status"
            label="Status"
            value={filters.status}
            any={null}
            options={statuses.map((s) => ({ value: s, label: PEOPLE_STATUS_LABELS[s] }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" className="h-10 rounded-lg">
            Apply filters
          </Button>
        </div>
      </form>
    </FilterDisclosure>
  );
}
