import type { Metadata } from "next";
import Link from "next/link";

import { PlaceholderPage } from "@/components/shell/placeholder-page";
import { Button } from "@/components/ui/button";
import { canAccessHref } from "@/lib/nav";
import { getSession } from "@/server/identity/session";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "People" };

/** The way in to the import until the People list (slice 1.5) gives it a header action. */
async function ImportAction() {
  const session = await getSession();
  const role = session?.active?.role;
  if (!role || !canAccessHref(role, "/app/people/import")) return null;
  return (
    <Button asChild className="h-11 self-start rounded-lg px-5">
      <Link href="/app/people/import">Import employees</Link>
    </Button>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/people">
      <div className="flex flex-col gap-6">
        <PlaceholderPage href="/app/people" />
        <ImportAction />
      </div>
    </RouteGate>
  );
}
