import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { loadHeadOptions, loadPeopleDirectory } from "@/server/people/people-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import { AddDepartmentForm, DepartmentRowForm } from "./department-forms";

export const metadata: Metadata = { title: "Departments" };

/** Add, rename and set the head of departments. Owner, admin and hr. */
async function Departments() {
  const ctx = await peoplePageContext();
  const [directory, heads] = await Promise.all([
    loadPeopleDirectory(ctx.supabase, ctx.organisationId, ctx.today),
    loadHeadOptions(ctx.supabase, ctx.organisationId),
  ]);
  const departments = [...directory.departments].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Departments"
        description={`${departments.length} ${departments.length === 1 ? "department" : "departments"} · every employee belongs to one, and each can have a head.`}
      />
      <AddDepartmentForm heads={heads} />
      {departments.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          No departments yet. Add one above, or import a staff list and its departments come in with
          it.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {departments.map((d) => (
            <DepartmentRowForm key={d.id} department={d} heads={heads} />
          ))}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/settings/departments">
      <Departments />
    </RouteGate>
  );
}
