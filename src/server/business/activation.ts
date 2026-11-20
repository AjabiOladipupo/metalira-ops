import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { activationIssuesFromDb } from "@/lib/activation";
import { formatDate } from "@/lib/dates";
import { sendContractWelcomeEmail } from "@/server/email/contract-welcome";
import { logAuditEvent } from "@/server/identity/audit";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

import { CONTRACT_EDITORS } from "./contracts";

/**
 * Activating and ending a contract (slice 2.7), as `mutate()` specs. Both are one SQL function
 * each, run with the signed-in user's own client: `activate_contract` and `end_contract` check
 * the caller's role in the database (owner, admin, ops_manager, trusted sessions only), lock the
 * contract row, write the posts, roster requirements and rate card closures in one transaction
 * and log `contract.activated` / `contract.ended`. Posts and requirements have no write grants.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const optionalDate = z
  .string()
  .trim()
  .max(10)
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || ISO_DATE.test(v), "Choose a date");

/** A ticked checkbox ("on"), or a boolean from the registry. */
const checkbox = z
  .union([z.boolean(), z.string().max(5)])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

export const activateContractSchema = z.object({
  contractId: z.uuid("Choose a contract"),
  goLiveDate: optionalDate,
  sendWelcome: checkbox,
});

export const endContractSchema = z.object({
  contractId: z.uuid("Choose a contract"),
  endDate: z.string().trim().regex(ISO_DATE, "Choose the last day of service"),
  reason: z
    .string()
    .trim()
    .min(1, "Say why the contract is ending")
    .max(500, "500 characters or fewer")
    .regex(/^[^\p{Cc}<>]*$/u, "Plain text only"),
});

export interface ActivationResult {
  contractId: string;
  status: string;
  goLiveDate: string | null;
  activatedNow: boolean;
  sendWelcome: boolean;
  posts: number;
  requirements: number;
}

export interface EndResult {
  contractId: string;
  endDate: string;
  changed: boolean;
  postsClosed: number;
  requirementsClosed: number;
  requirementsCancelled: number;
  rateCardsClosed: number;
  rateCardsCancelled: number;
}

/** Database refusals in plain English; an activation refusal lists every missing item by code. */
export function fromActivationDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
  if (error.code === "P0002") {
    throw new MutationError("invalid", "That contract wasn't found. Reload the page.");
  }
  if (/^MLCT\d$/.test(error.code)) {
    const issues = activationIssuesFromDb(error);
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      fieldErrors[issue.code] = fieldErrors[issue.code]
        ? `${fieldErrors[issue.code]} ${issue.message}`
        : issue.message;
    }
    throw new MutationError(
      "invalid",
      issues.length > 1
        ? `This contract can't go live yet: ${issues.length} things to fix.`
        : "This contract can't go live yet.",
      fieldErrors,
    );
  }
  if (/^MLCE\d$/.test(error.code)) {
    const field = error.code === "MLCE3" ? "reason" : "endDate";
    throw new MutationError("invalid", error.message, { [field]: error.message });
  }
  if (/^ML(RC|PO|CO)\d$/.test(error.code)) {
    throw new MutationError("invalid", error.message);
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export const activateContractSpec: MutationSpec<typeof activateContractSchema, ActivationResult> = {
  schema: activateContractSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("activate_contract", {
      p_organisation_id: organisationId,
      p_contract_id: data.contractId,
      ...(data.goLiveDate ? { p_go_live_date: data.goLiveDate } : {}),
      p_send_welcome: data.sendWelcome,
    });
    if (error) fromActivationDbError(error);
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      contractId: data.contractId,
      status: String(r.status ?? ""),
      goLiveDate: typeof r.go_live_date === "string" ? r.go_live_date : null,
      activatedNow: r.activated_now === true,
      sendWelcome: r.send_welcome === true,
      posts: num(r.posts),
      requirements: num(r.requirements),
    };
  },
};

export function activateContract(input: unknown) {
  return mutate(activateContractSpec, input);
}

export const endContractSpec: MutationSpec<typeof endContractSchema, EndResult> = {
  schema: endContractSchema,
  roles: CONTRACT_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: result, error } = await supabase.rpc("end_contract", {
      p_organisation_id: organisationId,
      p_contract_id: data.contractId,
      p_end_date: data.endDate,
      p_reason: data.reason,
    });
    if (error) fromActivationDbError(error);
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      contractId: data.contractId,
      endDate: data.endDate,
      changed: r.changed === true,
      postsClosed: num(r.posts_closed),
      requirementsClosed: num(r.requirements_closed),
      requirementsCancelled: num(r.requirements_cancelled),
      rateCardsClosed: num(r.rate_cards_closed),
      rateCardsCancelled: num(r.rate_cards_cancelled),
    };
  },
};

export function endContract(input: unknown) {
  return mutate(endContractSpec, input);
}

// ---------------------------------------------------------------------------
// Welcome email
// ---------------------------------------------------------------------------

export interface WelcomeRecipient {
  contactId: string;
  name: string;
  email: string;
}

export interface WelcomePayload {
  organisationId: string;
  contractId: string;
  organisationName: string | null;
  contractName: string;
  reference: string;
  sites: string[];
  goLiveDate: string;
  invoiceEmail: string | null;
  recipients: WelcomeRecipient[];
}

/**
 * The client's primary ops and billing contacts, one email each (the same address once).
 * Exported for tests.
 */
export function welcomeRecipients(
  contacts: readonly {
    id: string;
    name: string;
    email: string;
    role: string;
    is_primary: boolean;
  }[],
): WelcomeRecipient[] {
  const seen = new Set<string>();
  const out: WelcomeRecipient[] = [];
  for (const role of ["ops", "billing"]) {
    const contact = contacts.find((c) => c.role === role && c.is_primary);
    if (!contact) continue;
    const email = contact.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ contactId: contact.id, name: contact.name, email });
  }
  return out;
}

/**
 * What the welcome email needs, read with the user's own client before the response (contacts
 * are readable by every role that may activate). Null when there is nobody to write to.
 */
export async function loadWelcomePayload(
  supabase: SupabaseClient<Database>,
  organisationId: string,
  contractId: string,
): Promise<WelcomePayload | null> {
  const [contract, org] = await Promise.all([
    supabase
      .from("contracts")
      .select("id, client_id, name, reference, go_live_date, contract_sites(sites(name))")
      .eq("organisation_id", organisationId)
      .eq("id", contractId)
      .maybeSingle(),
    supabase
      .from("organisations")
      .select("name, trading_name, invoice_email")
      .eq("id", organisationId)
      .maybeSingle(),
  ]);
  if (contract.error || !contract.data?.go_live_date) return null;
  const contacts = await supabase
    .from("client_contacts")
    .select("id, name, email, role, is_primary")
    .eq("organisation_id", organisationId)
    .eq("client_id", contract.data.client_id)
    .eq("status", "active");
  if (contacts.error) return null;
  const wanted = welcomeRecipients(contacts.data ?? []);
  if (wanted.length === 0) return null;
  // The company's daily cap and once a day per contact (private.contract_welcome_allowed).
  const allowed = await supabase.rpc("contract_welcome_allowed", {
    p_organisation_id: organisationId,
    p_contract_id: contractId,
    p_contact_ids: wanted.map((r) => r.contactId),
  });
  if (allowed.error) return null;
  const allowedIds = new Set((allowed.data ?? []) as string[]);
  const recipients = wanted.filter((r) => allowedIds.has(r.contactId));
  if (recipients.length < wanted.length) {
    // Counts only: never the addresses.
    console.warn(
      `contract.welcome_held: ${wanted.length - recipients.length} of ${wanted.length} over the daily limit or already welcomed today`,
    );
  }
  if (recipients.length === 0) return null;
  return {
    organisationId,
    contractId,
    organisationName: org.data?.trading_name ?? org.data?.name ?? null,
    contractName: contract.data.name,
    reference: contract.data.reference,
    sites: (contract.data.contract_sites ?? [])
      .map((cs) => cs.sites?.name)
      .filter((n): n is string => typeof n === "string")
      .sort((a, b) => a.localeCompare(b)),
    goLiveDate: formatDate(contract.data.go_live_date),
    invoiceEmail: org.data?.invoice_email ?? null,
    recipients,
  };
}

/**
 * Sends the welcome email to each recipient, then logs `contract.welcome_sent` with the count
 * (never the addresses). Failures are logged without the address and never thrown: activation
 * has already happened.
 */
export async function sendContractWelcome(
  supabase: SupabaseClient<Database>,
  payload: WelcomePayload,
): Promise<void> {
  let sent = 0;
  const sentTo: string[] = [];
  for (const recipient of payload.recipients) {
    try {
      await sendContractWelcomeEmail({
        to: recipient.email,
        contractId: payload.contractId,
        contactId: recipient.contactId,
        organisationName: payload.organisationName,
        contactName: recipient.name,
        contractName: payload.contractName,
        reference: payload.reference,
        sites: payload.sites,
        goLiveDate: payload.goLiveDate,
        invoiceEmail: payload.invoiceEmail,
      });
      sent += 1;
      sentTo.push(recipient.contactId);
    } catch (error) {
      console.error(
        "contract.welcome_failed:",
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }
  try {
    await logAuditEvent(supabase, {
      organisationId: payload.organisationId,
      action: "contract.welcome_sent",
      entity: "contracts",
      entityId: payload.contractId,
      // Contact ids, never addresses: they feed the daily cap and once-a-day rule.
      after: { recipients: sent, contact_ids: sentTo },
    });
  } catch (error) {
    console.error(
      "contract.welcome_audit_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
  }
}
