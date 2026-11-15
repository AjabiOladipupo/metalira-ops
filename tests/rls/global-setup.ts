/**
 * Vitest globalSetup for the rls project. Fails loudly when the local stack is
 * not running or not migrated. A silent skip would make the isolation test
 * meaningless.
 */
import { loadLocalEnv, pgClient } from "./helpers/supabase";

export default async function setup(): Promise<void> {
  let env;
  try {
    env = loadLocalEnv();
  } catch (error) {
    throw new Error(`Local Supabase not running: run pnpm db:start. (${(error as Error).message})`);
  }

  try {
    const res = await fetch(`${env.apiUrl}/auth/v1/health`, {
      headers: { apikey: env.publishableKey },
    });
    if (!res.ok) throw new Error(`auth health returned ${res.status}`);
  } catch (error) {
    throw new Error(
      `Local Supabase not reachable at ${env.apiUrl}: run pnpm db:start. (${(error as Error).message})`,
    );
  }

  const db = await pgClient();
  try {
    const { rows } = await db.query<{ ok: boolean }>(
      "select to_regclass('public.organisations') is not null as ok",
    );
    if (!rows[0]?.ok) {
      throw new Error("Migrations not applied to the local database: run pnpm db:reset.");
    }
  } finally {
    await db.end();
  }
}
