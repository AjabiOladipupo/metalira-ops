import { MutationError, mutate } from "@/server/identity/mutate";
import { exportPeopleSpec } from "@/server/people/bulk";

/**
 * "Export CSV" on the People list (slice U.1; security review L1). `mutate()` checks the
 * signed-in user (a role that reads the People list, People on), resolves the selection from
 * the caller's own reads (a line manager gets only their reportees), builds the file on the
 * server and logs `people.exported` with the count only. The file goes out in this response
 * only: never stored, `no-store`, saved as an attachment. Nothing here is logged.
 *
 * POST with a JSON body ({ selection }), same origin only: a cross-site form can't send JSON
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

export async function POST(request: Request) {
  if (!sameOrigin(request)) return plain("Export from the People list.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return plain("Export from the People list.", 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return plain("Choose who to export.", 400);
  }

  let file;
  try {
    file = await mutate(exportPeopleSpec, body);
  } catch (error) {
    if (error instanceof MutationError) {
      if (error.code === "unauthenticated") return plain("Sign in to export.", 401);
      if (error.code === "forbidden") return plain(error.message, 403);
      if (error.code === "invalid") return plain(error.message, 400);
    }
    console.error(
      "people.export_failed:",
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
