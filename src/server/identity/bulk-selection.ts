import "server-only";

import { z } from "zod";

import { selectionDigest } from "@/server/people/bulk";

import { MutationError } from "./mutate";

/**
 * The selection guard for bulk actions on the lists (slice U.2), as U.1's People bulk actions:
 *
 * - The server resolves the ticked ids against the caller's own reads (RLS and role scope: a line
 *   manager sees only their reportees). An id the caller can't read (another company's, outside
 *   their scope, or gone) refuses the request (MLLB2) rather than being dropped quietly.
 * - Every preview returns `selection { ids, count, digest }`; the confirm sends `expectedDigest`
 *   back, and the server resolves again and refuses with "The list changed since the preview"
 *   (MLLB3) when the set differs, so a confirm never acts on rows the preview didn't show.
 */

/** At most this many rows in one bulk approve, resend or cancel (owner decision). */
export const LIST_BULK_LIMIT = 500;
/** At most this many rows in one export. */
export const LIST_EXPORT_LIMIT = 5000;

export function idsSchema(limit: number, noun = "rows") {
  return z
    .array(z.uuid(`Select ${noun} from the list`))
    .min(1, `Select at least one of the ${noun}`)
    .max(limit, `Select ${limit.toLocaleString("en-NG")} ${noun} or fewer at a time`);
}

export const expectedDigestSchema = z
  .string("Preview the change first")
  .regex(/^[0-9a-f]{64}$/, "Preview the change first");

/** The rows a preview covers: the ids it resolved, how many, and their digest. */
export interface PreviewedSet {
  ids: string[];
  count: number;
  digest: string;
}

export function previewedSet(ids: readonly string[]): PreviewedSet {
  const distinct = [...new Set(ids)];
  return { ids: distinct, count: distinct.length, digest: selectionDigest(distinct) };
}

export const LIST_CHANGED = "The list changed since the preview. Review it again.";

/** The selection now resolves to other rows than the preview showed (MLLB3). */
export class ListChanged extends MutationError {
  override name = "ListChanged";
  readonly refusal = "MLLB3";
  constructor() {
    super("invalid", LIST_CHANGED, { selection: LIST_CHANGED });
  }
}

export const NOT_IN_LIST =
  "Some of the rows selected aren't in your list. Reload the page and select again.";

/** Some ids sent aren't rows the caller can read (MLLB2). */
export class NotInList extends MutationError {
  override name = "NotInList";
  readonly refusal = "MLLB2";
  constructor() {
    super("invalid", NOT_IN_LIST, { selection: NOT_IN_LIST });
  }
}

/**
 * The ids sent, each one a row the caller can read (`visible`), distinct and in the order sent.
 * Refuses (MLLB2) when any isn't.
 */
export function resolveSelection(sent: readonly string[], visible: ReadonlySet<string>): string[] {
  const ids = [...new Set(sent.map((id) => id.toLowerCase()))];
  if (ids.some((id) => !visible.has(id))) throw new NotInList();
  return ids;
}

/** The confirm's ids, resolved again: refused (MLLB3) unless they are the preview's set. */
export function confirmSelection(
  sent: readonly string[],
  visible: ReadonlySet<string>,
  expectedDigest: string,
): string[] {
  let ids: string[];
  try {
    ids = resolveSelection(sent, visible);
  } catch (error) {
    if (error instanceof NotInList) throw new ListChanged();
    throw error;
  }
  if (selectionDigest(ids) !== expectedDigest) throw new ListChanged();
  return ids;
}

/** A lower-cased set, for comparing ids from the database with ids from a form. */
export function idSet(ids: Iterable<string>): Set<string> {
  return new Set([...ids].map((id) => id.toLowerCase()));
}
