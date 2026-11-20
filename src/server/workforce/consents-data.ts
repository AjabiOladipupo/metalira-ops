import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/db";

/** Who may read consents: the worker themselves, and owner, admin and HR (RLS agrees). */
export const CONSENT_READERS = ["owner", "admin", "hr"] as const;

export interface ConsentsSummary {
  activeWorkers: number;
  /** Active workers with an open location consent. */
  location: number;
  /** Active workers with an open selfie consent. */
  selfie: number;
}

/**
 * How many active workers have agreed to location and selfie (slice 3.1, for Lira and later the
 * people screens). The rest are clocked in by their supervisor. Counts only: no names.
 */
export async function loadConsentsSummary(
  supabase: SupabaseClient<Database>,
  organisationId: string,
): Promise<ConsentsSummary> {
  const [workers, consents] = await Promise.all([
    supabase
      .from("workers")
      .select("id", { count: "exact", head: true })
      .eq("organisation_id", organisationId)
      .eq("status", "active"),
    supabase
      .from("worker_consents")
      .select("kind, worker_id, workers!worker_consents_worker_fkey!inner ( status )")
      .eq("organisation_id", organisationId)
      .is("withdrawn_at", null)
      .eq("workers.status", "active"),
  ]);
  if (workers.error) throw new Error(`Could not count workers (${workers.error.code})`);
  if (consents.error) throw new Error(`Could not count consents (${consents.error.code})`);
  const rows = consents.data ?? [];
  return {
    activeWorkers: workers.count ?? 0,
    location: rows.filter((row) => row.kind === "location").length,
    selfie: rows.filter((row) => row.kind === "selfie").length,
  };
}
