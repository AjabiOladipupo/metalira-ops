import "server-only";

import { randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { canEditPay } from "@/lib/pay-access";
import { isManagerRole } from "@/lib/roles";
import {
  emailsLeft,
  isOnboardingRole,
  ONBOARDING_ROLE_LABELS,
  ONBOARDING_STAFF,
  listStatus,
  type OnboardingListStatus,
  type OnboardingRole,
  type OnboardingStatus,
} from "@/lib/self-onboarding";
import { decryptPii, encryptPiiForDb, last4, type PiiContext } from "@/server/crypto/pii";
import { emailIsConfigured } from "@/server/email/send";
import { sendSelfOnboardingInviteEmail } from "@/server/email/self-onboarding";
import { getCompany } from "@/server/identity/company-data";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import { bankAccountContext } from "./bank-changes";
import {
  approveOnboardingSchema,
  onboardingInviteIdSchema,
  onboardingInviteSchema,
} from "./self-onboarding-schemas";
import { toPayRateRecord } from "./schemas";
import { nextStaffId } from "./staff-id";
import { loadStaffIds } from "./workers";

/**
 * Self-onboarding invites, the manager side (slice U.4; docs/U4_SELF_ONBOARDING.md). The owner or
 * HR invites by email with ONE role, resends or cancels, and approves what the invitee sent. Each
 * change is one SQL function called with the user's own client through mutate(), so the database
 * checks the role (owner or HR, trusted session) and the invite's state again, and writes the
 * `onboarding.*` audit rows (ids and role only).
 *
 * Raw tokens exist only in the result of create and resend: the action emails the link. The
 * invitee's personal numbers are encrypted for the invite row; approval decrypts them here and
 * encrypts them again for the rows they move to (the worker, the bank-detail change, the NHF
 * record), so the database never sees them in the clear. Nothing personal is logged.
 */

type Client = SupabaseClient<Database>;

const INVITE_PATH_TABLE = "onboarding_invites";

export interface OnboardingListItem {
  id: string;
  email: string;
  role: OnboardingRole;
  status: OnboardingListStatus;
  name: string | null;
  sentAt: string;
  expiresAt: string;
  submittedAt: string | null;
  workerId: string | null;
}

/** The company's invites, newest first (owner and HR read them; RLS). */
export async function loadOnboardingInvites(
  supabase: Client,
  organisationId: string,
): Promise<OnboardingListItem[]> {
  const { data, error } = await supabase
    .from("onboarding_invites")
    .select(
      "id, email, role, status, first_name, last_name, sent_at, expires_at, submitted_at, worker_id",
    )
    .eq("organisation_id", organisationId)
    .order("sent_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Could not load the onboarding invites: ${error.code}`);
  const now = new Date();
  return (data ?? []).flatMap((row): OnboardingListItem[] =>
    isOnboardingRole(row.role)
      ? [
          {
            id: row.id,
            email: row.email,
            role: row.role,
            status: listStatus(row.status as OnboardingStatus, row.expires_at, now),
            name: row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : null,
            sentAt: row.sent_at,
            expiresAt: row.expires_at,
            submittedAt: row.submitted_at,
            workerId: row.worker_id,
          },
        ]
      : [],
  );
}

/** What the reviewer sees: the invitee's details with personal numbers masked to the last 4. */
export interface OnboardingReview {
  id: string;
  email: string;
  role: OnboardingRole;
  onPayroll: boolean;
  status: OnboardingListStatus;
  submittedAt: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  homeAddress: string | null;
  nextOfKinName: string | null;
  nextOfKinPhone: string | null;
  ninLast4: string | null;
  bankName: string | null;
  accountName: string | null;
  bankAccountLast4: string | null;
  pfaName: string | null;
  rsaPinLast4: string | null;
  taxState: string | null;
  nhfOptIn: boolean;
  nhfNumberLast4: string | null;
  /** Whole kobo as a string (never a JavaScript number). */
  annualRentKobo: string | null;
  locationConsent: boolean;
  selfieConsent: boolean;
  departmentName: string | null;
  workerId: string | null;
}

export async function loadOnboardingReview(
  supabase: Client,
  organisationId: string,
  inviteId: string,
): Promise<OnboardingReview | null> {
  const { data, error } = await supabase
    .from("onboarding_invites")
    .select(
      "id, email, role, on_payroll, status, expires_at, submitted_at, first_name, last_name, phone, date_of_birth, home_address, next_of_kin_name, next_of_kin_phone, nin_last4, bank_name, account_name, bank_account_last4, pfa_name, rsa_pin_last4, tax_state, nhf_opt_in, nhf_number_last4, annual_rent_declared_kobo::text, location_consent_at, selfie_consent_at, department_id, worker_id",
    )
    .eq("organisation_id", organisationId)
    .eq("id", inviteId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the invite: ${error.code}`);
  if (!data) return null;
  // PostgREST types the cast column loosely; it is text here.
  const row = data as unknown as Record<string, unknown> & typeof data;
  if (!isOnboardingRole(row.role)) return null;
  let departmentName: string | null = null;
  if (row.department_id) {
    const { data: dept } = await supabase
      .from("departments")
      .select("name")
      .eq("organisation_id", organisationId)
      .eq("id", row.department_id)
      .maybeSingle();
    departmentName = dept?.name ?? null;
  }
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    onPayroll: row.on_payroll,
    status: listStatus(row.status as OnboardingStatus, row.expires_at),
    submittedAt: row.submitted_at,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    dateOfBirth: row.date_of_birth,
    homeAddress: row.home_address,
    nextOfKinName: row.next_of_kin_name,
    nextOfKinPhone: row.next_of_kin_phone,
    ninLast4: row.nin_last4,
    bankName: row.bank_name,
    accountName: row.account_name,
    bankAccountLast4: row.bank_account_last4,
    pfaName: row.pfa_name,
    rsaPinLast4: row.rsa_pin_last4,
    taxState: row.tax_state,
    nhfOptIn: row.nhf_opt_in,
    nhfNumberLast4: row.nhf_number_last4,
    annualRentKobo: (row.annual_rent_declared_kobo as string | null) ?? null,
    locationConsent: row.location_consent_at !== null,
    selfieConsent: row.selfie_consent_at !== null,
    departmentName,
    workerId: row.worker_id,
  };
}

/** Emails left today under the shared caps (30 a company, 80 overall). */
export async function loadEmailsLeft(
  supabase: Client,
  organisationId: string,
): Promise<{ left: number; cap: number }> {
  const { data, error } = await supabase
    .rpc("self_onboarding_emails_sent", { p_organisation_id: organisationId })
    .maybeSingle();
  if (error) throw new Error(`Could not count today's emails: ${error.code}`);
  return {
    left: emailsLeft(
      { company: data?.company ?? 0, overall: data?.overall ?? 0 },
      INBOX_EMAIL_CAPS,
    ),
    cap: INBOX_EMAIL_CAPS.perCompany,
  };
}

// ---------------------------------------------------------------------------
// Refusals from the database, in plain English
// ---------------------------------------------------------------------------

const DB_MESSAGES: Record<string, { code: "invalid" | "forbidden"; message: string }> = {
  MLSO1: {
    code: "invalid",
    message: "This address already belongs to someone in your company.",
  },
  MLSO2: {
    code: "invalid",
    message: "An invite for this address is already open. Resend or cancel it.",
  },
  MLSO3: { code: "invalid", message: "This invite has already been used." },
  MLSO4: { code: "invalid", message: "This invite has expired. Send it again." },
  MLSO5: { code: "invalid", message: "This invite was cancelled." },
  MLSO6: {
    code: "invalid",
    message: "This invite has moved on since you opened the page. Refresh and try again.",
  },
  MLSO7: {
    code: "invalid",
    message: "This person's account is no longer valid. Cancel the invite and send a new one.",
  },
  MLSO9: {
    code: "invalid",
    message: "Your company has sent 50 onboarding invites in 24 hours. Try again tomorrow.",
  },
  MLFZ2: { code: "forbidden", message: "Only the owner or HR can set the declared rent." },
  "42501": { code: "forbidden", message: "Only the owner or HR can onboard people." },
  P0002: { code: "invalid", message: "That wasn't found. Refresh and try again." },
  "23505": {
    code: "invalid",
    message: "An invite for this address was just sent. Refresh the page to see it.",
  },
};

export function onboardingDbError(error: PostgrestError, what: string): MutationError {
  const known = DB_MESSAGES[error.code];
  if (known) return new MutationError(known.code, known.message);
  if (error.code === "22023") return new MutationError("invalid", error.message);
  if (error.code.startsWith("MLPR") || error.code === "23P01") {
    return new MutationError("invalid", error.message, { payEffectiveFrom: error.message });
  }
  return new MutationError("failed", `${what} failed (${error.code}).`);
}

// ---------------------------------------------------------------------------
// Invite, resend, cancel
// ---------------------------------------------------------------------------

export interface IssuedOnboardingInvite {
  inviteId: string;
  token: string;
  email: string;
  role: OnboardingRole;
  expiresAt: Date;
}

export const inviteOnboardingSpec: MutationSpec<
  typeof onboardingInviteSchema,
  IssuedOnboardingInvite
> = {
  module: "people",
  schema: onboardingInviteSchema,
  roles: ONBOARDING_STAFF,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase.rpc("create_self_onboarding_invite", {
      p_organisation_id: organisationId,
      p_email: data.email,
      p_role: data.role,
      p_on_payroll: data.onPayroll,
      p_department_id: data.departmentId ?? undefined,
      p_line_manager_worker_id: data.lineManagerWorkerId ?? undefined,
      p_line_manager_membership_id: data.lineManagerMembershipId ?? undefined,
    });
    if (error) throw onboardingDbError(error, "create_self_onboarding_invite");
    const row = rows?.[0];
    if (!row) throw new Error("create_self_onboarding_invite returned no invite");
    return {
      inviteId: row.invite_id,
      token: row.token,
      email: data.email,
      role: data.role,
      expiresAt: new Date(row.invite_expires_at),
    };
  },
};

export const resendOnboardingSpec: MutationSpec<
  typeof onboardingInviteIdSchema,
  IssuedOnboardingInvite
> = {
  module: "people",
  schema: onboardingInviteIdSchema,
  roles: ONBOARDING_STAFF,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase.rpc("resend_self_onboarding_invite", {
      p_organisation_id: organisationId,
      p_invite_id: data.inviteId,
    });
    if (error) throw onboardingDbError(error, "resend_self_onboarding_invite");
    const row = rows?.[0];
    if (!row || !isOnboardingRole(row.invite_role)) {
      throw new Error("resend_self_onboarding_invite returned no invite");
    }
    return {
      inviteId: data.inviteId,
      token: row.token,
      email: row.invite_email,
      role: row.invite_role,
      expiresAt: new Date(row.invite_expires_at),
    };
  },
};

export const cancelOnboardingSpec: MutationSpec<
  typeof onboardingInviteIdSchema,
  { inviteId: string }
> = {
  module: "people",
  schema: onboardingInviteIdSchema,
  roles: ONBOARDING_STAFF,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("cancel_self_onboarding_invite", {
      p_organisation_id: organisationId,
      p_invite_id: data.inviteId,
    });
    if (error) throw onboardingDbError(error, "cancel_self_onboarding_invite");
    return { inviteId: data.inviteId };
  },
};

export type InviteEmailOutcome = "sent" | "skipped" | "capped" | "failed";

/**
 * Emails the invite link under the shared daily caps (30 a company, 80 overall; kind
 * `self_onboarding`). Past a cap nothing is sent ("capped"); without a Resend key (development,
 * previews) nothing is claimed or sent ("skipped"). Never throws; failures are logged by name.
 */
export async function emailOnboardingInvite(
  invite: IssuedOnboardingInvite,
  organisationId: string,
  inviterName: string | null,
  url: string,
): Promise<InviteEmailOutcome> {
  try {
    const company = await getCompany(organisationId);
    if (!company) return "failed";
    if (emailIsConfigured()) {
      const claim = await createAdminSupabase().rpc("claim_manager_email", {
        p_organisation_id: organisationId,
        p_kind: "self_onboarding",
        p_ref_id: randomUUID(),
        p_recipients: 1,
        p_org_cap: INBOX_EMAIL_CAPS.perCompany,
        p_global_cap: INBOX_EMAIL_CAPS.overall,
      });
      if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
      if (!claim.data) return "capped";
    }
    const result = await sendSelfOnboardingInviteEmail({
      to: invite.email,
      inviteId: invite.inviteId,
      organisationName: company.name,
      inviterName,
      roleLabel: ONBOARDING_ROLE_LABELS[invite.role],
      inviteUrl: url,
      expiresAt: invite.expiresAt,
    });
    return result.status === "sent" ? "sent" : "skipped";
  } catch (error) {
    console.error(
      "onboarding.invite_email_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

export interface ApprovedOnboarding {
  inviteId: string;
  role: OnboardingRole;
  email: string;
  workerId: string | null;
  membershipId: string | null;
  userId: string | null;
  bankDetailsPending: boolean;
}

const STAFF_ID_ATTEMPTS = 3;

function inviteContext(organisationId: string, inviteId: string, column: string): PiiContext {
  return { organisationId, table: INVITE_PATH_TABLE, column, rowId: inviteId };
}

/**
 * Approves what the invitee sent. Owner or HR (the database checks again); the pay rate is owner
 * or HR's to set, as everywhere (PAY_EDITORS). Creates the membership and/or worker the invite's
 * role says; the role is never taken from this input.
 */
export const approveOnboardingSpec: MutationSpec<
  typeof approveOnboardingSchema,
  ApprovedOnboarding
> = {
  module: "people",
  schema: approveOnboardingSchema,
  roles: ONBOARDING_STAFF,
  run: async ({ supabase, organisationId, role, data }) => {
    if (data.payType && !(isManagerRole(role) && canEditPay(role))) {
      throw new MutationError("forbidden", "Only the owner or HR can set pay.");
    }
    const { data: inv, error: readError } = await supabase
      .from("onboarding_invites")
      .select(
        "id, email, role, on_payroll, status, user_id, nin_enc, rsa_pin_enc, bank_account_enc, bank_account_last4, nhf_number_enc",
      )
      .eq("organisation_id", organisationId)
      .eq("id", data.inviteId)
      .maybeSingle();
    if (readError) throw new Error(`Could not read the invite: ${readError.code}`);
    if (!inv || !isOnboardingRole(inv.role)) {
      throw new MutationError("invalid", "That invite wasn't found. Refresh and try again.");
    }
    if (inv.status !== "submitted") {
      throw new MutationError("invalid", DB_MESSAGES.MLSO6!.message);
    }

    let worker: Record<string, string | null> | null = null;
    let bankEnc: string | null = null;
    let nhf: { id: string; enc: string } | null = null;
    let payRate: ReturnType<typeof toPayRateRecord> | null = null;
    if (inv.on_payroll) {
      const missing: Record<string, string> = {};
      if (!data.startDate) missing.startDate = "Enter the start date";
      if (!data.employmentType) missing.employmentType = "Choose the employment type";
      if (Object.keys(missing).length > 0) {
        throw new MutationError("invalid", "Check the highlighted fields.", missing);
      }
      const workerId = randomUUID();
      const from = (column: string) => inviteContext(organisationId, inv.id, column);
      const workerCtx = (column: string): PiiContext => ({
        organisationId,
        table: "workers",
        column,
        rowId: workerId,
      });
      worker = {
        id: workerId,
        employment_type: data.employmentType,
        start_date: data.startDate,
        nin_enc: inv.nin_enc
          ? encryptPiiForDb(decryptPii(inv.nin_enc, from("nin_enc")), workerCtx("nin_enc"))
          : null,
        rsa_pin_enc: inv.rsa_pin_enc
          ? encryptPiiForDb(
              decryptPii(inv.rsa_pin_enc, from("rsa_pin_enc")),
              workerCtx("rsa_pin_enc"),
            )
          : null,
      };
      if (inv.bank_account_enc) {
        const number = decryptPii(inv.bank_account_enc, from("bank_account_enc"));
        // The approver sees the last 4 on the review: they must belong to the number paid.
        if (last4(number) !== inv.bank_account_last4) {
          throw new MutationError(
            "invalid",
            "The bank details sent can't be checked. Cancel this invite and send a new one.",
          );
        }
        bankEnc = encryptPiiForDb(number, bankAccountContext(organisationId, workerId));
      }
      if (inv.nhf_number_enc) {
        const nhfId = randomUUID();
        nhf = {
          id: nhfId,
          enc: encryptPiiForDb(decryptPii(inv.nhf_number_enc, from("nhf_number_enc")), {
            organisationId,
            table: "payroll_nhf_numbers",
            column: "nhf_number_enc",
            rowId: nhfId,
          }),
        };
      }
      payRate =
        data.payType && data.startDate
          ? toPayRateRecord(data.payType, data, data.payEffectiveFrom ?? data.startDate)
          : null;
    }

    for (let attempt = 1; ; attempt += 1) {
      const staffIdGenerated = !data.staffId;
      const staffId = worker
        ? (data.staffId ?? nextStaffId(await loadStaffIds(supabase, organisationId)))
        : null;
      const { data: rows, error } = await supabase.rpc("approve_self_onboarding", {
        p_organisation_id: organisationId,
        p_invite_id: inv.id,
        p_worker: worker ? { ...worker, staff_id: staffId } : undefined,
        p_pay_rate: payRate ?? undefined,
        p_bank_account_enc: bankEnc ?? undefined,
        p_nhf_id: nhf?.id,
        p_nhf_enc: nhf?.enc,
      });
      if (!error) {
        const row = rows?.[0];
        return {
          inviteId: inv.id,
          role: inv.role,
          email: inv.email,
          workerId: row?.worker_id ?? null,
          membershipId: row?.membership_id ?? null,
          userId: inv.user_id,
          bankDetailsPending: bankEnc !== null,
        };
      }
      const text = `${error.message} ${error.details ?? ""}`;
      const takenByRace =
        worker !== null &&
        staffIdGenerated &&
        ((error.code === "23505" && text.includes("workers_staff_id_key")) ||
          error.code === "MLSI3");
      if (!takenByRace || attempt >= STAFF_ID_ATTEMPTS) {
        if (error.code === "23505" && text.includes("workers_staff_id_key")) {
          const message = "Another employee already has this staff ID.";
          throw new MutationError("invalid", message, { staffId: message });
        }
        if (error.code === "MLSI3") {
          throw new MutationError("invalid", error.message, { staffId: error.message });
        }
        throw onboardingDbError(error, "approve_self_onboarding");
      }
    }
  },
};
