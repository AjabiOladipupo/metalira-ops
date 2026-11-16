import type { Metadata } from "next";

import { RouteGate } from "../../_shell/slots";
import { EmployeesStep } from "../_components/steps";

export const metadata: Metadata = { title: "Set up: Employees" };

async function Step({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { batch } = await searchParams;
  return <EmployeesStep batchId={typeof batch === "string" ? batch : undefined} />;
}

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <RouteGate href="/app/setup/employees">
      <Step searchParams={searchParams} />
    </RouteGate>
  );
}
