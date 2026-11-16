import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Projects" };

export default function Page() {
  return (
    <RouteGate href="/app/projects">
      <PlaceholderPage href="/app/projects" />
    </RouteGate>
  );
}
