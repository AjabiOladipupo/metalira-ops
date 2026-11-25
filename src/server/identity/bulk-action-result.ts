import "server-only";

import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";

import { ListChanged, NotInList } from "./bulk-selection";
import { MutationError } from "./mutate";

/**
 * What a list's bulk action returns to its action bar (slice U.2): the value, or a refusal in
 * plain words. Never the input, which names people.
 */
export type ListBulkResult<T> =
  | { ok: true; value: T; message?: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<string, string>>;
      /** The selection now resolves to other rows (MLLB3, or MLLB2 on the confirm): preview again. */
      changed?: boolean;
    };

const FAILED = "That didn't work. Try again in a minute.";

/** A refusal for the action bar; logs the error's name and message only for the unexpected. */
export function listBulkRefusal(error: unknown, logTag: string): ListBulkResult<never> {
  if (error instanceof ListChanged) return { ok: false, message: error.message, changed: true };
  if (error instanceof NotInList) return { ok: false, message: error.message };
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, message: error.message };
    if (error.code === "invalid") {
      return { ok: false, message: error.message, fieldErrors: error.fieldErrors };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error(`${logTag}:`, cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, message: FAILED };
}
