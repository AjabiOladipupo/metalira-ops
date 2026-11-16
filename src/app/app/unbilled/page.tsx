import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Unbilled work" };

export default function Page() {
  return (
    <RouteGate href="/app/unbilled">
      <PlaceholderPage href="/app/unbilled" />
    </RouteGate>
  );
}
