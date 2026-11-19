"use client";

import { useActionState, useId } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  addContactAction,
  removeContactAction,
  setClientStatusAction,
  updateContactAction,
} from "@/server/business/actions";
import type { CompanyFormState } from "@/server/identity/company-form-state";

import { fieldValue } from "../../_company/form-footer";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-start gap-4";

const ROLE_OPTIONS = [
  { value: "billing", label: "Billing: gets invoices and receipts" },
  { value: "approver", label: "Approver: approves timesheets" },
  { value: "ops", label: "Operations: site matters" },
];

function PrimaryCheckbox({ defaultChecked, label }: { defaultChecked?: boolean; label: string }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-2.5">
      <input
        id={id}
        type="checkbox"
        name="isPrimary"
        defaultChecked={defaultChecked}
        className="size-5 accent-[var(--action)]"
      />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}

/** Adds a contact to a client. */
export function AddContactForm({ clientId }: { clientId: string }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(addContactAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label="Add contact"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <div className={GRID}>
        <Field
          label="Name"
          name="name"
          required
          placeholder="Ngozi Eze"
          defaultValue={fieldValue(state, "name", "")}
          error={errors?.name}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          required
          placeholder="ngozi@coastline.ng"
          defaultValue={fieldValue(state, "email", "")}
          error={errors?.email}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          placeholder="0803 123 4567"
          defaultValue={fieldValue(state, "phone", "")}
          error={errors?.phone}
        />
        <SelectField
          label="Role"
          name="role"
          options={ROLE_OPTIONS}
          defaultValue={fieldValue(state, "role", "billing")}
          error={errors?.role}
        />
      </div>
      <PrimaryCheckbox
        label="Primary for this role"
        defaultChecked={fieldValue(state, "isPrimary", "") === "on"}
      />
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Adding…" className="w-auto px-5">
          Add contact
        </SubmitButton>
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}

export interface ContactValues {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isPrimary: boolean;
}

/** Edits one contact in place, makes it primary, or removes it. */
export function ContactRowForm({
  contact,
  roleLabel,
}: {
  contact: ContactValues;
  roleLabel: string;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(updateContactAction, null);
  const [removeState, remove] = useActionState<CompanyFormState, FormData>(
    removeContactAction,
    null,
  );
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const defaults = {
    name: fieldValue(state, "name", contact.name),
    email: fieldValue(state, "email", contact.email),
    phone: fieldValue(state, "phone", contact.phone),
  };
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <form
        key={JSON.stringify({ defaults, primary: contact.isPrimary })}
        action={action}
        noValidate
        aria-label={`Contact ${contact.name}`}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="contactId" value={contact.id} />
        <div className={GRID}>
          <Field
            label="Name"
            name="name"
            required
            defaultValue={defaults.name}
            error={errors?.name}
          />
          <Field
            label="Email"
            name="email"
            type="email"
            required
            defaultValue={defaults.email}
            error={errors?.email}
          />
          <Field
            label="Phone"
            name="phone"
            type="tel"
            defaultValue={defaults.phone}
            error={errors?.phone}
          />
        </div>
        {contact.isPrimary ? (
          <input type="hidden" name="isPrimary" value="on" />
        ) : (
          <PrimaryCheckbox label={`Make primary ${roleLabel.toLowerCase()} contact`} />
        )}
        <FormAlert message={state && !state.ok ? state.formError : undefined} />
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
            Save
          </SubmitButton>
          <Button
            type="submit"
            variant="outline"
            className="h-11 px-4"
            formAction={remove}
            formNoValidate
          >
            Remove
          </Button>
          <p role="status" className="m-0 text-sm text-fg-muted">
            {state?.ok ? state.message : null}
            {removeState && !removeState.ok ? removeState.formError : null}
          </p>
        </div>
      </form>
    </div>
  );
}

/** Archive or restore a client. */
export function ClientStatusForm({
  clientId,
  status,
}: {
  clientId: string;
  status: "active" | "archived";
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(setClientStatusAction, null);
  const next = status === "active" ? "archived" : "active";
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="status" value={next} />
      <SubmitButton
        pendingLabel={next === "archived" ? "Archiving…" : "Restoring…"}
        className="w-auto px-5"
      >
        {next === "archived" ? "Archive client" : "Restore client"}
      </SubmitButton>
      <p role="status" className="m-0 text-sm text-fg-muted">
        {state?.ok ? state.message : state?.formError}
      </p>
    </form>
  );
}
