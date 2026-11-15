/** Isolation registry for the identity module (slice 0.3). */
import type { TableSpec } from "../helpers/registry";

async function one(promise: PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (!row) throw new Error("fixture row not found");
  return row;
}

export const tables: TableSpec[] = [
  {
    table: "organisations",
    key: "id",
    tenantColumn: "id",
    tenantValue: (side) => side.orgId,
    noOrganisationIdReason: "Tenant root: its id is the organisation id.",
    rowOf: async ({ side }) => side.orgId,
    attackInsert: () => ({ name: "Hijack Ltd" }),
    patch: { name: "Hijacked" },
  },
  {
    table: "profiles",
    key: "user_id",
    tenantColumn: "user_id",
    tenantValue: (side) => side.id,
    noOrganisationIdReason: "One row per login, shared across organisations.",
    rowOf: async ({ side }) => side.id,
    attackInsert: ({ victim }) => ({ user_id: victim.id, full_name: "Hijacked" }),
    patch: { full_name: "Hijacked" },
  },
  {
    table: "memberships",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => {
      const row = await one(
        admin.from("memberships").select("id").eq("organisation_id", side.orgId).limit(1),
      );
      return row.id as string;
    },
    attackInsert: ({ attacker, victim }) => ({
      organisation_id: victim.orgId,
      user_id: attacker.id,
      role: "owner",
    }),
    patch: { role: "worker" },
  },
  {
    table: "audit_log",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    rowOf: async ({ admin, side }) => {
      const row = await one(
        admin.from("audit_log").select("id").eq("organisation_id", side.orgId).limit(1),
      );
      return row.id as string;
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      action: "test.forged",
      entity: "organisations",
    }),
    patch: { action: "tampered" },
  },
];
