import type { Metadata } from "next";

import { RouteGate } from "../../_shell/slots";
import { ClientsStep } from "../_components/steps";

export const metadata: Metadata = { title: "Set up: Clients and contracts" };

export default function Page() {
  return (
    <RouteGate href="/app/setup/clients">
      <ClientsStep />
    </RouteGate>
  );
}
