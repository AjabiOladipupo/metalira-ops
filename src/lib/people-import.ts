/**
 * Shared by the people import screens (slice 1.8) and their Server Actions. Browser-safe.
 */

/** Private Storage bucket for uploads, at {organisation_id}/{batch_id}.{csv,xlsx}. */
export const IMPORTS_BUCKET = "imports";

/** The two places the import lives: its own page, and step 5 of company setup. */
export const IMPORT_PATHS = ["/app/people/import", "/app/setup/employees"] as const;

export type ImportPath = (typeof IMPORT_PATHS)[number];

/** What an import form action returns to `useActionState`. */
export type ImportActionState = { ok: boolean; message: string } | null;

/** Where the template and the problems list download from. */
export const IMPORT_TEMPLATE_HREF = "/app/people/import/template";

export function importProblemsHref(batchId: string): string {
  return `/app/people/import/${batchId}/problems`;
}

/** The review address for a batch on either screen. */
export function importReviewHref(path: ImportPath, batchId: string): string {
  return `${path}?batch=${encodeURIComponent(batchId)}`;
}
