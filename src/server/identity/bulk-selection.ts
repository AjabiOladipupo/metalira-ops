import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { derivePiiSubkey } from "@/server/crypto/pii";

import { MutationError } from "./mutate";

/**
 * The selection guard for bulk actions on the lists (slice U.2; security review M1):
 *
 * - The server resolves the ticked ids against the caller's own reads (RLS and role scope: a line
 *   manager sees only their reportees). An id the caller can't read (another company's, outside
 *   their scope, or gone) refuses the request (MLLB2) rather than being dropped quietly.
 * - Every preview is a dry run that says which ids it WOULD act on (`act`). It returns
 *   `selection { ids, count, act, digest }`, where the digest is an HMAC-SHA256, keyed with a
 *   server-only secret (derived from the personal data key, purpose `bulk-selection-digest`),
 *   over the action, the signed-in user, the organisation, the ticked ids and the act set.
 * - The digest also signs when the preview was made, and travels as `<issued-at ms>.<hmac hex>`.
 *   A confirm more than 15 minutes after its preview is refused with "The preview has expired"
 *   (security review of U.3, L2), so an old screen can't act on a stale picture.
 * - The confirm sends the ticked ids, the act set and the digest back. The server resolves the
 *   ticked ids again and checks the digest (constant time); anything else is refused with "The
 *   list changed since the preview" (MLLB3). Only the act set is passed to the database, so a
 *   row the preview skipped is never acted on, even if it became clean since: it is reported as
 *   "Changed since the preview" instead.
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
  .regex(/^\d{1,15}\.[0-9a-f]{64}$/, "Preview the change first");

/** How long a preview may be confirmed for. */
export const PREVIEW_TTL_MS = 15 * 60 * 1000;

/** The act set the preview signed: the ids it said it would act on. */
export function actIdsSchema(limit: number) {
  return z.array(z.uuid("Preview the change first")).min(1, "Nothing to do").max(limit);
}

/** Whose preview this is: the digest is bound to the action, the user and the organisation. */
export interface PreviewScope {
  action: string;
  userId: string;
  organisationId: string;
}

/** The rows a preview covers: the ticked ids, how many, the ids it would act on, the digest. */
export interface PreviewedSet {
  ids: string[];
  count: number;
  act: string[];
  /** `<issued-at ms>.<hmac hex>`: send it back unchanged with the confirm. */
  digest: string;
}

function sortedDistinct(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

/**
 * HMAC-SHA256 (hex) over the scope, the ticked ids, the act set (each sorted and distinct) and
 * the time the preview was made.
 */
export function previewDigest(
  scope: PreviewScope,
  ids: readonly string[],
  act: readonly string[],
  issuedAt: number,
): string {
  const payload = JSON.stringify([
    "metalira-ops/bulk-preview/v2",
    issuedAt,
    scope.action,
    scope.userId.toLowerCase(),
    scope.organisationId.toLowerCase(),
    sortedDistinct(ids),
    sortedDistinct(act),
  ]);
  return createHmac("sha256", derivePiiSubkey("bulk-selection-digest"))
    .update(payload, "utf8")
    .digest("hex");
}

export function previewedSet(
  scope: PreviewScope,
  ids: readonly string[],
  act: readonly string[],
  now: number = Date.now(),
): PreviewedSet {
  const distinct = [...new Set(ids.map((id) => id.toLowerCase()))];
  const acting = [...new Set(act.map((id) => id.toLowerCase()))];
  return {
    ids: distinct,
    count: distinct.length,
    act: acting,
    digest: `${now}.${previewDigest(scope, distinct, acting, now)}`,
  };
}

export const LIST_CHANGED = "The list changed since the preview. Review it again.";

/** The selection now resolves to other rows than the preview showed (MLLB3). */
export class ListChanged extends MutationError {
  override name = "ListChanged";
  readonly refusal = "MLLB3";
  constructor(message: string = LIST_CHANGED) {
    super("invalid", message, { selection: message });
  }
}

export const NOT_IN_LIST =
  "Some of the rows selected aren't in your list. Reload the page and select again.";

export const PREVIEW_EXPIRED = "The preview has expired. Review it again.";

/** The confirm came more than 15 minutes after its preview (MLLB3, preview again). */
export class PreviewExpired extends ListChanged {
  override name = "PreviewExpired";
  constructor() {
    super(PREVIEW_EXPIRED);
  }
}

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

/** What a confirm may do: the ticked ids, and the subset the preview said it would act on. */
export interface ConfirmedPlan {
  ids: string[];
  act: string[];
  /** Ticked ids the preview didn't act on: skipped as "Changed since the preview". */
  rest: string[];
}

/**
 * The confirm's ids, resolved again, and the act set checked against the preview's digest.
 * Refused (MLLB3) when a ticked id is no longer readable, the act set isn't within the ticked
 * ids, or the digest isn't the one the preview gave this user, company and action.
 */
export function confirmPlan(
  scope: PreviewScope,
  sent: readonly string[],
  visible: ReadonlySet<string>,
  sentAct: readonly string[],
  expectedDigest: string,
  now: number = Date.now(),
): ConfirmedPlan {
  let ids: string[];
  try {
    ids = resolveSelection(sent, visible);
  } catch (error) {
    if (error instanceof NotInList) throw new ListChanged();
    throw error;
  }
  const act = [...new Set(sentAct.map((id) => id.toLowerCase()))];
  const ticked = new Set(ids);
  if (act.some((id) => !ticked.has(id))) throw new ListChanged();
  const [issued, mac] = expectedDigest.split(".");
  const issuedAt = Number(issued);
  if (!mac || !Number.isSafeInteger(issuedAt)) throw new ListChanged();
  const expected = Buffer.from(previewDigest(scope, ids, act, issuedAt), "hex");
  const given = Buffer.from(mac, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ListChanged();
  }
  // Checked after the signature, so only a genuine preview's own time is trusted. A minute of
  // clock skew is allowed for a time slightly ahead.
  if (now - issuedAt > PREVIEW_TTL_MS || issuedAt - now > 60_000) throw new PreviewExpired();
  const acting = new Set(act);
  return { ids, act, rest: ids.filter((id) => !acting.has(id)) };
}

/** A lower-cased set, for comparing ids from the database with ids from a form. */
export function idSet(ids: Iterable<string>): Set<string> {
  return new Set([...ids].map((id) => id.toLowerCase()));
}
