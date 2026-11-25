"use server";

import { revalidatePath } from "next/cache";

import { bulkSummary, INVITE_SKIP_TEXT, NOT_IN_PREVIEW } from "@/lib/bulk-approve";
import { createServerSupabase } from "@/lib/supabase/server";

import { listBulkRefusal, type ListBulkResult } from "./bulk-action-result";
import { getCompany } from "./company-data";
import { mutate } from "./mutate";
import { getSession } from "./session";
import {
  inviteBulkSpec,
  previewInviteBulkSpec,
  sendAndCommitResends,
  type InviteBulkPreview,
} from "./worker-invite-bulk";
import { inviteOrigin, loadRecipients } from "./worker-invites";

/**
 * Server Actions for "Resend invites" and "Cancel invites" on /app/people/invites (slice U.2).
 * Each goes through `mutate()` (owner, admin or hr, Zod, the caller's own client); the database
 * checks the role again, claims each resend under the caps and audits every invite. A resend
 * emails the new links first and records only the ones that went out, so nobody is left without
 * a working link. The links are never returned to the screen.
 */

const INVITES_PATH = "/app/people/invites";

export async function previewInviteBulkAction(
  input: unknown,
): Promise<ListBulkResult<InviteBulkPreview>> {
  try {
    return { ok: true, value: await mutate(previewInviteBulkSpec, input) };
  } catch (error) {
    return listBulkRefusal(error, "worker_invite.bulk_preview_failed");
  }
}

export async function inviteBulkAction(input: unknown): Promise<ListBulkResult<InviteBulkPreview>> {
  let result: InviteBulkPreview;
  try {
    result = await mutate(inviteBulkSpec, input);
  } catch (error) {
    return listBulkRefusal(error, "worker_invite.bulk_failed");
  }
  try {
    if (result.action === "resend" && result.done.length > 0) {
      const organisationId = (await getSession())?.active?.organisationId;
      const company = organisationId ? await getCompany(organisationId) : null;
      const supabase = await createServerSupabase();
      const outcome = company
        ? await sendAndCommitResends(
            supabase,
            company.id,
            result.done,
            await loadRecipients(
              supabase,
              company.id,
              result.done.map((w) => w.workerId),
            ),
            company,
            await inviteOrigin(),
          )
        : { resent: [], notSent: [] };
      result = {
        ...result,
        done: outcome.resent,
        skipped: [...result.skipped, ...outcome.notSent],
      };
    }
  } catch (error) {
    console.error(
      "worker_invite.bulk_send_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    // Nothing recorded: every claimed worker keeps their earlier link.
    if (result.action === "resend") {
      result = {
        ...result,
        done: [],
        skipped: [
          ...result.skipped,
          ...result.done.map((w) => ({
            ...w,
            code: "not_sent" as const,
            reason: INVITE_SKIP_TEXT.not_sent,
          })),
        ],
      };
    }
  } finally {
    revalidatePath(INVITES_PATH);
  }
  const reasons = [
    ...result.skipped.map((s) => s.reason),
    ...result.notInPreview.map(() => NOT_IN_PREVIEW),
  ];
  return {
    ok: true,
    value: result,
    message: bulkSummary(result.done.length, reasons, {
      verb: result.action === "resend" ? "emailed" : "cancelled",
      done: true,
    }),
  };
}
