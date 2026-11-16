"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDate } from "@/lib/dates";
import { PII_FIELDS } from "@/lib/mask";
import { PiiKeyError } from "@/server/crypto/pii";
import type { CompanyFormState as PeopleFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";

import { createDepartment, updateDepartment } from "./departments";
import { echoableValues, workerFormErrors, workerFormInput } from "./form-input";
import { PiiAccessError, PiiRecordNotFoundError, revealPii } from "./pii-access";
import { addPayRate, cancelPayRate, createWorker, endEmployment, updateWorker } from "./workers";

/**
 * Server Actions for the People screens (slice 1.5). Each one goes through a helper that runs
 * `mutate()`: the caller's role in the active organisation is checked here, on the server, for
 * every action (owner, admin and hr change people; everyone else is refused with 403), then the
 * input is validated and written with the caller's own client, so RLS and the database's rules
 * apply again and the audit triggers log the change.
 */

const FORBIDDEN = "Only the owner, an admin or HR can change employee records.";
const FAILED = "That was not saved. Try again in a minute.";

function refusal(
  error: unknown,
  values?: Record<string, string>,
  mapErrors: (e: Partial<Record<string, string>>) => Partial<Record<string, string>> = (e) => e,
): PeopleFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, status: 403, formError: FORBIDDEN, values };
    if (error.code === "invalid") {
      return {
        ok: false,
        status: 400,
        formError: error.message,
        fieldErrors: mapErrors(error.fieldErrors),
        values,
      };
    }
  }
  // Names and messages only: never the input, which can hold personal data.
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "people.save_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, status: 500, formError: FAILED, values };
}

function refreshPeople(): void {
  revalidatePath("/app/people", "layout");
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export async function createWorkerAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const fields = formFields(formData);
  let id: string;
  try {
    ({ id } = await createWorker(workerFormInput(fields, "create")));
  } catch (error) {
    return refusal(error, echoableValues(fields), workerFormErrors);
  }
  refreshPeople();
  redirect(`/app/people/${id}`);
}

export async function updateWorkerAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const fields = formFields(formData);
  let id: string;
  try {
    ({ id } = await updateWorker(workerFormInput(fields, "update")));
  } catch (error) {
    return refusal(error, echoableValues(fields), workerFormErrors);
  }
  refreshPeople();
  redirect(`/app/people/${id}`);
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

/** "Change pay": a new dated version from the chosen date; the current one closes the day before. */
export async function changePayAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const fields = formFields(formData);
  try {
    await addPayRate(fields);
  } catch (error) {
    return refusal(error, echoableValues(fields));
  }
  refreshPeople();
  const from = fields.effectiveFrom ? ` It applies from ${formatDate(fields.effectiveFrom)}.` : "";
  return { ok: true, status: 200, message: `Pay change saved.${from}` };
}

/** Cancels a scheduled pay version and reopens the one before it. */
export async function cancelPayRateAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const fields = formFields(formData);
  try {
    await cancelPayRate(fields);
  } catch (error) {
    return refusal(error);
  }
  refreshPeople();
  return { ok: true, status: 200, message: "Scheduled pay change cancelled." };
}

// ---------------------------------------------------------------------------
// End employment
// ---------------------------------------------------------------------------

export async function endEmploymentAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const fields = formFields(formData);
  try {
    await endEmployment(fields);
  } catch (error) {
    return refusal(error, echoableValues(fields));
  }
  refreshPeople();
  return {
    ok: true,
    status: 200,
    message: `Employment ends on ${fields.endDate ? formatDate(fields.endDate) : "that day"}.`,
  };
}

// ---------------------------------------------------------------------------
// Reveal personal data
// ---------------------------------------------------------------------------

const revealInput = z.object({
  workerId: z.uuid(),
  field: z.enum(PII_FIELDS),
});

export type RevealResult = { ok: true; value: string | null } | { ok: false; message: string };

/**
 * Shows one personal data field of one worker in full, for roles allowed to see it (owner and
 * hr every field, finance bank account numbers only). The role is checked against the caller's
 * own membership and every reveal is written to the audit log by `revealPii`.
 */
export async function revealWorkerPii(input: unknown): Promise<RevealResult> {
  const parsed = revealInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That can't be shown." };
  const session = await getSession();
  if (!session) redirect(SIGN_IN_PATH);
  if (!session.active) return { ok: false, message: "Your role can't see this in full." };
  try {
    const value = await revealPii({
      organisationId: session.active.organisationId,
      field: parsed.data.field,
      entity: "workers",
      entityId: parsed.data.workerId,
    });
    return { ok: true, value };
  } catch (error) {
    if (error instanceof PiiAccessError || error instanceof PiiRecordNotFoundError) {
      return { ok: false, message: error.message };
    }
    console.error(
      "people.reveal_failed:",
      error instanceof PiiKeyError
        ? "PiiKeyError"
        : error instanceof Error
          ? error.name
          : "unknown",
    );
    return { ok: false, message: "This can't be shown right now. Try again in a minute." };
  }
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

function refreshDepartments(): void {
  revalidatePath("/app/settings/departments");
  refreshPeople();
}

export async function createDepartmentAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const fields = formFields(formData);
  try {
    await createDepartment(fields);
  } catch (error) {
    return refusal(error, echoableValues(fields));
  }
  refreshDepartments();
  return { ok: true, status: 200, message: `${fields.name?.trim() ?? "Department"} added.` };
}

export async function updateDepartmentAction(
  _prev: PeopleFormState,
  formData: FormData,
): Promise<PeopleFormState> {
  const fields = formFields(formData);
  try {
    await updateDepartment(fields);
  } catch (error) {
    return refusal(error, echoableValues(fields));
  }
  refreshDepartments();
  return { ok: true, status: 200, message: "Saved" };
}
