import type { Metadata } from "next";

import { RouteGate } from "../../_shell/slots";
import { BusinessStep } from "../_components/steps";

export const metadata: Metadata = { title: "Set up: Business details" };

export default function Page() {
  return (
    <RouteGate href="/app/setup/business">
      <BusinessStep />
    </RouteGate>
  );
}
