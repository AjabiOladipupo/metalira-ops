import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "People" };

export default function Page() {
  return (
    <RouteGate href="/app/people">
      <PlaceholderPage href="/app/people" />
    </RouteGate>
  );
}
