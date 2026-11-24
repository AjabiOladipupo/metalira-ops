import "server-only";

import type { z } from "zod";

import { formatNaira } from "@/lib/money";
import { runMonth } from "@/lib/payroll/run-format";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";

import {
  approvedRun,
  fromPayoutDbError,
  loadActiveBatch,
  PAYOUT_MAKERS,
  RELEASE_TWO_PERSON_MESSAGE,
} from "./payouts";
import { runIdSchema } from "./runs";

/**
 * Release (slice 5.4, docs/PHASE_5.md decision 9): Finance or the owner confirms the run's bank
 * file went to the company's own bank. `release_payroll_run` (as the user, trusted session)
 * needs an active bank file and refuses anyone who prepared or changed the run (rule 10, the same
 * list approval uses: private.payroll_run_touchers); approved -> released, with its decision row,
 * audited. Metalira moves no money (rule 6): release records what the company did at its bank.
 *
 * After a release the server calls `onPayrollReleased(organisationId, runId)`, the one hook for
 * what follows. Slice 5.5 adds payslip publication there (PDFs, inbox items, emails).
 */

export const releaseRunSchema = runIdSchema;

/** The release preview: the file's control totals and what release does. */
export async function previewRelease(
  ctx: Pick<MutationContext, "supabase" | "organisationId" | "userId">,
  data: z.output<typeof releaseRunSchema>,
): Promise<CapabilityPreview> {
  const run = await approvedRun(ctx.supabase, ctx.organisationId, data.runId);
  // The database checks the full list (every recalculation, adjustment and acknowledgement too).
  if ([run.preparedBy, run.submittedBy, run.calculatedBy].includes(ctx.userId)) {
    throw new MutationError("invalid", RELEASE_TWO_PERSON_MESSAGE);
  }
  const batch = await loadActiveBatch(ctx.supabase, ctx.organisationId, run.id);
  if (!batch) {
    throw new MutationError(
      "invalid",
      "Make the bank file and upload it to the bank before releasing.",
    );
  }
  const money = formatNaira(batch.totalKobo, { whole: true });
  return {
    summary: `Releases ${runMonth(run.periodEnd)} payroll: you confirm the bank file (${batch.itemCount} ${batch.itemCount === 1 ? "worker" : "workers"}, ${money}, SHA-256 ${batch.fileSha256.slice(0, 12)}…) was uploaded to the company's bank. Workers can then see their payslips. This can't be undone.`,
    changes: [
      { label: "Status", before: "Approved", after: "Released" },
      { label: "Workers in the file", after: String(batch.itemCount) },
      { label: "Total", after: money },
    ],
  };
}

/** Releases an approved run (owner or finance, never whoever prepared or changed it). */
export const releaseRunSpec: MutationSpec<
  typeof releaseRunSchema,
  { runId: string; decisionId: string }
> = {
  module: "payroll",
  schema: releaseRunSchema,
  roles: PAYOUT_MAKERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: decisionId, error } = await supabase.rpc("release_payroll_run", {
      p_organisation_id: organisationId,
      p_run_id: data.runId,
    });
    if (error) fromPayoutDbError(error);
    return { runId: data.runId, decisionId: decisionId! };
  },
};

/** One thing that follows a release, given the company and the run. */
export type ReleaseFollowUp = (organisationId: string, runId: string) => Promise<void>;

/**
 * What follows a release, in order. Slice 5.5 adds payslip publication here (make the PDFs, then
 * an inbox item per worker and the "Your payslip is ready" email, inside the caps). Each step must
 * be idempotent: a retry may run it again.
 */
export const RELEASE_FOLLOW_UPS: readonly ReleaseFollowUp[] = [];

/**
 * Runs after a release commits (from the Server Action, in `after()`), once per release: the
 * single hook point for what follows (RELEASE_FOLLOW_UPS). Never throws: a failed step is logged
 * by error name only, the others still run, and the run stays released.
 */
export async function onPayrollReleased(organisationId: string, runId: string): Promise<void> {
  for (const step of RELEASE_FOLLOW_UPS) {
    try {
      await step(organisationId, runId);
    } catch (error) {
      console.error(
        "payroll.release_followup_failed:",
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }
}
