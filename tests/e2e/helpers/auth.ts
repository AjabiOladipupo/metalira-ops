/**
 * Auth helpers for the e2e suite. They talk to the LOCAL Supabase stack only (the RLS helpers
 * refuse any other host) and use its secret key to create users quickly, which is a
 * deliberate test-only exception to the "secret key only under src/server/" rule.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

import type { Role } from "../../../src/lib/roles";
import { adminClient, anonClient, loadLocalEnv } from "../../rls/helpers/supabase";

/** True when the local stack is up and the app under test was built against it. */
export const supabaseReady: boolean = (() => {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return false;
  try {
    return loadLocalEnv().apiUrl === process.env.NEXT_PUBLIC_SUPABASE_URL;
  } catch {
    return false;
  }
})();

export const NEEDS_SUPABASE = "Needs the local Supabase stack: pnpm db:start";

export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

export function uniqueEmail(label: string): string {
  return `e2e-${label}-${randomUUID()}@example.test`;
}

/** Meets the project's letters_digits rule. */
export function newPassword(): string {
  return `${randomBytes(12).toString("base64url")}a1`;
}

export interface TestAccount {
  userId: string;
  email: string;
  password: string;
  fullName: string;
}

/** A confirmed user with no organisation. */
export async function createAccount(
  label: string,
  fullName = "Test Manager",
): Promise<TestAccount> {
  const email = uniqueEmail(label);
  const password = newPassword();
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data.user) throw new Error(`Could not create ${label}: ${error?.message}`);
  return { userId: data.user.id, email, password, fullName };
}

export interface TestOwner extends TestAccount {
  orgId: string;
  orgName: string;
}

/** A confirmed owner with their own organisation, created through the public RPC. */
export async function createOwner(label: string, orgName: string): Promise<TestOwner> {
  const account = await createAccount(label, "Test Owner");
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (signIn.error) throw new Error(`Could not sign in ${label}: ${signIn.error.message}`);
  const { data, error } = await client.rpc("create_organisation", { p_name: orgName });
  if (error || !data) throw new Error(`Could not create ${orgName}: ${error?.message}`);
  return { ...account, orgId: data, orgName };
}

/** Adds a membership directly (no invite UI until Phase 1). */
export async function addMembership(orgId: string, userId: string, role: Role): Promise<void> {
  const { error } = await adminClient()
    .from("memberships")
    .insert({ organisation_id: orgId, user_id: userId, role });
  if (error) throw new Error(`Could not add membership: ${error.message}`);
}

export async function signInViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// ---------------------------------------------------------------------------
// Mailpit (the local stack's inbox)
// ---------------------------------------------------------------------------

let mailpitUrl: string | undefined;

function mailpitBase(): string {
  mailpitUrl ??= process.env.SUPABASE_MAILPIT_URL;
  if (mailpitUrl) return mailpitUrl;
  try {
    const cli = path.join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");
    const out = execFileSync(process.execPath, [cli, "status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const status = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string | undefined>;
    mailpitUrl = status.MAILPIT_URL ?? status.INBUCKET_URL;
  } catch {
    // Fall through to the configured local port.
  }
  mailpitUrl ??= "http://127.0.0.1:55324";
  return mailpitUrl;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
}

/** The newest email to `to`, waiting up to 30 seconds for it to arrive. */
export async function latestEmailTo(
  to: string,
): Promise<{ subject: string; html: string; text: string }> {
  const base = mailpitBase();
  let found: MailpitSummary | undefined;
  await expect
    .poll(
      async () => {
        const res = await fetch(
          `${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`,
        );
        if (!res.ok) return false;
        const body = (await res.json()) as { messages?: MailpitSummary[] };
        found = body.messages?.[0];
        return Boolean(found);
      },
      { timeout: 30_000, message: `email to ${to}` },
    )
    .toBe(true);
  const res = await fetch(`${base}/api/v1/message/${found!.ID}`);
  const message = (await res.json()) as { Subject: string; HTML?: string; Text?: string };
  return { subject: message.Subject, html: message.HTML ?? "", text: message.Text ?? "" };
}

/**
 * Follows the auth link in an email back to the app under test, whatever origin the email
 * names. Handles both the token-hash templates in supabase/templates (link straight to
 * /auth/confirm) and Supabase's default PKCE link (via /auth/v1/verify, which redirects with
 * `?code=` to the redirect URL or, when that is not allow-listed, the Site URL).
 */
export async function followEmailLink(page: Page, email: { html: string; text: string }) {
  const links = [...`${email.html} ${email.text}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) =>
    m[0].replaceAll("&amp;", "&"),
  );
  const link = links.find((l) => /\/auth\/(v1\/verify|confirm|callback)/.test(l));
  if (!link) throw new Error(`No auth link in email: ${links.join(", ")}`);

  let url = new URL(link);
  if (url.pathname.endsWith("/auth/v1/verify")) {
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location");
    if (!location) throw new Error(`Verify did not redirect (${res.status})`);
    url = new URL(location, url);
  }

  if (url.pathname.startsWith("/auth/")) {
    await page.goto(`${url.pathname}${url.search}`);
    return;
  }
  const code = url.searchParams.get("code");
  if (!code)
    throw new Error(`Unexpected redirect from the email link: ${url.pathname}${url.search}`);
  await page.goto(`/auth/callback?code=${encodeURIComponent(code)}&next=%2Fapp`);
}
