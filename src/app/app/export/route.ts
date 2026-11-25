import { z } from "zod";

import { LIST_EXPORTS, listExportSpec } from "@/server/exports/specs";
import { MutationError, mutate } from "@/server/identity/mutate";

/**
 * "Export selected to CSV" on the lists (slice U.2): clients, sites, live attendance, timesheets,
 * leave, payroll runs, payslips and remittances (People has its own, /app/people/export).
 * `mutate()` checks the signed-in user against the list's readers and its module switch, then
 * builds the file on the server from the caller's own reads (their company and role scope) and
 * logs `<list>.exported` with the count only. The file goes out in this response only: never
 * stored, `no-store`, saved as an attachment. Nothing here is logged.
 *
 * POST with a JSON body ({ list, ids, ... }), same origin only: a cross-site form can't send JSON
 * without a preflight, and the Origin check refuses anything else.
 */

function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

const which = z.object({ list: z.enum(LIST_EXPORTS) });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return plain("Export from the list.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return plain("Export from the list.", 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return plain("Choose what to export.", 400);
  }
  const list = which.safeParse(body);
  if (!list.success) return plain("Choose what to export.", 400);

  let file;
  try {
    file = await mutate(listExportSpec(list.data.list), body);
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") return plain("Sign in to export.", 401);
      if (error.code === "forbidden") return plain(error.message, 403);
      if (error.code === "invalid") {
        return plain(Object.values(error.fieldErrors)[0] ?? error.message, 400);
      }
    }
    console.error(
      "list.export_failed:",
      error instanceof MutationError && error.cause instanceof Error
        ? error.cause.name
        : "unknown error",
    );
    return plain("The file couldn't be made. Try again in a minute.", 500);
  }

  return new Response(file.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-export-count": String(file.count),
    },
  });
}
