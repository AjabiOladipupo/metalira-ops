import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PlaceholderPage } from "@/components/shell/placeholder-page";
import { pendingSetupHref } from "@/server/identity/company-data";

import { RouteGate } from "./_shell/slots";

export const metadata: Metadata = { title: "Home" };

/** An owner or admin whose company has not finished setup lands on the wizard instead. */
async function Home() {
  const setupHref = await pendingSetupHref();
  if (setupHref) redirect(setupHref);
  return <PlaceholderPage href="/app" />;
}

export default function Page() {
  return (
    <RouteGate href="/app">
      <Home />
    </RouteGate>
  );
}
