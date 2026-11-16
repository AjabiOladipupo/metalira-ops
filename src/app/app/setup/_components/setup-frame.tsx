import { Check } from "lucide-react";
import Link from "next/link";

import {
  SETUP_STEPS,
  setupDoneCount,
  setupStep,
  setupStepHref,
  type SetupSlug,
} from "@/lib/company";
import { cn } from "@/lib/utils";
import type { Company } from "@/server/identity/company-data";

/**
 * The Setup board's frame inside the manager shell: a rail with "Setup N of 5 done" and the six
 * steps, and the current step's heading. Steps up to the furthest one reached are links, so the
 * owner can go back and change anything; later steps are not reachable from the rail yet.
 */
export function SetupFrame({
  current,
  company,
  title,
  description,
  children,
}: {
  current: SetupSlug;
  company: Pick<Company, "setupStep" | "setupCompletedAt">;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const completed = company.setupCompletedAt !== null;
  const furthest = completed ? 6 : company.setupStep;
  const step = setupStep(current);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
      <aside className="flex shrink-0 flex-col gap-5 rounded-xl bg-surface p-5 lg:sticky lg:top-6 lg:w-[260px]">
        <div className="flex flex-col gap-1">
          <span className="type-label text-fg-muted">Setup</span>
          <span className="font-display text-[22px] font-bold" data-testid="setup-progress">
            {setupDoneCount(company.setupStep, completed)} of 5 done
          </span>
        </div>
        <ol aria-label="Setup steps" className="m-0 flex list-none flex-col gap-1 p-0">
          {SETUP_STEPS.map((s) => {
            const isCurrent = s.slug === current;
            const done = completed ? s.number <= 5 : s.number < furthest;
            const reachable = s.number <= furthest;
            const badge = (
              <span
                aria-hidden
                className={cn(
                  "flex size-[26px] shrink-0 items-center justify-center rounded-full font-display text-[13px] font-bold",
                  done || isCurrent
                    ? "bg-foreground text-background"
                    : "border-[1.5px] border-fg-muted text-fg-muted",
                )}
              >
                {done && !isCurrent ? <Check strokeWidth={2.5} className="size-3.5" /> : s.number}
              </span>
            );
            const rowClass = cn(
              "flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-[15px] font-medium text-foreground no-underline",
              isCurrent ? "bg-background ring-1 ring-line" : "hover:bg-background/60",
            );
            return (
              <li key={s.slug}>
                {reachable ? (
                  <Link
                    href={setupStepHref(s.slug)}
                    aria-current={isCurrent ? "step" : undefined}
                    className={rowClass}
                  >
                    {badge}
                    {s.label}
                    {done ? <span className="sr-only">, done</span> : null}
                  </Link>
                ) : (
                  <span className={cn(rowClass, "text-fg-muted")}>
                    {badge}
                    {s.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        <p className="m-0 text-[13px] text-fg-muted">
          Everything here can be changed later in Settings.
        </p>
      </aside>

      <section className="flex max-w-[1040px] min-w-0 flex-1 flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          {step.number <= 5 ? (
            <span className="type-label text-fg-muted">Step {step.number}</span>
          ) : null}
          <h1 className="m-0 type-h1">{title}</h1>
          {description ? <p className="m-0 type-body-lg text-fg-muted">{description}</p> : null}
        </div>
        {children}
      </section>
    </div>
  );
}
