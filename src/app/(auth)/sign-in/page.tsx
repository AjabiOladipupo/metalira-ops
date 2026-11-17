import type { Metadata } from "next";
import Link from "next/link";

import { BackLink } from "@/components/back-link";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <BackLink href="/" label="home" className="-my-2" />
        <span className="type-label text-fg-muted">Manager account</span>
        <h1 className="m-0 type-h1">Sign in</h1>
        <p className="m-0 type-body-lg text-fg-muted">
          Owners, admins, HR, finance and managers sign in here.
        </p>
      </div>
      <SignInForm />
      <div className="flex flex-col gap-2 border-t border-line pt-5 text-sm">
        <p className="m-0">
          New to Metalira Ops? <Link href="/sign-up">Create an account</Link>
        </p>
        <p className="m-0 text-fg-muted">
          Staff member? <Link href="/m/sign-in">Sign in on your phone</Link>
        </p>
      </div>
    </>
  );
}
