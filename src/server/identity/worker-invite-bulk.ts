import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { INVITE_SKIP_TEXT, inviteSkipCode, type InviteSkipCode } from "@/lib/bulk-approve";
import { INBOX_EMAIL_CAPS } from "@/lib/inbox";

import {
  LIST_BULK_LIMIT,
  confirmSelection,
  expectedDigestSchema,
  idSet,
  idsSchema,
  previewedSet,
  resolveSelection,
  type PreviewedSet,
} from "./bulk-selection";
import { MutationError, type MutationContext, type MutationSpec } from "./mutate";
import { INVITERS, loadInviteRoster, type CreatedInvite } from "./worker-invites";

/**
 * "Resend" and "Cancel invite" for the workers ticked on /app/people/invites (slice U.2), with
 * the single invite's rules and roles (owner, admin or hr; create_worker_invites revokes the open
 * invite and makes a new one).
 *
 * - Resend: public.bulk_resend_worker_invites emails a fresh invite to each worker whose last
 *   invite wasn't used, claiming each email first under the shared email caps (30 a company and
 *   80 overall a day, src/lib/inbox.ts). Past a cap the worker is skipped, keeps their open
 *   invite and is listed; so are leavers, workers with no email, the never invited and the
 *   signed up. The emails go out through the existing invite email (emailInvites).
 * - Cancel: public.bulk_cancel_worker_invites revokes each open invite so its link stops working;
 *   no open invite, or an expired one, is skipped.
 *
 * Both preview with a dry run and confirm with the preview's digest (MLLB3 when the ticked
 * workers now resolve differently; MLLB2 for a worker not on the caller's invite list). One audit
 * row per invite and one for the batch, in the function's transaction. Raw tokens exist only in
 * the confirm's result on the server, on their way into the email; never returned to the screen.
 */

export const INVITE_BULK_ACTIONS = ["resend", "cancel"] as const;
export type InviteBulkAction = (typeof INVITE_BULK_ACTIONS)[number];

export const previewInviteBulkSchema = z.object({
  action: z.enum(INVITE_BULK_ACTIONS),
  workerIds: idsSchema(LIST_BULK_LIMIT, "employees"),
});

export const inviteBulkSchema = previewInviteBulkSchema.extend({
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
  /** Resent or cancelled (or, in the preview, will be). */
  done: InviteBulkWorker[];
  skipped: InviteBulkSkipped[];
  /** Send `selection.digest` back with the confirm. */
  selection: PreviewedSet;
}

/** The confirm's result on the server: with the new invites to email after a resend. */
export interface InviteBulkResult extends InviteBulkPreview {
  invites: CreatedInvite[];
}

const workerRow = z.object({
  worker_id: z.string(),
  name: z.string().nullable(),
  staff_id: z.string().nullable(),
});

const resultSchema = z.object({
  sent: z
    .array(
      workerRow.extend({
        invite_id: z.string(),
        expires_at: z.string(),
        token: z.string().nullable(),
      }),
    )
    .optional(),
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

async function visibleWorkers(ctx: Pick<MutationContext, "supabase" | "organisationId">) {
  const roster = await loadInviteRoster(ctx.supabase, ctx.organisationId);
  return idSet(roster.map((w) => w.id));
}

async function run(
  ctx: Pick<MutationContext, "supabase" | "organisationId">,
  action: InviteBulkAction,
  ids: string[],
  dryRun: boolean,
): Promise<InviteBulkResult> {
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
  const worker = (w: z.infer<typeof workerRow>): InviteBulkWorker => ({
    workerId: w.worker_id,
    name: w.name,
    staffId: w.staff_id,
  });
  const done = action === "resend" ? (r.sent ?? []) : (r.cancelled ?? []);
  return {
    action,
    done: done.map(worker),
    skipped: r.skipped.flatMap((s) => {
      const code = inviteSkipCode(s.code);
      return code ? [{ ...worker(s), code, reason: INVITE_SKIP_TEXT[code] }] : [];
    }),
    selection: previewedSet(ids),
    invites: (r.sent ?? []).flatMap((s) =>
      s.token
        ? [
            {
              inviteId: s.invite_id,
              workerId: s.worker_id,
              token: s.token,
              expiresAt: s.expires_at,
            },
          ]
        : [],
    ),
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
    // The preview never carries tokens (the dry run makes none that last).
    const { invites: _none, ...preview } = await run(ctx, ctx.data.action, ids, true);
    void _none;
    return preview;
  },
};

export const inviteBulkSpec: MutationSpec<typeof inviteBulkSchema, InviteBulkResult> = {
  module: "people",
  schema: inviteBulkSchema,
  roles: INVITERS,
  run: async (ctx) => {
    const ids = confirmSelection(
      ctx.data.workerIds,
      await visibleWorkers(ctx),
      ctx.data.expectedDigest,
    );
    return run(ctx, ctx.data.action, ids, false);
  },
  // The function writes one audit row per invite and one for the batch, in its transaction.
};
