"use client";

import { useActionState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { createDepartmentAction, updateDepartmentAction } from "@/server/people/actions";
import type { Option } from "@/server/people/people-data";

import { fieldValue } from "../../_company/form-footer";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-end gap-4";

/** Adds a department, with its head if one is chosen. */
export function AddDepartmentForm({ heads }: { heads: Option[] }) {
  const [state, action] = useActionState(createDepartmentAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const defaults = {
    name: fieldValue(state, "name", ""),
    headWorkerId: fieldValue(state, "headWorkerId", ""),
  };
  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label="Add department"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <div className={GRID}>
        <Field
          label="New department"
          name="name"
          placeholder="Security services"
          required
          defaultValue={defaults.name}
          error={errors?.name}
        />
        <SelectField
          label="Head"
          name="headWorkerId"
          placeholder="No head yet"
          options={heads}
          defaultValue={defaults.headWorkerId}
          error={errors?.headWorkerId}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Adding…" className="w-auto px-5">
          Add department
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}

/** Renames a department or changes its head. */
export function DepartmentRowForm({
  department,
  heads,
}: {
  department: { id: string; name: string; headWorkerId: string | null; count: number };
  heads: Option[];
}) {
  const [state, action] = useActionState(updateDepartmentAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const defaults = {
    name: fieldValue(state, "name", department.name),
    headWorkerId: fieldValue(state, "headWorkerId", department.headWorkerId),
  };
  return (
    <form
      key={JSON.stringify(defaults)}
      action={action}
      noValidate
      aria-label={`Department ${department.name}`}
      className="flex flex-col gap-3 border-t border-line pt-5"
    >
      <input type="hidden" name="departmentId" value={department.id} />
      <div className={GRID}>
        <Field
          label="Name"
          name="name"
          required
          hint={`${department.count.toLocaleString("en-NG")} ${department.count === 1 ? "employee" : "employees"}`}
          defaultValue={defaults.name}
          error={errors?.name}
        />
        <SelectField
          label="Head"
          name="headWorkerId"
          placeholder="No head yet"
          options={heads}
          defaultValue={defaults.headWorkerId}
          error={errors?.headWorkerId}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}
