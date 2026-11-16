import type { Metadata } from "next";

import { RouteGate } from "../../_shell/slots";
import { InvoicesStep } from "../_components/steps";

export const metadata: Metadata = { title: "Set up: Invoices and payments" };

export default function Page() {
  return (
    <RouteGate href="/app/setup/invoices">
      <InvoicesStep />
    </RouteGate>
  );
}
