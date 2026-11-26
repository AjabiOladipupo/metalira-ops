import "server-only";

import { createHash } from "node:crypto";

import { connection } from "next/server";

import { bankByCode } from "@/lib/banks";
import { CONSENT_NOTICES } from "@/lib/messages/consent";
import { isOnboardingRole, isOnboardingToken, type OnboardingRole } from "@/lib/self-onboarding";
import { encryptPiiForDb, type PiiContext } from "@/server/crypto/pii";
import { clientIp } from "@/server/identity/worker-sign-in";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Json } from "@/types/db";

import type { OnboardingDetails } from "./self-onboarding-schemas";

/**
 * Self-onboarding, the public side (slice U.4): the invite page at /onboard/[token] and what it
 * sends. The visitor is signed out (worker roles) or the invited manager, so the lookup and the
 * submission go through the secret-key client and functions only the server may call. Holding
 * the token (256 random bits, single use, 7 days) entitles the visitor to see the company name and
 * the role; the address stays on the server, which compares it. Errors are logged by code only;
 * nothing the visitor typed reaches a log.
 */

export type OnboardingView =
  | {
      state: "pending";
      inviteId: string;
      organisationId: string;
      organisationName: string;
      /** Server only: never rendered (the page shows the company and the role). */
      email: string;
      role: OnboardingRole;
      onPayroll: boolean;
      userId: string | null;
      expiresAt: string;
    }
  | {
      state: "submitted" | "approved" | "cancelled" | "expired";
      organisationName: string;
      role: OnboardingRole;
    }
  | { state: "invalid" | "unavailable" | "limited" };

function hash(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(`${kind}:${value.trim().toLowerCase()}`).digest("hex")}`;
}

/**
 * Counts one attempt (private.onboarding_attempt_allowed): a token's submits and email links (10
 * an hour), one network address's (30 an hour), and page views from one address (120 an hour).
 * Fails closed.
 */
export async function onboardingAttemptAllowed(
  subject: { kind: "submit"; token: string } | { kind: "view" },
  headers: { get(name: string): string | null },
): Promise<boolean> {
  const ip = clientIp(headers);
  const keys =
    subject.kind === "submit"
      ? [hash("submit", subject.token), ...(ip ? [hash("ip", ip)] : [])]
      : ip
        ? [hash("view", ip)]
        : [];
  // Local runs have no x-real-ip (Vercel always sets it): page views are then not counted.
  if (keys.length === 0) return true;
  try {
    const { data, error } = await createAdminSupabase().rpc("onboarding_attempt_allowed", {
      p_keys: keys,
    });
    if (error) throw new Error(error.code);
    return data === true;
  } catch (error) {
    console.error(
      "onboarding.attempt_limit_failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
}

export async function lookupOnboarding(
  token: string,
  { markOpened = false }: { markOpened?: boolean } = {},
): Promise<OnboardingView> {
  await connection();
  if (!isOnboardingToken(token)) return { state: "invalid" };
  try {
    const { data, error } = await createAdminSupabase()
      .rpc("self_onboarding_lookup", { p_token: token, p_mark_opened: markOpened })
      .maybeSingle();
    if (error) throw new Error(`Onboarding lookup failed: ${error.code}`);
    if (!data || !isOnboardingRole(data.role)) return { state: "invalid" };
    if (data.state === "pending") {
      return {
        state: "pending",
        inviteId: data.invite_id,
        organisationId: data.organisation_id,
        organisationName: data.organisation_name,
        email: data.email,
        role: data.role,
        onPayroll: data.on_payroll,
        userId: data.user_id,
        expiresAt: data.expires_at,
      };
    }
    if (
      data.state === "submitted" ||
      data.state === "approved" ||
      data.state === "cancelled" ||
      data.state === "expired"
    ) {
      return { state: data.state, organisationName: data.organisation_name, role: data.role };
    }
    return { state: "invalid" };
  } catch (error) {
    console.error(
      "onboarding.lookup_failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
    return { state: "unavailable" };
  }
}

/**
 * The submission as public.submit_self_onboarding reads it. Personal numbers are encrypted here
 * for the invite row, with their last 4 for the reviewer. No role, by construction.
 */
export function buildSubmission(
  organisationId: string,
  inviteId: string,
  details: OnboardingDetails,
): Record<string, Json> {
  const ctx = (column: string): PiiContext => ({
    organisationId,
    table: "onboarding_invites",
    column,
    rowId: inviteId,
  });
  const seal = (value: string | null, column: string) =>
    value === null ? null : encryptPiiForDb(value, ctx(column));
  const tail = (value: string | null) => (value === null ? null : value.slice(-4));
  const bank = details.bankCode ? bankByCode(details.bankCode) : undefined;
  return {
    first_name: details.firstName,
    last_name: details.lastName,
    phone: details.phone,
    date_of_birth: details.dateOfBirth,
    home_address: details.homeAddress,
    next_of_kin_name: details.nextOfKinName,
    next_of_kin_phone: details.nextOfKinPhone,
    nin_enc: seal(details.nin, "nin_enc"),
    nin_last4: tail(details.nin),
    pfa_name: details.pfaName,
    rsa_pin_enc: seal(details.rsaPin, "rsa_pin_enc"),
    rsa_pin_last4: tail(details.rsaPin),
    tax_state: details.taxState,
    nhf_opt_in: details.nhfOptIn,
    nhf_number_enc: seal(details.nhfNumber, "nhf_number_enc"),
    nhf_number_last4: tail(details.nhfNumber),
    annual_rent_declared_kobo: details.annualRentDeclared?.toString() ?? null,
    bank_code: bank && details.bankAccountNumber ? bank.code : null,
    bank_name: bank && details.bankAccountNumber ? bank.name : null,
    account_name: bank && details.bankAccountNumber ? details.accountName : null,
    bank_account_enc: bank ? seal(details.bankAccountNumber, "bank_account_enc") : null,
    bank_account_last4: bank ? tail(details.bankAccountNumber) : null,
    ...(details.locationConsent
      ? { location_consent_version: CONSENT_NOTICES.location.version }
      : {}),
    ...(details.selfieConsent ? { selfie_consent_version: CONSENT_NOTICES.selfie.version } : {}),
  };
}

const SUBMIT_MESSAGES: Record<string, string> = {
  MLSO1: "You are already a member of this company. Sign in to open the app.",
  MLSO3: "These details were already sent. HR will be in touch.",
  MLSO4: "This invite has expired. Ask the person who invited you to send it again.",
  MLSO5: "This invite was cancelled. Ask the person who invited you for a new one.",
  MLSO7: "This invite is for a different email address. Sign in with the address it was sent to.",
};

export type SubmitOutcome = { ok: true } | { ok: false; message: string };

/** Sends the details. The database ends the token. */
export async function submitOnboarding(
  token: string,
  userId: string | null,
  submission: Record<string, Json>,
): Promise<SubmitOutcome> {
  const { error } = await createAdminSupabase().rpc("submit_self_onboarding", {
    p_token: token,
    // Null for a worker role (the generated type says string).
    p_user_id: userId as string,
    p_details: submission,
  });
  if (!error) return { ok: true };
  const known = SUBMIT_MESSAGES[error.code];
  if (known) return { ok: false, message: known };
  // A check constraint the form's rules should have caught (logged by code only).
  console.error("onboarding.submit_failed:", error.code);
  return {
    ok: false,
    message:
      error.code === "23514" || error.code === "22023"
        ? "Some details weren't accepted. Check each field and try again."
        : "Your details weren't sent. Try again in a minute.",
  };
}
