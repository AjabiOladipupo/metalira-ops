import { z } from "zod";

import { createServerSupabase } from "@/lib/supabase/server";
import { listImportProblemRows } from "@/server/people/imports/data";
import { importProblemsCsv, problemsFileName } from "@/server/people/imports/downloads";
import { csvResponse, importRouteAccess } from "@/server/people/imports/route-access";

/** "Download problems (.csv)": every row listed for attention, with the problem and the fix. */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const access = await importRouteAccess();
  if (!access.ok) return access.response;
  const { batchId } = await params;
  if (!z.uuid().safeParse(batchId).success) {
    return new Response("That import wasn't found.", { status: 404 });
  }

  const supabase = await createServerSupabase();
  const { data: batch, error } = await supabase
    .from("import_batches")
    .select("file_name")
    .eq("id", batchId)
    .eq("organisation_id", access.organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the import: ${error.message}`);
  if (!batch) return new Response("That import wasn't found.", { status: 404 });

  const rows = await listImportProblemRows(access.organisationId, batchId);
  return csvResponse(importProblemsCsv(rows), problemsFileName(batch.file_name));
}
