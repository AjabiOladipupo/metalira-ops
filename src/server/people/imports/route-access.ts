import "server-only";

import { getSession } from "@/server/identity/session";

import { PEOPLE_IMPORTERS } from "@/lib/pay-access";

/**
 * Role check for the import download routes (Route Handlers do their own; the proxy only
 * checks that someone is signed in). Owner and hr of the active organisation: the import carries
 * pay (owner decision, 23 Nov 2026).
 */
export async function importRouteAccess(): Promise<
  { ok: true; organisationId: string } | { ok: false; response: Response }
> {
  const session = await getSession();
  if (!session) {
    return { ok: false, response: new Response("Sign in to download this file.", { status: 401 }) };
  }
  const role = session.active?.role;
  if (!session.active || !role || !(PEOPLE_IMPORTERS as readonly string[]).includes(role)) {
    return {
      ok: false,
      response: new Response("Only an owner or HR can download this file.", {
        status: 403,
      }),
    };
  }
  return { ok: true, organisationId: session.active.organisationId };
}

/** A CSV download response that is never cached. */
export function csvResponse(body: string, fileName: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
