"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDate } from "@/lib/dates";
import { MutationError, mutate } from "@/server/identity/mutate";

import {
  BulkRefusal,
  bulkDepartmentSpec,
  bulkEndEmploymentSpec,
  bulkLineManagerSpec,
  exportPeopleSpec,
  previewBulkEndSpec,
  previewBulkReassignSpec,
  type BulkEndPreview,
  type BulkProblem,
  type BulkReassignPreview,
  type PeopleExport,
} from "./bulk";

/**
 * Server Actions for the People list's bulk actions (slice U.1). Each goes through `mutate()`
 * (role, Zod, the caller's own client) and returns a plain result for the action bar: never
 * the input, which names people.
 */

export type BulkResult<T> =
  | { ok: true; value: T; message?: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<string, string>>;
      problems?: BulkProblem[];
    };

const FAILED = "That didn't work. Try again in a minute.";

function refusal(error: unknown): BulkResult<never> {
  if (error instanceof BulkRefusal) {
    return { ok: false, message: error.message, problems: error.problems };
  }
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, message: error.message };
    if (error.code === "invalid") {
      return { ok: false, message: error.message, fieldErrors: error.fieldErrors };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(
    "people.bulk_failed:",
    cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
  );
  return { ok: false, message: FAILED };
}

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;

export async function previewBulkEndEmploymentAction(
  input: unknown,
): Promise<BulkResult<BulkEndPreview>> {
  try {
    return { ok: true, value: await mutate(previewBulkEndSpec, input) };
  } catch (error) {
    return refusal(error);
  }
}

export async function bulkEndEmploymentAction(
  input: unknown,
): Promise<BulkResult<{ ended: number }>> {
  try {
    const result = await mutate(bulkEndEmploymentSpec, input);
    revalidatePath("/app/people", "layout");
    return {
      ok: true,
      value: { ended: result.ended },
      message: `Employment ends on ${formatDate(result.endDate)} for ${people(result.ended)}.`,
    };
  } catch (error) {
    return refusal(error);
  }
}

export async function previewBulkReassignAction(
  input: unknown,
): Promise<BulkResult<BulkReassignPreview>> {
  try {
    return { ok: true, value: await mutate(previewBulkReassignSpec, input) };
  } catch (error) {
    return refusal(error);
  }
}

export async function bulkSetLineManagerAction(
  input: unknown,
): Promise<BulkResult<{ changed: number }>> {
  try {
    const result = await mutate(bulkLineManagerSpec, input);
    revalidatePath("/app/people", "layout");
    return {
      ok: true,
      value: { changed: result.changed },
      message: `Line manager changed for ${people(result.changed)}.`,
    };
  } catch (error) {
    return refusal(error);
  }
}

export async function bulkSetDepartmentAction(
  input: unknown,
): Promise<BulkResult<{ changed: number }>> {
  try {
    const result = await mutate(bulkDepartmentSpec, input);
    revalidatePath("/app/people", "layout");
    return {
      ok: true,
      value: { changed: result.changed },
      message: `Department changed for ${people(result.changed)}.`,
    };
  } catch (error) {
    return refusal(error);
  }
}

export async function exportPeopleAction(input: unknown): Promise<BulkResult<PeopleExport>> {
  try {
    const file = await mutate(exportPeopleSpec, input);
    return { ok: true, value: file, message: `Exported ${people(file.count)}.` };
  } catch (error) {
    return refusal(error);
  }
}
