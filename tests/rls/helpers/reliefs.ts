/**
 * Slice 5.9a: a worker's relief declared, its proof stored and checked, and verified, through the
 * real functions (declare_payroll_relief as owner or hr, the proof uploaded to the private bucket
 * and recorded with the secret key as the server does, verify_payroll_relief as a different owner
 * or hr: the person who declared a relief can't verify it, MLYA7). Under NTA 2025 v2 rent relief
 * applies only once its proof is verified, so seeds that rely on a declared rent (the golden
 * workers) verify it here.
 *
 * A verifier counts as having changed a run of that worker's tax year (approve_payroll_run's
 * two-person check), so seeds use a dedicated hr "relief checker" who never approves.
 */
import { createHash, randomUUID } from "node:crypto";

import { anonClient, createTestUser, type Client } from "./supabase";

/** A minimal PDF: the server's magic-byte check reads only the header. */
const PDF = new TextEncoder().encode("%PDF-1.4\n% proof of rent, test fixture\n%%EOF\n");

export interface ReliefWriter {
  /** A signed-in owner or hr client of the company. */
  client: Client;
  /** That user's id. */
  userId: string;
}

/** A new hr member of the company who verifies proofs and does nothing else. */
export async function reliefChecker(admin: Client, orgId: string): Promise<ReliefWriter> {
  const user = await createTestUser(`relief-checker-${randomUUID().slice(0, 6)}`, "Relief Checker");
  const { error } = await admin
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: user.id, role: "hr" });
  if (error) throw new Error(`relief checker: ${error.message}`);
  return { client: user.client, userId: user.id };
}

export async function verifyRelief(
  admin: Client,
  declarer: ReliefWriter,
  verifier: ReliefWriter,
  orgId: string,
  workerId: string,
  kind: "rent" | "nhis" | "life_assurance",
  annualKobo: bigint,
  taxYear = 2026,
): Promise<string> {
  const declared = await declarer.client.rpc("declare_payroll_relief", {
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
    p_actor: declarer.userId,
    p_document_kind: kind === "rent" ? "tenancy_agreement" : "contribution_statement",
    p_file_ext: "pdf",
    p_size_bytes: PDF.length,
    p_sha256: createHash("sha256").update(PDF).digest("hex"),
  });
  if (recorded.error) throw new Error(`record_payroll_relief_proof: ${recorded.error.message}`);
  const verified = await verifier.client.rpc("verify_payroll_relief", {
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
  declarer: ReliefWriter,
  orgId: string,
  workers: Record<string, string>,
  golden: { workers: { name: string; annual_rent: number }[] },
): Promise<void> {
  const verifier = await reliefChecker(admin, orgId);
  for (const w of golden.workers) {
    if (w.annual_rent <= 0) continue;
    const id = workers[w.name];
    if (!id) throw new Error(`no worker for ${w.name}`);
    await verifyRelief(admin, declarer, verifier, orgId, id, "rent", BigInt(w.annual_rent) * 100n);
  }
}

/** Verifies the declared rent of every worker of the company that has one (seeds that rely on it). */
export async function verifyDeclaredRents(
  admin: Client,
  declarer: ReliefWriter,
  orgId: string,
): Promise<void> {
  const { data, error } = await admin
    .from("workers")
    .select("id, annual_rent_declared_kobo")
    .eq("organisation_id", orgId)
    .gt("annual_rent_declared_kobo", 0);
  if (error) throw new Error(`workers: ${error.message}`);
  const verifier = await reliefChecker(admin, orgId);
  for (const w of data ?? []) {
    await verifyRelief(
      admin,
      declarer,
      verifier,
      orgId,
      w.id,
      "rent",
      BigInt(w.annual_rent_declared_kobo ?? 0),
    );
  }
}
