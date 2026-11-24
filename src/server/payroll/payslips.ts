import "server-only";

import { z } from "zod";

import { normaliseQueryText, queryTextProblem } from "@/lib/queries";
import { MutationError, type MutationSpec } from "@/server/identity/mutate";

import {
  PAYSLIP_PUBLISHERS,
  PAYSLIP_READERS,
  PublishPayslipsError,
  payslipDownloadLink,
  publishPayslips,
  type PayslipLink,
  type PublishResult,
} from "./payslip-documents";

/**
 * The payslip writes and reads behind Server Actions (slice 5.5). Managers go through
 * `mutate()` (role, module payroll, Zod); the worker app uses the worker's own session
 * (src/server/people/own-requests.ts `ownContext`, channel worker_app).
 */

const reload = "Reload the page and try again";

export const payslipIdSchema = z.object({ payslipId: z.uuid(reload) });
export const publishPayslipsSchema = z.object({ runId: z.uuid(reload) });

/** Longest question, leaving room for "About my October 2026 payslip: " within HR's 500. */
export const ASK_HR_MAX = 400;
const QUESTION_MESSAGES = {
  length: `Write your question in 3 to ${ASK_HR_MAX} characters.`,
  markup: "Use plain text, without < or >.",
  web: "Leave web addresses out.",
  number: "Leave out long numbers such as phone, account or ID numbers.",
} as const;

/**
 * "Ask HR" from a payslip: the question, plain text under 4.6's query rules (no markup, no web
 * addresses, no run of 10 or more digits), with the payslip it is about.
 */
export const askHrSchema = z.object({
  payslipId: z.uuid(reload),
  question: z
    .string(QUESTION_MESSAGES.length)
    .transform(normaliseQueryText)
    .superRefine((value, ctx) => {
      const problem = queryTextProblem(value, { min: 3, max: ASK_HR_MAX }, true);
      if (problem) ctx.addIssue({ code: "custom", message: QUESTION_MESSAGES[problem] });
    }),
});

/** A manager's download: a 60-second link after open_payslip_document says yes (audited). */
export const downloadPayslipSpec: MutationSpec<typeof payslipIdSchema, PayslipLink> = {
  schema: payslipIdSchema,
  roles: PAYSLIP_READERS,
  module: "payroll",
  run: ({ supabase, organisationId, data }) =>
    payslipDownloadLink(supabase, organisationId, data.payslipId),
};

/**
 * "Finish publishing" on a released run: makes the PDFs and notices a failed or interrupted
 * release left out. Owner or finance (the people who release). Idempotent.
 */
export const publishPayslipsSpec: MutationSpec<typeof publishPayslipsSchema, PublishResult> = {
  schema: publishPayslipsSchema,
  roles: PAYSLIP_PUBLISHERS,
  module: "payroll",
  run: async ({ supabase, organisationId, userId, data }) => {
    // Read as the user first: RLS decides they may see the run at all.
    const { data: run, error } = await supabase
      .from("payroll_runs")
      .select("id, status")
      .eq("organisation_id", organisationId)
      .eq("id", data.runId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the run (${error.code})`);
    if (!run) throw new MutationError("invalid", "That payroll run wasn't found. Reload the page.");
    if (run.status !== "released") {
      throw new MutationError("invalid", "Payslips are published once the run is released.");
    }
    try {
      return await publishPayslips(organisationId, data.runId, { actorId: userId });
    } catch (cause) {
      if (cause instanceof PublishPayslipsError) throw new MutationError("invalid", cause.message);
      throw cause;
    }
  },
  event: ({ result, data }) => ({
    action: "payroll.payslips_published",
    entity: "payroll_runs",
    entityId: data.runId,
    after: {
      payslips: result.payslips,
      made: result.made,
      kept: result.kept,
      failed: result.failed,
      notified: result.notified,
      emailed: result.emailed,
      notice_failed: result.noticeFailed,
    },
  }),
};

/** What the publish step says, numbers first. */
export function publishSummary(r: PublishResult): string {
  const pdfs = r.made + r.kept;
  const parts = [`${pdfs} of ${r.payslips} payslip PDFs made`, `${r.notified} workers told`];
  if (r.failed + r.noticeFailed > 0) {
    parts.push(`${r.failed + r.noticeFailed} still to do. Press Finish publishing again`);
  }
  return `${parts.join(", ")}.`;
}
