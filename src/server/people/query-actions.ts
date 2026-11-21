"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { formatDate } from "@/lib/dates";
import { type InboxMessage } from "@/lib/inbox";
import { queryClosedNotice, queryFollowUpNotice, newQueryNotice } from "@/lib/queries";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import { MutationError } from "@/server/identity/mutate";
import { formFields } from "@/server/identity/schemas";
import type { WorkerActionState } from "@/server/workforce/action-state";
import { notifyWorker } from "@/server/workforce/notify";

import { ownContext } from "./own-requests";
import { closeQuery, followUpQuery, raiseQuery, runReplyToQuery, withdrawQuery } from "./queries";

/**
 * Server Actions for queries (slice 4.6): managers raise, follow up, close and withdraw from the
 * HR file on the person page; the worker replies from /m/queries. Each goes through `mutate()`
 * (manager) or the worker's own session, then one SQL function that checks again. The worker is
 * told by inbox (and email within notifyWorker's caps) when a query is raised, followed up or
 * closed; a failed notice never undoes the saved change. Logs carry error names only.
 */

const FAILED = "That was not saved. Try again in a minute.";

function refusal(error: unknown, values?: Record<string, string>): CompanyFormState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") {
      return { ok: false, status: 403, formError: error.message, values };
    }
    if (error.code === "invalid") {
      const fieldErrors = error.fieldErrors;
      return {
        ok: false,
        status: 400,
        formError: Object.keys(fieldErrors).length > 0 ? undefined : error.message,
        fieldErrors,
        values,
      };
    }
  }
  const cause = error instanceof MutationError ? error.cause : error;
  console.error("people.query_failed:", cause instanceof Error ? cause.name : "unknown error");
  return { ok: false, status: 500, formError: FAILED, values };
}

/** Tells the worker; never throws (the change is saved whatever happens to the notice). */
async function tell(organisationId: string, workerId: string, message: InboxMessage) {
  try {
    await notifyWorker(organisationId, workerId, message);
  } catch (error) {
    console.error(
      "people.query_notice_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
  }
}

function refreshWorker(workerId: string) {
  revalidatePath(`/app/people/${workerId}`);
  revalidatePath("/m/queries");
}

/** "Send query" on the HR file. */
export async function raiseQueryAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let raised;
  try {
    raised = await raiseQuery(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  await tell(raised.organisationId, raised.workerId, newQueryNotice(raised));
  refreshWorker(raised.workerId);
  return {
    ok: true,
    status: 200,
    message: `Query sent. Reply needed by ${formatDate(raised.replyBy)}. The employee sees it in their app.`,
  };
}

/** "Add follow-up" on an open query. */
export async function followUpQueryAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await followUpQuery(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  await tell(result.organisationId, result.workerId, queryFollowUpNotice(result));
  refreshWorker(result.workerId);
  return { ok: true, status: 200, message: "Follow-up added. The employee sees it in their app." };
}

/** "Close query" with an outcome note. */
export async function closeQueryAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await closeQuery(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  if (result.subject) {
    await tell(result.organisationId, result.workerId, queryClosedNotice({ subject: result.subject }));
  }
  refreshWorker(result.workerId);
  return { ok: true, status: 200, message: "Query closed. The outcome stays on the HR file." };
}

/** "Withdraw query" with a reason (the person who raised it). */
export async function withdrawQueryAction(
  _prev: CompanyFormState,
  formData: FormData,
): Promise<CompanyFormState> {
  const fields = formFields(formData);
  let result;
  try {
    result = await withdrawQuery(fields);
  } catch (error) {
    return refusal(error, fields);
  }
  refreshWorker(result.workerId);
  return { ok: true, status: 200, message: "Query withdrawn. It stays on the HR file." };
}

/** The worker's "Send reply" on /m/queries. */
export async function replyToQueryAction(
  _prev: WorkerActionState,
  formData: FormData,
): Promise<WorkerActionState> {
  try {
    await runReplyToQuery(await ownContext(), formFields(formData));
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") redirect(WORKER_SIGN_IN_PATH);
      if (error.code === "forbidden" || error.code === "invalid") {
        return { ok: false, message: error.fieldErrors.body ?? error.message };
      }
    }
    const cause = error instanceof MutationError ? error.cause : error;
    console.error("people.query_reply_failed:", cause instanceof Error ? cause.name : "unknown error");
    return { ok: false, message: "Your reply wasn't sent. Try again in a minute." };
  }
  revalidatePath("/m/queries");
  revalidatePath("/m");
  return { ok: true, message: "Reply sent. It goes to your manager and on your HR file." };
}
