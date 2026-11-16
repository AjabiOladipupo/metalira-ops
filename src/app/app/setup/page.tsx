import type { Metadata } from "next";

import { RouteGate } from "../_shell/slots";
import { ResumeSetup } from "./_components/steps";

export const metadata: Metadata = { title: "Set up your business" };

/** Sends the owner to the furthest setup step reached, or to Ready once setup is complete. */
export default function Page() {
  return (
    <RouteGate href="/app/setup">
      <ResumeSetup />
    </RouteGate>
  );
}
