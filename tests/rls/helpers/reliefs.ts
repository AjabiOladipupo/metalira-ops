/**
 * Slice 5.9a: a worker's relief declared, its proof stored and checked, and verified, through the
 * real functions (declare_payroll_relief as owner or hr, the proof uploaded to the private bucket
 * and recorded with the secret key as the server does, verify_payroll_relief as owner or hr).
 * Under NTA 2025 v2 rent relief applies only once its proof is verified, so seeds that rely on a
 * declared rent (the golden workers) verify it here.
 */
import { createHash, randomUUID } from "node:crypto";

import { anonClient, type Client } from "./supabase";

/** A minimal PDF: the server's magic-byte check reads only the header. */
const PDF = new TextEncoder().encode("%PDF-1.4\n% proof of rent, test fixture\n%%EOF\n");

export interface ReliefWriter {
  /** A signed-in owner or hr client of the company. */
  client: Client;
  /** That user's id (named as who checked the proof). */
  userId: string;
}

export async function verifyRelief(
  admin: Client,
  writer: ReliefWriter,
  orgId: string,
  workerId: string,
  kind: "rent" | "nhis" | "life_assurance",
  annualKobo: bigint,
  taxYear = 2026,
): Promise<string> {
  const declared = await writer.client.rpc("declare_payroll_relief", {
    p_organisation_id: orgId,
    p_worker_id: workerId,
    p_tax_year: taxYear,
    p_kind: kind,
    p_annual_kobo: annualKobo.toString(),
    p_reason: "Declared at go-live",
  });
  if (declared.error) throw new Error(`declare_payroll_relief: ${declared.error.message}`);
  const declarationId = declared.data!;
  const proofId = randomUUID();
  const path = `${orgId}/${workerId}/${declarationId}/${proofId}.pdf`;
  const uploaded = await admin.storage
    .from("payroll-relief-proofs")
    .upload(path, PDF, { contentType: "application/pdf" });
  if (uploaded.error) throw new Error(`relief proof upload: ${uploaded.error.message}`);
  const recorded = await admin.rpc("record_payroll_relief_proof", {
    p_organisation_id: orgId,
    p_declaration_id: declarationId,
    p_proof_id: proofId,
    p_actor: writer.userId,
    p_document_kind: kind === "rent" ? "tenancy_agreement" : "contribution_statement",
    p_file_ext: "pdf",
    p_size_bytes: PDF.length,
    p_sha256: createHash("sha256").update(PDF).digest("hex"),
  });
  if (recorded.error) throw new Error(`record_payroll_relief_proof: ${recorded.error.message}`);
  const verified = await writer.client.rpc("verify_payroll_relief", {
    p_organisation_id: orgId,
    p_declaration_id: declarationId,
    p_decision: "verified",
  });
  if (verified.error) throw new Error(`verify_payroll_relief: ${verified.error.message}`);
  return declarationId;
}

/** A signed-in client for an account made by the e2e helpers (email and password). */
export async function signedInClient(email: string, password: string): Promise<Client> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in: ${error.message}`);
  return client;
}

/** Verifies each golden worker's declared rent (annual rent in naira, as the fixture gives it). */
export async function verifyGoldenRents(
  admin: Client,
  writer: ReliefWriter,
  orgId: string,
  workers: Record<string, string>,
  golden: { workers: { name: string; annual_rent: number }[] },
): Promise<void> {
  for (const w of golden.workers) {
    if (w.annual_rent <= 0) continue;
    const id = workers[w.name];
    if (!id) throw new Error(`no worker for ${w.name}`);
    await verifyRelief(admin, writer, orgId, id, "rent", BigInt(w.annual_rent) * 100n);
  }
}

/** Verifies the declared rent of every worker of the company that has one (seeds that rely on it). */
export async function verifyDeclaredRents(
  admin: Client,
  writer: ReliefWriter,
  orgId: string,
): Promise<void> {
  const { data, error } = await admin
    .from("workers")
    .select("id, annual_rent_declared_kobo")
    .eq("organisation_id", orgId)
    .gt("annual_rent_declared_kobo", 0);
  if (error) throw new Error(`workers: ${error.message}`);
  for (const w of data ?? []) {
    await verifyRelief(
      admin,
      writer,
      orgId,
      w.id,
      "rent",
      BigInt(w.annual_rent_declared_kobo ?? 0),
    );
  }
}
