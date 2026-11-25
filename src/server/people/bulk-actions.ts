"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDate } from "@/lib/dates";
import { createServerSupabase } from "@/lib/supabase/server";
import { ListChanged } from "@/server/identity/bulk-selection";
import { MutationError, mutate } from "@/server/identity/mutate";

import {
  BulkRefusal,
  SelectionChanged,
  bulkDepartmentSpec,
  bulkEndEmploymentSpec,
  bulkLineManagerSpec,
  previewBulkEndSpec,
  previewBulkReassignSpec,
  type BulkEndPreview,
  type BulkProblem,
  type BulkReassignPreview,
} from "./bulk";
import { bulkMapSpec, previewBulkMapSpec, type BulkMapPreview } from "./bulk-mapping";
import { planBulkMappingNotices, sendPlannedNotices } from "./bulk-mapping-notices";
import { notifyNewLineManager } from "./bulk-notices";

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
      /** The selection now resolves to other people (MLBU6): preview again. */
      changed?: boolean;
    };

const FAILED = "That didn't work. Try again in a minute.";

function refusal(error: unknown): BulkResult<never> {
  if (error instanceof SelectionChanged || error instanceof ListChanged) {
    return { ok: false, message: error.message, changed: true };
  }
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
    // One summary notice to the new line manager, after the response (as the single save does).
    if (result.changed > 0) {
      const supabase = await createServerSupabase();
      after(() => notifyNewLineManager(supabase, result));
    }
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

export async function previewBulkMapAction(input: unknown): Promise<BulkResult<BulkMapPreview>> {
  try {
    return { ok: true, value: await mutate(previewBulkMapSpec, input) };
  } catch (error) {
    return refusal(error);
  }
}

export interface BulkMapOutcome {
  changed: number;
  /** People whose line manager wasn't emailed: the daily email limit was reached. */
  notEmailed: { workerId: string; name: string }[];
}

export async function bulkMapAction(input: unknown): Promise<BulkResult<BulkMapOutcome>> {
  try {
    const result = await mutate(bulkMapSpec, input);
    revalidatePath("/app/people", "layout");
    // The single save's email to each person's line manager, claimed under the daily caps now
    // and sent after the response.
    const supabase = await createServerSupabase();
    const plan = await planBulkMappingNotices(supabase, result);
    if (plan.send.length > 0) after(() => sendPlannedNotices(plan));
    const skipped =
      plan.skipped.length > 0
        ? ` The line managers of ${people(plan.skipped.length)} weren't emailed: the daily email limit was reached.`
        : "";
    return {
      ok: true,
      value: { changed: result.changed, notEmailed: plan.skipped },
      message: `Mapping saved for ${people(result.changed)}.${skipped}`,
    };
  } catch (error) {
    return refusal(error);
  }
}
