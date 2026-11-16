import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { normaliseKey } from "@/lib/observability/scrub";
import type { Database, Json } from "@/types/db";

/**
 * App-level audit events: things that are not a row change, such as revealing personal data
 * (`pii.reveal`) or exporting a payroll file. Row changes are logged by the database itself
 * (private.audit_row_change triggers, same transaction), so never log those here.
 *
 * Mirrors the checks in private.log_audit_impl so a bad event fails before the round trip.
 */
export const auditEventSchema = z.object({
  organisationId: z.uuid(),
  action: z
    .string()
    .max(100)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Audit action must look like module.event")
    .refine(
      (value) => !/\.(insert|update|delete)$/.test(value),
      "Row-change actions are written by triggers only",
    ),
  entity: z
    .string()
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, "Audit entity must be a lower-case name"),
  entityId: z.uuid().nullish(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().trim().max(1000).nullish(),
});

export type AuditEvent = z.input<typeof auditEventSchema>;

/** Anywhere in the normalised key: credentials and column-encrypted personal data. */
const SECRET_ANYWHERE = /(_enc$|password|secret)/;

/**
 * Whole `_`-separated parts of the normalised key: personal data in plain text (NIN, BVN, RSA
 * PIN, bank account numbers) and credentials. A decrypted value passed in for `pii.reveal`
 * must never reach the log.
 */
const SECRET_PART =
  /(^|_)(nin|bvn|pin|pin_hash|rsa_pin|passwd|passcode|token|token_hash|api_key|apikey|account_number|account_no|bank_account|nuban|otp)(_|$)/;

/**
 * True when a key is never written to the log, at any depth (rule 9). The key is normalised
 * as for Sentry (`rsaPin` and `rsa-pin` become `rsa_pin`). The database applies the same list
 * (private.audit_secret_key); keep the two in step.
 */
export function isAuditSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  return SECRET_ANYWHERE.test(k) || SECRET_PART.test(k);
}

/** Copy of `value` with secret keys removed. The database redacts too; this is belt and braces. */
export function redactForAudit(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    return typeof value === "number" || typeof value === "string" || typeof value === "boolean"
      ? value
      : null;
  }
  if (Array.isArray(value)) return value.map((item) => redactForAudit(item) ?? null);
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isAuditSecretKey(key)) continue;
    const redacted = redactForAudit(item);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

/**
 * Writes one app-level event through public.log_audit, as the signed-in user. The database
 * sets the actor and time itself and refuses callers who are not managers in the organisation.
 */
export async function logAuditEvent(
  supabase: SupabaseClient<Database>,
  event: AuditEvent,
): Promise<string> {
  const e = auditEventSchema.parse(event);
  const { data, error } = await supabase.rpc("log_audit", {
    p_organisation_id: e.organisationId,
    p_action: e.action,
    p_entity: e.entity,
    p_entity_id: e.entityId ?? undefined,
    p_before: redactForAudit(e.before),
    p_after: redactForAudit(e.after),
    p_reason: e.reason ?? undefined,
  });
  if (error) throw new Error(`Could not write the audit event: ${error.message}`);
  return data;
}
