import "server-only";

import { getPageSession } from "@/server/identity/session";
import { lookupWorkerPageSession } from "@/server/identity/worker-session";

import { crewSessionFrom, type CrewSessionLookup } from "./crew-session";

/**
 * The crew session for rendering a page only (the token's signature checked locally). Never for
 * a write: Server Actions use lookupCrewSession (crew-session.ts), verified with the Auth server.
 */
export async function lookupCrewPageSession(): Promise<CrewSessionLookup> {
  return crewSessionFrom(await lookupWorkerPageSession(), getPageSession);
}
