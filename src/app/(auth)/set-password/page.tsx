import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { FormAlert } from "@/components/form";
import { Button } from "@/components/ui/button";
import { passwordTrusted, PASSWORD_SET_AT_KEY } from "@/lib/auth/amr";
import { SIGN_IN_PATH, safeNextPath } from "@/lib/auth/routes";
import { createServerSupabase } from "@/lib/supabase/server";
import { sessionUsedPassword } from "@/server/identity/claims";
import { sendSetPasswordLinkAction } from "@/server/identity/password-actions";

import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = {
  title: "Choose a password",
  robots: { index: false, follow: false },
};

function Heading({ body }: { body: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="type-label text-fg-muted">Your account</span>
      <h1 className="m-0 type-h1">Choose a password</h1>
      <p className="m-0 type-body-lg text-fg-muted">{body}</p>
    </div>
  );
}

async function SetPassword({ next }: { next: string }) {
  // Request-time only: reads the session (and the Auth client reads the clock).
  await connection();
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) {
    return (
      <>
        <Heading body="Sign in first, then choose your password." />
        <Button asChild className="h-11 self-start rounded-lg px-5">
          <Link href={`${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`}>Go to sign in</Link>
        </Button>
      </>
    );
  }
  if (passwordTrusted(user.app_metadata?.[PASSWORD_SET_AT_KEY], user.email_confirmed_at)) {
    return (
      <>
        <Heading body="Your password is set." />
        <Button asChild className="h-11 self-start rounded-lg px-5">
          <Link href={next}>Continue</Link>
        </Button>
      </>
    );
  }
  if (await sessionUsedPassword(supabase)) {
    return (
      <>
        <Heading body="To keep your account safe, choose your password from a link we email you." />
        <FormAlert message="Your password was set before your email address was confirmed, so it can't be used yet." />
        <form action={sendSetPasswordLinkAction}>
          <input type="hidden" name="next" value={next} />
          <Button type="submit" className="h-11 rounded-lg px-5">
            Email me a link
          </Button>
        </form>
      </>
    );
  }
  return (
    <>
      <Heading
        body={`Signed in as ${user.email ?? "you"}. Choose the password you will sign in with.`}
      />
      <SetPasswordForm next={next} />
    </>
  );
}

/**
 * /set-password (slice 1.13): after an email link, a manager chooses their password. A password
 * counts only once chosen here (or on the join page), after the address was confirmed.
 */
export default function SetPasswordPage({ searchParams }: PageProps<"/set-password">) {
  return (
    <Suspense fallback={<Heading body="One moment." />}>
      {searchParams.then((params) => {
        const raw = params.next;
        return <SetPassword next={safeNextPath(typeof raw === "string" ? raw : null)} />;
      })}
    </Suspense>
  );
}
