/**
 * Test-only helpers for the RLS suite. They talk to the LOCAL Supabase stack
 * (`pnpm db:start`) and refuse any other host, so a stray environment variable
 * can never point these tests at a hosted project.
 *
 * Reading the secret key here is a deliberate, test-only exception to the
 * "secret key only under src/server/" rule (see tests/unit/secret-key-boundary.test.ts).
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import type { Database } from "@/types/db";

export type Client = SupabaseClient<Database>;

export interface LocalEnv {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
  dbUrl: string;
}

let cachedEnv: LocalEnv | undefined;

function assertLocal(url: string, name: string): void {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} must point at the local Supabase stack, got host "${host}".`);
  }
}

function readStatus(): Record<string, string> {
  const cli = path.join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");
  if (!existsSync(cli)) {
    throw new Error("Supabase CLI not installed: run pnpm install.");
  }
  const out = execFileSync(process.execPath, [cli, "status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = out.indexOf("{");
  if (start === -1) {
    throw new Error(`Unexpected output from supabase status: ${out.slice(0, 200)}`);
  }
  return JSON.parse(out.slice(start)) as Record<string, string>;
}

/**
 * Local stack settings. Uses SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
 * SUPABASE_SECRET_KEY and SUPABASE_DB_URL when all four are set, otherwise
 * parses `supabase status -o json`.
 */
export function loadLocalEnv(): LocalEnv {
  if (cachedEnv) return cachedEnv;

  const env = process.env;
  let result: LocalEnv;
  if (
    env.SUPABASE_URL &&
    env.SUPABASE_PUBLISHABLE_KEY &&
    env.SUPABASE_SECRET_KEY &&
    env.SUPABASE_DB_URL
  ) {
    result = {
      apiUrl: env.SUPABASE_URL,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      secretKey: env.SUPABASE_SECRET_KEY,
      dbUrl: env.SUPABASE_DB_URL,
    };
  } else {
    const status = readStatus();
    const apiUrl = status.API_URL;
    const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
    const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
    const dbUrl = status.DB_URL;
    if (!apiUrl || !publishableKey || !secretKey || !dbUrl) {
      throw new Error("supabase status did not return API_URL, keys and DB_URL.");
    }
    result = { apiUrl, publishableKey, secretKey, dbUrl };
  }

  assertLocal(result.apiUrl, "Supabase API URL");
  assertLocal(result.dbUrl, "Supabase DB URL");
  cachedEnv = result;
  return result;
}

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/** Secret-key client. Bypasses RLS, but not grants or triggers. */
export function adminClient(): Client {
  const { apiUrl, secretKey } = loadLocalEnv();
  return createClient<Database>(apiUrl, secretKey, { auth: noSession });
}

/** Publishable-key client with no session (the anon role). */
export function anonClient(): Client {
  const { apiUrl, publishableKey } = loadLocalEnv();
  return createClient<Database>(apiUrl, publishableKey, { auth: noSession });
}

export interface TestUser {
  id: string;
  email: string;
  client: Client;
}

/** Creates a confirmed user with a random email and returns a signed-in client. */
export async function createTestUser(label: string, fullName?: string): Promise<TestUser> {
  const email = `rls-${label}-${randomUUID()}@example.test`;
  const password = randomBytes(18).toString("base64url");

  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : {},
  });
  if (error || !data.user) {
    throw new Error(`Could not create test user ${label}: ${error?.message ?? "no user"}`);
  }

  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) {
    throw new Error(`Could not sign in test user ${label}: ${signIn.error.message}`);
  }

  return { id: data.user.id, email, client };
}

/** A user with their own organisation, created through the public RPC. */
export interface TenantUser extends TestUser {
  orgId: string;
}

export async function createTenantUser(label: string, orgName: string): Promise<TenantUser> {
  const user = await createTestUser(label);
  const { data, error } = await user.client.rpc("create_organisation", { p_name: orgName });
  if (error || !data) {
    throw new Error(`Could not create organisation for ${label}: ${error?.message ?? "no id"}`);
  }
  return { ...user, orgId: data };
}

/** node-postgres client connected as `postgres` (owner of the public tables). */
export async function pgClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: loadLocalEnv().dbUrl });
  await client.connect();
  return client;
}
