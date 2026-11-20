import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { INBOX_EMAIL_CAPS, inboxMessageSchema, type InboxMessage } from "@/lib/inbox";
import { emailAppUrl } from "@/server/email/config";
import { sendEmail } from "@/server/email/send";
import { emailDisplayName } from "@/server/email/team";
import { WorkerNoticeEmail, workerNoticeSubject } from "@/server/email/templates/worker-notice";
import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * Tells one worker something (slice 3.1): an inbox item in the worker app, always, and an email
 * when the worker has an address and the caps allow. Rule 8: email or in-app only.
 *
 * - Server code only, with the secret key: workers can't add items to their own inbox. It does
 *   no authorisation of its own: call it only after the caller has checked who may notify whom,
 *   with `organisationId` and `workerId` from a verified session (mutate's context) or a job
 *   record, never from request input. The database refuses a worker of
 *   another organisation (composite foreign key) and any text with a web address or markup.
 * - Email caps (Resend Free: 100 a day for the whole account): at most 30 per company and 80
 *   overall in any 24 hours (INBOX_EMAIL_CAPS), claimed atomically by public.claim_inbox_email.
 *   Past a cap the email is skipped and the item stays in the inbox. A claimed email that then
 *   fails to send still counts, so a Resend outage can't turn into a burst later.
 * - Text that looks like a web address ("acme-pay.com") never reaches an email from Metalira's
 *   domain: the email falls back to generic wording and the worker reads it in the app.
 * - Logs carry error names and ids only, never addresses or message text.
 */

const DOMAIN_LIKE = /\b[a-z0-9-]+\.[a-z]{2,}\b/i;

export interface NotifyResult {
  itemId: string;
  email: "sent" | "skipped_no_email" | "skipped_cap" | "skipped_no_key" | "failed";
}

const idsSchema = z.object({ organisationId: z.uuid(), workerId: z.uuid() });

/** The worker already has the inbox item for this roster publication (slice 3.3). */
export class AlreadyNotifiedError extends Error {
  override name = "AlreadyNotifiedError";
}

export interface NotifyOptions {
  /**
   * The roster publication this notice is for (slice 3.3). The database keeps one item per
   * worker per publication, so a second notice for the same version throws AlreadyNotifiedError.
   */
  rosterPublicationId?: string;
}

export async function notifyWorker(
  organisationId: string,
  workerId: string,
  message: InboxMessage,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const ids = idsSchema.parse({ organisationId, workerId });
  const publicationId = options.rosterPublicationId
    ? z.uuid().parse(options.rosterPublicationId)
    : null;
  const data = inboxMessageSchema.parse(message);
  const admin = createAdminSupabase({ channel: "system" });

  const inserted = await admin
    .from("inbox_items")
    .insert({
      organisation_id: ids.organisationId,
      worker_id: ids.workerId,
      kind: data.kind,
      title: data.title,
      body: data.body,
      link_path: data.link ?? null,
      ...(publicationId ? { roster_publication_id: publicationId } : {}),
    })
    .select("id")
    .single();
  if (inserted.error?.code === "23505" && publicationId) {
    throw new AlreadyNotifiedError("This worker was already told about this roster version");
  }
  if (inserted.error) {
    throw new Error(`Could not add the inbox item (${inserted.error.code})`);
  }
  const itemId = inserted.data.id;

  const worker = await admin
    .from("workers")
    .select("first_name, email, status, organisations ( name )")
    .eq("organisation_id", ids.organisationId)
    .eq("id", ids.workerId)
    .single();
  if (worker.error) throw new Error(`Could not read the worker (${worker.error.code})`);
  const email = worker.data.email?.trim();
  if (!email || worker.data.status !== "active" || !z.email().safeParse(email).success) {
    return { itemId, email: "skipped_no_email" };
  }

  const claim = await admin.rpc("claim_inbox_email", {
    p_item_id: itemId,
    p_org_cap: INBOX_EMAIL_CAPS.perCompany,
    p_global_cap: INBOX_EMAIL_CAPS.overall,
  });
  if (claim.error) throw new Error(`Could not check the email caps (${claim.error.code})`);
  if (!claim.data) return { itemId, email: "skipped_cap" };

  const appUrl = emailAppUrl();
  const organisationName = emailDisplayName(worker.data.organisations?.name ?? null);
  const title = emailDisplayName(data.title);
  const body = DOMAIN_LIKE.test(data.body) ? null : data.body;
  try {
    const sent = await sendEmail({
      to: email,
      subject: workerNoticeSubject(title, organisationName),
      react: createElement(WorkerNoticeEmail, {
        organisationName,
        workerName: emailDisplayName(worker.data.first_name),
        title,
        body,
        openUrl: `${appUrl}${data.link ?? "/m/inbox"}`,
        appUrl,
      }),
      tags: [
        { name: "type", value: "worker_notice" },
        { name: "kind", value: data.kind },
      ],
      idempotencyKey: `worker-notice/${itemId}`,
    });
    return { itemId, email: sent.status === "sent" ? "sent" : "skipped_no_key" };
  } catch (error) {
    console.error(
      "workforce.notify_email_failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return { itemId, email: "failed" };
  }
}
