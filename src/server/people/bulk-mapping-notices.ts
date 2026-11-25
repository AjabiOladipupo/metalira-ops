import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { fullName } from "@/lib/people";
import { sendMappingChangedEmail } from "@/server/email";
import { emailIsConfigured } from "@/server/email/send";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import type { BulkMapped } from "./bulk-mapping";
import type { SavedMapping } from "./mapping";
import { mappingNotice, shouldNotifyLineManager } from "./mapping-notify";

/**
 * After a bulk mapping (slice U.3): the same email the single save sends (mapping-notify.ts), to
 * the same person, on the same rules, once per person whose mapping changed: their line manager,
 * when they have an address and didn't make the change themselves. Never more than the single
 * path would send, and never an extra channel: the single save sends no inbox item, so neither
 * does this.
 *
 * Unlike the single save, a batch could send up to 200 emails, so each one is first claimed
 * against the shared daily caps (public.claim_manager_email: 30 a company and 80 overall). Past a
 * cap the email is skipped and the person is listed in the result as "not emailed"; the change
 * itself stands. The claims run before the response (so the result can say what was skipped);
 * the sends run after it. Failures are logged by error name and worker id only.
 */

type Client = SupabaseClient<Database>;

export interface PlannedNotices {
  /** Emails claimed under the caps, to send after the response. */
  send: (() => Promise<void>)[];
  /** People whose line manager wasn't emailed because the daily email limit was reached. */
  skipped: { workerId: string; name: string }[];
}

const NONE: PlannedNotices = { send: [], skipped: [] };

function lineManagerKey(saved: SavedMapping): string | null {
  const lm = saved.after.lineManager;
  return lm ? `${lm.kind}:${lm.id}` : null;
}

function logFailure(workerId: string, error: unknown): void {
  console.error(
    `mapping.notify_failed for worker ${workerId}:`,
    error instanceof Error ? error.name : "unknown error",
  );
}

export async function planBulkMappingNotices(
  supabase: Client,
  mapped: Pick<BulkMapped, "organisationId" | "actorUserId" | "saved">,
): Promise<PlannedNotices> {
  const due = mapped.saved.filter(shouldNotifyLineManager);
  if (due.length === 0 || !emailIsConfigured()) return NONE;
  const organisationId = z.uuid().parse(mapped.organisationId);

  try {
    const [{ data: workers, error: workersError }, { data: org }] = await Promise.all([
      supabase
        .from("workers")
        .select("id, staff_id, first_name, last_name")
        .eq("organisation_id", organisationId)
        .in(
          "id",
          due.map((s) => s.workerId),
        ),
      supabase.from("organisations").select("name").eq("id", organisationId).maybeSingle(),
    ]);
    if (workersError) throw new Error(`worker lookup failed (${workersError.code})`);
    if (!org) return NONE;
    const workerOf = new Map((workers ?? []).map((w) => [w.id, w]));

    // One address lookup per line manager (the single save's read, with the saver's own client).
    const contactOf = new Map<string, { email: string; name: string | null } | null>();
    for (const saved of due) {
      const key = lineManagerKey(saved);
      if (!key || contactOf.has(key)) continue;
      const { data: contacts, error } = await supabase.rpc("worker_line_manager_contact", {
        p_organisation_id: organisationId,
        p_worker_id: saved.workerId,
      });
      if (error) throw new Error(`contact lookup failed (${error.code})`);
      const contact = contacts?.[0];
      contactOf.set(
        key,
        contact?.email &&
          contact.user_id !== mapped.actorUserId &&
          z.email().safeParse(contact.email).success
          ? { email: contact.email, name: contact.name }
          : null,
      );
    }

    const admin = createAdminSupabase({ channel: "system" });
    const plan: PlannedNotices = { send: [], skipped: [] };
    let capReached = false;
    for (const saved of due) {
      const key = lineManagerKey(saved);
      const contact = key ? contactOf.get(key) : null;
      const worker = workerOf.get(saved.workerId);
      if (!contact || !worker) continue;
      const workerName = fullName({ firstName: worker.first_name, lastName: worker.last_name });
      if (!capReached) {
        const claim = await admin.rpc("claim_manager_email", {
          p_organisation_id: organisationId,
          p_kind: "bulk_mapping",
          p_ref_id: randomUUID(),
          p_recipients: 1,
          p_org_cap: INBOX_EMAIL_CAPS.perCompany,
          p_global_cap: INBOX_EMAIL_CAPS.overall,
        });
        if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
        capReached = !claim.data;
      }
      if (capReached) {
        plan.skipped.push({ workerId: saved.workerId, name: workerName });
        continue;
      }
      const notice = mappingNotice(saved, contact.name);
      plan.send.push(async () => {
        try {
          await sendMappingChangedEmail({
            to: contact.email,
            workerName,
            staffId: worker.staff_id,
            organisationName: org.name,
            ...notice,
          });
        } catch (error) {
          logFailure(saved.workerId, error);
        }
      });
    }
    return plan;
  } catch (error) {
    logFailure("batch", error);
    return NONE;
  }
}

/** Sends the claimed emails a few at a time. Never throws. */
export async function sendPlannedNotices(plan: PlannedNotices): Promise<void> {
  const queue = [...plan.send];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await next();
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}
