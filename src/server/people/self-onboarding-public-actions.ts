"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { CHECK_EMAIL_PATH, NEXT_PATH_KEY, SIGN_IN_PATH } from "@/lib/auth/routes";
import { isManagerOnboardingRole, isOnboardingToken, onboardingPath } from "@/lib/self-onboarding";
import { createServerSupabase } from "@/lib/supabase/server";
import { ACTIVE_ORG_COOKIE } from "@/server/identity/active-org";
import { emailLinkAllowed } from "@/server/identity/email-link-limit";
import { chooseOwnPassword, invitePasswordStepFor } from "@/server/identity/invite-password";
import { appOrigin } from "@/server/identity/origin";
import { formFields, newPasswordSchema } from "@/server/identity/schemas";
import { getSession } from "@/server/identity/session";

import {
  buildSubmission,
  lookupOnboarding,
  onboardingAttemptAllowed,
  submitOnboarding,
} from "./self-onboarding-public";
import {
  managerOnboardingSchema,
  workerOnboardingSchema,
  type OnboardingDetails,
} from "./self-onboarding-schemas";
import type { OnboardingActionState } from "./self-onboarding-state";

/**
 * Server Actions for the public invite page /onboard/[token] (slice U.4). The token is the only
 * thing taken from the visitor that names an invite; the company, role and address come from
 * the database. A worker role sends everything at once, without an account. A manager role first
 * creates their account from an email link to the invited address (as team invites do), then
 * sends their profile signed in. Each send is rate limited by token and network address.
 */

const FAILED = "Your details weren't sent. Try again in a minute.";
const NOT_OPEN = "This invite can no longer be used. Ask the person who invited you for a new one.";
const TOO_MANY = "Too many tries. Wait an hour and try again.";
const WRONG_EMAIL =
  "That isn't the address this invite was sent to. Type the email address the invite came to.";

/** Personal numbers never go back to the browser in `values`. */
const SECRET_FIELDS = new Set(["nin", "bankAccountNumber", "rsaPin", "nhfNumber", "password"]);

function echo(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => key !== "token" && !SECRET_FIELDS.has(key)),
  );
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** A guard, cleaner or supervisor sends their details. */
export async function submitWorkerOnboardingAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const fields = formFields(formData);
  const token = fields.token ?? "";
  if (!isOnboardingToken(token)) return { ok: false, formError: NOT_OPEN };
  if (!(await onboardingAttemptAllowed({ kind: "submit", token }, await headers()))) {
    return { ok: false, formError: TOO_MANY, values: echo(fields) };
  }
  const invite = await lookupOnboarding(token);
  if (invite.state !== "pending" || isManagerOnboardingRole(invite.role)) {
    return { ok: false, formError: NOT_OPEN };
  }

  const parsed = workerOnboardingSchema().safeParse(fields);
  if (!parsed.success) {
    return {
      ok: false,
      formError: "Check the highlighted fields.",
      fieldErrors: issues(parsed.error),
      values: echo(fields),
    };
  }
  const { confirmEmail, ...details } = parsed.data;
  if (confirmEmail !== invite.email) {
    return {
      ok: false,
      fieldErrors: { confirmEmail: WRONG_EMAIL },
      values: echo(fields),
    };
  }

  let outcome;
  try {
    outcome = await submitOnboarding(
      token,
      null,
      buildSubmission(invite.organisationId, invite.inviteId, details),
    );
  } catch (error) {
    console.error("onboarding.submit_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, formError: FAILED, values: echo(fields) };
  }
  if (!outcome.ok) return { ok: false, formError: outcome.message, values: echo(fields) };
  redirect(onboardingPath(token));
}

/**
 * Starts (or signs in) the account for the invited address. The address comes from the invite,
 * never from the form, so this can only email the person who was invited; they come back signed
 * in from the link. Capped per invite and per network address (email-link-limit.ts).
 */
export async function emailOnboardingLinkAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const token = formFields(formData).token ?? "";
  if (!isOnboardingToken(token)) return { ok: false, formError: NOT_OPEN };
  const invite = await lookupOnboarding(token);
  if (invite.state !== "pending" || !isManagerOnboardingRole(invite.role)) {
    return { ok: false, formError: NOT_OPEN };
  }
  if (!(await emailLinkAllowed({ kind: "token", value: token }, await headers()))) {
    return { ok: false, formError: "Too many links sent for this invite. Try again in an hour." };
  }
  const path = onboardingPath(token);
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email: invite.email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${await appOrigin()}/auth/callback?next=${encodeURIComponent(path)}`,
      data: { [NEXT_PATH_KEY]: path },
    },
  });
  if (error) {
    if (
      error.status === 429 ||
      error.code === "over_request_rate_limit" ||
      error.code === "over_email_send_rate_limit"
    ) {
      return { ok: false, formError: "Too many attempts. Wait a few minutes and try again." };
    }
    console.error("onboarding.email_link_failed:", error.code ?? "unknown");
    return { ok: false, formError: FAILED };
  }
  redirect(`${CHECK_EMAIL_PATH}?sent=invite`);
}

/** Employee details a manager not paid through payroll doesn't send. */
function withoutEmployee(details: OnboardingDetails): OnboardingDetails {
  return {
    ...details,
    dateOfBirth: null,
    homeAddress: null,
    nextOfKinName: null,
    nextOfKinPhone: null,
    nin: null,
    bankCode: null,
    bankAccountNumber: null,
    accountName: null,
    pfaName: null,
    rsaPin: null,
    taxState: null,
    nhfOptIn: false,
    nhfNumber: null,
    annualRentDeclared: null,
    locationConsent: false,
    selfieConsent: false,
  };
}

/**
 * The invited manager, signed in as the invited address, sends their profile (and chooses their
 * password when they came from the email link). Nothing is granted until owner or HR approves.
 */
export async function submitManagerOnboardingAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const fields = formFields(formData);
  const token = fields.token ?? "";
  if (!isOnboardingToken(token)) return { ok: false, formError: NOT_OPEN };
  const session = await getSession();
  if (!session) redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(onboardingPath(token))}`);
  if (!(await onboardingAttemptAllowed({ kind: "submit", token }, await headers()))) {
    return { ok: false, formError: TOO_MANY, values: echo(fields) };
  }
  const invite = await lookupOnboarding(token);
  if (invite.state !== "pending" || !isManagerOnboardingRole(invite.role)) {
    return { ok: false, formError: NOT_OPEN };
  }
  if (session.user.email.toLowerCase() !== invite.email) {
    return {
      ok: false,
      formError:
        "This invite is for a different email address. Sign out, then use the address it was sent to.",
    };
  }

  const supabase = await createServerSupabase();
  const step = await invitePasswordStepFor(supabase);
  if (step === "use_email_link") {
    return {
      ok: false,
      formError:
        'For your safety, choose your password from a link we email you. Sign out, then choose "Email me a link" here.',
    };
  }
  const parsed = managerOnboardingSchema().safeParse(fields);
  const password =
    step === "set_password" ? newPasswordSchema.safeParse(fields.password ?? "") : null;
  if (!parsed.success || (password && !password.success)) {
    return {
      ok: false,
      formError: "Check the highlighted fields.",
      fieldErrors: {
        ...(parsed.success ? {} : issues(parsed.error)),
        ...(password && !password.success
          ? { password: password.error.issues[0]?.message ?? "Choose a password." }
          : {}),
      },
      values: echo(fields),
    };
  }
  if (password?.success) {
    try {
      const refused = await chooseOwnPassword(supabase, session.user.id, password.data);
      if (refused) return { ok: false, fieldErrors: { password: refused }, values: echo(fields) };
    } catch (error) {
      console.error("onboarding.password_failed:", error instanceof Error ? error.name : "unknown");
      return { ok: false, formError: FAILED, values: echo(fields) };
    }
  }
  const details = invite.onPayroll ? parsed.data : withoutEmployee(parsed.data);
  // Their own profile, with their own client (RLS: own row only; the audit trigger applies).
  const { error: nameError } = await supabase
    .from("profiles")
    .update({ full_name: `${details.firstName} ${details.lastName}` })
    .eq("user_id", session.user.id);
  if (nameError) console.error("onboarding.name_failed:", nameError.code);

  let outcome;
  try {
    outcome = await submitOnboarding(
      token,
      session.user.id,
      buildSubmission(invite.organisationId, invite.inviteId, details),
    );
  } catch (error) {
    console.error("onboarding.submit_failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, formError: FAILED, values: echo(fields) };
  }
  if (!outcome.ok) return { ok: false, formError: outcome.message, values: echo(fields) };
  await supabase.auth.updateUser({ data: { [NEXT_PATH_KEY]: null } });
  redirect(onboardingPath(token));
}

/** Signs out the wrong account and comes back to the invite. */
export async function signOutForOnboardingAction(formData: FormData): Promise<void> {
  const token = formFields(formData).token ?? "";
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  (await cookies()).delete(ACTIVE_ORG_COOKIE);
  redirect(isOnboardingToken(token) ? onboardingPath(token) : SIGN_IN_PATH);
}
