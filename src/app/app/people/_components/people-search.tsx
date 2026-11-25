import { Search } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Search by name or staff ID. A plain GET form, so the result is a shareable URL. It keeps the
 * filters and page size (`keep`) and leaves out the page, so a new search starts on page 1.
 */
export function PeopleSearch({
  query,
  keep = {},
}: {
  query: string;
  /** Other search params to keep: the filters and a non-default page size. */
  keep?: Readonly<Record<string, string>>;
}) {
  const kept = Object.entries(keep).filter(([name, value]) => name !== "q" && value);
  const clear = new URLSearchParams(kept);
  const clearHref = clear.size ? `/app/people?${clear.toString()}` : "/app/people";
  return (
    <form
      role="search"
      action="/app/people"
      method="get"
      className="flex flex-wrap items-center gap-2"
    >
      {kept.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label htmlFor="people-search" className="sr-only">
        Search by name or staff ID
      </label>
      <div className="relative min-w-0 flex-1 basis-60">
        <Search
          strokeWidth={1.75}
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted"
        />
        <Input
          id="people-search"
          type="search"
          name="q"
          defaultValue={query}
          maxLength={100}
          placeholder="Search by name or staff ID"
          className="h-10 rounded-lg pl-9 text-[15px]"
        />
      </div>
      <Button type="submit" variant="outline" className="h-10 rounded-lg">
        Search
      </Button>
      {query ? (
        <Button asChild variant="ghost" className="h-10 rounded-lg">
          <Link href={clearHref}>Clear</Link>
        </Button>
      ) : null}
    </form>
  );
}
