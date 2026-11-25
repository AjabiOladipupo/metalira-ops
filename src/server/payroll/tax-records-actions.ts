"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CapabilityPreview } from "@/server/capabilities/types";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate, type MutationSpec } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";

import {
  TAX_RECORD_WRITERS,
  declareReliefSchema,
  declareReliefSpec,
  importOpeningSchema,
  importOpeningSpec,
  itfFlagSchema,
  itfFlagSpec,
  nhfNumberSpec,
  openingBalanceSchema,
  previewDeclareRelief,
  previewImportOpening,
  previewItfFlag,
  previewOpeningBalance,
  previewVerifyRelief,
  proofLinkSpec,
  recordOpeningSpec,
  recordProofSpec,
  startProofSpec,
  verifyReliefSchema,
  verifyReliefSpec,
  type ProofLink,
  type StartedProof,
} from "./tax-records";

/**
 * Server Actions for payroll tax records (slice 5.9a): opening balances, relief declarations and
 * their proofs, NHF numbers and the ITF turnover switch. Each goes through `mutate()` (role,
 * module, Zod, then one SQL function as the user). A money write previews first ("intent" =
 * preview) and saves on the confirm step ("intent" = save). Messages never carry file contents,
 * paths, links or personal numbers. Registered in src/server/capabilities/registry.ts.
 */

const FAILED = "That didn't work. Try again in a minute.";
const SETTINGS_PATH = "/app/settings/payroll";

type Failure = { ok: false; message: string; fieldErrors?: Partial<Record<string, string>> };

function failure(error: unknown): Failure {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") return { ok: false, message: error.message };
    if (error.code === "invalid") {
      const field = Object.values(error.fieldErrors).find(Boolean);
      return { ok: false, message: field ?? error.message, fieldErrors: error.fieldErrors };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error("payroll_tax_records.failed:", cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, message: FAILED };
}

export type TaxFormState =
  (NonNullable<CompanyFormState> & { preview?: CapabilityPreview }) | null;

function refused(error: unknown, values: Record<string, string>): TaxFormState {
  const failed = failure(error);
  return {
    ok: false,
    status: error instanceof MutationError && error.code === "forbidden" ? 403 : 400,
    formError: failed.message,
    fieldErrors: failed.fieldErrors,
    values,
  };
}

function previewSpec<S extends z.ZodType>(
  schema: S,
  preview: (
    ctx: Parameters<MutationSpec<S, CapabilityPreview>["run"]>[0],
    data: z.output<S>,
  ) => Promise<CapabilityPreview>,
): MutationSpec<S, CapabilityPreview> {
  return {
    module: "payroll",
    schema,
    roles: TAX_RECORD_WRITERS,
    run: (ctx) => preview(ctx, ctx.data),
  };
}

/** Preview on the first press, save on the confirm step. */
async function previewThenSave<S extends z.ZodType, R>(
  formData: FormData,
  preview: MutationSpec<S, CapabilityPreview>,
  save: MutationSpec<S, R>,
  done: (values: Record<string, string>) => { message: string; paths: string[] },
): Promise<TaxFormState> {
  const values = formFields(formData);
  try {
    if (values.intent !== "save") {
      return { ok: true, status: 200, preview: await mutate(preview, values), values };
    }
    await mutate(save, values);
  } catch (error) {
    return refused(error, values);
  }
  const { message, paths } = done(values);
  for (const p of paths) revalidatePath(p);
  return { ok: true, status: 200, message };
}

const workerPath = (values: Record<string, string>) =>
  values.workerId ? [`/app/people/${values.workerId}`] : [];

/** "Record opening balance" (or correct the one in force). */
export async function recordOpeningBalanceAction(
  _prev: TaxFormState,
  formData: FormData,
): Promise<TaxFormState> {
  return previewThenSave(
    formData,
    previewSpec(openingBalanceSchema, previewOpeningBalance),
    recordOpeningSpec,
    (v) => ({
      message: "Opening balance saved. Year-to-date PAYE counts it from the next calculation.",
      paths: workerPath(v),
    }),
  );
}

/** Settings > Payroll rules: "Import opening balances" from pasted rows. */
export async function importOpeningBalancesAction(
  _prev: TaxFormState,
  formData: FormData,
): Promise<TaxFormState> {
  return previewThenSave(
    formData,
    previewSpec(importOpeningSchema, previewImportOpening),
    importOpeningSpec,
    () => ({
      message: "Opening balances imported. Runs count them from their next calculation.",
      paths: [SETTINGS_PATH],
    }),
  );
}

/** "Declare a relief" (or correct the one in force). */
export async function declareReliefAction(
  _prev: TaxFormState,
  formData: FormData,
): Promise<TaxFormState> {
  return previewThenSave(
    formData,
    previewSpec(declareReliefSchema, previewDeclareRelief),
    declareReliefSpec,
    (v) => ({
      message: "Relief saved. Upload its proof, then verify it so PAYE counts it.",
      paths: [...workerPath(v), SETTINGS_PATH],
    }),
  );
}

/** "Verify" or "Reject" a relief's proof. */
export async function verifyReliefAction(
  _prev: TaxFormState,
  formData: FormData,
): Promise<TaxFormState> {
  return previewThenSave(
    formData,
    previewSpec(verifyReliefSchema, previewVerifyRelief),
    verifyReliefSpec,
    (v) => ({
      message:
        v.decision === "verified"
          ? "Verified. PAYE counts the relief from the next calculation."
          : "Rejected. PAYE doesn't count the relief.",
      paths: [...workerPath(v), SETTINGS_PATH],
    }),
  );
}

/** Settings > Payroll rules: the ITF turnover switch. */
export async function setItfTurnoverAction(
  _prev: TaxFormState,
  formData: FormData,
): Promise<TaxFormState> {
  return previewThenSave(
    formData,
    previewSpec(itfFlagSchema, previewItfFlag),
    itfFlagSpec,
    () => ({
      message: "Saved. Runs use it from their next calculation.",
      paths: [SETTINGS_PATH],
    }),
  );
}

/** "NHF number": set or remove the number on file (shown masked). */
export async function setNhfNumberAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const values = formFields(formData);
  try {
    await mutate(nhfNumberSpec, values);
  } catch (error) {
    const failed = failure(error);
    return {
      ok: false,
      status: error instanceof MutationError && error.code === "forbidden" ? 403 : 400,
      formError: failed.message,
      fieldErrors: failed.fieldErrors,
      values: { ...values, nhfNumber: "" },
    };
  }
  for (const p of workerPath(values)) revalidatePath(p);
  return {
    ok: true,
    status: 200,
    message: values.nhfNumber?.trim() ? "NHF number saved." : "NHF number removed.",
  };
}

export type StartProofResult = ({ ok: true } & StartedProof) | Failure;

/** Step 1 of "Add proof": where the browser uploads the file. */
export async function startReliefProofAction(input: {
  declarationId: string;
  documentKind: string;
  fileName: string;
  size: number;
}): Promise<StartProofResult> {
  try {
    return { ok: true, ...(await mutate(startProofSpec, input)) };
  } catch (error) {
    return failure(error);
  }
}

/** Step 2: the file is uploaded; check it and record it. */
export async function recordReliefProofAction(input: {
  declarationId: string;
  documentKind: string;
  proofId: string;
  fileExt: string;
  workerId: string;
}): Promise<{ ok: true } | Failure> {
  try {
    await mutate(recordProofSpec, input);
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/app/people/${input.workerId}`);
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

export type ProofLinkResult = ({ ok: true } & ProofLink) | Failure;

/** "Open proof": a 60-second link, audited. */
export async function reliefProofLinkAction(input: { proofId: string }): Promise<ProofLinkResult> {
  try {
    return { ok: true, ...(await mutate(proofLinkSpec, input)) };
  } catch (error) {
    return failure(error);
  }
}
