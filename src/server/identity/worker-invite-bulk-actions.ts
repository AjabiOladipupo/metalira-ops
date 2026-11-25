"use server";

import { revalidatePath } from "next/cache";

import { bulkSummary } from "@/lib/bulk-approve";
import { createServerSupabase } from "@/lib/supabase/server";

import { listBulkRefusal, type ListBulkResult } from "./bulk-action-result";
import { getCompany } from "./company-data";
import { MutationError, mutate } from "./mutate";
import { getSession } from "./session";
import {
  inviteBulkSpec,
  previewInviteBulkSpec,
  type InviteBulkPreview,
} from "./worker-invite-bulk";
import { emailInvites, inviteOrigin, loadRecipients } from "./worker-invites";

/**
 * Server Actions for "Resend" and "Cancel invite" on /app/people/invites (slice U.2). Each goes
 * through `mutate()` (owner, admin or hr, Zod, the caller's own client); the database checks the
 * role again, claims each resend under the shared email caps and audits every invite. The new
 * links go out by the invite email and are never returned to the screen.
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
  try {
    const { invites, ...result } = await mutate(inviteBulkSpec, input);
    const skipped = result.skipped.map((s) => s.reason);
    let message: string;
    if (result.action === "resend") {
      let sent = 0;
      if (invites.length > 0) {
        const organisationId = (await getSession())?.active?.organisationId;
        const company = organisationId ? await getCompany(organisationId) : null;
        if (!company) throw new MutationError("forbidden", "Your role can't invite workers.");
        const supabase = await createServerSupabase();
        const recipients = await loadRecipients(
          supabase,
          company.id,
          invites.map((i) => i.workerId),
        );
        const outcome = await emailInvites(invites, recipients, company, await inviteOrigin());
        sent = outcome.sent;
        if (outcome.skipped > 0) {
          skipped.push(
            ...Array<string>(outcome.skipped).fill("Email is not set up here: print a sheet"),
          );
        }
        if (outcome.failed > 0) {
          skipped.push(...Array<string>(outcome.failed).fill("Email couldn't be sent"));
        }
      }
      message = bulkSummary(sent, skipped, { verb: "emailed", done: true });
    } else {
      message = bulkSummary(result.done.length, skipped, { verb: "cancelled", done: true });
    }
    revalidatePath(INVITES_PATH);
    return { ok: true, value: result, message };
  } catch (error) {
    return listBulkRefusal(error, "worker_invite.bulk_failed");
  }
}
