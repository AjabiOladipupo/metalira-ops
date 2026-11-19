import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DocumentKind } from "@/lib/contract-documents";
import type { Database } from "@/types/db";

import type { ContractStatus } from "./contract-schemas";

/**
 * Reads for contract documents (slice 2.6), with the signed-in user's own client, scoped to the
 * active organisation: RLS shows them to owner, admin, finance and ops_manager only. These reads
 * never return object paths (only the upload step hands the uploader the path of their own
 * pending row); a document opens through its route, which signs a 60-second URL on the server.
 */

type Client = SupabaseClient<Database>;

export type DocumentStatus = "pending" | "active" | "rejected" | "removed";

export interface ContractDocument {
  id: string;
  kind: DocumentKind;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  status: DocumentStatus;
  uploadedAt: string | null;
  uploadedByName: string | null;
  removedAt: string | null;
  removedByName: string | null;
  removedReason: string | null;
}

const LIST_LIMIT = 500;

/** A contract's documents: active ones newest first, then removed ones (pending and rejected uploads are left out). */
export async function listContractDocuments(
  supabase: Client,
  organisationId: string,
  contractId: string,
): Promise<ContractDocument[]> {
  const { data, error } = await supabase
    .from("contract_documents")
    .select(
      "id, kind, title, file_name, mime_type, size_bytes, status, uploaded_at, uploaded_by, removed_at, removed_by, removed_reason",
    )
    .eq("organisation_id", organisationId)
    .eq("contract_id", contractId)
    .in("status", ["active", "removed"])
    .order("uploaded_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`Could not read the documents (${error.code})`);
  const rows = data ?? [];

  const people = [
    ...new Set(rows.flatMap((r) => [r.uploaded_by, r.removed_by]).filter(Boolean)),
  ] as string[];
  const names = new Map<string, string>();
  if (people.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", people);
    for (const p of profiles ?? [])
      if (p.full_name?.trim()) names.set(p.user_id, p.full_name.trim());
  }

  const docs = rows.map((r) => ({
    id: r.id,
    kind: r.kind as DocumentKind,
    title: r.title,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    status: r.status as DocumentStatus,
    uploadedAt: r.uploaded_at,
    uploadedByName: names.get(r.uploaded_by) ?? null,
    removedAt: r.removed_at,
    removedByName: r.removed_by ? (names.get(r.removed_by) ?? null) : null,
    removedReason: r.removed_reason,
  }));
  return [
    ...docs.filter((d) => d.status === "active"),
    ...docs.filter((d) => d.status !== "active"),
  ];
}

/**
 * The compact summary of an organisation's contract documents, for dashboards and later the ops
 * agent (docs/LIRA.md). Counts and contract references only: no titles, file names or links.
 */
export interface ContractDocumentsSummary {
  /** Documents on file (active). */
  active: number;
  /** Active documents by kind. */
  byKind: Partial<Record<DocumentKind, number>>;
  /** Removed in the last 30 days (their files are still kept until then). */
  removedLast30Days: number;
  /** Active contracts with no signed contract on file. */
  activeWithoutSignedContract: number;
  /** Their references, at most 20, for a link to each. */
  activeWithoutSignedContractRefs: string[];
  /** Draft contracts with no signed contract on file yet. */
  draftWithoutSignedContract: number;
}

export interface SummaryInput {
  contracts: { id: string; reference: string; status: ContractStatus }[];
  documents: {
    contractId: string;
    kind: DocumentKind;
    status: DocumentStatus;
    removedAt: string | null;
  }[];
}

export function summariseContractDocuments(
  input: SummaryInput,
  now: Date = new Date(),
): ContractDocumentsSummary {
  const active = input.documents.filter((d) => d.status === "active");
  const byKind: Partial<Record<DocumentKind, number>> = {};
  for (const d of active) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  const signed = new Set(
    active.filter((d) => d.kind === "signed_contract").map((d) => d.contractId),
  );
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const missing = (status: ContractStatus) =>
    input.contracts.filter((c) => c.status === status && !signed.has(c.id));
  const activeMissing = missing("active");
  return {
    active: active.length,
    byKind,
    removedLast30Days: input.documents.filter(
      (d) => d.status === "removed" && d.removedAt !== null && Date.parse(d.removedAt) >= cutoff,
    ).length,
    activeWithoutSignedContract: activeMissing.length,
    activeWithoutSignedContractRefs: activeMissing
      .map((c) => c.reference)
      .sort()
      .slice(0, 20),
    draftWithoutSignedContract: missing("draft").length,
  };
}

export async function loadContractDocumentsSummary(
  supabase: Client,
  organisationId: string,
): Promise<ContractDocumentsSummary> {
  const [contracts, documents] = await Promise.all([
    supabase
      .from("contracts")
      .select("id, reference, status")
      .eq("organisation_id", organisationId)
      .limit(5000),
    supabase
      .from("contract_documents")
      .select("contract_id, kind, status, removed_at")
      .eq("organisation_id", organisationId)
      .in("status", ["active", "removed"])
      .limit(20000),
  ]);
  if (contracts.error) throw new Error(`Could not read contracts (${contracts.error.code})`);
  if (documents.error) throw new Error(`Could not read documents (${documents.error.code})`);
  return summariseContractDocuments({
    contracts: (contracts.data ?? []).map((c) => ({
      id: c.id,
      reference: c.reference,
      status: c.status as ContractStatus,
    })),
    documents: (documents.data ?? []).map((d) => ({
      contractId: d.contract_id,
      kind: d.kind as DocumentKind,
      status: d.status as DocumentStatus,
      removedAt: d.removed_at,
    })),
  });
}
