import "server-only";

import { randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type { ManagerRole } from "@/lib/roles";
import { encryptPiiForDb, sealPii, type PiiContext } from "@/server/crypto/pii";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import type { Database, Json } from "@/types/db";

import {
  addPayRateSchema,
  cancelPayRateSchema,
  createWorkerSchema,
  endEmploymentSchema,
  toPayRateRecord,
  updateWorkerSchema,
} from "./schemas";
import { nextStaffId } from "./staff-id";

/**
 * Server helpers for workers and their pay (slice 1.3). Each one goes through `mutate()`: the
 * role check, the Zod parse, then the write with the signed-in user's own client so RLS and the
 * database's own rules apply (row audit triggers, pay-rate versioning, line-manager loops).
 * Writes that touch several rows run in one SQL function: `create_worker`, `add_pay_rate`,
 * `cancel_pay_rate`, `end_employment`. Each is given the active organisation and touches only
 * its rows, so a user with a role in two companies can't reach the other one's workers (and the
 * app-level audit event can't land in the wrong company's log).
 *
 * Personal data is encrypted here, for the worker's row id, before it leaves the server
 * (src/server/crypto/pii.ts). Plaintext is never logged or audited: the database records which
 * personal data fields changed, never their values.
 */

/** Who may add and edit workers and pay (owner, admin, hr; docs/PHASE_1.md 1.3). */
export const PEOPLE_EDITORS = ["owner", "admin", "hr"] as const satisfies readonly ManagerRole[];

type Client = SupabaseClient<Database>;
/**
 * A workers update with money as a string of whole kobo: PostgREST casts it straight to bigint,
 * so it never passes through a JavaScript number (the generated type says `number`).
 */
type WorkerUpdate = Omit<
  Database["public"]["Tables"]["workers"]["Update"],
  "annual_rent_declared_kobo"
> & { annual_rent_declared_kobo?: string | null };

const WORKERS = "workers";

function piiContext(organisationId: string, rowId: string, column: string): PiiContext {
  return { organisationId, table: WORKERS, column, rowId };
}

const PAGE = 1000;

/** Every staff ID in the organisation, a page at a time (PostgREST caps one read at 1000). */
async function loadStaffIds(supabase: Client, organisationId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("workers")
      .select("staff_id")
      .eq("organisation_id", organisationId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read staff IDs: ${error.message}`);
    ids.push(...(data ?? []).map((row) => row.staff_id));
    if (!data || data.length < PAGE) return ids;
  }
}

/** True when another active worker in the organisation already has this phone number. */
async function phoneInUse(
  supabase: Client,
  organisationId: string,
  phone: string,
  exceptWorkerId: string | null,
): Promise<boolean> {
  let query = supabase
    .from("workers")
    .select("id")
    .eq("organisation_id", organisationId)
    .eq("phone", phone)
    .eq("status", "active")
    .limit(1);
  if (exceptWorkerId) query = query.neq("id", exceptWorkerId);
  const { data, error } = await query;
  if (error) throw new Error(`Could not check the phone number: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Field errors for the database's own refusals; anything else is rethrown as a failure. */
function fromDbError(error: PostgrestError, fields: { effectiveFrom?: string } = {}): never {
  const effectiveFrom = fields.effectiveFrom ?? "effectiveFrom";
  const invalid = (field: string, message: string) => {
    throw new MutationError("invalid", message, { [field]: message });
  };
  const text = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      throw new MutationError("forbidden", "Your role can't make this change.");
    case "P0002":
      throw new MutationError("invalid", error.message);
    case "MLLM1":
      return invalid("lineManagerWorkerId", error.message);
    case "MLLM2":
      return invalid("lineManagerMembershipId", error.message);
    case "MLPR1":
    case "MLPR2":
    case "MLPR3":
      return invalid(effectiveFrom, error.message);
    case "23P01":
      return invalid(effectiveFrom, "This pay rate overlaps another version for the same dates.");
    case "23505":
      if (text.includes("workers_staff_id_key")) {
        return invalid("staffId", "Another employee already has this staff ID.");
      }
      break;
    case "23503":
      if (text.includes("department"))
        return invalid("departmentId", "That department wasn't found.");
      if (text.includes("line_manager_worker")) {
        return invalid("lineManagerWorkerId", "That line manager wasn't found.");
      }
      if (text.includes("line_manager_membership")) {
        return invalid("lineManagerMembershipId", "That line manager wasn't found.");
      }
      break;
  }
  throw new Error(`Database refused the change (${error.code}): ${error.message}`);
}

// ---------------------------------------------------------------------------
// createWorker
// ---------------------------------------------------------------------------

export interface CreatedWorker {
  id: string;
  staffId: string;
  staffIdGenerated: boolean;
  supervisorClockIn: boolean;
}

/** Generated staff IDs are retried this many times when another save takes the same ID. */
const STAFF_ID_ATTEMPTS = 3;

export const createWorkerSpec: MutationSpec<typeof createWorkerSchema, CreatedWorker> = {
  schema: createWorkerSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const id = randomUUID();
    const ctx = (column: string) => piiContext(organisationId, id, column);

    const bank = data.bankAccountNumber
      ? sealPii(data.bankAccountNumber, ctx("bank_account_enc"))
      : null;
    const rsa = data.rsaPin ? sealPii(data.rsaPin, ctx("rsa_pin_enc")) : null;
    const supervisorClockIn =
      data.supervisorClockIn ||
      (data.phone !== null && (await phoneInUse(supabase, organisationId, data.phone, null)));

    const worker = {
      id,
      organisation_id: organisationId,
      first_name: data.firstName,
      last_name: data.lastName,
      phone: data.phone,
      email: data.email,
      job_title: data.jobTitle,
      department_id: data.departmentId,
      line_manager_worker_id: data.lineManagerWorkerId,
      line_manager_membership_id: data.lineManagerMembershipId,
      employment_type: data.employmentType,
      start_date: data.startDate,
      bank_name: data.bankName,
      account_name: data.accountName,
      bank_account_enc: bank?.enc ?? null,
      bank_account_last4: bank?.last4 ?? null,
      nin_enc: data.nin ? encryptPiiForDb(data.nin, ctx("nin_enc")) : null,
      tin: data.tin,
      tax_state: data.taxState,
      pfa_name: data.pfaName,
      rsa_pin_enc: rsa?.enc ?? null,
      rsa_pin_last4: rsa?.last4 ?? null,
      nhf_opt_in: data.nhfOptIn,
      annual_rent_declared_kobo: data.annualRentDeclared?.toString() ?? null,
      next_of_kin_name: data.nextOfKinName,
      next_of_kin_phone: data.nextOfKinPhone,
      supervisor_clock_in: supervisorClockIn,
    } satisfies Record<string, Json>;

    const payRate = data.payType
      ? toPayRateRecord(data.payType, data, data.payEffectiveFrom ?? data.startDate)
      : null;

    for (let attempt = 1; ; attempt += 1) {
      const staffIdGenerated = data.staffId === null;
      const staffId = data.staffId ?? nextStaffId(await loadStaffIds(supabase, organisationId));
      const { error } = await supabase.rpc("create_worker", {
        p_worker: { ...worker, staff_id: staffId },
        p_pay_rate: payRate ?? undefined,
      });
      if (!error) return { id, staffId, staffIdGenerated, supervisorClockIn };

      const takenByRace =
        staffIdGenerated &&
        error.code === "23505" &&
        error.message.includes("workers_staff_id_key");
      if (!takenByRace || attempt >= STAFF_ID_ATTEMPTS) {
        fromDbError(error, { effectiveFrom: "payEffectiveFrom" });
      }
    }
  },
};

/** Adds a worker, with their first pay rate when one is given. */
export function createWorker(input: unknown): Promise<CreatedWorker> {
  return mutate(createWorkerSpec, input);
}

// ---------------------------------------------------------------------------
// updateWorker
// ---------------------------------------------------------------------------

export interface UpdatedWorker {
  id: string;
  changed: boolean;
}

export const updateWorkerSpec: MutationSpec<typeof updateWorkerSchema, UpdatedWorker> = {
  schema: updateWorkerSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const id = data.workerId;
    const ctx = (column: string) => piiContext(organisationId, id, column);
    const patch: WorkerUpdate = {};

    if (data.firstName !== undefined) patch.first_name = data.firstName;
    if (data.lastName !== undefined) patch.last_name = data.lastName;
    if (data.phone !== undefined) patch.phone = data.phone;
    if (data.email !== undefined) patch.email = data.email;
    if (data.jobTitle !== undefined) patch.job_title = data.jobTitle;
    if (data.departmentId !== undefined) patch.department_id = data.departmentId;
    if (data.employmentType !== undefined) patch.employment_type = data.employmentType;
    if (data.startDate !== undefined) patch.start_date = data.startDate;
    if (data.tin !== undefined) patch.tin = data.tin;
    if (data.taxState !== undefined) patch.tax_state = data.taxState;
    if (data.pfaName !== undefined) patch.pfa_name = data.pfaName;
    if (data.nhfOptIn !== undefined) patch.nhf_opt_in = data.nhfOptIn;
    if (data.nextOfKinName !== undefined) patch.next_of_kin_name = data.nextOfKinName;
    if (data.nextOfKinPhone !== undefined) patch.next_of_kin_phone = data.nextOfKinPhone;
    if (data.supervisorClockIn !== undefined) patch.supervisor_clock_in = data.supervisorClockIn;
    if (data.annualRentDeclared !== undefined) {
      patch.annual_rent_declared_kobo = data.annualRentDeclared?.toString() ?? null;
    }

    // One line manager: naming one clears the other.
    if (data.lineManagerWorkerId !== undefined || data.lineManagerMembershipId !== undefined) {
      patch.line_manager_worker_id = data.lineManagerWorkerId ?? null;
      patch.line_manager_membership_id = data.lineManagerWorkerId
        ? null
        : (data.lineManagerMembershipId ?? null);
    }

    if (data.nin !== undefined) {
      patch.nin_enc = data.nin === null ? null : encryptPiiForDb(data.nin, ctx("nin_enc"));
    }
    if (data.rsaPin !== undefined) {
      const rsa = data.rsaPin === null ? null : sealPii(data.rsaPin, ctx("rsa_pin_enc"));
      patch.rsa_pin_enc = rsa?.enc ?? null;
      patch.rsa_pin_last4 = rsa?.last4 ?? null;
    }

    // A phone shared with another worker means a supervisor clocks this worker in.
    if (patch.phone && (await phoneInUse(supabase, organisationId, patch.phone, id))) {
      patch.supervisor_clock_in = true;
    }

    if (Object.keys(patch).length === 0) return { id, changed: false };

    const { data: row, error } = await supabase
      .from("workers")
      .update(patch as Database["public"]["Tables"]["workers"]["Update"])
      .eq("id", id)
      .eq("organisation_id", organisationId)
      .select("id")
      .maybeSingle();
    if (error) fromDbError(error);
    if (!row) throw new MutationError("invalid", "That employee wasn't found.");
    return { id, changed: true };
  },
};

/** Changes a worker's details. Bank details and pay have their own flows; the staff ID is fixed. */
export function updateWorker(input: unknown): Promise<UpdatedWorker> {
  return mutate(updateWorkerSpec, input);
}

// ---------------------------------------------------------------------------
// addPayRate
// ---------------------------------------------------------------------------

export const addPayRateSpec: MutationSpec<typeof addPayRateSchema, { id: string }> = {
  schema: addPayRateSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: id, error } = await supabase.rpc("add_pay_rate", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_rate: { ...toPayRateRecord(data.payType, data, data.effectiveFrom) },
    });
    if (error) fromDbError(error);
    return { id };
  },
};

/**
 * Adds a pay version from `effectiveFrom` and closes the current one the day before. A version
 * already in force is never edited; the database refuses that too.
 */
export function addPayRate(input: unknown): Promise<{ id: string }> {
  return mutate(addPayRateSpec, input);
}

// ---------------------------------------------------------------------------
// cancelPayRate
// ---------------------------------------------------------------------------

export const cancelPayRateSpec: MutationSpec<typeof cancelPayRateSchema, { id: string }> = {
  schema: cancelPayRateSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("cancel_pay_rate", {
      p_organisation_id: organisationId,
      p_pay_rate_id: data.payRateId,
    });
    if (error) fromDbError(error, { effectiveFrom: "payRateId" });
    return { id: data.payRateId };
  },
};

/**
 * Cancels a scheduled pay version (one that has not started) and reopens the version before
 * it. A version in force, or one with a later version after it, is refused by the database.
 * To move a scheduled version, cancel it and add it again from the new date.
 */
export function cancelPayRate(input: unknown): Promise<{ id: string }> {
  return mutate(cancelPayRateSpec, input);
}

// ---------------------------------------------------------------------------
// endEmployment
// ---------------------------------------------------------------------------

export const endEmploymentSpec: MutationSpec<typeof endEmploymentSchema, { id: string }> = {
  schema: endEmploymentSchema,
  roles: PEOPLE_EDITORS,
  run: async ({ supabase, organisationId, data }) => {
    const { error } = await supabase.rpc("end_employment", {
      p_organisation_id: organisationId,
      p_worker_id: data.workerId,
      p_end_date: data.endDate,
    });
    if (error) fromDbError(error, { effectiveFrom: "endDate" });
    return { id: data.workerId };
  },
  // The row changes are audited by trigger; this adds the reason, when one is given.
  event: ({ data }) => ({
    action: "people.employment_ended",
    entity: WORKERS,
    entityId: data.workerId,
    after: { end_date: data.endDate },
    reason: data.reason,
  }),
};

/** Ends a worker's employment and closes their open assignments on the last working day. */
export function endEmployment(input: unknown): Promise<{ id: string }> {
  return mutate(endEmploymentSpec, input);
}
