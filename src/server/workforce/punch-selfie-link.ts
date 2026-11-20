import "server-only";

import { z } from "zod";

import type { ManagerRole } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import { getSession } from "@/server/identity/session";

/**
 * A punch's selfie, opened by a manager (slice 3.5): a 60-second signed URL made with the
 * manager's own session, so Storage's punch_photos_select policy decides (owner, admin and
 * ops_manager of the company, a line manager for their reportees; never public). The link is
 * never logged.
 */

export const SELFIE_READERS: readonly ManagerRole[] = [
  "owner",
  "admin",
  "ops_manager",
  "line_manager",
];

const SIGNED_URL_SECONDS = 60;

export const selfieLinkSchema = z.object({ punchId: z.uuid() });

export type SelfieLinkResult =
  { ok: true; url: string } | { ok: false; reason: "forbidden" | "not_found" | "deleted" };

export async function runPunchSelfieLink(input: unknown): Promise<SelfieLinkResult> {
  const parsed = selfieLinkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "not_found" };
  const session = await getSession();
  const active = session?.active;
  if (!active || !SELFIE_READERS.includes(active.role)) return { ok: false, reason: "forbidden" };

  const supabase = await createServerSupabase();
  const { data: punch, error } = await supabase
    .from("punches")
    .select("selfie_path, selfie_deleted_at")
    .eq("organisation_id", active.organisationId)
    .eq("id", parsed.data.punchId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the punch (${error.code})`);
  if (!punch) return { ok: false, reason: "not_found" };
  if (!punch.selfie_path) {
    return { ok: false, reason: punch.selfie_deleted_at ? "deleted" : "not_found" };
  }
  const { data, error: signError } = await supabase.storage
    .from("punch-photos")
    .createSignedUrl(punch.selfie_path, SIGNED_URL_SECONDS);
  if (signError || !data?.signedUrl) return { ok: false, reason: "forbidden" };
  return { ok: true, url: data.signedUrl };
}
