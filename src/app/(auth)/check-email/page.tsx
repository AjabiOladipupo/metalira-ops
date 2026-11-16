import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { CheckEmailMessage } from "./check-email-message";

export const metadata: Metadata = { title: "Check your email" };

export default function CheckEmailPage() {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="type-label text-fg-muted">Almost there</span>
        <h1 className="m-0 type-h1">Check your email</h1>
      </div>
      <Suspense fallback={<p className="m-0 type-body-lg">We sent you an email with a link.</p>}>
        <CheckEmailMessage />
      </Suspense>
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm text-fg-muted">
        <li>The link works once and expires in 1 hour.</li>
        <li>Nothing after 5 minutes? Check your spam folder.</li>
      </ul>
      <p className="m-0 border-t border-line pt-5 text-sm">
        Wrong address or link expired? <Link href="/sign-in">Back to sign in</Link>
      </p>
    </>
  );
}
