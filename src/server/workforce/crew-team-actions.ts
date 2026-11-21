"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatMinutes } from "@/lib/timesheets/minutes";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import { notifyLeaveDeciders, notifyWorkerOfLeave } from "@/server/people/leave-notices";

import type { WorkerActionState } from "./action-state";
import { lookupCrewSession, type CrewSession } from "./crew-session";
import { crewApproveSpec, crewLeaveStep1Spec, crewRejectSpec, runCrewDecision } from "./crew-team";

/**
 * Server Actions behind /m/team (slice 4.7b): a worker-supervisor or a line manager on the
 * worker app approves or rejects one of their crew's timesheet days, or decides step 1 of a
 * crew member's leave. The session is verified with the Auth server (lookupCrewSession); the SQL
 * functions check the crew again and refuse the caller's own day or leave. The worker is told as
 * from the manager app. Registered in src/server/capabilities/registry.ts. Logs carry error
 * names only.
 */

const FAILED = "That was not saved. Try again in a minute.";

async function decide(
  formData: FormData,
  run: (session: CrewSession, fields: Record<string, string>) => Promise<string>,
): Promise<WorkerActionState> {
  const lookup = await lookupCrewSession();
  if (lookup.type === "signed_out") redirect(WORKER_SIGN_IN_PATH);
  if (lookup.type !== "crew") return { ok: false, message: "Only supervisors decide here." };
  let message: string;
  try {
    message = await run(lookup.session, formFields(formData));
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
      if (error.code === "forbidden" || error.code === "invalid") {
        const field = Object.values(error.fieldErrors).find(Boolean);
        return { ok: false, message: field ?? error.message };
      }
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error("crew_team.decision_failed:", cause instanceof Error ? cause.name : "unknown");
    return { ok: false, message: FAILED };
  }
  revalidatePath("/m/team");
  revalidatePath("/m");
  return { ok: true, message };
}

/** "Approve" on a crew member's day. */
export async function approveCrewDayAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  return decide(formData, async (session, fields) => {
    const result = await runCrewDecision(session, crewApproveSpec, fields);
    return `Approved · ${formatMinutes(result.workedMinutes)} worked`;
  });
}

/** "Reject" with a reason; the worker is told (rejectLineSpec sends the notice). */
export async function rejectCrewDayAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  return decide(formData, async (session, fields) => {
    await runCrewDecision(session, crewRejectSpec, fields);
    return "Rejected · the worker is told";
  });
}

/** Step 1 of a crew member's leave: approve (on to HR) or decline with a note. */
export async function decideCrewLeaveAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  return decide(formData, async (session, fields) => {
    const result = await runCrewDecision(session, crewLeaveStep1Spec, fields);
    const organisationId = session.organisationId;
    if (result.status === "pending_hr") {
      after(async () => {
        await notifyWorkerOfLeave(organisationId, result.id, "line_manager_approved");
        await notifyLeaveDeciders(organisationId, result.id, "hr");
      });
      return `Approved · ${result.days} ${result.days === 1 ? "day" : "days"} sent to HR`;
    }
    after(() => notifyWorkerOfLeave(organisationId, result.id, "line_manager_declined"));
    return "Declined · the worker is told";
  });
}
