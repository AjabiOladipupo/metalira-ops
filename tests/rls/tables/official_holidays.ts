/**
 * Slice 5.9b: the official holiday calendar (migration 20261122240000). A deliberate tenancy
 * exception: platform reference data with no organisation_id, the same for every company,
 * read-only for signed-in users and written only by a migration or the secret key. It is declared
 * as a platform table, not a tenant one; tests/rls/official-holidays.test.ts covers the rest.
 */
import type { PlatformTableSpec, TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [];

export const platformTables: PlatformTableSpec[] = [
  {
    table: "official_holidays",
    key: "id",
    noOrganisationIdReason:
      "Platform reference data: the federal and state public holidays statutory deadlines count around, the same for every company and kept by Metalira.",
    // The migration seeds New Year's Day 2026.
    rowOf: async (admin) => {
      const { data, error } = await admin
        .from("official_holidays")
        .select("id")
        .eq("entry", "holiday")
        .eq("holiday_date", "2026-01-01")
        .eq("scope", "federal")
        .single();
      if (error || !data) throw new Error(`No seeded official holiday (${error?.message})`);
      return data.id;
    },
    attackInsert: () => ({
      entry: "holiday",
      holiday_date: "2026-11-30",
      name: "Made-up day",
      scope: "federal",
      source: "A customer",
      recorded_by: "attacker",
    }),
    patch: { name: "Changed" },
  },
];
