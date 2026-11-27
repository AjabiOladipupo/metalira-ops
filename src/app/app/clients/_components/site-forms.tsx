"use client";

import Link from "next/link";
import { useActionState, useId } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import { NIGERIAN_STATES } from "@/lib/company";
import { cn } from "@/lib/utils";
import type { CompanyFormState } from "@/server/identity/company-form-state";
import {
  addCheckpointAction,
  createOfficeAction,
  createSiteAction,
  moveCheckpointAction,
  renameCheckpointAction,
  retireCheckpointAction,
  rotateCheckpointQrAction,
  setSiteStatusAction,
  updateSiteAction,
} from "@/server/sites/actions";

import { fieldValue } from "../../_company/form-footer";

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-start gap-4";
const STATE_OPTIONS = NIGERIAN_STATES.map((s) => ({ value: s, label: s }));

export interface SiteFormValues {
  id: string;
  name: string;
  address: string | null;
  state: string | null;
  landmark: string | null;
}

/**
 * Add a site to a client, or change a site's name, address, state and landmark. With `office`,
 * the same for one of the company's own offices (slice 6.11): no client, and Cancel goes back to
 * Settings > Company.
 */
export function SiteDetailsForm({
  mode,
  clientId,
  site,
  office = false,
}: {
  mode: "create" | "edit";
  clientId?: string;
  site?: SiteFormValues;
  office?: boolean;
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(
    mode === "edit" ? updateSiteAction : office ? createOfficeAction : createSiteAction,
    null,
  );
  const cancelHref = office
    ? "/app/settings/company#head-office"
    : `/app/clients/${clientId}?tab=sites`;
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const value = (name: string, saved: string | null | undefined) => fieldValue(state, name, saved);
  const addressId = useId();
  const addressNote = errors?.address ?? "Where your people report. Shown to them in the app.";
  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label={
        mode === "create"
          ? office
            ? "Add office"
            : "Add site"
          : office
            ? "Office details"
            : "Site details"
      }
      className={cn(
        "flex flex-col gap-4",
        mode === "edit" ? "rounded-xl bg-surface p-4 sm:p-5" : "max-w-[880px]",
      )}
    >
      {mode === "create" && !office ? (
        <input type="hidden" name="clientId" value={clientId} />
      ) : null}
      {site ? <input type="hidden" name="siteId" value={site.id} /> : null}
      <div className={GRID}>
        <Field
          label={office ? "Office name" : "Site name"}
          name="name"
          required
          placeholder={office ? "Ikeja branch" : "Apapa Warehouse 3"}
          defaultValue={value("name", site?.name)}
          error={errors?.name}
        />
        <Field
          label="Landmark"
          name="landmark"
          placeholder="Opposite the Total filling station"
          defaultValue={value("landmark", site?.landmark)}
          error={errors?.landmark}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={addressId} className="text-[13px] font-medium">
          Address
        </label>
        <textarea
          id={addressId}
          name="address"
          rows={3}
          defaultValue={value("address", site?.address)}
          aria-invalid={errors?.address ? true : undefined}
          aria-describedby={`${addressId}-note`}
          className="w-full min-w-0 rounded-lg border border-line bg-background px-3 py-2.5 text-[15px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal aria-invalid:border-foreground"
        />
        <p
          id={`${addressId}-note`}
          className={cn(
            "m-0 text-xs",
            errors?.address ? "font-medium text-foreground" : "text-fg-muted",
          )}
        >
          {addressNote}
        </p>
      </div>
      <div className={GRID}>
        <SelectField
          label="State"
          name="state"
          placeholder="Choose a state"
          options={STATE_OPTIONS}
          defaultValue={value("state", site?.state)}
          error={errors?.state}
        />
      </div>
      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton
          pendingLabel={mode === "create" ? "Adding…" : "Saving…"}
          className="w-auto px-5"
        >
          {mode === "create" ? (office ? "Add office" : "Add site") : "Save details"}
        </SubmitButton>
        {mode === "create" ? (
          <Button asChild variant="outline" className="h-11 px-4">
            <Link href={cancelHref}>Cancel</Link>
          </Button>
        ) : null}
        <p role="status" className="m-0 text-sm text-fg-muted">
          {state?.ok ? state.message : null}
        </p>
      </div>
    </form>
  );
}

/** Archive or restore a site. */
export function SiteStatusForm({
  siteId,
  status,
}: {
  siteId: string;
  status: "active" | "archived";
}) {
  const [state, action] = useActionState<CompanyFormState, FormData>(setSiteStatusAction, null);
  const next = status === "active" ? "archived" : "active";
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="status" value={next} />
      <SubmitButton
        pendingLabel={next === "archived" ? "Archiving…" : "Restoring…"}
        className="w-auto px-5"
      >
        {next === "archived" ? "Archive site" : "Restore site"}
      </SubmitButton>
      <p role="status" className="m-0 text-sm text-fg-muted">
        {state?.ok ? state.message : state?.formError}
      </p>
    </form>
  );
}

/** Adds a checkpoint at the end of the round. */
export function AddCheckpointForm({ siteId }: { siteId: string }) {
  const [state, action] = useActionState<CompanyFormState, FormData>(addCheckpointAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form
      key={JSON.stringify(state)}
      action={action}
      noValidate
      aria-label="Add checkpoint"
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="siteId" value={siteId} />
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Checkpoint name"
          name="name"
          required
          placeholder="Gate A"
          className="min-w-0 flex-[1_1_14rem]"
          defaultValue={fieldValue(state, "name", "")}
          error={errors?.name}
        />
        <SubmitButton pendingLabel="Adding…" className="w-auto px-5">
          Add checkpoint
        </SubmitButton>
      </div>
      <FormAlert message={state && !state.ok && !errors?.name ? state.formError : undefined} />
      <p role="status" className="m-0 text-sm text-fg-muted empty:hidden">
        {state?.ok ? state.message : null}
      </p>
    </form>
  );
}

export interface CheckpointValues {
  id: string;
  name: string;
  position: number;
  qrRotatedAt: string | null;
}

/** One checkpoint: rename, move up or down, new QR code, or retire. */
export function CheckpointRow({
  checkpoint,
  isFirst,
  isLast,
  rotatedLabel,
}: {
  checkpoint: CheckpointValues;
  isFirst: boolean;
  isLast: boolean;
  rotatedLabel: string | null;
}) {
  const [state, rename] = useActionState<CompanyFormState, FormData>(renameCheckpointAction, null);
  const [moveState, move] = useActionState<CompanyFormState, FormData>(moveCheckpointAction, null);
  const [rotateState, rotate] = useActionState<CompanyFormState, FormData>(
    rotateCheckpointQrAction,
    null,
  );
  const [retireState, retire] = useActionState<CompanyFormState, FormData>(
    retireCheckpointAction,
    null,
  );
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const note =
    (rotateState?.ok ? rotateState.message : rotateState?.formError) ??
    (retireState && !retireState.ok ? retireState.formError : undefined) ??
    (moveState && !moveState.ok ? moveState.formError : undefined) ??
    (state?.ok ? state.message : state?.formError);
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0" data-testid="checkpoint-row">
      <form
        key={JSON.stringify({ state, name: checkpoint.name })}
        action={rename}
        noValidate
        aria-label={`Checkpoint ${checkpoint.position}: ${checkpoint.name}`}
        className="flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="checkpointId" value={checkpoint.id} />
        <span className="flex h-11 min-w-8 items-center text-sm font-semibold tabular-nums">
          {checkpoint.position}.
        </span>
        <Field
          label="Name"
          name="name"
          required
          className="min-w-0 flex-[1_1_12rem]"
          defaultValue={fieldValue(state, "name", checkpoint.name)}
          error={errors?.name}
        />
        <SubmitButton pendingLabel="Saving…" className="w-auto px-4">
          Rename
        </SubmitButton>
        <Button
          type="submit"
          variant="outline"
          className="h-11 px-3"
          formAction={move}
          name="direction"
          value="up"
          disabled={isFirst}
          formNoValidate
        >
          Move up
        </Button>
        <Button
          type="submit"
          variant="outline"
          className="h-11 px-3"
          formAction={move}
          name="direction"
          value="down"
          disabled={isLast}
          formNoValidate
        >
          Move down
        </Button>
        <Button
          type="submit"
          variant="outline"
          className="h-11 px-3"
          formAction={rotate}
          formNoValidate
        >
          New QR code
        </Button>
        <Button
          type="submit"
          variant="outline"
          className="h-11 px-3"
          formAction={retire}
          formNoValidate
        >
          Retire
        </Button>
      </form>
      <p role="status" className="m-0 text-sm text-fg-muted empty:hidden">
        {note ?? rotatedLabel}
      </p>
    </li>
  );
}
