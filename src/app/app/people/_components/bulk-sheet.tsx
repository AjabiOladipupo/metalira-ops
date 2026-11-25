"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { BulkProblem } from "@/server/people/bulk";

/** Shared pieces of the People list's bulk sheets (slices U.1 and U.3). */

/** What the server needs for a selection: the ticked ids, or the filters to re-run. */
export type SelectionInput =
  { kind: "ids"; ids: string[] } | { kind: "filters"; filters: Record<string, string> };

export function Problems({ problems }: { problems: readonly BulkProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul aria-label="People who can't be changed" className="m-0 flex list-none flex-col gap-1 p-0">
      {problems.map((p) => (
        <li key={p.workerId} className="text-sm">
          <span className="font-semibold">{p.name ?? "Unknown employee"}</span>
          {p.staffId ? <span className="text-fg-muted"> · {p.staffId}</span> : null}
          <span>: {p.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function SheetFrame({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="pr-12">
          <SheetTitle className="type-h3">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
