"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { lagosDate, plural } from "@/lib/worker-invites";
import { createServerSupabase } from "@/lib/supabase/server";

import { getActiveCompany } from "./company-data";
import { MutationError, mutate } from "./mutate";
import { getSession } from "./session";
import type { InviteActionState } from "./worker-invite-state";
import {
  createInvitesSpec,
  emailInvites,
  INVITERS,
  inviteOrigin,
  loadInviteRoster,
  loadRecipients,
  sheetEntries,
} from "./worker-invites";

/**
 * Server Actions for /app/people/invites. Each one authorises (owner, admin or hr of the active
 * organisation) and creates the invites through mutate(); the database checks the role again
 * and audits every invite row. The raw links exist only in the email or in the returned sheet.
 */

const INVITES_PATH = "/app/people/invites";

function refusal(error: unknown): InviteActionState {
  if (error instanceof MutationError) {
    if (error.code === "unauthenticated") redirect(SIGN_IN_PATH);
    if (error.code === "forbidden") {
      return {
        ok: false,
        status: 403,
        message: "Only the owner, an admin or HR can invite workers.",
      };
    }
    if (error.code === "invalid") {
      return {
        ok: false,
        status: 400,
        message: Object.values(error.fieldErrors)[0] ?? error.message,
      };
    }
  }
  console.error(
    "worker_invite.failed:",
    error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
  );
  return {
    ok: false,
    status: 500,
    message: "The invites were not created. Try again in a minute.",
  };
}

/**
 * The active company when the signed-in user may invite there (owner, admin, hr), else null.
 * Signed out goes to sign-in. mutate() and the database check the role again.
 */
async function inviterCompany() {
  const session = await getSession();
  if (!session) redirect(SIGN_IN_PATH);
  const role = session.active?.role;
  if (!role || !(INVITERS as readonly string[]).includes(role)) return null;
  return getActiveCompany();
}

function selectedIds(formData: FormData): string[] {
  return formData.getAll("workerId").filter((v): v is string => typeof v === "string");
}

/** Emails a single-use invite link to each chosen worker that has an email address. */
export async function emailWorkerInvites(
  _prev: InviteActionState,
  formData: FormData,
): Promise<InviteActionState> {
  const company = await inviterCompany();
  if (!company) return refusal(new MutationError("forbidden", ""));
  try {
    const supabase = await createServerSupabase();
    const ids = selectedIds(formData);
    const recipients = await loadRecipients(supabase, company.id, ids);
    const withEmail = ids.filter((id) => recipients.get(id)?.email);
    if (withEmail.length === 0) {
      return {
        ok: false,
        status: 400,
        message: "None of the chosen employees has an email address. Print a sheet instead.",
      };
    }

    const invites = await mutate(createInvitesSpec, { workerIds: withEmail, channel: "email" });
    const origin = await inviteOrigin();
    const outcome = await emailInvites(invites, recipients, company, origin);
    revalidatePath(INVITES_PATH);

    const parts = [`Invites created for ${plural(invites.length, "employee")}.`];
    if (outcome.sent > 0) parts.push(`${plural(outcome.sent, "email")} sent.`);
    if (outcome.skipped > 0) {
      parts.push(
        `Email is not set up here, so ${plural(outcome.skipped, "email")} did not go out. Print a sheet instead.`,
      );
    }
    if (outcome.failed > 0) parts.push(`${plural(outcome.failed, "email")} could not be sent.`);
    const noEmail = ids.length - withEmail.length;
    if (noEmail > 0)
      parts.push(`${plural(noEmail, "employee")} with no email address need a printed sheet.`);
    return { ok: true, kind: "email", message: parts.join(" ") };
  } catch (error) {
    return refusal(error);
  }
}

/** Creates printed-sheet invites for the chosen workers and returns the cards to print. */
export async function createInviteSheet(
  _prev: InviteActionState,
  formData: FormData,
): Promise<InviteActionState> {
  const company = await inviterCompany();
  if (!company) return refusal(new MutationError("forbidden", ""));
  try {
    const ids = selectedIds(formData);
    const invites = await mutate(createInvitesSpec, { workerIds: ids, channel: "print" });

    const supabase = await createServerSupabase();
    const [recipients, roster] = await Promise.all([
      loadRecipients(supabase, company.id, ids),
      loadInviteRoster(supabase, company.id),
    ]);
    const sites = new Map(roster.map((w) => [w.id, w.siteName]));
    const cards = await sheetEntries(invites, recipients, sites, await inviteOrigin());
    revalidatePath(INVITES_PATH);

    const expiresAt = invites[0]?.expiresAt ?? new Date().toISOString();
    return {
      ok: true,
      kind: "print",
      message: `Invite sheet ready for ${plural(cards.length, "employee")}.`,
      companyName: company.name,
      companyCode: company.companyCode,
      expiresOn: lagosDate(expiresAt),
      cards,
    };
  } catch (error) {
    return refusal(error);
  }
}
