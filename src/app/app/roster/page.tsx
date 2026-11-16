import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Roster" };

export default function Page() {
  return (
    <RouteGate href="/app/roster">
      <PlaceholderPage href="/app/roster" />
    </RouteGate>
  );
}
