import { StatusDot } from "@/components/status";
import { formatNaira } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Made-up figures for the landing page card. Money is kobo, formatted at the edge. */
const TILES: { label: string; value: string; emphasis?: boolean }[] = [
  { label: "Billed", value: formatNaira(1_430_250_000n, { whole: true }) },
  { label: "Labour cost", value: "67.2%" },
  { label: "On shift now", value: "118" },
  { label: "Not yet billed", value: formatNaira(341_800_000n, { whole: true }), emphasis: true },
];

const SITES = [
  { name: "Apapa Warehouse 3", margin: "−1.8%" },
  { name: "Lekki Estate Gate B", margin: "18.2%" },
  { name: "Ikeja Retail Park", margin: "34.5%" },
];

/**
 * The prototype's sample dashboard card: a month across all sites, clearly labelled as sample
 * data so nobody reads it as a customer's figures.
 */
export function SampleDashboard() {
  return (
    <figure
      aria-label="Sample dashboard with made-up figures"
      className="m-0 flex flex-col gap-4 rounded-lg border border-line bg-background p-4 sm:p-5 lg:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="type-label text-fg-muted">October · all sites</span>
          <span className="rounded-sm border border-line px-1.5 py-0.5 text-xs font-medium text-fg-muted">
            Sample data
          </span>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[13px]">
          <StatusDot tone="done" />
          Payroll ready
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-6">
        <dl className="m-0 grid grid-cols-2 gap-2.5">
          {TILES.map((tile) => (
            <div
              key={tile.label}
              className={cn(
                "flex min-w-0 flex-col gap-1 rounded-lg p-3 sm:p-3.5",
                tile.emphasis ? "border-[1.5px] border-foreground" : "bg-surface",
              )}
            >
              <dt className={cn("text-[13px]", !tile.emphasis && "text-fg-muted")}>{tile.label}</dt>
              <dd className="m-0 font-display text-[20px] leading-tight font-bold tabular-nums sm:text-[25px] xl:text-[28px]">
                {tile.value}
              </dd>
            </div>
          ))}
        </dl>
        <table className="w-full border-collapse self-start text-sm">
          <caption className="sr-only">Margin by site</caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="py-2 type-label font-medium text-fg-muted">
                Site
              </th>
              <th scope="col" className="py-2 text-right type-label font-medium text-fg-muted">
                Margin
              </th>
            </tr>
          </thead>
          <tbody>
            {SITES.map((site, i) => (
              <tr key={site.name} className={cn(i < SITES.length - 1 && "border-b border-line")}>
                <td className="py-2.5">{site.name}</td>
                <td className="py-2.5 text-right font-semibold tabular-nums">{site.margin}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
