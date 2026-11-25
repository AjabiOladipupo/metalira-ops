"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Row selection for lists (slice U.1; reused by the other lists in U.2).
 *
 * API:
 * - `<RowSelection rowIds matchingCount noun>` wraps a list. `rowIds` are the rows on the current
 *   page, `matchingCount` is every row matching the current filters across all pages, `noun`
 *   names a row ("employee"/"employees"). Give it a `key` that changes with the page and filters
 *   (for example the search string), so moving to another page or filter clears the selection.
 * - `<SelectAllCheckbox />` goes in the table header: it ticks every row on the page (and shows
 *   a mixed state for some). Once the page is ticked and more rows match, the bar offers
 *   "Select all N matching" across every page and the current filters.
 * - `<RowCheckbox rowId label />` goes in each row's first cell; `label` is read out ("Select
 *   Ada Obi"). Pair it with `selectableRowClass` on the table row (or rely on the table's
 *   `:has(:checked)` styling) so a ticked row shows the signal colour.
 * - `<SelectionBar>{(selection, clear) => actions}</SelectionBar>` appears once anything is
 *   ticked: "N selected", the actions the render function returns, and Clear. Sticky at the top
 *   of the list on wide screens, fixed to the bottom of the screen on a phone.
 * - `useRowSelection()` reads the same state anywhere inside (for example in a dialog).
 *
 * A selection is `{ mode: "ids", ids }` (the ticked rows) or `{ mode: "all", count }` (everyone
 * matching the filters; the server re-runs the filters, so the ids never travel). Native
 * checkboxes keep it keyboard and screen-reader friendly; the count is announced politely.
 */

export type RowSelectionValue =
  { mode: "ids"; ids: readonly string[] } | { mode: "all"; count: number };

interface RowSelectionState {
  rowIds: readonly string[];
  matchingCount: number;
  noun: { one: string; many: string };
  selected: ReadonlySet<string>;
  allMatching: boolean;
  /** How many rows the selection covers. */
  count: number;
  value: RowSelectionValue | null;
  isSelected: (id: string) => boolean;
  toggle: (id: string, on?: boolean) => void;
  togglePage: (on: boolean) => void;
  selectAllMatching: () => void;
  clear: () => void;
}

const SelectionContext = createContext<RowSelectionState | null>(null);

export function useRowSelection(): RowSelectionState {
  const state = useContext(SelectionContext);
  if (!state) throw new Error("useRowSelection must be used inside <RowSelection>.");
  return state;
}

/** Rows with a ticked box: the table's selected-row style (signal edge, surface fill). */
export const selectableRowClass =
  "has-[input[data-row-select]:checked]:bg-surface has-[input[data-row-select]:checked]:shadow-[inset_3px_0_0_var(--signal)]";

export function RowSelection({
  rowIds,
  matchingCount,
  noun = { one: "row", many: "rows" },
  children,
}: {
  rowIds: readonly string[];
  matchingCount: number;
  noun?: { one: string; many: string };
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [allMatching, setAllMatching] = useState(false);

  const toggle = useCallback((id: string, on?: boolean) => {
    setAllMatching(false);
    setSelected((current) => {
      const next = new Set(current);
      const want = on ?? !next.has(id);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const togglePage = useCallback(
    (on: boolean) => {
      setAllMatching(false);
      setSelected(on ? new Set(rowIds) : new Set());
    },
    [rowIds],
  );

  const selectAllMatching = useCallback(() => {
    setSelected(new Set(rowIds));
    setAllMatching(true);
  }, [rowIds]);

  const clear = useCallback(() => {
    setAllMatching(false);
    setSelected(new Set());
  }, []);

  const value = useMemo<RowSelectionValue | null>(() => {
    if (allMatching) return { mode: "all", count: matchingCount };
    if (selected.size === 0) return null;
    return { mode: "ids", ids: rowIds.filter((id) => selected.has(id)) };
  }, [allMatching, matchingCount, rowIds, selected]);

  const state = useMemo<RowSelectionState>(
    () => ({
      rowIds,
      matchingCount,
      noun,
      selected,
      allMatching,
      count: allMatching ? matchingCount : selected.size,
      value,
      isSelected: (id) => allMatching || selected.has(id),
      toggle,
      togglePage,
      selectAllMatching,
      clear,
    }),
    [
      rowIds,
      matchingCount,
      noun,
      selected,
      allMatching,
      value,
      toggle,
      togglePage,
      selectAllMatching,
      clear,
    ],
  );

  return <SelectionContext.Provider value={state}>{children}</SelectionContext.Provider>;
}

const BOX =
  "size-[18px] cursor-pointer rounded-[4px] border border-line accent-[var(--signal)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

/** The header box: ticks every row on this page; mixed when only some are ticked. */
export function SelectAllCheckbox({ label = "Select all on this page" }: { label?: string }) {
  const { rowIds, selected, allMatching, togglePage } = useRowSelection();
  const ref = useRef<HTMLInputElement>(null);
  const ticked = rowIds.filter((id) => selected.has(id)).length;
  const all = allMatching || (rowIds.length > 0 && ticked === rowIds.length);
  const some = !all && ticked > 0;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);
  return (
    <label className="-m-2 inline-flex size-11 items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        className={BOX}
        aria-label={label}
        checked={all}
        aria-checked={some ? "mixed" : all}
        disabled={rowIds.length === 0}
        onChange={(event) => togglePage(event.target.checked)}
      />
    </label>
  );
}

/** One row's box. The 44px label around it is the touch target. */
export function RowCheckbox({ rowId, label }: { rowId: string; label: string }) {
  const { isSelected, toggle } = useRowSelection();
  return (
    <label className="-m-2 inline-flex size-11 items-center justify-center">
      <input
        type="checkbox"
        data-row-select
        className={BOX}
        aria-label={label}
        checked={isSelected(rowId)}
        onChange={(event) => toggle(rowId, event.target.checked)}
      />
    </label>
  );
}

/**
 * The action bar, shown once anything is ticked. `children` renders the actions for the
 * current selection; `clear` empties it (call it after an action succeeds).
 */
export function SelectionBar({
  children,
  label = "Selection",
  className,
}: {
  children: (selection: RowSelectionValue, clear: () => void) => React.ReactNode;
  label?: string;
  className?: string;
}) {
  const {
    value,
    count,
    rowIds,
    selected,
    allMatching,
    matchingCount,
    noun,
    selectAllMatching,
    clear,
  } = useRowSelection();
  const pageTicked = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
  const offerAll = !allMatching && pageTicked && matchingCount > rowIds.length;
  const word = (n: number) => (n === 1 ? noun.one : noun.many);

  return (
    <>
      {/* Announced politely whenever the count changes; empty while nothing is ticked. */}
      <p role="status" aria-live="polite" className="sr-only">
        {value ? `${count.toLocaleString("en-NG")} selected` : ""}
      </p>
      {value ? (
        <div
          role="region"
          aria-label={label}
          data-testid="selection-bar"
          className={cn(
            // Phone: fixed to the bottom edge, full width, above the page. Wide: sticky above the list.
            "fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center gap-2 border-t border-line bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgb(0_0_0/0.08)]",
            "lg:sticky lg:top-2 lg:bottom-auto lg:rounded-xl lg:border lg:px-4 lg:py-2.5 lg:shadow-none",
            className,
          )}
        >
          <p className="m-0 mr-1 text-sm font-semibold tabular-nums">
            {count.toLocaleString("en-NG")} selected
            {allMatching ? (
              <span className="font-normal text-fg-muted"> · all {word(count)} matching</span>
            ) : null}
          </p>
          {offerAll ? (
            <Button
              type="button"
              variant="link"
              className="h-11 px-1 text-signal lg:h-9"
              onClick={selectAllMatching}
            >
              Select all {matchingCount.toLocaleString("en-NG")} matching
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 lg:justify-end">
            {children(value, clear)}
            <Button
              type="button"
              variant="ghost"
              className="h-11 rounded-lg lg:h-9"
              onClick={clear}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
