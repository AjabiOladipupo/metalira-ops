"use client";

import { useSearchParams } from "next/navigation";

/** The email address is never put in the URL, so the copy does not repeat it. */
export function CheckEmailMessage() {
  const sent = useSearchParams().get("sent");
  if (sent === "signup") {
    return (
      <p className="m-0 type-body-lg">
        We sent a link to confirm your email address. Open it, choose your password, and your
        company&apos;s account is ready.
      </p>
    );
  }
  if (sent === "password") {
    return (
      <p className="m-0 type-body-lg">
        To keep your account safe, we sent a link to your email address. Open it and choose your
        password, then you can sign in with it.
      </p>
    );
  }
  if (sent === "invite") {
    return (
      <p className="m-0 type-body-lg">
        We sent a link to confirm your email address. Open it, then choose your password and accept
        the invite. If it doesn&apos;t take you back to the invite, open the invite email again.
      </p>
    );
  }
  return (
    <p className="m-0 type-body-lg">
      If that email address has an account, we sent it a sign-in link.
    </p>
  );
}
