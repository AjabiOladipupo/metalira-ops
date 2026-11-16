import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "My team" };

export default function Page() {
  return (
    <RouteGate href="/app/team">
      <PlaceholderPage href="/app/team" />
    </RouteGate>
  );
}
