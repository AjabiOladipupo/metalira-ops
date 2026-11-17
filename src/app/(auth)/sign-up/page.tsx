import type { Metadata } from "next";
import Link from "next/link";

import { Illustration } from "@/components/illustration";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

/**
 * Sign-up. On wide screens (xl and up) the welcome scene sits beside the form copy; the auth
 * layout widens its column for pages marked `data-auth-wide`. Below xl the scene is hidden: on a
 * 390 x 844 phone it would push the four fields and the button below the fold.
 */
export default function SignUpPage() {
  return (
    <div data-auth-wide className="flex flex-col gap-10 xl:flex-row xl:items-start">
      <div className="flex min-w-0 flex-col gap-6 xl:w-[440px] xl:shrink-0">
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
      </div>
      <Illustration name="welcome" size="onboarding" decorative className="hidden xl:block" />
    </div>
  );
}
