import { createServerSupabase } from "@/lib/supabase/server";
import { contractDocumentLink } from "@/server/business/contract-documents";
import { CONTRACT_READERS } from "@/server/business/contracts";
import { getSession } from "@/server/identity/session";

/**
 * Opens a contract document (slice 2.6): checks the signed-in user (owner, admin, finance or
 * ops_manager of the active company), reads the row under RLS (it must belong to this contract, and the contract to this client) and redirects to a 60-second
 * signed URL for the file. `?download=1` saves it under its file name instead. The URL is never
 * logged, cached or shown on the page; a removed document no longer opens.
 */

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ clientId: string; contractId: string; documentId: string }> },
) {
  const session = await getSession();
  if (!session) return plain("Sign in to open this document.", 401);
  const role = session.active?.role;
  if (!session.active || !role || !(CONTRACT_READERS as readonly string[]).includes(role)) {
    return plain("Your role can't open contract documents.", 403);
  }
  const { clientId, contractId, documentId } = await params;
  const download = new URL(request.url).searchParams.get("download") === "1";
  const link = await contractDocumentLink(
    await createServerSupabase(),
    session.active.organisationId,
    documentId,
    { download, contractId, clientId },
  );
  if (!link.ok) {
    return plain(
      link.reason === "removed" ? "This document has been removed." : "That document wasn't found.",
      link.reason === "removed" ? 410 : 404,
    );
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: link.url,
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
