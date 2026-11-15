import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

export const metadata: Metadata = { title: "People" };

export default function Page() {
  return <PlaceholderPage href="/app/people" />;
}
