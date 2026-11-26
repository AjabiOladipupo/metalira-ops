import "server-only";

import { createAdminSupabase } from "@/server/supabase/admin";

/**
 * Daily (the bank-detail-changes cron route): self-onboarding submissions nobody decided within
 * 14 days are cancelled and their personal data cleared (slice U.4, security review L4). Never
 * throws; returns how many it closed, or 0 on failure (logged by code).
 */
export async function expireOnboardingSubmissions(): Promise<number> {
  try {
    const { data, error } = await createAdminSupabase().rpc("expire_self_onboarding_submissions");
    if (error) throw new Error(error.code);
    return data ?? 0;
  } catch (error) {
    console.error("onboarding.expire_failed:", error instanceof Error ? error.message : "unknown");
    return 0;
  }
}
