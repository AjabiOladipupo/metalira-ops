import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Live attendance" };

export default function Page() {
  return (
    <RouteGate href="/app/attendance">
      <PlaceholderPage href="/app/attendance" />
    </RouteGate>
  );
}
