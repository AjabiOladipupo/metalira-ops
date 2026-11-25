"use client";

import { useState, useTransition } from "react";

import { SelectionBar, useRowSelection, type RowSelectionValue } from "@/components/row-selection";
import { Button } from "@/components/ui/button";

/**
 * "Export selected to CSV" for a list (slice U.2), with the shared row selection
 * (src/components/row-selection.tsx). POSTs the ticked ids to the route handler /app/export,
 * which checks the caller, builds the file on the server in their scope and sends it as a
 * no-store attachment; the browser saves it. `params` names the list and anything it needs (the
 * pay period, the run, the client).
 *
 * `<ListSelectionBar params noun>{(ids, clear) => extra actions}</ListSelectionBar>` puts the
 * export (and any other actions) in the list's action bar.
 */

export type ExportParams = { list: string } & Record<string, string>;

/** The ticked ids; "all matching" means every row on the list (these lists show every row). */
export function selectedIds(value: RowSelectionValue, rowIds: readonly string[]): string[] {
  return value.mode === "ids" ? [...value.ids] : [...rowIds];
}

async function saveFile(response: Response, fallback: string): Promise<number> {
  const count = Number(response.headers.get("x-export-count") ?? "0");
  const name =
    /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return count;
}

export function ExportSelectedButton({
  params,
  ids,
  noun,
  onDone,
}: {
  params: ExportParams;
  ids: readonly string[];
  noun: { one: string; many: string };
  onDone: (message: string) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 rounded-lg lg:h-9"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            let response: Response;
            try {
              response = await fetch("/app/export", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...params, ids }),
              });
            } catch {
              setError("The file couldn't be made. Try again in a minute.");
              return;
            }
            if (!response.ok) {
              setError((await response.text()) || "The file couldn't be made.");
              return;
            }
            const count = await saveFile(response, `${params.list}.csv`);
            onDone(
              `Exported ${count.toLocaleString("en-NG")} ${count === 1 ? noun.one : noun.many}.`,
            );
          })
        }
      >
        {pending ? "Exporting…" : "Export CSV"}
      </Button>
      {error ? (
        <p role="alert" className="m-0 w-full text-sm font-medium">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The action bar with "Export CSV", plus a live line for the result. */
export function ListSelectionBar({
  params,
  noun,
  label = "Bulk actions",
  children,
}: {
  params: ExportParams;
  noun: { one: string; many: string };
  label?: string;
  /** Other actions for the ticked ids, before the export. */
  children?: (ids: string[], done: (message: string) => void) => React.ReactNode;
}) {
  const { rowIds } = useRowSelection();
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <SelectionBar label={label}>
        {(value, clear) => {
          const ids = selectedIds(value, rowIds);
          const done = (message: string) => {
            setNotice(message);
            clear();
          };
          return (
            <>
              {children?.(ids, done)}
              <ExportSelectedButton params={params} ids={ids} noun={noun} onDone={setNotice} />
            </>
          );
        }}
      </SelectionBar>
      {/* One live region, kept in the page and hidden while empty, so the result is read out. */}
      <p
        role="status"
        data-testid="list-notice"
        className="m-0 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm empty:hidden"
      >
        {notice ?? ""}
      </p>
    </>
  );
}
