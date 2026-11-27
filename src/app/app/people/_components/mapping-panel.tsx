"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useState, useSyncExternalStore } from "react";

import { FormAlert, SelectField, SubmitButton } from "@/components/form";
import { StatusDot } from "@/components/status";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatDate } from "@/lib/dates";
import { saveMappingAction } from "@/server/people/actions";
import type { Option, SiteOption } from "@/server/people/people-data";

/** The worker the panel maps, as the People list already has them. */
export interface MappingWorker {
  id: string;
  name: string;
  initials: string;
  jobTitle: string | null;
  staffId: string;
  departmentId: string | null;
  /** `w:<id>`, `m:<id>` or empty. */
  lineManager: string;
  siteIds: string[];
  projectIds: string[];
  /** First day of site or project changes already saved for later, if any. */
  changesFrom: string | null;
}

export interface MappingOptions {
  departments: Option[];
  lineManagers: Option[];
  /** Offices first (slice 6.11); an office takes no projects. */
  sites: SiteOption[];
  projects: Option[];
}

/** Below this width the panel is a bottom sheet; from it, the right-hand column. */
const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    // On the server the sheet stays closed; phones open it once hydrated.
    () => true,
  );
}

/**
 * The mapping panel on /app/people (People board): department, line manager, site and projects
 * for one employee, then "Save mapping". At 1440px it is the right-hand column beside the
 * table; at 390px it opens as a bottom sheet when an employee's mapping status is tapped, and
 * closing it drops `?map=` from the address.
 */
export function MappingPanel({
  worker,
  options,
  open,
  closeHref,
  avatar,
}: {
  worker: MappingWorker | null;
  options: MappingOptions;
  /** The worker's avatar, rendered on the server (the same face as in the table). */
  avatar?: React.ReactNode;
  /** True when an employee was picked (`?map=`), so phones show the sheet. */
  open: boolean;
  closeHref: string;
}) {
  const isDesktop = useIsDesktop();
  const router = useRouter();

  if (!worker) {
    return (
      <aside
        aria-label="Mapping"
        className="hidden flex-[1_1_340px] flex-col gap-2 rounded-xl border border-line p-5 lg:flex"
      >
        <h2 className="m-0 type-h3">Mapping</h2>
        <p className="m-0 text-sm text-fg-muted">
          Choose an employee&apos;s mapping status to set their department, line manager, site and
          projects.
        </p>
      </aside>
    );
  }

  return (
    <>
      <aside
        aria-label="Mapping"
        className="hidden flex-[1_1_340px] flex-col rounded-xl border border-line p-5 lg:flex"
      >
        <MappingForm key={worker.id} worker={worker} options={options} avatar={avatar} />
      </aside>
      <Sheet
        open={open && !isDesktop}
        onOpenChange={(next) => {
          if (!next) router.replace(closeHref, { scroll: false });
        }}
      >
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          className="max-h-[88dvh] gap-0 overflow-y-auto rounded-t-xl p-5 pt-6"
        >
          <MappingForm key={worker.id} worker={worker} options={options} avatar={avatar} inSheet />
        </SheetContent>
      </Sheet>
    </>
  );
}

function MappingForm({
  worker,
  options,
  avatar,
  inSheet = false,
}: {
  worker: MappingWorker;
  options: MappingOptions;
  avatar?: React.ReactNode;
  inSheet?: boolean;
}) {
  const [state, action] = useActionState(saveMappingAction, null);
  // Controlled, so a refused save keeps what was chosen (React resets uncontrolled forms).
  const [departmentId, setDepartmentId] = useState(worker.departmentId ?? "");
  const [lineManager, setLineManager] = useState(worker.lineManager);
  const [siteId, setSiteId] = useState(worker.siteIds[0] ?? "");
  const [projectIds, setProjectIds] = useState<string[]>(worker.projectIds);
  const [edited, setEdited] = useState(false);
  const titleId = useId();
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  // Slice 6.11: an office has no client, so no projects. None are sent, and saving closes any.
  const atOffice = options.sites.find((s) => s.value === siteId)?.office ?? false;

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setEdited(true);
    };
  const toggleProject = edit((id: string) =>
    setProjectIds((current) =>
      current.includes(id) ? current.filter((p) => p !== id) : [...current, id],
    ),
  );

  const title = (
    <h2 id={titleId} className="m-0 type-h3 break-words">
      {worker.name}
    </h2>
  );

  return (
    <form
      action={action}
      onSubmit={() => setEdited(false)}
      noValidate
      aria-labelledby={titleId}
      data-testid="mapping-form"
      className="flex flex-col gap-3.5"
    >
      <input type="hidden" name="workerId" value={worker.id} />
      <div className="flex items-center gap-3 pr-8 lg:pr-0">
        {avatar ?? (
          <span
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface text-[15px] font-semibold"
          >
            {worker.initials}
          </span>
        )}
        <div className="flex min-w-0 flex-col">
          {inSheet ? <SheetTitle asChild>{title}</SheetTitle> : title}
          <span className="text-[13px] text-fg-muted">
            {worker.jobTitle ? `${worker.jobTitle} · ` : ""}
            {worker.staffId}
          </span>
        </div>
      </div>

      <SelectField
        label="Department"
        name="departmentId"
        placeholder="Not set"
        options={options.departments}
        value={departmentId}
        onChange={(e) => edit(setDepartmentId)(e.currentTarget.value)}
        error={errors?.departmentId}
      />
      <SelectField
        label="Line manager"
        name="lineManager"
        placeholder="Not set"
        options={options.lineManagers}
        value={lineManager}
        onChange={(e) => edit(setLineManager)(e.currentTarget.value)}
        error={errors?.lineManager}
      />
      <SelectField
        label="Site"
        name="siteId"
        placeholder="Not set"
        options={options.sites}
        value={siteId}
        onChange={(e) => edit(setSiteId)(e.currentTarget.value)}
        hint={
          options.sites.length === 0
            ? "No sites yet. Sites come in with your employee import, or with your clients."
            : worker.siteIds.length > 1
              ? `On ${worker.siteIds.length} sites now. Saving keeps only the one chosen here.`
              : undefined
        }
        error={errors?.siteId}
      />

      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1.5 text-[13px] font-medium">Projects</legend>
        {atOffice ? (
          <p className="m-0 text-xs text-fg-muted" data-testid="mapping-office-note">
            An office has no projects. People here are overhead, not a client&apos;s labour cost.
            {worker.projectIds.length > 0 ? " Saving takes them off their projects." : ""}
          </p>
        ) : options.projects.length === 0 ? (
          <p className="m-0 text-xs text-fg-muted">No projects yet.</p>
        ) : (
          <div className="flex max-h-64 flex-col overflow-y-auto">
            {options.projects.map((project) => (
              <label
                key={project.value}
                className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm"
              >
                <input
                  type="checkbox"
                  name="projectIds"
                  value={project.value}
                  checked={projectIds.includes(project.value)}
                  onChange={() => toggleProject(project.value)}
                  className="size-[18px] shrink-0 accent-foreground"
                />
                <span className="min-w-0 break-words">{project.label}</span>
              </label>
            ))}
          </div>
        )}
        {errors?.projectIds ? (
          <p className="m-0 text-xs font-medium text-foreground">{errors.projectIds}</p>
        ) : null}
      </fieldset>

      <p className="m-0 text-[13px] text-fg-muted">
        Changes apply from the next shift. The line manager is told by email, and the employee sees
        the change in their profile.
        {worker.changesFrom && !(state?.ok && !edited)
          ? ` Changes already saved start on ${formatDate(worker.changesFrom)}.`
          : ""}
      </p>

      <FormAlert message={state && !state.ok ? state.formError : undefined} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
          Save mapping
        </SubmitButton>
        {state?.ok && !edited ? (
          <p role="status" className="m-0 inline-flex items-center gap-2 text-sm font-semibold">
            <StatusDot tone="done" />
            {state.message ?? "Saved"}
          </p>
        ) : null}
      </div>
    </form>
  );
}
