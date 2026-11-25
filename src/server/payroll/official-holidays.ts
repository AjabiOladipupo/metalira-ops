import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { officialCalendar, type OfficialCalendar } from "@/lib/payroll/statutory";
import type { Database } from "@/types/db";

/**
 * Reads of the platform's official holiday calendar (slice 5.9b, `public.official_holidays`):
 * federal holidays and each state's own, kept by Metalira and used only to count statutory
 * deadlines. Any signed-in user reads it under RLS; nobody writes it from the app (a migration or
 * the secret key does, insert-only, withdrawing a wrong date by a withdrawal row).
 */

type Client = SupabaseClient<Database>;

export interface OfficialHoliday {
  id: string;
  date: string;
  name: string;
  scope: "federal" | "state";
  /** The normalised tax-state key ("lagos") of a state holiday; null for a federal one. */
  stateKey: string | null;
  source: string;
}

/** The standing official holidays (withdrawn ones left out), by date; one year when asked. */
export async function loadOfficialHolidays(
  supabase: Client,
  options: { year?: number } = {},
): Promise<OfficialHoliday[]> {
  const { data, error } = await supabase
    .from("official_holidays")
    .select("id, entry, holiday_date, name, scope, state_key, source, withdraws_id")
    .order("holiday_date", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Could not read the official holidays (${error.code})`);
  const rows = data ?? [];
  const withdrawn = new Set(rows.flatMap((r) => (r.withdraws_id ? [r.withdraws_id] : [])));
  return rows
    .filter(
      (r) =>
        r.entry === "holiday" &&
        r.holiday_date !== null &&
        !withdrawn.has(r.id) &&
        (options.year === undefined || r.holiday_date.startsWith(`${options.year}-`)),
    )
    .map((r) => ({
      id: r.id,
      date: r.holiday_date!,
      name: r.name ?? "",
      scope: r.scope === "state" ? "state" : "federal",
      stateKey: r.state_key,
      source: r.source ?? "",
    }));
}

/** The calendar the deadline maths takes. */
export async function loadOfficialCalendar(supabase: Client): Promise<OfficialCalendar> {
  return officialCalendar(await loadOfficialHolidays(supabase));
}
