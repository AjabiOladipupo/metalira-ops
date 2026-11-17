import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { formatDate } from "@/lib/dates";
import { describeChange, mappingChanges, type MappingSnapshot } from "@/lib/mapping";
import { fullName } from "@/lib/people";
import { sendMappingChangedEmail } from "@/server/email";
import type { Database } from "@/types/db";

import type { SavedMapping } from "./mapping";
import type { EditedMapping, LineManagerEdit } from "./workers";

/**
 * Tells the worker's line manager about a mapping change by email (docs/PHASE_1.md 1.6; owner
 * decision 5: managers are told by email, no SMS). Runs after the response (next/server
 * `after()`), so a slow or failed send never holds up the save; failures are logged by name
 * only, never with the address.
 *
 * Who is told: the line manager after the change, when they have an address (a worker line
 * manager's email on their record, or a manager-app user's confirmed sign-in address), and not
 * when they made the change themselves. Nothing is sent when nothing changed.
 *
 * Two saves lead here: the mapping panel (`saveMappingAction`) and "Edit details"
 * (`updateWorkerAction`) when it changes the line manager. Both send the same email.
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

// ---------------------------------------------------------------------------
// A line manager changed through "Edit details"
// ---------------------------------------------------------------------------

/** Names for the ids an edit points at. A missing name reads "Not set" or "A manager". */
export interface EditNames {
  departments: ReadonlyMap<string, string>;
  workers: ReadonlyMap<string, string>;
  memberships: ReadonlyMap<string, string | null>;
}

function snapshotOf(m: EditedMapping, names: EditNames): MappingSnapshot {
  const department = m.departmentId
    ? { id: m.departmentId, name: names.departments.get(m.departmentId) ?? "A department" }
    : null;
  const { workerId, membershipId } = m.lineManager;
  const lineManager = workerId
    ? { kind: "worker" as const, id: workerId, name: names.workers.get(workerId) ?? null }
    : membershipId
      ? {
          kind: "membership" as const,
          id: membershipId,
          name: names.memberships.get(membershipId) ?? null,
        }
      : null;
  // The form doesn't change sites or projects, so they are left out of both sides.
  return { department, lineManager, sites: [], projects: [] };
}

/**
 * The edit as a saved mapping, so it goes through the same rules and email as the mapping
 * panel. Department and line manager change at once; no site or project changed. Pure.
 */
export function savedMappingFromEdit(edit: LineManagerEdit, names: EditNames): SavedMapping {
  const before = snapshotOf(edit.before, names);
  const after = snapshotOf(edit.after, names);
  return {
    workerId: edit.workerId,
    organisationId: edit.organisationId,
    actorUserId: edit.actorUserId,
    changed: true,
    lineManagerChanged: true,
    assignmentsChanged: false,
    // Only shown when sites or projects changed, which this form never does.
    effectiveFrom: new Date().toISOString().slice(0, 10),
    before,
    after,
  };
}

function idsOf(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

/** Looks up the names the email needs, with the saver's own client. */
async function loadEditNames(supabase: Client, edit: LineManagerEdit): Promise<EditNames> {
  const sides = [edit.before, edit.after];
  const departmentIds = idsOf(sides.map((s) => s.departmentId));
  const workerIds = idsOf(sides.map((s) => s.lineManager.workerId));
  const membershipIds = idsOf(sides.map((s) => s.lineManager.membershipId));
  const org = edit.organisationId;

  const [departments, workers, memberships] = await Promise.all([
    departmentIds.length
      ? supabase
          .from("departments")
          .select("id, name")
          .eq("organisation_id", org)
          .in("id", departmentIds)
      : Promise.resolve({ data: [], error: null }),
    workerIds.length
      ? supabase
          .from("workers")
          .select("id, first_name, last_name")
          .eq("organisation_id", org)
          .in("id", workerIds)
      : Promise.resolve({ data: [], error: null }),
    membershipIds.length
      ? supabase
          .from("memberships")
          .select("id, user_id")
          .eq("organisation_id", org)
          .in("id", membershipIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (departments.error || workers.error || memberships.error) {
    throw new Error("name lookup failed");
  }

  const userIds = idsOf((memberships.data ?? []).map((m) => m.user_id));
  const profiles = userIds.length
    ? await supabase.from("profiles").select("user_id, full_name").in("user_id", userIds)
    : { data: [], error: null };
  if (profiles.error) throw new Error("name lookup failed");
  const profileName = new Map(
    (profiles.data ?? []).map((p) => [p.user_id, p.full_name?.trim() || null]),
  );

  return {
    departments: new Map((departments.data ?? []).map((d) => [d.id, d.name])),
    workers: new Map(
      (workers.data ?? []).map((w) => [
        w.id,
        fullName({ firstName: w.first_name, lastName: w.last_name }),
      ]),
    ),
    memberships: new Map(
      (memberships.data ?? []).map((m) => [m.id, profileName.get(m.user_id) ?? null]),
    ),
  };
}

/**
 * Tells the new line manager about a change saved through "Edit details": the same email, to
 * the same person, on the same rules as the mapping panel. Never throws.
 */
export async function notifyLineManagerOfEdit(
  supabase: Client,
  edit: LineManagerEdit,
): Promise<void> {
  // Nobody to tell when the line manager was cleared.
  if (!edit.after.lineManager.workerId && !edit.after.lineManager.membershipId) return;
  let saved: SavedMapping;
  try {
    saved = savedMappingFromEdit(edit, await loadEditNames(supabase, edit));
  } catch (error) {
    console.error(
      `mapping.notify_failed for worker ${edit.workerId}:`,
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
    return;
  }
  await notifyLineManager(supabase, saved);
}
