import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { formatDate } from "@/lib/dates";
import { changeDateChoices } from "@/lib/leave/entitlements";
import { ADVISER_LINE, findPreset, isPresetId } from "@/lib/leave/presets";
import { cn } from "@/lib/utils";
import { describePresetResult } from "@/server/capabilities/leave-previews";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { loadCalendar, previewApplyPreset } from "@/server/people/leave-setup-data";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../../../_shell/slots";
import { ApplyPresetForm } from "../../_components/leave-forms";

export const metadata: Metadata = { title: "Apply a leave preset" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Applying a preset, step one: the preview. It runs apply_leave_preset as a dry run, so what it
 * lists is what Apply will do unless the types change in between. `?from=tomorrow` starts the
 * changes to existing types tomorrow instead of the next 1 January.
 */
async function PresetPreview({
  params,
  searchParams,
}: {
  params: PageProps<"/app/settings/leave/preset/[preset]">["params"];
  searchParams: PageProps<"/app/settings/leave/preset/[preset]">["searchParams"];
}) {
  const [{ preset: raw }, query, ctx] = await Promise.all([
    params,
    searchParams,
    peoplePageContext(),
  ]);
  if (!isPresetId(raw)) notFound();
  if (!canEditLeaveSetup(ctx.role)) redirect("/app/settings/leave");
  const preset = findPreset(raw);
  const calendar = await loadCalendar(ctx.supabase, ctx.organisationId);
  const choices = changeDateChoices(calendar.today);
  const tomorrow = first(query.from) === "tomorrow";
  const from = tomorrow ? choices.tomorrow : choices.nextJanuary;

  const result = await previewApplyPreset(ctx.supabase, ctx.organisationId, preset.id, from);
  const preview = describePresetResult(result);
  const nothing = result.types.every((t) => t.action === "unchanged" && !t.detailsChanged);
  const hasExisting = result.types.some((t) => t.action !== "create");

  const tab = (active: boolean) =>
    cn(
      "rounded-lg border px-3 py-2 text-sm no-underline",
      active ? "border-foreground font-semibold text-foreground" : "border-line text-fg-muted",
    );

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        back={{ href: "/app/settings/leave", label: "Leave settings" }}
        eyebrow={`Preset ${preset.id}`}
        title={preset.name}
        description={preset.source}
      />
      <p className="m-0 rounded-lg bg-surface px-3 py-2.5 text-sm font-medium">{ADVISER_LINE}</p>

      {hasExisting ? (
        <nav aria-label="When changes start" className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg-muted">Changes to types you have start</span>
          <Link
            href={`/app/settings/leave/preset/${preset.id}`}
            className={tab(!tomorrow)}
            aria-current={!tomorrow ? "true" : undefined}
          >
            {formatDate(choices.nextJanuary)}
          </Link>
          <Link
            href={`/app/settings/leave/preset/${preset.id}?from=tomorrow`}
            className={tab(tomorrow)}
            aria-current={tomorrow ? "true" : undefined}
          >
            Tomorrow, {formatDate(choices.tomorrow)}
          </Link>
        </nav>
      ) : null}

      <p className="m-0 text-[15px] font-medium" data-testid="preset-preview">
        {preview.summary}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {preview.changes.map((c) => (
          <li
            key={c.label}
            className="flex flex-col gap-0.5 rounded-lg border border-line p-3 sm:flex-row sm:items-baseline sm:gap-3"
          >
            <span className="shrink-0 text-sm font-semibold sm:w-36">{c.label}</span>
            <span className="text-sm">
              {c.before ? <span className="text-fg-muted">{c.before} → </span> : null}
              {c.after}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[13px] text-fg-muted">
        New types start from 1 January this year so this year&apos;s balances can be given. Days
        already in force are never changed: a change is a new version from its start date.
      </p>
      {nothing ? (
        <Link href="/app/settings/leave" className="text-sm text-signal">
          Back to leave settings
        </Link>
      ) : (
        <ApplyPresetForm
          preset={preset.id}
          effectiveFrom={from}
          label={`Apply preset ${preset.id}`}
        />
      )}
    </div>
  );
}

export default function Page({ params, searchParams }: PageProps<"/app/settings/leave/preset/[preset]">) {
  return (
    <RouteGate href="/app/settings/leave">
      <PresetPreview params={params} searchParams={searchParams} />
    </RouteGate>
  );
}
