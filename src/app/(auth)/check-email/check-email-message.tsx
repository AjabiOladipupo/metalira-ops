"use client";

import { useSearchParams } from "next/navigation";

/** The email address is never put in the URL, so the copy does not repeat it. */
export function CheckEmailMessage() {
  const sent = useSearchParams().get("sent");
  if (sent === "signup") {
    return (
      <p className="m-0 type-body-lg">
        We sent a link to confirm your email address. Open it to finish creating your company&apos;s
        account.
      </p>
    );
  }
  return (
    <p className="m-0 type-body-lg">
      If that email address has an account, we sent it a sign-in link.
    </p>
  );
}
