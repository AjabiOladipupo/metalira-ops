import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { PII_FIELDS, type PiiField } from "@/lib/mask";
import type { Role } from "@/lib/roles";
import { decryptPii, type PiiCiphertext } from "@/server/crypto/pii";
import { logAuditEvent } from "@/server/identity/audit";
import type { Database } from "@/types/db";

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

/** The caller's role may not reveal this field. */
export class PiiAccessError extends Error {
  override name = "PiiAccessError";
  constructor(readonly field: PiiField) {
    super("Your role can't see this in full.");
  }
}

export interface RevealPiiInput {
  /** The signed-in user's own client, so `log_audit` records them as the actor. */
  supabase: SupabaseClient<Database>;
  organisationId: string;
  /** The caller's role in `organisationId`, from the session (never from the request). */
  role: Role;
  field: PiiField;
  /** The table the value belongs to, for example `workers`. */
  entity: string;
  entityId: string;
  /** The `_enc` column value as read from the database. */
  value: PiiCiphertext | null;
  reason?: string | null;
}

/**
 * Decrypts one field for a permitted role and writes a `pii.reveal` audit row (field and record
 * only, never the value). The plaintext is returned only after the audit row is written, so a
 * reveal that cannot be audited does not happen. Returns null when nothing is on file.
 */
export async function revealPii(input: RevealPiiInput): Promise<string | null> {
  if (!canSeePii(input.role, input.field)) throw new PiiAccessError(input.field);
  if (input.value == null) return null;

  const plaintext = decryptPii(input.value);
  await logAuditEvent(input.supabase, {
    organisationId: input.organisationId,
    action: "pii.reveal",
    entity: input.entity,
    entityId: input.entityId,
    after: { field: input.field },
    reason: input.reason ?? null,
  });
  return plaintext;
}
