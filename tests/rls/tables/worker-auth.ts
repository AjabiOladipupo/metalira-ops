/** Isolation registry for worker invites and PIN sign-in (slice 1.9). */
import { randomBytes, randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

async function firstId(
  admin: Client,
  table: "workers" | "worker_invites" | "worker_credentials",
  orgId: string,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
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
    table: "worker_invites",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const workerId = await firstId(admin, "workers", side.orgId);
      check(
        (
          await admin.from("worker_invites").insert({
            organisation_id: side.orgId,
            worker_id: workerId,
            token_hash: randomBytes(32).toString("hex"),
            sent_via: "print",
            created_by: side.id,
          })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "worker_invites", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      token_hash: randomBytes(32).toString("hex"),
      sent_via: "print",
    }),
    patch: { used_at: new Date().toISOString() },
  },
  {
    table: "worker_credentials",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const workerId = await firstId(admin, "workers", side.orgId);
      const user = await admin.auth.admin.createUser({
        email: `w-${workerId}@workers.metalira.invalid`,
        email_confirm: true,
        app_metadata: { login: "worker" },
      });
      check(user.error);
      check(
        (
          await admin.from("worker_credentials").insert({
            organisation_id: side.orgId,
            worker_id: workerId,
            auth_user_id: user.data.user!.id,
            privacy_notice_accepted_at: new Date().toISOString(),
          })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "worker_credentials", side.orgId),
    attackInsert: ({ attacker, victim }) => ({
      organisation_id: victim.orgId,
      worker_id: randomUUID(),
      auth_user_id: attacker.id,
      privacy_notice_accepted_at: new Date().toISOString(),
    }),
    patch: { failed_attempts: 0, locked_until: null },
  },
];
