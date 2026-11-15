import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/shell/placeholder-page";

export const metadata: Metadata = { title: "Payroll run" };

export default function Page() {
  return <PlaceholderPage href="/app/payroll" />;
}
