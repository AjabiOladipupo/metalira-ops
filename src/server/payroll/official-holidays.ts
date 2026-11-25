import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { officialCalendar, type OfficialCalendar } from "@/lib/payroll/statutory";
import type { Database } from "@/types/db";

/**
 * Reads of the platform's official holiday calendar (slice 5.9b, `public.official_holidays`):
 * federal holidays and each state's own, kept by Metalira and used only to count statutory
 * deadlines. Any signed-in user reads it under RLS; nobody writes it from the app (a migration or
 * the secret key does, insert-only, withdrawing a wrong date by a withdrawal row).
 *
 * Security review M1: `official_holidays_between` filters the dates and leaves withdrawn ones out
 * in SQL, and the rows are read in pages, so no read is cut short at the API's row cap.
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

/** Rows per page: under the API's 1,000-row cap. */
export const OFFICIAL_HOLIDAY_PAGE = 500;

/** The standing official holidays from `from` to `to` (inclusive, `YYYY-MM-DD`), by date. */
export async function loadOfficialHolidays(
  supabase: Client,
  range: { from: string; to: string },
): Promise<OfficialHoliday[]> {
  const out: OfficialHoliday[] = [];
  for (let offset = 0; ; offset += OFFICIAL_HOLIDAY_PAGE) {
    const { data, error } = await supabase
      .rpc("official_holidays_between", { p_from: range.from, p_to: range.to })
      .range(offset, offset + OFFICIAL_HOLIDAY_PAGE - 1);
    if (error) throw new Error(`Could not read the official holidays (${error.code})`);
    const rows = data ?? [];
    for (const r of rows) {
      out.push({
        id: r.id,
        date: r.holiday_date,
        name: r.name,
        scope: r.scope === "state" ? "state" : "federal",
        // The generator types table results as non-null; a federal day has none.
        stateKey: (r.state_key as string | null) || null,
        source: r.source,
      });
    }
    if (rows.length < OFFICIAL_HOLIDAY_PAGE) return out;
  }
}

/** One year's standing official holidays. */
export function loadOfficialHolidayYear(
  supabase: Client,
  year: number,
): Promise<OfficialHoliday[]> {
  return loadOfficialHolidays(supabase, { from: `${year}-01-01`, to: `${year}-12-31` });
}

/** The calendar the deadline maths takes, for the dates from `from` to `to`. */
export async function loadOfficialCalendar(
  supabase: Client,
  range: { from: string; to: string },
): Promise<OfficialCalendar> {
  return officialCalendar(await loadOfficialHolidays(supabase, range));
}
