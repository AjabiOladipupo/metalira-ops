import type { Metadata } from "next";

import { RouteGate } from "../../_shell/slots";
import { PlanStep } from "../_components/steps";

export const metadata: Metadata = { title: "Set up: Plan" };

export default function Page() {
  return (
    <RouteGate href="/app/setup/plan">
      <PlanStep />
    </RouteGate>
  );
}
