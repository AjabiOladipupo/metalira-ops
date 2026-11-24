"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError, mutate } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { ownContext, runOwnChangeRequest } from "@/server/people/own-requests";
import type { WorkerActionState } from "@/server/workforce/action-state";

import { payslipDownloadLink, type PayslipLink } from "./payslip-documents";
import { loadMyPayslips } from "./payslip-reads";
import {
  askHrSchema,
  downloadPayslipSpec,
  payslipIdSchema,
  publishPayslipsSpec,
  publishSummary,
} from "./payslips";

/**
 * Server Actions for payslips (slice 5.5): the worker downloads their own PDF and asks HR from
 * /m/payslips (their own session, channel worker_app); owner, hr and finance download any PDF on
 * the run's Payslips page; owner and finance finish publishing a released run. Registered in
 * src/server/capabilities/registry.ts. Logs carry error names only, never URLs or text typed.
 */

export type PayslipLinkState = { ok: true; url: string } | { ok: false; message: string };

const LINK_MESSAGES: Record<Exclude<PayslipLink, { ok: true }>["reason"], string> = {
  not_found: "That payslip wasn't found. Reload the page.",
  not_ready: "The PDF isn't ready yet. Try again in a minute.",
  forbidden: "You can't open this payslip.",
};

function linkState(link: PayslipLink): PayslipLinkState {
  return link.ok ? link : { ok: false, message: LINK_MESSAGES[link.reason] };
}

/** "Download PDF" in the worker app: the worker's own released payslip, as a 60-second link. */
export async function downloadMyPayslipAction(input: unknown): Promise<PayslipLinkState> {
  const parsed = payslipIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: LINK_MESSAGES.not_found };
  try {
    const ctx = await ownContext();
    return linkState(
      await payslipDownloadLink(ctx.supabase, ctx.organisationId, parsed.data.payslipId),
    );
  } catch (error) {
    if (error instanceof MutationError && error.code === "unauthenticated") {
      redirect(WORKER_SIGN_IN_PATH);
    }
    console.error(
      "payroll.my_payslip_download_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return { ok: false, message: "The PDF didn't open. Try again in a minute." };
  }
}

/** "PDF" on the run's Payslips page (owner, hr, finance). */
export async function downloadPayslipAction(input: unknown): Promise<PayslipLinkState> {
  try {
    return linkState(await mutate(downloadPayslipSpec, input));
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
      if (error.code === "forbidden") return { ok: false, message: LINK_MESSAGES.forbidden };
      if (error.code === "invalid") return { ok: false, message: LINK_MESSAGES.not_found };
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error(
      "payroll.payslip_download_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
    return { ok: false, message: "The PDF didn't open. Try again in a minute." };
  }
}

/** "Finish publishing" on a released run (owner, finance): PDFs and notices still missing. */
export async function publishPayslipsAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const input = formFields(formData);
  try {
    const result = await mutate(publishPayslipsSpec, input);
    revalidatePath(`/app/payroll/${input.runId ?? ""}/payslips`);
    return { ok: true, status: 200, message: publishSummary(result) };
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
      if (error.code === "forbidden") return { ok: false, status: 403, formError: error.message };
      if (error.code === "invalid") return { ok: false, status: 400, formError: error.message };
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error(
      "payroll.payslips_publish_failed:",
      cause instanceof Error ? cause.name : "unknown error",
    );
    return { ok: false, status: 500, formError: "That didn't finish. Try again in a minute." };
  }
}

/**
 * "Ask HR" from a payslip: a request HR sees on the worker's page (topic other), with the
 * payslip's month in front. Only for the worker's own released payslip.
 */
export async function askHrAboutPayslipAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  const parsed = askHrSchema.safeParse(formFields(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check your question." };
  }
  try {
    const ctx = await ownContext();
    const mine = await loadMyPayslips(ctx.supabase, ctx.organisationId);
    const slip = mine.find((p) => p.payslipId === parsed.data.payslipId);
    if (!slip) return { ok: false, message: LINK_MESSAGES.not_found };
    await runOwnChangeRequest(ctx, {
      topic: "other",
      details: `About my ${slip.month} payslip: ${parsed.data.question}`,
    });
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
      if (error.code === "invalid") {
        return {
          ok: false,
          message: error.fieldErrors.details ?? (error.message || "Check your question."),
        };
      }
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error("payroll.ask_hr_failed:", cause instanceof Error ? cause.name : "unknown error");
    return { ok: false, message: "Your question wasn't sent. Try again in a minute." };
  }
  revalidatePath("/m/me");
  revalidatePath("/app/people", "layout");
  return { ok: true, message: "Sent to HR. They see it on your record and will get back to you." };
}
