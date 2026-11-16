import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { lagosToday } from "@/lib/dates";
import type { WorkerChangeRequestStatus, WorkerChangeTopic } from "@/lib/worker-requests";
import { createServerSupabase } from "@/lib/supabase/server";
import type { WorkerSession } from "@/server/identity/worker-session";
import type { Database } from "@/types/db";

import type { BankChangeStatus } from "./bank-changes";
import { loadWorkerProfile, type WorkerProfile } from "./people-data";

/**
 * What the worker app's Me screen reads (slice 1.10): the worker's own record, their recent
 * bank-detail changes and their change requests. Every read uses the worker's own session
 * (publishable key + RLS), never the secret key, so a worker can only ever load their own rows.
 * No account, NIN or RSA PIN number is decrypted: the screen shows last four digits and
 * "On file" / "Missing" only.
 */

type Client = SupabaseClient<Database>;

export interface MyBankChange {
  id: string;
  status: BankChangeStatus;
  bankName: string;
  last4: string;
  appliesAfter: string | null;
  createdAt: string;
}

export interface MyChangeRequest {
  id: string;
  topic: WorkerChangeTopic;
  details: string;
  status: WorkerChangeRequestStatus;
  resolutionNote: string | null;
  createdAt: string;
}

export interface MyProfile {
  profile: WorkerProfile;
  /** Whether the worker row names a line manager (the name may still be hidden or blank). */
  hasLineManager: boolean;
  bankChanges: MyBankChange[];
  requests: MyChangeRequest[];
  /** A bank change waits for approval or for its 72-hour hold: no new one until it is done. */
  bankChangeOpen: boolean;
}

/** Most recent bank changes and requests shown under "Your requests". */
const RECENT = 10;

export async function loadMyBankChanges(
  supabase: Client,
  session: WorkerSession,
): Promise<MyBankChange[]> {
  const { data, error } = await supabase
    .from("bank_detail_changes")
    .select("id, status, bank_name, bank_account_last4, applies_after, created_at")
    .eq("organisation_id", session.organisationId)
    .eq("worker_id", session.workerId)
    .order("created_at", { ascending: false })
    .limit(RECENT);
  if (error) throw new Error(`Could not read your bank changes: ${error.code}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    bankName: r.bank_name,
    last4: r.bank_account_last4,
    appliesAfter: r.applies_after,
    createdAt: r.created_at,
  }));
}

export async function loadMyChangeRequests(
  supabase: Client,
  session: WorkerSession,
): Promise<MyChangeRequest[]> {
  const { data, error } = await supabase
    .from("worker_change_requests")
    .select("id, topic, details, status, resolution_note, created_at")
    .eq("organisation_id", session.organisationId)
    .eq("worker_id", session.workerId)
    .order("created_at", { ascending: false })
    .limit(RECENT);
  if (error) throw new Error(`Could not read your requests: ${error.code}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    topic: r.topic,
    details: r.details,
    status: r.status,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
  }));
}

export function hasOpenBankChange(changes: readonly MyBankChange[]): boolean {
  return changes.some((c) => c.status === "pending" || c.status === "approved");
}

/** The signed-in worker's own profile, or null when RLS hides the row (for example, ended). */
export async function loadMyProfile(session: WorkerSession): Promise<MyProfile | null> {
  const supabase = await createServerSupabase();
  const [profile, bankChanges, requests] = await Promise.all([
    loadWorkerProfile(supabase, session.organisationId, session.workerId, lagosToday(), {
      viewer: "self",
    }),
    loadMyBankChanges(supabase, session),
    loadMyChangeRequests(supabase, session),
  ]);
  if (!profile) return null;
  return {
    profile,
    hasLineManager: profile.lineManager !== null,
    bankChanges,
    requests,
    bankChangeOpen: hasOpenBankChange(bankChanges),
  };
}
