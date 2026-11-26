import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { z } from "zod";

import { formatDate } from "@/lib/dates";
import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { emailAppUrl } from "@/server/email/config";
import { emailIsConfigured, sendEmail } from "@/server/email/send";
import { emailDisplayName } from "@/server/email/team";
import { TeamMappedEmail, teamMappedSubject } from "@/server/email/templates/team-mapped";
import { createAdminSupabase } from "@/server/supabase/admin";
import type { Database } from "@/types/db";

import type { BulkMapped } from "./bulk-mapping";
import type { SavedMapping } from "./mapping";
import { shouldNotifyLineManager } from "./mapping-notify";

/**
 * After a bulk mapping (slice U.3): ONE summary email per line manager ("Site and projects
 * changed for 12 people on your team"), not one per person (security review M1), as U.1's bulk
 * line manager change does (bulk-notices.ts).
 *
 * - Who: the line manager of each person whose mapping changed, on the single save's rules: they
 *   have an address (public.worker_line_manager_contact, with the saver's own client) and didn't
 *   make the change themselves. The single save sends no inbox item, so neither does this.
 * - Caps: one claim per line manager under the shared daily caps (public.claim_manager_email, 30 a
 *   company and 80 overall), with a ref_id derived from the batch and the line manager (UUID v5),
 *   so the same batch can never email the same manager twice. Past a cap the email is skipped
 *   and the people concerned are listed in the result; the change itself stands.
 * - The claims run before the response (so the result can say what was skipped); the sends run
 *   after it. Failures are logged by error name only.
 */

type Client = SupabaseClient<Database>;

export interface ManagerContact {
  email: string;
  name: string | null;
}

export interface NoticeIo {
  /** The line manager's address, read through one of their reportees, or null for none. */
  contactFor: (workerId: string) => Promise<(ManagerContact & { userId: string | null }) | null>;
  /** Claims one email under the caps; true when it may be sent. */
  claim: (refId: string) => Promise<boolean>;
}

export interface ManagerSummary {
  to: ManagerContact;
  count: number;
  siteName: string | null;
  appliesFrom: string | null;
}

export interface PlannedNotices {
  /** One summary per line manager, claimed under the caps, to send after the response. */
  summaries: ManagerSummary[];
  /** People whose line manager wasn't emailed because the daily email limit was reached. */
  skipped: { workerId: string }[];
}

const NONE: PlannedNotices = { summaries: [], skipped: [] };

/** RFC 4122 version 5 UUID (SHA-1, URL namespace) of `name`. */
export function uuidV5(name: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const hash = createHash("sha1").update(namespace).update(name, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function lineManagerKey(saved: SavedMapping): string | null {
  const lm = saved.after.lineManager;
  return lm ? `${lm.kind}:${lm.id}` : null;
}

/** The people to tell about, grouped by their line manager after the change. Pure. */
export function groupByLineManager(saved: readonly SavedMapping[]): Map<string, SavedMapping[]> {
  const groups = new Map<string, SavedMapping[]>();
  for (const s of saved) {
    if (!shouldNotifyLineManager(s)) continue;
    const key = lineManagerKey(s);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return groups;
}

/**
 * Plans the summaries: one contact lookup and at most one claim per line manager. Once a claim is
 * refused (a cap is reached), the remaining managers are skipped without claiming.
 */
export async function planSummaries(
  mapped: Pick<BulkMapped, "actorUserId" | "saved" | "siteId" | "batchRef">,
  io: NoticeIo,
): Promise<PlannedNotices> {
  const plan: PlannedNotices = { summaries: [], skipped: [] };
  let capReached = false;
  for (const [key, group] of groupByLineManager(mapped.saved)) {
    const contact = await io.contactFor(group[0]!.workerId);
    if (!contact || contact.userId === mapped.actorUserId) continue;
    if (!z.email().safeParse(contact.email).success) continue;
    if (!capReached) {
      capReached = !(await io.claim(uuidV5(`bulk_mapping:${mapped.batchRef}:${key}`)));
    }
    if (capReached) {
      plan.skipped.push(...group.map((s) => ({ workerId: s.workerId })));
      continue;
    }
    const dates = [
      ...new Set(group.filter((s) => s.assignmentsChanged).map((s) => s.effectiveFrom)),
    ];
    const site = group[0]!.after.sites.find((s) => s.id === mapped.siteId)?.name ?? null;
    plan.summaries.push({
      to: { email: contact.email, name: contact.name },
      count: group.length,
      siteName: site,
      appliesFrom: dates.length === 1 ? formatDate(dates[0]!) : null,
    });
  }
  return plan;
}

export async function planBulkMappingNotices(
  supabase: Client,
  mapped: Pick<BulkMapped, "organisationId" | "actorUserId" | "saved" | "siteId" | "batchRef">,
): Promise<PlannedNotices> {
  if (!emailIsConfigured() || groupByLineManager(mapped.saved).size === 0) return NONE;
  try {
    const organisationId = z.uuid().parse(mapped.organisationId);
    const admin = createAdminSupabase({ channel: "system" });
    return await planSummaries(mapped, {
      contactFor: async (workerId) => {
        const { data, error } = await supabase.rpc("worker_line_manager_contact", {
          p_organisation_id: organisationId,
          p_worker_id: workerId,
        });
        if (error) throw new Error(`contact lookup failed (${error.code})`);
        const contact = data?.[0];
        return contact?.email
          ? { email: contact.email, name: contact.name, userId: contact.user_id }
          : null;
      },
      claim: async (refId) => {
        const claim = await admin.rpc("claim_manager_email", {
          p_organisation_id: organisationId,
          p_kind: "bulk_mapping",
          p_ref_id: refId,
          p_recipients: 1,
          p_org_cap: INBOX_EMAIL_CAPS.perCompany,
          p_global_cap: INBOX_EMAIL_CAPS.overall,
        });
        if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
        return claim.data === true;
      },
    });
  } catch (error) {
    console.error(
      "people.bulk_mapping_notice_failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return NONE;
  }
}

/** Sends the planned summaries, one per line manager. Never throws. */
export async function sendPlannedNotices(
  supabase: Client,
  organisationId: string,
  plan: PlannedNotices,
): Promise<void> {
  if (plan.summaries.length === 0) return;
  try {
    const { data: org } = await supabase
      .from("organisations")
      .select("name")
      .eq("id", organisationId)
      .maybeSingle();
    const organisationName = emailDisplayName(org?.name ?? null) ?? "your company";
    for (const summary of plan.summaries) {
      try {
        await sendEmail({
          to: summary.to.email,
          subject: teamMappedSubject(summary.count),
          react: createElement(TeamMappedEmail, {
            managerName: emailDisplayName(summary.to.name),
            count: summary.count,
            siteName: emailDisplayName(summary.siteName),
            appliesFrom: summary.appliesFrom,
            organisationName,
            appUrl: emailAppUrl(),
          }),
          tags: [{ name: "type", value: "bulk_mapping" }],
        });
      } catch (error) {
        console.error(
          "people.bulk_mapping_notice_failed:",
          error instanceof Error ? error.name : "unknown",
        );
      }
    }
  } catch (error) {
    console.error(
      "people.bulk_mapping_notice_failed:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
