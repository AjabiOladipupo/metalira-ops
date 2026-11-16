import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

import { RouteGate } from "../_shell/slots";

export const metadata: Metadata = { title: "Collections" };

export default function Page() {
  return (
    <RouteGate href="/app/collections">
      <PlaceholderPage href="/app/collections" />
    </RouteGate>
  );
}
