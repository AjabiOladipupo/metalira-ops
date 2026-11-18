import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { BackLink } from "@/components/back-link";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/lib/roles";
import { signOut } from "@/server/identity/actions";
import { getPageSession } from "@/server/identity/session";

export const metadata: Metadata = { title: "No access" };

/**
 * Where the app sends a signed-in user whose role cannot open a page, and client approvers
 * until a client portal exists. It lives outside /app so the app's access checks can never
 * redirect it to itself.
 */
export default function NoAccessPage() {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <BackLink href="/" label="Metalira Ops home" className="-my-2" />
        <span className="type-label text-fg-muted">No access</span>
        <h1 className="m-0 type-h1">You can&apos;t open this page</h1>
        <p className="m-0 type-body-lg text-fg-muted">
          Your role doesn&apos;t include it. Ask an owner or an admin of your company for access.
        </p>
      </div>
      <Suspense fallback={<SignOutButton />}>
        <NoAccessActions />
      </Suspense>
    </>
  );
}

async function NoAccessActions() {
  const session = await getPageSession();
  const active = session?.active;
  // Without a manager membership every membership is a worker or client approver role.
  const roles = !active && session ? session.memberships.map((m) => m.role) : [];
  return (
    <div className="flex flex-col gap-4">
      {session && roles.length > 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          Signed in as {session.user.email} ({roles.map((r) => ROLE_LABELS[r]).join(", ")}).
        </p>
      ) : null}
      {session && session.memberships.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted" data-testid="no-access-invited">
          Invited to join a company? Open the invite link in your email again and accept it.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {active ? (
          <Button asChild className="h-11 rounded-lg">
            <Link href="/app">Back to home</Link>
          </Button>
        ) : null}
        {session ? <SignOutButton /> : null}
        {!session ? (
          <Button asChild className="h-11 rounded-lg">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SignOutButton() {
  return (
    <form action={signOut}>
      <Button type="submit" variant="outline" className="h-11 rounded-lg">
        Sign out
      </Button>
    </form>
  );
}
