import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { z } from "zod";

import type { ManagerRole } from "@/lib/roles";
import type { InviteChannel, RosterWorker } from "@/lib/worker-invites";
import { sendWorkerInviteEmail } from "@/server/email";
import type { Database } from "@/types/db";

import { appOrigin } from "./origin";
import { MutationError, type MutationSpec } from "./mutate";

/**
 * Worker invites, manager side (slice 1.9): the roster with each worker's sign-in status,
 * creating invites (public.create_worker_invites, which revokes any open invite for the same
 * worker and returns the raw tokens once), emailing them, and the printable QR sheet.
 *
 * Owners, admins and HR only (the database checks the role again). A new invite for a worker
 * who already signed up is a PIN reset: when they use it, their old PIN and sessions stop
 * working.
 */

export const INVITERS = ["owner", "admin", "hr"] as const satisfies readonly ManagerRole[];

type Client = SupabaseClient<Database>;

const PAGE = 1000;

/** Every row of a query, a page at a time (PostgREST caps one read at 1000). */
async function readAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read the invite roster: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** YYYY-MM-DD in Africa/Lagos. */
function lagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(now);
}

/** Active workers with their current site, login and open invite, sorted by name. */
export async function loadInviteRoster(
  supabase: Client,
  organisationId: string,
): Promise<RosterWorker[]> {
  const today = lagosToday();
  const [workers, credentials, invites, assignments, sites] = await Promise.all([
    readAll((from, to) =>
      supabase
        .from("workers")
        .select("id, staff_id, first_name, last_name, email")
        .eq("organisation_id", organisationId)
        .eq("status", "active")
        .order("id")
        .range(from, to),
    ),
    readAll((from, to) =>
      supabase
        .from("worker_credentials")
        .select("worker_id, pin_set_at, last_sign_in_at, locked_until")
        .eq("organisation_id", organisationId)
        .order("id")
        .range(from, to),
    ),
    readAll((from, to) =>
      supabase
        .from("worker_invites")
        .select("worker_id, sent_via, created_at, expires_at")
        .eq("organisation_id", organisationId)
        .is("used_at", null)
        .is("revoked_at", null)
        .order("id")
        .range(from, to),
    ),
    readAll((from, to) =>
      supabase
        .from("worker_assignments")
        .select("worker_id, site_id, effective_from")
        .eq("organisation_id", organisationId)
        .not("site_id", "is", null)
        .lte("effective_from", today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order("id")
        .range(from, to),
    ),
    readAll((from, to) =>
      supabase
        .from("sites")
        .select("id, name")
        .eq("organisation_id", organisationId)
        .order("id")
        .range(from, to),
    ),
  ]);

  const siteNames = new Map(sites.map((s) => [s.id, s.name]));
  const credentialOf = new Map(credentials.map((c) => [c.worker_id, c]));
  const inviteOf = new Map(invites.map((i) => [i.worker_id, i]));
  // The most recent current assignment with a site wins.
  const siteOf = new Map<string, { siteId: string; from: string }>();
  for (const a of assignments) {
    if (!a.site_id) continue;
    const seen = siteOf.get(a.worker_id);
    if (!seen || a.effective_from > seen.from) {
      siteOf.set(a.worker_id, { siteId: a.site_id, from: a.effective_from });
    }
  }

  return workers
    .map((w): RosterWorker => {
      const credential = credentialOf.get(w.id);
      const invite = inviteOf.get(w.id);
      const siteId = siteOf.get(w.id)?.siteId ?? null;
      return {
        id: w.id,
        staffId: w.staff_id,
        firstName: w.first_name,
        lastName: w.last_name,
        hasEmail: w.email !== null,
        siteId,
        siteName: siteId ? (siteNames.get(siteId) ?? null) : null,
        pinSetAt: credential?.pin_set_at ?? null,
        lastSignInAt: credential?.last_sign_in_at ?? null,
        lockedUntil: credential?.locked_until ?? null,
        openInvite: invite
          ? {
              sentVia: invite.sent_via === "email" ? "email" : "print",
              createdAt: invite.created_at,
              expiresAt: invite.expires_at,
            }
          : null,
      };
    })
    .sort(
      (a, b) =>
        a.lastName.localeCompare(b.lastName, "en", { sensitivity: "base" }) ||
        a.firstName.localeCompare(b.firstName, "en", { sensitivity: "base" }) ||
        a.staffId.localeCompare(b.staffId),
    );
}

// ---------------------------------------------------------------------------
// Creating invites
// ---------------------------------------------------------------------------

export const createInvitesSchema = z.object({
  workerIds: z
    .array(z.uuid())
    .min(1, "Choose at least one employee.")
    .max(1000, "Choose at most 1,000 employees at a time."),
  channel: z.enum(["email", "print"]),
});

export interface CreatedInvite {
  inviteId: string;
  workerId: string;
  token: string;
  expiresAt: string;
}

/** Creates the invites as the signed-in manager. The raw tokens exist only in the result. */
export const createInvitesSpec: MutationSpec<typeof createInvitesSchema, CreatedInvite[]> = {
  schema: createInvitesSchema,
  roles: INVITERS,
  run: async ({ supabase, organisationId, data }) => {
    const { data: rows, error } = await supabase.rpc("create_worker_invites", {
      p_organisation_id: organisationId,
      p_worker_ids: data.workerIds,
      p_sent_via: data.channel,
    });
    if (error) {
      if (error.code === "42501") {
        throw new MutationError("forbidden", "Your role can't invite workers.");
      }
      if (error.code === "P0002" || error.code === "22023") {
        throw new MutationError("invalid", error.message);
      }
      throw new Error(`create_worker_invites failed (${error.code})`);
    }
    return (rows ?? []).map((row) => ({
      inviteId: row.invite_id,
      workerId: row.invite_worker_id,
      token: row.token,
      expiresAt: row.invite_expires_at,
    }));
  },
  event: ({ result, data }) => ({
    action: "worker_invites.created",
    entity: "worker_invites",
    after: { count: result.length, channel: data.channel },
  }),
};

/**
 * The origin for invite links: the site the manager is using (so a preview deployment prints
 * links to itself), else NEXT_PUBLIC_APP_URL. Server Actions only accept same-origin posts, so
 * the Origin header here is the app's own.
 */
export async function inviteOrigin(): Promise<string> {
  const origin = (await headers()).get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // Fall through.
    }
  }
  return appOrigin();
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/m/invite/${token}`;
}

export interface InviteRecipient {
  workerId: string;
  firstName: string;
  lastName: string;
  staffId: string;
  email: string | null;
}

/** Names, staff IDs and emails of the invited workers, read under RLS. */
export async function loadRecipients(
  supabase: Client,
  organisationId: string,
  workerIds: readonly string[],
): Promise<Map<string, InviteRecipient>> {
  const out = new Map<string, InviteRecipient>();
  for (let i = 0; i < workerIds.length; i += 200) {
    const { data, error } = await supabase
      .from("workers")
      .select("id, first_name, last_name, staff_id, email")
      .eq("organisation_id", organisationId)
      .in("id", workerIds.slice(i, i + 200));
    if (error) throw new Error(`Could not read the invited workers: ${error.message}`);
    for (const w of data ?? []) {
      out.set(w.id, {
        workerId: w.id,
        firstName: w.first_name,
        lastName: w.last_name,
        staffId: w.staff_id,
        email: w.email,
      });
    }
  }
  return out;
}

export interface EmailOutcome {
  sent: number;
  /** Not sent because email is not set up on this deployment (no Resend key). */
  skipped: number;
  failed: number;
}

/** Emails each invite, a few at a time. A failure is counted and logged without the address. */
export async function emailInvites(
  invites: readonly CreatedInvite[],
  recipients: Map<string, InviteRecipient>,
  company: { name: string; companyCode: string },
  origin: string,
): Promise<EmailOutcome> {
  const outcome: EmailOutcome = { sent: 0, skipped: 0, failed: 0 };
  const queue = [...invites];
  async function worker() {
    for (let invite = queue.shift(); invite; invite = queue.shift()) {
      const person = recipients.get(invite.workerId);
      if (!person?.email) {
        outcome.failed += 1;
        continue;
      }
      try {
        const result = await sendWorkerInviteEmail({
          to: person.email,
          firstName: person.firstName,
          organisationName: company.name,
          companyCode: company.companyCode,
          staffId: person.staffId,
          inviteUrl: inviteUrl(origin, invite.token),
          expiresAt: new Date(invite.expiresAt),
          inviteId: invite.inviteId,
        });
        if (result.status === "sent") outcome.sent += 1;
        else outcome.skipped += 1;
      } catch (error) {
        outcome.failed += 1;
        console.error(
          `worker_invite.email_failed for invite ${invite.inviteId}:`,
          error instanceof Error ? error.name : "unknown error",
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
  return outcome;
}

export interface SheetEntry {
  workerId: string;
  name: string;
  staffId: string;
  siteName: string | null;
  url: string;
  /** data:image/svg+xml;base64,… */
  qr: string;
}

/** One printable card per invite: name, staff ID, link and its QR code. */
export async function sheetEntries(
  invites: readonly CreatedInvite[],
  recipients: Map<string, InviteRecipient>,
  sites: Map<string, string | null>,
  origin: string,
): Promise<SheetEntry[]> {
  const entries = await Promise.all(
    invites.map(async (invite) => {
      const person = recipients.get(invite.workerId);
      if (!person) return null;
      const url = inviteUrl(origin, invite.token);
      const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
      return {
        workerId: invite.workerId,
        name: `${person.firstName} ${person.lastName}`,
        staffId: person.staffId,
        siteName: sites.get(invite.workerId) ?? null,
        url,
        qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      };
    }),
  );
  return entries
    .filter((e): e is SheetEntry => e !== null)
    .sort(
      (a, b) =>
        (a.siteName ?? "~").localeCompare(b.siteName ?? "~") || a.name.localeCompare(b.name),
    );
}

export type { InviteChannel };
