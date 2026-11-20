"use client";

import { useActionState, useState } from "react";

import { FormAlert, SubmitButton } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  MODULES,
  describeModulesChange,
  modulesProblem,
  modulesTurnedOff,
  type ModuleId,
  type Modules,
} from "@/lib/modules";
import { saveModules } from "@/server/identity/company-actions";

/**
 * Settings > Company > Modules (slice 3.0): one switch per part of the app with one plain
 * sentence each. Turning a part off asks for confirmation first and says that nothing is
 * deleted. The server checks the same rules again (payroll and shifts need people). The page
 * keys this form on the saved switches, so a successful save starts it afresh.
 */
export function ModulesForm({ modules }: { modules: Modules }) {
  const [state, action] = useActionState(saveModules, null);
  const [next, setNext] = useState<Modules>(modules);
  const [confirming, setConfirming] = useState(false);

  const off = modulesTurnedOff(modules, next);
  const problem = modulesProblem(next);
  const changed = MODULES.some((m) => modules[m.id] !== next[m.id]);
  const formError = state && !state.ok ? state.formError : undefined;

  function toggle(id: ModuleId, on: boolean) {
    setConfirming(false);
    setNext((current) => ({ ...current, [id]: on }));
  }

  return (
    <form
      action={action}
      onSubmit={(event) => {
        // Turning a part off goes through the confirm step first.
        if (off.length > 0 && !confirming) {
          event.preventDefault();
          setConfirming(true);
        }
      }}
      className="flex flex-col gap-5"
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {MODULES.map((m) => (
          <li key={m.id}>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4">
              <input
                type="checkbox"
                name={m.id}
                checked={next[m.id]}
                onChange={(event) => toggle(m.id, event.target.checked)}
                className="mt-0.5 size-[18px] shrink-0 accent-foreground"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-semibold">{m.name}</span>
                <span className="text-sm text-fg-muted">{m.body}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {problem ? (
        <p role="alert" className="m-0 text-sm font-medium">
          {problem}
        </p>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby="modules-confirm-title"
          className="flex flex-col gap-3 rounded-xl bg-surface p-4"
        >
          <p id="modules-confirm-title" className="m-0 text-[15px] font-semibold">
            {describeModulesChange(modules, next)}
          </p>
          <input type="hidden" name="confirmed" value="yes" />
          <div className="flex flex-wrap gap-3">
            <SubmitButton pendingLabel="Saving…" className="w-auto px-5">
              {off.length === 1 ? "Turn it off" : "Turn them off"}
            </SubmitButton>
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-lg px-4"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <FormAlert message={formError} />
      {confirming ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton
            pendingLabel="Saving…"
            className="w-auto px-5"
            disabled={!changed || problem !== null}
          >
            Save modules
          </SubmitButton>
          <p role="status" className="m-0 text-sm text-fg-muted">
            {changed ? null : "Every part matches what is saved."}
          </p>
        </div>
      )}
    </form>
  );
}
