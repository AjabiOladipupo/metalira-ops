"use server";

import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { z } from "zod";

import {
  APP_HOME_PATH,
  CHECK_EMAIL_PATH,
  NEXT_PATH_KEY,
  SIGN_IN_PATH,
  safeNextPath,
} from "@/lib/auth/routes";
import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";

import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_COOKIE_OPTIONS } from "./active-org";
import type { FormState } from "./form-state";
import { appOrigin } from "./origin";
import {
  formFields,
  magicLinkSchema,
  signInPasswordSchema,
  signUpSchema,
  switchOrganisationSchema,
} from "./schemas";
import { getSession } from "./session";
import { ensureOrganisationForNewUser } from "./sign-up";
import { sendOwnerWelcome } from "./welcome";

const NOT_CONFIGURED = "Sign-in is not set up on this deployment yet.";
const TOO_MANY = "Too many attempts. Wait a few minutes and try again.";
const SOMETHING_WRONG = "Something went wrong on our side. Try again in a minute.";

function configured(): boolean {
  try {
    getSupabasePublicEnv();
    return true;
  } catch {
    return false;
  }
}

function invalid(error: z.ZodError, values: Record<string, string>): FormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { ok: false, fieldErrors, values };
}

function isRateLimited(error: { status?: number; code?: string }): boolean {
  return error.status === 429 || error.code === "over_request_rate_limit";
}

/**
 * Creates the pending organisation, if any, and queues the welcome email. A failure here never
 * blocks signing in: the user lands on the no-access page and the next sign-in tries again.
 */
async function finishOwnerSignUp(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  user: User,
): Promise<void> {
  let created: Awaited<ReturnType<typeof ensureOrganisationForNewUser>> = null;
  try {
    created = await ensureOrganisationForNewUser(supabase, user);
  } catch (error) {
    // Name and message only: the raw error carries PostgREST details and hints, which can
    // echo the submitted company name into the logs.
    console.error(
      "identity.first_organisation_failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
  }
  if (created) {
    const org = created;
    after(() => sendOwnerWelcome(user, org, user.user_metadata?.full_name));
  }
}

export async function signInWithPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = formFields(formData);
  const values = { email: fields.email ?? "" };
  const parsed = signInPasswordSchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error, values);
  if (!configured()) return { ok: false, formError: NOT_CONFIGURED, values };

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    if (error && isRateLimited(error)) return { ok: false, formError: TOO_MANY, values };
    // Only reachable with the right password, so it reveals nothing to a guesser.
    if (error?.code === "email_not_confirmed") {
      return {
        ok: false,
        formError: "Confirm your email address first. Use the link we sent when you signed up.",
        values,
      };
    }
    // Never say which of the two was wrong.
    return { ok: false, formError: "That email and password don't match an account.", values };
  }

  // Covers an owner who confirmed their email in another browser, where the link could not
  // finish signing them in.
  await finishOwnerSignUp(supabase, data.user);
  redirect(safeNextPath(parsed.data.next));
}

export async function sendMagicLink(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = formFields(formData);
  const values = { email: fields.email ?? "" };
  const parsed = magicLinkSchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error, values);
  if (!configured()) return { ok: false, formError: NOT_CONFIGURED, values };

  const supabase = await createServerSupabase();
  const next = safeNextPath(parsed.data.next);
  // The magic-link template (supabase/templates/magic_link.html) links to the Site URL's
  // /auth/confirm and passes this redirect URL along as `redirect_to`; only the `next` path in
  // it is used (emailLinkNextPath). Without the template, Supabase's default PKCE link lands
  // on /auth/callback with the same `next`.
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${await appOrigin()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error && isRateLimited(error)) return { ok: false, formError: TOO_MANY, values };
  // Any other error (most often: no account with that email) looks like success, so the form
  // cannot be used to find out who has an account.
  redirect(`${CHECK_EMAIL_PATH}?sent=link`);
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const fields = formFields(formData);
  const values = {
    fullName: fields.fullName ?? "",
    companyName: fields.companyName ?? "",
    email: fields.email ?? "",
  };
  const parsed = signUpSchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error, values);
  if (!configured()) return { ok: false, formError: NOT_CONFIGURED, values };

  const { fullName, companyName, email, password } = parsed.data;
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${await appOrigin()}/auth/callback?next=${APP_HOME_PATH}`,
      // full_name fills profiles.full_name (private.handle_new_user); company_name waits for
      // the confirmed sign-in (ensureOrganisationForNewUser).
      // next_path is where the confirmation email's link lands (confirmation.html).
      data: { full_name: fullName, company_name: companyName, [NEXT_PATH_KEY]: APP_HOME_PATH },
    },
  });

  if (error) {
    if (isRateLimited(error)) return { ok: false, formError: TOO_MANY, values };
    if (error.code === "weak_password") {
      return {
        ok: false,
        fieldErrors: { password: "Choose a stronger password with letters and numbers." },
        values,
      };
    }
    if (error.code === "user_already_exists" || error.code === "email_exists") {
      return {
        ok: false,
        formError: "We couldn't create that account. If you already have one, sign in instead.",
        values,
      };
    }
    if (error.code === "signup_disabled") {
      return { ok: false, formError: "New accounts are closed for now.", values };
    }
    return { ok: false, formError: SOMETHING_WRONG, values };
  }

  // Email confirmation off: there is a session now, so finish here.
  if (data.session && data.user) {
    await finishOwnerSignUp(supabase, data.user);
    redirect(APP_HOME_PATH);
  }

  // Email confirmation on (the default): the link in the email finishes sign-up.
  redirect(`${CHECK_EMAIL_PATH}?sent=signup`);
}

export async function signOut(): Promise<void> {
  if (configured()) {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut();
  }
  (await cookies()).delete(ACTIVE_ORG_COOKIE);
  redirect(SIGN_IN_PATH);
}

/**
 * Makes another of the user's organisations the active one. The id is checked against the
 * user's own manager memberships on the server; the cookie only narrows what the app shows,
 * and row-level security still decides what the user can read.
 */
export async function switchOrganisation(formData: FormData): Promise<void> {
  const parsed = switchOrganisationSchema.safeParse(formFields(formData));
  const session = await getSession();
  if (!session) redirect(SIGN_IN_PATH);
  if (!parsed.success) return;

  const target = session.managerMemberships.find(
    (m) => m.organisationId === parsed.data.organisationId,
  );
  if (!target) return;

  (await cookies()).set(ACTIVE_ORG_COOKIE, target.organisationId, ACTIVE_ORG_COOKIE_OPTIONS);
  redirect(APP_HOME_PATH);
}
