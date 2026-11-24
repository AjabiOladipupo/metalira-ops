import "server-only";

import { z } from "zod";

import { formatNaira, type Kobo } from "@/lib/money";
import { runMonth } from "@/lib/payroll/run-format";
import type { CapabilityPreview } from "@/server/capabilities/types";
import { MutationError, type MutationContext, type MutationSpec } from "@/server/identity/mutate";

import { publishPayslips } from "./payslip-documents";
import {
  approvedRun,
  fromPayoutDbError,
  loadActiveBatch,
  loadFileDownloads,
  PAYOUT_MAKERS,
  RELEASE_TWO_PERSON_MESSAGE,
} from "./payouts";

/**
 * Release (slice 5.4, docs/PHASE_5.md decision 9): Finance or the owner confirms the run's bank
 * file went to the company's own bank. `release_payroll_run` (as the user, trusted session) needs
 * the active file named by id and SHA-256, downloaded at least once, and refuses anyone who
 * prepared or changed the run (rule 10, the same list approval uses:
 * private.payroll_run_touchers) and whoever made the file; approved -> released, with its decision
 * row, audited. The approver may release, so P prepares and makes the file, F approves and
 * releases. Metalira moves no money (rule 6): release records what the company did at its bank.
 *
 * After a release (and a retry of one) the server calls `onPayrollReleased(organisationId, runId,
 * { actorId })`, the one hook for what follows: slice 5.5's payslip publication (PDFs, inbox
 * items, emails).
 */

/**
 * The release names the file the person checked (money review H2): its id and SHA-256, as the
 * Pay step showed them. The database refuses if another file replaced it since (MLBFC).
 */
export const releaseRunSchema = z.object({
  runId: z.uuid("Reload the page and try again"),
  batchId: z.uuid("Reload the page and try again"),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/, "Reload the page and try again"),
});

/** Security review M1, as the person reads it. */
export const RELEASE_MAKER_MESSAGE =
  "You made this bank file, so a different person must confirm it went to the bank.";

/**
 * The release preview: the file's control totals, who is left out of it (they stay outstanding
 * after release), and what release does. Refuses up front what the database will refuse.
 */
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
  if (batch.id !== data.batchId || batch.fileSha256 !== data.fileSha256) {
    throw new MutationError(
      "invalid",
      "The bank file changed since you looked. Reload the page, check the control totals and confirm again.",
    );
  }
  if (batch.madeBy === ctx.userId) throw new MutationError("invalid", RELEASE_MAKER_MESSAGE);
  const downloads = await loadFileDownloads(ctx.supabase, ctx.organisationId, run.id);
  if (!downloads.some((d) => d.batchId === batch.id)) {
    throw new MutationError(
      "invalid",
      "Nobody has downloaded this bank file yet. Download it and upload it to the bank first.",
    );
  }
  const money = (k: Kobo) => formatNaira(k, { whole: true });
  const leftOut =
    batch.leftOutCount > 0
      ? ` ${batch.leftOutCount} ${batch.leftOutCount === 1 ? "worker is" : "workers are"} not in this file (${money(batch.leftOutKobo)}): they stay outstanding on the Pay step until paid.`
      : "";
  return {
    summary: `Releases ${runMonth(run.periodEnd)} payroll: you confirm the bank file (${batch.itemCount} ${batch.itemCount === 1 ? "worker" : "workers"}, ${money(batch.totalKobo)}, SHA-256 ${batch.fileSha256.slice(0, 12)}…) was uploaded to the company's bank.${leftOut} Workers can then see their payslips. This can't be undone.`,
    changes: [
      { label: "Status", before: "Approved", after: "Released" },
      { label: "Workers in the file", after: String(batch.itemCount) },
      { label: "Total", after: money(batch.totalKobo) },
      {
        label: "Left out (outstanding)",
        after: `${batch.leftOutCount} · ${money(batch.leftOutKobo)}`,
      },
    ],
  };
}

/**
 * Releases an approved run (owner or finance; never whoever prepared or changed it, nor whoever
 * made the file). A retry of a release that already went through returns its decision (money
 * review M2), so the follow-ups run again.
 */
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
      p_batch_id: data.batchId,
      p_file_sha256: data.fileSha256,
    });
    if (error) {
      if (error.code === "MLBFA") throw new MutationError("invalid", RELEASE_MAKER_MESSAGE);
      fromPayoutDbError(error);
    }
    return { runId: data.runId, decisionId: decisionId! };
  },
};

/** One thing that follows a release, given the company, the run and who released it. */
export type ReleaseFollowUp = (
  organisationId: string,
  runId: string,
  options: { actorId: string | null },
) => Promise<unknown>;

/**
 * What follows a release, in order. Each step must be idempotent: a retried release (money review
 * M2) runs them again. Slice 5.5's publication: make every payslip PDF, then an inbox item per
 * worker and the "Your payslip is ready" email, inside the caps.
 */
export const RELEASE_FOLLOW_UPS: readonly ReleaseFollowUp[] = [
  (organisationId, runId, { actorId }) => publishPayslips(organisationId, runId, { actorId }),
];

/**
 * Runs after a release commits (from the Server Action, in `after()`, once the database call
 * returned), on a first release and on a retry of it: the single hook point for what follows
 * (RELEASE_FOLLOW_UPS). Never throws: a failed step is logged by error name only, the others
 * still run, and the run stays released (Finance can finish publishing from the Payslips page).
 */
export async function onPayrollReleased(
  organisationId: string,
  runId: string,
  options: { actorId: string | null } = { actorId: null },
): Promise<void> {
  for (const step of RELEASE_FOLLOW_UPS) {
    try {
      await step(organisationId, runId, options);
    } catch (error) {
      console.error(
        "payroll.release_followup_failed:",
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }
}
