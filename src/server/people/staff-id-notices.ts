import "server-only";

import {
  sendStaffIdChangedEmail,
  sendStaffIdCorrectionRequestedEmail,
} from "@/server/email/staff-id";
import { createAdminSupabase } from "@/server/supabase/admin";

import { STAFF_ID_CORRECTORS } from "./staff-id-corrections";

/**
 * Tells every owner, admin and HR user who could approve a staff ID correction: not the
 * requester, and not the worker themselves if they hold one of those roles. Runs after the
 * correction is saved (from `after()`) and never undoes it. Reads with the secret key because
 * approvers' addresses live in Supabase Auth; scoped to one organisation and one correction.
 * Failures are logged by error name only, never with an address or name.
 */
export async function notifyApproversOfStaffIdCorrection(
  organisationId: string,
  correctionId: string,
): Promise<number> {
  const logFailure = (what: string, error: unknown) =>
    console.error(`people.${what}:`, error instanceof Error ? error.name : "unknown");
  try {
    const admin = createAdminSupabase();
    const { data: correction, error } = await admin
      .from("staff_id_corrections")
      .select(
        "id, worker_id, status, old_staff_id, new_staff_id, requested_by, workers!staff_id_corrections_worker_fkey ( first_name, last_name ), organisations ( name )",
      )
      .eq("organisation_id", organisationId)
      .eq("id", correctionId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the correction: ${error.code}`);
    if (
      !correction ||
      correction.status !== "pending" ||
      !correction.workers ||
      !correction.organisations
    ) {
      return 0;
    }

    const { data: members, error: membersError } = await admin
      .from("memberships")
      .select("user_id, worker_id")
      .eq("organisation_id", organisationId)
      .in("role", [...STAFF_ID_CORRECTORS]);
    if (membersError) throw new Error(`Could not read approvers: ${membersError.code}`);
    const approvers = (members ?? []).filter(
      (m) => m.user_id !== correction.requested_by && m.worker_id !== correction.worker_id,
    );

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("user_id", correction.requested_by)
      .maybeSingle();
    const requesterName = profile?.full_name?.trim() || "Someone in your company";
    const workerName = `${correction.workers.first_name} ${correction.workers.last_name}`;

    let sent = 0;
    for (const approver of approvers) {
      try {
        const { data: user } = await admin.auth.admin.getUserById(approver.user_id);
        const to = user.user?.email;
        if (!to || !user.user?.email_confirmed_at) continue;
        await sendStaffIdCorrectionRequestedEmail({
          to,
          correctionId: correction.id,
          workerId: correction.worker_id,
          recipientId: approver.user_id,
          organisationName: correction.organisations.name,
          workerName,
          requesterName,
          oldStaffId: correction.old_staff_id,
          newStaffId: correction.new_staff_id,
        });
        sent += 1;
      } catch (sendError) {
        logFailure("staff_id_correction_email_failed", sendError);
      }
    }
    return sent;
  } catch (error) {
    logFailure("staff_id_correction_notice_failed", error);
    return 0;
  }
}

/**
 * Tells the worker their staff ID was corrected (owner decision, 18 Nov 2026), only when their
 * worker record has an email address. Runs after the approval is saved and never undoes it.
 * Failures are logged by error name only.
 */
export async function notifyWorkerOfStaffIdChange(
  organisationId: string,
  correctionId: string,
): Promise<boolean> {
  try {
    const admin = createAdminSupabase();
    const { data: correction, error } = await admin
      .from("staff_id_corrections")
      .select(
        "id, status, new_staff_id, workers!staff_id_corrections_worker_fkey ( first_name, last_name, email ), organisations ( name )",
      )
      .eq("organisation_id", organisationId)
      .eq("id", correctionId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the correction: ${error.code}`);
    const to = correction?.workers?.email;
    if (!correction || correction.status !== "approved" || !to || !correction.organisations) {
      return false;
    }
    await sendStaffIdChangedEmail({
      to,
      correctionId: correction.id,
      organisationName: correction.organisations.name,
      workerName: `${correction.workers!.first_name} ${correction.workers!.last_name}`,
      newStaffId: correction.new_staff_id,
    });
    return true;
  } catch (error) {
    console.error(
      "people.staff_id_changed_email_failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }
}
