import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { INVITE_SKIP_TEXT, inviteSkipCode, type InviteSkipCode } from "@/lib/bulk-approve";
import { INBOX_EMAIL_CAPS } from "@/lib/inbox";
import { sendWorkerInviteEmail } from "@/server/email";
import { emailIsConfigured } from "@/server/email/send";
import type { Database } from "@/types/db";

import {
  LIST_BULK_LIMIT,
  actIdsSchema,
  confirmPlan,
  expectedDigestSchema,
  idSet,
  idsSchema,
  previewedSet,
  resolveSelection,
  type PreviewScope,
  type PreviewedSet,
} from "./bulk-selection";
import { MutationError, type MutationContext, type MutationSpec } from "./mutate";
import { INVITERS, inviteUrl, loadInviteRoster, type InviteRecipient } from "./worker-invites";

/**
 * "Resend invites" and "Cancel invites" for the workers ticked on /app/people/invites (slice
 * U.2), with the single invite's roles (owner, admin or hr).
 *
 * - Resend, in two steps so nobody is left without a working link (security review M2):
 *   public.bulk_resend_worker_invites claims one email per worker under the caps (invite resends'
 *   own sub-cap of 20 a company a day, one resend per worker a day, then the shared 30 a company
 *   and 80 overall) and changes no invite. The server then emails each claimed worker a new link
 *   it made itself, and public.commit_worker_invite_resends records only the links that went out
 *   (by id and SHA-256): the old invite is revoked only then. A worker whose email failed keeps
 *   their earlier link and is listed as "Link not sent". Nothing starts unless email is set up.
 *   Skipped too: leavers, no email address, never invited, signed up (a PIN set, or the last
 *   invite used), already resent today.
 * - Cancel: public.bulk_cancel_worker_invites revokes each open invite so its link stops
 *   working; no open invite, or an expired one, is skipped.
 *
 * Both preview with a dry run whose digest signs the workers it would act on; the confirm passes
 * only those to the database (security review M1; src/server/identity/bulk-selection.ts). One
 * audit row per invite and one per batch, in the functions' transactions. The raw tokens exist
 * only in memory on the server, on their way into the email; never stored, logged or returned.
 *
 * The single "Email invites" path (createInvitesSpec) claims no cap; this slice leaves it as it
 * is (security review L3).
 */

type Client = SupabaseClient<Database>;

export const INVITE_BULK_ACTIONS = ["resend", "cancel"] as const;
export type InviteBulkAction = (typeof INVITE_BULK_ACTIONS)[number];

export const previewInviteBulkSchema = z.object({
  action: z.enum(INVITE_BULK_ACTIONS),
  workerIds: idsSchema(LIST_BULK_LIMIT, "employees"),
});

export const inviteBulkSchema = previewInviteBulkSchema.extend({
  /** The workers the preview said it would act on (signed by the digest). */
  actIds: actIdsSchema(LIST_BULK_LIMIT),
  expectedDigest: expectedDigestSchema,
});

export interface InviteBulkWorker {
  workerId: string;
  name: string | null;
  staffId: string | null;
}

export interface InviteBulkSkipped extends InviteBulkWorker {
  code: InviteSkipCode;
  reason: string;
}

export interface InviteBulkPreview {
  action: InviteBulkAction;
  /** Will be (or, after a confirm, were) resent or cancelled. */
  done: InviteBulkWorker[];
  skipped: InviteBulkSkipped[];
  /** Send `selection.act` and `selection.digest` back with the confirm. */
  selection: PreviewedSet;
  /** On a confirm: ticked workers the preview skipped, left alone. */
  notInPreview: string[];
}

const workerRow = z.object({
  worker_id: z.string(),
  name: z.string().nullable(),
  staff_id: z.string().nullable(),
});

const resultSchema = z.object({
  sent: z.array(workerRow).optional(),
  cancelled: z.array(workerRow.extend({ invite_id: z.string() })).optional(),
  skipped: z.array(workerRow.extend({ code: z.string() })),
});

function fromDbError(error: PostgrestError): never {
  if (error.code === "42501") {
    throw new MutationError("forbidden", "Only an owner, an admin or HR can invite workers.");
  }
  if (error.code === "MLLB1" || error.code === "MLLB2" || error.code === "22023") {
    throw new MutationError("invalid", error.message, { selection: error.message });
  }
  throw new Error(`Database refused the change (${error.code})`);
}

const actionName = (action: InviteBulkAction) => `people.bulk_invites.${action}`;

async function visibleWorkers(ctx: Pick<MutationContext, "supabase" | "organisationId">) {
  const roster = await loadInviteRoster(ctx.supabase, ctx.organisationId);
  return idSet(roster.map((w) => w.id));
}

function skippedOf(s: z.infer<typeof workerRow> & { code: string }): InviteBulkSkipped[] {
  const code = inviteSkipCode(s.code);
  if (!code) return [];
  return [
    {
      workerId: s.worker_id,
      name: s.name,
      staffId: s.staff_id,
      code,
      reason: INVITE_SKIP_TEXT[code],
    },
  ];
}

async function run(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  action: InviteBulkAction,
  ids: string[],
  dryRun: boolean,
): Promise<Pick<InviteBulkPreview, "done" | "skipped">> {
  const { data, error } =
    action === "resend"
      ? await ctx.supabase.rpc("bulk_resend_worker_invites", {
          p_organisation_id: ctx.organisationId,
          p_worker_ids: ids,
          p_dry_run: dryRun,
          p_org_cap: INBOX_EMAIL_CAPS.perCompany,
          p_global_cap: INBOX_EMAIL_CAPS.overall,
        })
      : await ctx.supabase.rpc("bulk_cancel_worker_invites", {
          p_organisation_id: ctx.organisationId,
          p_worker_ids: ids,
          p_dry_run: dryRun,
        });
  if (error) fromDbError(error);
  const r = resultSchema.parse(data);
  const done = action === "resend" ? (r.sent ?? []) : (r.cancelled ?? []);
  return {
    done: done.map((w) => ({ workerId: w.worker_id, name: w.name, staffId: w.staff_id })),
    skipped: r.skipped.flatMap(skippedOf),
  };
}

export const previewInviteBulkSpec: MutationSpec<
  typeof previewInviteBulkSchema,
  InviteBulkPreview
> = {
  module: "people",
  schema: previewInviteBulkSchema,
  roles: INVITERS,
  run: async (ctx) => {
    const ids = resolveSelection(ctx.data.workerIds, await visibleWorkers(ctx));
    const result = await run(ctx, ctx.data.action, ids, true);
    const scope: PreviewScope = {
      action: actionName(ctx.data.action),
      userId: ctx.userId,
      organisationId: ctx.organisationId,
    };
    return {
      action: ctx.data.action,
      ...result,
      selection: previewedSet(
        scope,
        ids,
        result.done.map((w) => w.workerId),
      ),
      notInPreview: [],
    };
  },
};

export const EMAIL_NOT_SET_UP =
  "Email isn't set up here, so no invite was resent. Print a sheet instead.";

/**
 * The confirm. Cancel: the invites are revoked. Resend: step 1 only (the emails are claimed);
 * `sendAndCommitResends` emails the new links and records the ones that went out.
 */
export const inviteBulkSpec: MutationSpec<typeof inviteBulkSchema, InviteBulkPreview> = {
  module: "people",
  schema: inviteBulkSchema,
  roles: INVITERS,
  run: async (ctx) => {
    const scope: PreviewScope = {
      action: actionName(ctx.data.action),
      userId: ctx.userId,
      organisationId: ctx.organisationId,
    };
    const plan = confirmPlan(
      scope,
      ctx.data.workerIds,
      await visibleWorkers(ctx),
      ctx.data.actIds,
      ctx.data.expectedDigest,
    );
    if (ctx.data.action === "resend" && !emailIsConfigured()) {
      throw new MutationError("invalid", EMAIL_NOT_SET_UP);
    }
    // Only the workers the preview said it would act on reach the database.
    const result = await run(ctx, ctx.data.action, plan.act, false);
    return {
      action: ctx.data.action,
      ...result,
      selection: previewedSet(scope, plan.ids, plan.act),
      notInPreview: plan.rest,
    };
  },
  // The functions write the audit rows (claims, and each invite with its batch) in their
  // transactions.
};

export interface ResendOutcome {
  resent: InviteBulkWorker[];
  /** Claimed but not resent: the email failed, or the record step skipped them. */
  notSent: InviteBulkSkipped[];
}

/**
 * Step 2 of a resend: a new link for each claimed worker, made here (32 random bytes; only its
 * SHA-256 is stored), emailed a few at a time; then public.commit_worker_invite_resends records
 * only the links that went out, revoking the earlier invite at that moment. A worker whose email
 * failed keeps their earlier link. Failures are logged by error name and invite id only.
 */
export async function sendAndCommitResends(
  supabase: Client,
  organisationId: string,
  claimed: readonly InviteBulkWorker[],
  recipients: Map<string, InviteRecipient>,
  company: { name: string; companyCode: string },
  origin: string,
): Promise<ResendOutcome> {
  const notSent = (w: InviteBulkWorker): InviteBulkSkipped => ({
    ...w,
    code: "not_sent",
    reason: INVITE_SKIP_TEXT.not_sent,
  });
  // The expiry the database gives a new invite (7 days); the email shows the date.
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  const sent: { worker: InviteBulkWorker; inviteId: string; tokenHash: string }[] = [];
  const failed: InviteBulkSkipped[] = [];
  const queue = [...claimed];
  async function next() {
    for (let w = queue.shift(); w; w = queue.shift()) {
      const person = recipients.get(w.workerId);
      if (!person?.email) {
        failed.push(notSent(w));
        continue;
      }
      const inviteId = randomUUID();
      const token = randomBytes(32).toString("hex");
      try {
        const result = await sendWorkerInviteEmail({
          to: person.email,
          firstName: person.firstName,
          organisationName: company.name,
          companyCode: company.companyCode,
          staffId: person.staffId,
          inviteUrl: inviteUrl(origin, token),
          expiresAt,
          inviteId,
        });
        if (result.status === "sent") {
          sent.push({
            worker: w,
            inviteId,
            tokenHash: createHash("sha256").update(token).digest("hex"),
          });
        } else {
          failed.push(notSent(w));
        }
      } catch (error) {
        failed.push(notSent(w));
        console.error(
          `worker_invite.bulk_email_failed for invite ${inviteId}:`,
          error instanceof Error ? error.name : "unknown error",
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, next));
  if (sent.length === 0) return { resent: [], notSent: failed };

  const { data, error } = await supabase.rpc("commit_worker_invite_resends", {
    p_organisation_id: organisationId,
    p_invites: sent.map((s) => ({
      worker_id: s.worker.workerId,
      invite_id: s.inviteId,
      token_hash: s.tokenHash,
    })),
  });
  if (error) {
    // Nothing was recorded: the emailed links don't work, and the earlier ones still do.
    console.error("worker_invite.bulk_commit_failed:", error.code);
    return { resent: [], notSent: [...failed, ...sent.map((s) => notSent(s.worker))] };
  }
  const r = z
    .object({
      resent: z.array(z.object({ worker_id: z.string() })),
      skipped: z.array(z.object({ worker_id: z.string(), code: z.string() })),
    })
    .parse(data);
  const recorded = idSet(r.resent.map((x) => x.worker_id));
  return {
    resent: sent.filter((s) => recorded.has(s.worker.workerId)).map((s) => s.worker),
    notSent: [
      ...failed,
      ...sent.filter((s) => !recorded.has(s.worker.workerId)).map((s) => notSent(s.worker)),
    ],
  };
}
