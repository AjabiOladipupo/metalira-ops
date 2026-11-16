import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Revenue" };

export default function Page() {
  return (
    <RouteGate href="/app/revenue">
      <PlaceholderPage href="/app/revenue" />
    </RouteGate>
  );
}
