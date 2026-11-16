import type { Metadata } from "next";

import { RouteGate } from "../../_shell/slots";
import { ReadyStep } from "../_components/steps";

export const metadata: Metadata = { title: "Set up: Ready" };

export default function Page() {
  return (
    <RouteGate href="/app/setup/ready">
      <ReadyStep />
    </RouteGate>
  );
}
