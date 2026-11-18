import { cn } from "@/lib/utils";

/**
 * Plain, server-renderable table.
 * - `align: "right"` (or `kind: "money" | "number"`) right-aligns with tabular figures.
 * - Selected rows are marked with the signal colour.
 * - Scrolls inside its own frame: sideways on narrow screens, and down once it is taller than the
 *   viewport, so the header row stays frozen while scrolling a long list. (A sticky header cannot
 *   follow the page scroll from inside a sideways-scrolling box, and the app's top bar does not
 *   stick, so the frame is the scroller.) The frame is at most the viewport height less 6rem for
 *   the page's own controls; `maxHeight` overrides it.
 */
export type Column<Row> = {
  key: string;
  header: string;
  kind?: "text" | "money" | "number";
  align?: "left" | "right";
  cell: (row: Row) => React.ReactNode;
  className?: string;
};

type DataTableProps<Row> = {
  columns: Column<Row>[];
  rows: Row[];
  getRowId: (row: Row) => string;
  selectedIds?: readonly string[];
  caption?: string;
  /** e.g. "24rem". Overrides the default frame height. */
  maxHeight?: string;
  empty?: React.ReactNode;
  className?: string;
};

function isRight<Row>(col: Column<Row>) {
  return col.align === "right" || col.kind === "money" || col.kind === "number";
}

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  selectedIds = [],
  caption,
  maxHeight,
  empty,
  className,
}: DataTableProps<Row>) {
  return (
    <div
      data-slot="data-table"
      className={cn(
        "max-h-[max(20rem,calc(100dvh-6rem))] overflow-auto rounded-lg border border-line print:max-h-none print:overflow-visible",
        className,
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="w-full border-collapse text-sm text-foreground">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {/* The rule under the header is an inset line, not a border: collapsed borders stay
            behind when the header row sticks. */}
        <thead className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_var(--line)]">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  "px-3 py-2.5 font-semibold whitespace-nowrap",
                  isRight(col) ? "text-right tabular-nums" : "text-left",
                  col.className,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length} className="p-0">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = getRowId(row);
              const selected = selectedIds.includes(id);
              return (
                <tr
                  key={id}
                  aria-selected={selectedIds.length > 0 ? selected : undefined}
                  className={cn(
                    "border-b border-line last:border-b-0",
                    selected && "bg-surface shadow-[inset_3px_0_0_var(--signal)]",
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-3 whitespace-nowrap",
                        isRight(col) && "text-right tabular-nums",
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
