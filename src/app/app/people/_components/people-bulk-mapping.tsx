"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { FormAlert, SelectField } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  BULK_MAP_LIMIT,
  BULK_MAP_MODES,
  BULK_MAP_MODE_TEXT,
  bulkMapSummary,
  bulkMapWhen,
  type BulkMapMode,
} from "@/lib/bulk-mapping";
import type { BulkProblem } from "@/server/people/bulk";
import { bulkMapAction, previewBulkMapAction } from "@/server/people/bulk-actions";
import type { BulkMapPreview } from "@/server/people/bulk-mapping";
import type { BulkMappingTarget } from "@/server/people/people-data";

import { Problems, SheetFrame, type SelectionInput } from "./bulk-sheet";

const people = (n: number) => `${n.toLocaleString("en-NG")} ${n === 1 ? "person" : "people"}`;

/**
 * "Map to site and project" (slice U.3): one site, optionally projects of that site's client, and
 * Replace or Add, for everyone selected. A preview lists each person's site and projects now and
 * after, the day it applies and anyone who can't be mapped; the confirm is all or nothing.
 */
export function BulkMappingSheet({
  open,
  onOpenChange,
  selection,
  sites,
  projects,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: SelectionInput;
  sites: readonly BulkMappingTarget[];
  projects: readonly BulkMappingTarget[];
  onDone: (message: string) => void;
}) {
  const router = useRouter();
  const [siteId, setSiteId] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [mode, setMode] = useState<BulkMapMode>("replace");
  const [preview, setPreview] = useState<BulkMapPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<BulkProblem[]>([]);
  const [pending, start] = useTransition();

  const site = sites.find((s) => s.value === siteId);
  const clientId = site?.clientId ?? null;
  // Slice 6.11: an office has no client, so no projects.
  const atOffice = site?.office ?? false;
  const siteProjects = clientId ? projects.filter((p) => p.clientId === clientId) : [];

  const reset = () => {
    setPreview(null);
    setError(null);
    setProblems([]);
  };
  const blocked = preview ? preview.rows.some((r) => r.refusal) : false;
  const changing = preview ? preview.rows.filter((r) => r.changed).length : 0;

  return (
    <SheetFrame
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Map to site and project"
      description={`One site and its projects for everyone selected, up to ${BULK_MAP_LIMIT} at a time. Department and line manager stay as they are.`}
    >
      {preview === null ? (
        <form
          noValidate
          aria-label="Choose a site and projects"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            start(async () => {
              reset();
              if (!siteId) {
                setError("Choose a site.");
                return;
              }
              const result = await previewBulkMapAction({
                selection,
                siteId,
                projectIds: atOffice ? [] : projectIds,
                mode,
              });
              if (!result.ok) {
                setError(
                  result.fieldErrors?.siteId ?? result.fieldErrors?.selection ?? result.message,
                );
                return;
              }
              setPreview(result.value);
            });
          }}
        >
          <SelectField
            label="Site"
            options={sites}
            placeholder="Choose a site"
            value={siteId}
            onChange={(e) => {
              setSiteId(e.target.value);
              setProjectIds([]);
            }}
            hint={
              sites.length === 0
                ? "No sites yet. Sites come in with your employee import, or with your clients."
                : undefined
            }
          />

          <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
            <legend className="mb-1.5 text-[13px] font-medium">Projects (optional)</legend>
            {!siteId ? (
              <p className="m-0 text-xs text-fg-muted">Choose a site to see its projects.</p>
            ) : atOffice ? (
              <p className="m-0 text-xs text-fg-muted" data-testid="bulk-map-office-note">
                An office has no projects. People here are overhead, not a client&apos;s labour
                cost.
              </p>
            ) : siteProjects.length === 0 ? (
              <p className="m-0 text-xs text-fg-muted">This site&apos;s client has no projects.</p>
            ) : (
              <div className="flex max-h-56 flex-col overflow-y-auto">
                {siteProjects.map((project) => (
                  <label
                    key={project.value}
                    className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm lg:min-h-9"
                  >
                    <input
                      type="checkbox"
                      value={project.value}
                      checked={projectIds.includes(project.value)}
                      onChange={() =>
                        setProjectIds((ids) =>
                          ids.includes(project.value)
                            ? ids.filter((id) => id !== project.value)
                            : [...ids, project.value],
                        )
                      }
                      className="size-[18px] shrink-0 accent-foreground"
                    />
                    <span className="min-w-0 break-words">{project.label}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1.5 text-[13px] font-medium">Their other assignments</legend>
            {BULK_MAP_MODES.map((m) => (
              <label
                key={m}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm has-[:checked]:border-foreground"
              >
                <input
                  type="radio"
                  name="bulk-map-mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="mt-0.5 size-[18px] shrink-0 accent-foreground"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-semibold">{BULK_MAP_MODE_TEXT[m].label}</span>
                  <span className="text-[13px] text-fg-muted">{BULK_MAP_MODE_TEXT[m].hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <FormAlert message={error ?? undefined} />
          <Button type="submit" className="h-11 rounded-lg" disabled={pending}>
            {pending ? "Checking…" : "Preview"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm" data-testid="bulk-map-summary">
            {bulkMapSummary(preview.rows, preview.siteName)}
          </p>
          <ul aria-label="Mapping before and after" className="m-0 flex list-none flex-col p-0">
            {preview.rows.map((row) => (
              <li
                key={row.workerId}
                className="flex min-w-0 flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0"
              >
                <span className="text-sm font-semibold break-words">
                  {row.name ?? "Unknown employee"}
                  {row.staffId ? (
                    <span className="font-normal text-fg-muted"> · {row.staffId}</span>
                  ) : null}
                </span>
                {row.refusal ? (
                  <span className="text-sm font-medium">{row.refusal}</span>
                ) : (
                  <>
                    <span className="text-[13px] break-words text-fg-muted">
                      Now: {row.before?.sites}; {row.before?.projects}
                    </span>
                    <span className="text-[13px] break-words">
                      After: {row.after?.sites}; {row.after?.projects}
                    </span>
                    <span className="text-[13px] text-fg-muted">{bulkMapWhen(row)}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <Problems problems={problems} />
          <FormAlert message={error ?? undefined} />
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-lg"
              onClick={reset}
              disabled={pending}
            >
              Back
            </Button>
            <Button
              type="button"
              className="h-11 rounded-lg"
              disabled={pending || blocked || changing === 0}
              onClick={() =>
                start(async () => {
                  setError(null);
                  setProblems([]);
                  const result = await bulkMapAction({
                    workerIds: preview.selection.ids,
                    actIds: preview.selection.act,
                    expectedDigest: preview.selection.digest,
                    siteId,
                    projectIds: atOffice ? [] : projectIds,
                    mode,
                  });
                  if (!result.ok) {
                    // The list or the choice changed since the preview: preview again.
                    if (result.changed) setPreview(null);
                    setError(result.message);
                    setProblems(result.problems ?? []);
                    return;
                  }
                  setPreview(null);
                  setSiteId("");
                  setProjectIds([]);
                  setMode("replace");
                  onDone(result.message ?? "Done.");
                  router.refresh();
                })
              }
            >
              {pending ? "Saving…" : `Map ${people(changing)}`}
            </Button>
          </div>
        </div>
      )}
    </SheetFrame>
  );
}
