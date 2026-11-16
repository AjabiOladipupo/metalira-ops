/** Isolation registry for the people import (slice 1.8). */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";
import type { Client } from "../helpers/supabase";

async function firstId(admin: Client, table: "import_batches" | "import_rows", orgId: string) {
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

function batchFor(orgId: string) {
  const id = randomUUID();
  return {
    id,
    organisation_id: orgId,
    file_name: "employees.csv",
    file_format: "csv",
    file_path: `${orgId}/${id}.csv`,
  };
}

export const tables: TableSpec[] = [
  {
    table: "import_batches",
    ...byOrg,
    seed: async ({ admin, side }) => {
      check((await admin.from("import_batches").insert(batchFor(side.orgId))).error);
    },
    rowOf: ({ admin, side }) => firstId(admin, "import_batches", side.orgId),
    attackInsert: ({ victim }) => batchFor(victim.orgId),
    patch: { rows_total: 99 },
  },
  {
    table: "import_rows",
    ...byOrg,
    seed: async ({ admin, side }) => {
      const batchId = await firstId(admin, "import_batches", side.orgId);
      check(
        (
          await admin.from("import_rows").insert({
            organisation_id: side.orgId,
            batch_id: batchId,
            row_number: 2,
            raw: { first_name: "Musa", last_name: "Ibrahim" },
            status: "ready",
          })
        ).error,
      );
    },
    rowOf: ({ admin, side }) => firstId(admin, "import_rows", side.orgId),
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      batch_id: randomUUID(),
      row_number: 2,
      raw: { first_name: "Hijack" },
      status: "ready",
    }),
    patch: { status: "held" },
  },
];
