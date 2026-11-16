import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { formatDate } from "@/lib/dates";
import { describeChange, mappingChanges, type MappingSnapshot } from "@/lib/mapping";
import { fullName } from "@/lib/people";
import { sendMappingChangedEmail } from "@/server/email";
import type { Database } from "@/types/db";

import type { SavedMapping } from "./mapping";

/**
 * Tells the worker's line manager about a mapping change by email (docs/PHASE_1.md 1.6; owner
 * decision 5: managers are told by email, no SMS). Runs after the response (next/server
 * `after()`), so a slow or failed send never holds up the save; failures are logged by name
 * only, never with the address.
 *
 * Who is told: the line manager after the change, when they have an address (a worker line
 * manager's email on their record, or a manager-app user's confirmed sign-in address), and not
 * when they made the change themselves. Nothing is sent when nothing changed.
 */

type Client = SupabaseClient<Database>;

/** Plain text that may go into an email: no control characters, angle brackets or links. */
function emailSafe(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || text.length > 200) return null;
  if (/[\p{Cc}<>]/u.test(text) || /:\/\/|www\./i.test(text)) return null;
  return text;
}

/** The snapshot with every name made email-safe (a manager's profile name is free text). */
function safeSnapshot(s: MappingSnapshot): MappingSnapshot {
  return {
    ...s,
    lineManager: s.lineManager ? { ...s.lineManager, name: emailSafe(s.lineManager.name) } : null,
  };
}

/** True when the change is worth telling the line manager about. */
export function shouldNotifyLineManager(saved: SavedMapping): boolean {
  return saved.changed && saved.after.lineManager !== null;
}

export interface MappingNotice {
  managerName: string | null;
  reportsToYou: boolean;
  changes: string[];
  appliesFrom: string | null;
}

/** What the email says, from the before and after snapshots. Pure. */
export function mappingNotice(saved: SavedMapping, managerName: string | null): MappingNotice {
  const changes = mappingChanges(safeSnapshot(saved.before), safeSnapshot(saved.after));
  return {
    managerName: emailSafe(managerName),
    reportsToYou: saved.lineManagerChanged,
    changes: changes.map(describeChange),
    appliesFrom: saved.assignmentsChanged ? formatDate(saved.effectiveFrom) : null,
  };
}

/** Sends the email for one saved mapping, with the saver's own client. Never throws. */
export async function notifyLineManager(supabase: Client, saved: SavedMapping): Promise<void> {
  if (!shouldNotifyLineManager(saved)) return;
  try {
    const [{ data: contacts, error }, { data: worker }, { data: org }] = await Promise.all([
      supabase.rpc("worker_line_manager_contact", {
        p_organisation_id: saved.organisationId,
        p_worker_id: saved.workerId,
      }),
      supabase
        .from("workers")
        .select("staff_id, first_name, last_name")
        .eq("organisation_id", saved.organisationId)
        .eq("id", saved.workerId)
        .maybeSingle(),
      supabase.from("organisations").select("name").eq("id", saved.organisationId).maybeSingle(),
    ]);
    if (error) throw new Error(`contact lookup failed (${error.code})`);
    const contact = contacts?.[0];
    // No address on file, or the manager made the change themselves.
    if (!contact?.email || contact.user_id === saved.actorUserId) return;
    if (!worker || !org) return;

    const notice = mappingNotice(saved, contact.name);
    await sendMappingChangedEmail({
      to: contact.email,
      workerName: fullName({ firstName: worker.first_name, lastName: worker.last_name }),
      staffId: worker.staff_id,
      organisationName: org.name,
      ...notice,
    });
  } catch (error) {
    console.error(
      `mapping.notify_failed for worker ${saved.workerId}:`,
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
  }
}
