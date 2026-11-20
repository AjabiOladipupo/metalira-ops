/**
 * Isolation registry for contract documents (slice 2.6). Its own file so it doesn't collide with
 * other Phase 2 slices editing business.ts; it loads after business.ts, whose seed creates the
 * contract each organisation's document hangs off.
 */
import { randomUUID } from "node:crypto";

import type { TableSpec } from "../helpers/registry";

export const tables: TableSpec[] = [
  {
    table: "contract_documents",
    key: "id",
    tenantColumn: "organisation_id",
    tenantValue: (side) => side.orgId,
    seed: async ({ admin, side }) => {
      const contract = await admin
        .from("contracts")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1)
        .single();
      if (contract.error) throw new Error(contract.error.message);
      const { error } = await admin.from("contract_documents").insert({
        organisation_id: side.orgId,
        contract_id: contract.data.id,
        kind: "signed_contract",
        title: "Signed guarding contract",
        file_name: "contract.pdf",
        file_ext: "pdf",
        mime_type: "application/pdf",
        uploaded_by: side.id,
      } as never);
      if (error) throw new Error(error.message);
    },
    rowOf: async ({ admin, side }) => {
      const { data, error } = await admin
        .from("contract_documents")
        .select("id")
        .eq("organisation_id", side.orgId)
        .order("created_at")
        .limit(1);
      if (error) throw new Error(error.message);
      const id = data?.[0]?.id;
      if (!id) throw new Error("fixture row not found in contract_documents");
      return id;
    },
    attackInsert: ({ victim }) => ({
      organisation_id: victim.orgId,
      contract_id: randomUUID(),
      kind: "other",
      title: "Hijack",
      file_name: "hijack.pdf",
      file_ext: "pdf",
      mime_type: "application/pdf",
    }),
    patch: { title: "Hijacked" },
  },
];
