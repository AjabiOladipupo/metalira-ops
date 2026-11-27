/** Isolation registry for the people module (slice 1.3). */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

async function firstId(admin: Client, table: string, orgId: string): Promise<string> {
  const { data, error } = await admin
    .from(table as "clients")
    .select("id")
    .eq("organisation_id", orgId)
    .order("created_at")
    .limit(1);
  if (error) throw new Error(error.message);
  const id = data?.[0]?.id;
  if (!id) throw new Error(`fixture row not found in ${table}`);
  return id;
}

function check(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

const byOrg = {
  key: "id",
  tenantColumn: "organisation_id",
  tenantValue: (side: { orgId: string }) => side.orgId,
} as const;

export const tables: TableSpec[] = [
  {
    table: "clients",
    ...byOrg,
    // Billing columns are not granted to signed-in users (slice 2.1).
    selectColumns: "id, organisation_id, name, status",
    seed: async ({ admin, side }) => {
      check(
        (
          await admin
            .from("clients")
            .insert({ organisation_id: side.orgId, name: "Coastline Logistics" })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "clients", side.orgId),
    attackInsert: ({ victim }) => ({ organisation_id: victim.orgId, name: "Hijack Ltd" }),
    patch: { name: "Hijacked" },
  },
  {
    table: "sites",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const clientId = await firstId(admin, "clients", side.orgId);
      check(
        (
          await admin
            .from("sites")
            .insert({ organisation_id: side.orgId, client_id: clientId, name: "Apapa Warehouse 3" })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "sites", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      client_id: randomUUID(),
      name: "Hijack site",
    }),
    patch: { name: "Hijacked" },
  },
  {
    table: "projects",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const clientId = await firstId(admin, "clients", side.orgId);
      check(
        (
          await admin.from("projects").insert({
            organisation_id: side.orgId,
            client_id: clientId,
            name: "Coastline guarding contract",
          })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "projects", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      client_id: randomUUID(),
      name: "Hijack project",
    }),
    patch: { name: "Hijacked" },
  },
  {
    table: "departments",
    ...byOrg,
    seed: async ({ admin, side }) => {
      check(
        (
          await admin
            .from("departments")
            .insert({ organisation_id: side.orgId, name: "Security services" })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "departments", side.orgId),
    attackInsert: ({ victim }) => ({ organisation_id: victim.orgId, name: "Hijack department" }),
    patch: { name: "Hijacked" },
  },
  {
    table: "workers",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const departmentId = await firstId(admin, "departments", side.orgId);
      check(
        (
          await admin.from("workers").insert({
            organisation_id: side.orgId,
            staff_id: "EMP-0001",
            first_name: "Musa",
            last_name: "Ibrahim",
            phone: "08030000001",
            department_id: departmentId,
            employment_type: "permanent",
            start_date: "2024-03-03",
          })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "workers", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      staff_id: "HIJACK-1",
      first_name: "Hijack",
      last_name: "Worker",
      employment_type: "casual",
      start_date: "2026-01-01",
    }),
    patch: { first_name: "Hijacked" },
  },
  {
    table: "pay_rates",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const workerId = await firstId(admin, "workers", side.orgId);
      check(
        (
          await admin.from("pay_rates").insert({
            organisation_id: side.orgId,
            worker_id: workerId,
            pay_type: "monthly",
            basic_kobo: 6_000_000,
            housing_kobo: 3_600_000,
            transport_kobo: 2_400_000,
            other_allowances_kobo: 0,
            effective_from: "2024-03-03",
          })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "pay_rates", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      pay_type: "daily",
      daily_rate_kobo: 800_000,
      effective_from: "2099-01-01",
    }),
    patch: { effective_to: "2099-12-31" },
  },
  {
    table: "worker_assignments",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const workerId = await firstId(admin, "workers", side.orgId);
      // A client's site, as before slice 6.11: every company's first site is now its Head
      // office, and a person mapped there can't be put on a client's shift (roster.ts seeds one).
      const { data: clientSite, error: siteError } = await admin
        .from("sites")
        .select("id")
        .eq("organisation_id", side.orgId)
        .eq("kind", "client")
        .order("created_at")
        .limit(1);
      if (siteError) throw new Error(siteError.message);
      const siteId = clientSite?.[0]?.id;
      if (!siteId) throw new Error("fixture row not found in sites");
      check(
        (
          await admin.from("worker_assignments").insert({
            organisation_id: side.orgId,
            worker_id: workerId,
            site_id: siteId,
            effective_from: "2024-03-03",
          })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "worker_assignments", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      site_id: randomUUID(),
      effective_from: "2026-01-01",
    }),
    patch: { effective_to: "2099-12-31" },
  },
];
