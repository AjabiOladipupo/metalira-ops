import type { Metadata } from "next";

import { RouteGate } from "../../_shell/slots";
import { EmployeesStep } from "../_components/steps";

export const metadata: Metadata = { title: "Set up: Employees" };

export default function Page() {
  return (
    <RouteGate href="/app/setup/employees">
      <EmployeesStep />
    </RouteGate>
  );
}
