import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { z } from "zod";

import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { emailAppUrl } from "@/server/email/config";
import { sendEmail } from "@/server/email/send";
import { emailDisplayName } from "@/server/email/team";
import {
  ReporteesAddedEmail,
  reporteesAddedSubject,
} from "@/server/email/templates/reportees-added";
import { createAdminSupabase } from "@/server/supabase/admin";
import { notifyWorker } from "@/server/workforce/notify";
import type { Database } from "@/types/db";

import type { BulkLineManagerChanged } from "./bulk";

/**
 * After a bulk line manager change (slice U.1), ONE summary to the new line manager ("You're
 * now line manager for 12 people"), not one email per person. Rule 8: email or the inbox.
 *
 * - The contact comes from the same read the single save uses (public.worker_line_manager_contact,
 *   with the saver's own client): a worker line manager's address on their record, or a
 *   manager-app user's confirmed sign-in address. Nobody is told about their own change.
 * - A worker-supervisor (a worker login) gets an inbox item in the worker app, plus an email
 *   within the shared caps (notifyWorker). A manager-app user has no inbox yet, so they get the
 *   email, claimed against the same caps (public.claim_manager_email, 30 per company, 80
 *   overall a day). Past a cap nothing is sent; the people still show on their People list.
 * - Runs after the response; never undoes the change; logs error names only.
 */

type Client = SupabaseClient<Database>;

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;

function logFailure(error: unknown): void {
  console.error(
    "people.bulk_line_manager_notice_failed:",
    error instanceof Error ? error.name : "unknown",
  );
}

export async function notifyNewLineManager(
  supabase: Client,
  change: Pick<BulkLineManagerChanged, "organisationId" | "actorUserId" | "workerIds" | "changed">,
): Promise<"inbox" | "email" | "none"> {
  try {
    const organisationId = z.uuid().parse(change.organisationId);
    const workerId = change.workerIds[0];
    if (!workerId || change.changed < 1) return "none";

    // Everyone selected now has the same line manager: read it through one of them.
    const [{ data: worker }, { data: contacts, error }, { data: org }] = await Promise.all([
      supabase
        .from("workers")
        .select("line_manager_worker_id")
        .eq("organisation_id", organisationId)
        .eq("id", workerId)
        .maybeSingle(),
      supabase.rpc("worker_line_manager_contact", {
        p_organisation_id: organisationId,
        p_worker_id: workerId,
      }),
      supabase.from("organisations").select("name").eq("id", organisationId).maybeSingle(),
    ]);
    if (error) throw new Error(`contact lookup failed (${error.code})`);
    const contact = contacts?.[0];
    const title = `You're now line manager for ${people(change.changed)}`;

    // A worker-supervisor: their worker login has an inbox.
    const lmWorkerId = worker?.line_manager_worker_id ?? null;
    if (lmWorkerId) {
      const { data: login } = await supabase
        .from("memberships")
        .select("user_id, role")
        .eq("organisation_id", organisationId)
        .eq("worker_id", lmWorkerId)
        .maybeSingle();
      if (login?.user_id === change.actorUserId) return "none";
      if (login?.role === "worker") {
        await notifyWorker(organisationId, lmWorkerId, {
          kind: "new_reportees",
          title,
          body: `${people(change.changed)} now ${change.changed === 1 ? "reports" : "report"} to you. Open My team to see them.`,
          link: "/m/team",
        });
        return "inbox";
      }
    }

    if (!contact?.email || contact.user_id === change.actorUserId || !org) return "none";
    if (!z.email().safeParse(contact.email).success) return "none";

    const admin = createAdminSupabase({ channel: "system" });
    const claim = await admin.rpc("claim_manager_email", {
      p_organisation_id: organisationId,
      p_kind: "bulk_line_manager",
      p_ref_id: randomUUID(),
      p_recipients: 1,
      p_org_cap: INBOX_EMAIL_CAPS.perCompany,
      p_global_cap: INBOX_EMAIL_CAPS.overall,
    });
    if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
    if (!claim.data) return "none";

    const organisationName = emailDisplayName(org.name) ?? "your company";
    await sendEmail({
      to: contact.email,
      subject: reporteesAddedSubject(change.changed),
      react: createElement(ReporteesAddedEmail, {
        managerName: emailDisplayName(contact.name),
        count: change.changed,
        organisationName,
        appUrl: emailAppUrl(),
      }),
      tags: [{ name: "type", value: "bulk_line_manager" }],
    });
    return "email";
  } catch (error) {
    logFailure(error);
    return "none";
  }
}
