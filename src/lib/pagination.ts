/**
 * Page-size choice and page maths for long lists (the People table). Pure, so the server page and
 * the client size picker agree, and unit-testable.
 */

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/** Cookie that remembers the People page size on this device. Not sensitive. */
export const PEOPLE_PAGE_SIZE_COOKIE = "people_page_size";

/** A page size from a URL or cookie value, or null when it is not one of the choices. */
export function parsePageSize(value: string | null | undefined): PageSize | null {
  if (!value || !/^\d{1,3}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : null;
}

/** A 1-based page number from a URL value; anything else is page 1. */
export function parsePage(value: string | null | undefined): number {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return 1;
  return Math.max(1, Number(value.trim()));
}

export interface PageWindow {
  /** The page shown, clamped to the last page. */
  page: number;
  pageCount: number;
  size: PageSize;
  total: number;
  /** Slice bounds: rows[from, to). */
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** Which rows a page shows. A page past the end shows the last page; an empty list is page 1 of 1. */
export function pageWindow(total: number, page: number, size: PageSize): PageWindow {
  const safeTotal = Math.max(0, Math.floor(total));
  const pageCount = Math.max(1, Math.ceil(safeTotal / size));
  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const from = (current - 1) * size;
  const to = Math.min(from + size, safeTotal);
  return {
    page: current,
    pageCount,
    size,
    total: safeTotal,
    from,
    to,
    hasPrevious: current > 1,
    hasNext: current < pageCount,
  };
}

/** "1–25 of 162", "0 of 0". Numbers first, en dash between the bounds. */
export function formatPageRange(pages: Pick<PageWindow, "from" | "to" | "total">): string {
  const n = (v: number) => v.toLocaleString("en-NG");
  if (pages.total === 0) return "0 of 0";
  return `${n(pages.from + 1)}–${n(pages.to)} of ${n(pages.total)}`;
}
