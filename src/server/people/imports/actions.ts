"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { MutationError, mutate } from "@/server/identity/mutate";

import {
  applyImportFixSpec,
  cancelImportSpec,
  checkImportSpec,
  commitImportSpec,
  startImportSpec,
} from "./batches";
import { IMPORT_PATHS, type ImportActionState, type ImportPath } from "@/lib/people-import";

/**
 * Server Actions for the people import (/app/people/import and setup step 5). Each one goes
 * through mutate(): owner, admin or hr of the active organisation, Zod-validated, written with
 * the user's own client. Messages are plain English and never carry personal data.
 */

const FORBIDDEN = "Only the owner, an admin or HR can import employees.";
const FAILED = "That didn't work. Try again in a minute.";

function refusal(error: unknown): { ok: false; message: string } {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, message: FORBIDDEN };
    if (error.code === "invalid") {
      const field = Object.values(error.fieldErrors).find(Boolean);
      return { ok: false, message: field ?? error.message };
    }
  }
  // Names only: a cause could quote a row, and rows can hold personal data.
  console.error(
    "people.import_failed:",
    error instanceof Error ? `${error.name}: ${error.message.slice(0, 120)}` : "unknown error",
  );
  return { ok: false, message: FAILED };
}

function returnPath(value: FormDataEntryValue | null): ImportPath {
  return IMPORT_PATHS.find((path) => path === value) ?? IMPORT_PATHS[0];
}

export type StartImportResult =
  { ok: true; batchId: string; path: string; contentType: string } | { ok: false; message: string };

/** Step 1 of an upload: a batch to upload into, and where the browser puts the file. */
export async function startImportUpload(input: {
  fileName: string;
  size: number;
}): Promise<StartImportResult> {
  try {
    const started = await mutate(startImportSpec, input);
    return { ok: true, ...started };
  } catch (error) {
    return refusal(error);
  }
}

/** Step 2: the file is in Storage; check every row and store the result. */
export async function checkImportUpload(
  batchId: string,
): Promise<{ ok: true; batchId: string } | { ok: false; message: string }> {
  try {
    const checked = await mutate(checkImportSpec, { batchId });
    return { ok: true, batchId: checked.batchId };
  } catch (error) {
    return refusal(error);
  }
}

/** One-click fix on a held row ("Set to Kola Adebayo", "Match to Coastline Logistics"). */
export async function applyImportFix(
  _prev: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const fixed = await mutate(applyImportFixSpec, {
      batchId: formData.get("batchId"),
      rowNumber: formData.get("rowNumber"),
      fixLabel: formData.get("fixLabel"),
    });
    refresh();
    return { ok: true, message: `Row ${fixed.rowNumber}: ${fixed.label}` };
  } catch (error) {
    const result = refusal(error);
    refresh();
    return result;
  }
}

/** "Import N employees". */
export async function commitImport(
  _prev: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  try {
    const result = await mutate(commitImportSpec, {
      batchId: formData.get("batchId"),
      expected: formData.get("expected"),
    });
    refresh();
    if (result.status === "changed") {
      return {
        ok: false,
        message: `The file changed since you checked it: ${result.importable} rows are ready now. Check the list and import again.`,
      };
    }
    if (result.created === 0) {
      return { ok: true, message: "These employees are already imported." };
    }
    return {
      ok: true,
      message: `${result.created} ${result.created === 1 ? "employee" : "employees"} imported`,
    };
  } catch (error) {
    return refusal(error);
  }
}

/** Drops a batch that has no imported rows, and goes back to the upload. */
export async function cancelImport(
  _prev: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  const to = returnPath(formData.get("returnTo"));
  try {
    await mutate(cancelImportSpec, { batchId: formData.get("batchId") });
  } catch (error) {
    return refusal(error);
  }
  redirect(to);
}
