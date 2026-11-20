"use client";

import { useRouter } from "next/navigation";

/** The site picker in the roster header: changing it opens that site's roster for the week. */
export function SiteSelect({
  sites,
  value,
  week,
}: {
  sites: { id: string; label: string }[];
  value: string;
  week: string;
}) {
  const router = useRouter();
  return (
    <label className="flex max-w-full min-w-0">
      <span className="sr-only">Site</span>
      <select
        value={value}
        onChange={(e) => router.push(`/app/roster?site=${e.target.value}&week=${week}`)}
        className="h-10 max-w-full min-w-0 rounded-lg border border-line bg-background px-3 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
