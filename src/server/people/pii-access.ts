import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { PII_FIELDS, type PiiField } from "@/lib/mask";
import type { Role } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import { decryptPii, type PiiCiphertext } from "@/server/crypto/pii";
import { logAuditEvent } from "@/server/identity/audit";
import { getSession } from "@/server/identity/session";

export { PII_FIELDS, type PiiField };

/**
 * Who may see personal data unmasked (owner decision 7): owner and hr see every field, finance
 * sees bank account numbers only, and every other role (admin, ops_manager, line_manager,
 * worker, client_approver) sees masked values. Unlisted roles see nothing, so a role added to
 * the enum later is masked until it is added here on purpose.
 */
const UNMASKED: Readonly<Partial<Record<Role, readonly PiiField[]>>> = {
  owner: PII_FIELDS,
  hr: PII_FIELDS,
  finance: ["bank_account"],
};

/** True when `role` may reveal `field` in full. Lists still show masked values for everyone. */
export function canSeePii(role: Role, field: PiiField): boolean {
  return UNMASKED[role]?.includes(field) ?? false;
}

/**
 * Where each field is stored, per table. This is the only place a reveal can read from, so a
 * caller cannot point it at another column. Bank-detail change requests hold a bank account
 * only.
 */
const PII_COLUMNS = {
  workers: { nin: "nin_enc", bank_account: "bank_account_enc", rsa_pin: "rsa_pin_enc" },
  bank_detail_changes: { bank_account: "bank_account_enc" },
} as const satisfies Record<string, Partial<Record<PiiField, `${string}_enc`>>>;

export type PiiEntity = keyof typeof PII_COLUMNS;
export const PII_ENTITIES = Object.keys(PII_COLUMNS) as [PiiEntity, ...PiiEntity[]];

function piiColumn(entity: PiiEntity, field: PiiField): string | undefined {
  const columns: Partial<Record<PiiField, string>> = PII_COLUMNS[entity];
  return columns[field];
}

/** The caller is not a member of the organisation, or their role may not reveal this field. */
export class PiiAccessError extends Error {
  override name = "PiiAccessError";
  constructor(readonly field: PiiField) {
    super("Your role can't see this in full.");
  }
}

/** No record with that id in that organisation is visible to the caller. */
export class PiiRecordNotFoundError extends Error {
  override name = "PiiRecordNotFoundError";
  constructor() {
    super("That record wasn't found.");
  }
}

/**
 * What a reveal request may carry. Only the target is named here: the role comes from the
 * session and the ciphertext from the database, so neither can be supplied by the caller.
 */
export const revealPiiInputSchema = z
  .object({
    organisationId: z.uuid(),
    field: z.enum(PII_FIELDS),
    entity: z.enum(PII_ENTITIES),
    entityId: z.uuid(),
    reason: z.string().trim().max(1000).nullish(),
  })
  .refine((input) => piiColumn(input.entity, input.field) !== undefined, {
    message: "That record doesn't hold this field.",
    path: ["field"],
  });

export type RevealPiiInput = z.input<typeof revealPiiInputSchema>;

/**
 * Decrypts one field of one record for the signed-in user and writes a `pii.reveal` audit row
 * (field and record only, never the value).
 *
 * Everything that decides what is shown is resolved here, not taken from the caller: the role
 * is the user's own membership in `organisationId`; the ciphertext is read with the user's own
 * RLS client from `entity` where `id = entityId` and `organisation_id = organisationId`; and it
 * is decrypted under that same organisation, table, column and row, so the audited record is
 * the one the value came from. The plaintext is returned only after the audit row is written,
 * so a reveal that cannot be audited does not happen. Returns null when nothing is on file.
 *
 * Reads cookies: call it from a Server Function or Route Handler.
 */
export async function revealPii(input: RevealPiiInput): Promise<string | null> {
  const { organisationId, field, entity, entityId, reason } = revealPiiInputSchema.parse(input);
  const column = piiColumn(entity, field);
  if (!column) throw new PiiAccessError(field); // unreachable: the schema refines on this

  const session = await getSession();
  const membership = session?.memberships.find((m) => m.organisationId === organisationId);
  if (!membership || !canSeePii(membership.role, field)) throw new PiiAccessError(field);

  const supabase = await createServerSupabase();
  // The table name comes from PII_COLUMNS, and `bank_detail_changes` arrives in slice 1.7, so
  // the read goes through an untyped view of the same client (same session, same RLS).
  const { data, error } = await (supabase as unknown as SupabaseClient)
    .from(entity)
    .select(column)
    .eq("id", entityId)
    .eq("organisation_id", organisationId)
    .maybeSingle<Record<string, PiiCiphertext | null>>();
  if (error) throw new Error(`Could not read the record: ${error.message}`);
  if (!data) throw new PiiRecordNotFoundError();

  const value = data[column];
  if (value == null) return null;

  const plaintext = decryptPii(value, { organisationId, table: entity, column, rowId: entityId });
  await logAuditEvent(supabase, {
    organisationId,
    action: "pii.reveal",
    entity,
    entityId,
    after: { field },
    reason: reason ?? null,
  });
  return plaintext;
}
