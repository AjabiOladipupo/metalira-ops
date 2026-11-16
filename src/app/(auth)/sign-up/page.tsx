import type { Metadata } from "next";
import Link from "next/link";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="type-label text-fg-muted">New company</span>
        <h1 className="m-0 type-h1">Create an account</h1>
        <p className="m-0 type-body-lg text-fg-muted">
          You become the owner of your company&apos;s account. Invite your team after setup.
        </p>
      </div>
      <SignUpForm />
      <p className="m-0 border-t border-line pt-5 text-sm">
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </>
  );
}
