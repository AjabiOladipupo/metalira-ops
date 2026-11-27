import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import type { SiteRow } from "@/server/sites/sites-data";

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;

function OfficeStatus({ office }: { office: SiteRow }) {
  if (office.status === "archived") return <Status tone="pending">Archived</Status>;
  if (office.needsDetails) return <Status tone="action">Needs details</Status>;
  return <Status tone="done">Ready</Status>;
}

/**
 * Settings > Company > Head office (slice 6.11): the company's own offices, where staff who don't
 * work at a client's site are mapped. Each opens its page to set the address, geofence and
 * checkpoints; "Add a branch office" adds another. People mapped here are overhead.
 */
export function OfficesCard({
  offices,
  mapped,
  canEdit,
}: {
  offices: readonly SiteRow[];
  /** People mapped to each office today, by site id. */
  mapped: ReadonlyMap<string, number>;
  canEdit: boolean;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="head-office-card">
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {offices.map((office) => {
          const details = [
            office.address ? office.address.split("\n")[0] : "No address",
            office.geofence === null ? "no geofence" : "geofence set",
            people(mapped.get(office.id) ?? 0),
          ].join(" · ");
          return (
            <li key={office.id}>
              <Link
                href={`/app/settings/offices/${office.id}`}
                className="flex items-center gap-4 rounded-xl border border-line p-4 text-foreground no-underline hover:bg-surface sm:p-5"
                data-testid="office-row"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-base font-semibold break-words">{office.name}</span>
                    <OfficeStatus office={office} />
                  </span>
                  <span className="text-sm break-words text-fg-muted">{details}</span>
                </span>
                <ChevronRight
                  strokeWidth={1.75}
                  className="size-5 shrink-0 text-fg-muted"
                  aria-hidden
                />
              </Link>
            </li>
          );
        })}
      </ul>
      {canEdit ? (
        <div>
          <Button asChild variant="outline" className="h-11 px-4">
            <Link href="/app/settings/offices/new">Add a branch office</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
