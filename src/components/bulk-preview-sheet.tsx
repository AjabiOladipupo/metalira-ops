"use client";

import { useState, useTransition } from "react";

import { FormAlert } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * The preview-then-confirm sheet for a list's bulk action (slice U.2): "Approve selected" on
 * timesheets and leave, "Resend" and "Cancel invite" on worker invites. The preview lists what
 * will happen and every item that will be skipped with its reason ("3 will be approved, 2
 * skipped"); the confirm sends the ids the preview would act on with its signed digest (so it
 * never acts on anything the preview skipped), and when the server says the list changed
 * the sheet goes back to a fresh preview. Not all or nothing: the confirm acts on what passes.
 */

export interface BulkItem {
  id: string;
  title: string;
  detail?: string;
  /** Why it is skipped; absent for an item that goes ahead. */
  reason?: string;
}

export interface BulkPlan {
  passing: BulkItem[];
  skipped: BulkItem[];
  summary: string;
  digest: string;
  /** The ids the preview said it would act on; the confirm sends them with the digest. */
  act: string[];
}

type Result<T> =
  { ok: true; value: T; message?: string } | { ok: false; message: string; changed?: boolean };

export function BulkPreviewSheet<T>({
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  preview,
  confirm,
  plan,
  onDone,
}: {
  /** The action bar's button text ("Approve selected"). */
  trigger: string;
  title: string;
  description: string;
  /** "Approve 3", given how many pass. */
  confirmLabel: (passing: number) => string;
  pendingLabel: string;
  preview: () => Promise<Result<T>>;
  confirm: (signed: { expectedDigest: string; actIds: string[] }) => Promise<Result<T>>;
  plan: (value: T) => BulkPlan;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<BulkPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      setError(null);
      const result = await preview();
      if (!result.ok) {
        setCurrent(null);
        setError(result.message);
        return;
      }
      setCurrent(plan(result.value));
    });

  const close = () => {
    setOpen(false);
    setCurrent(null);
    setError(null);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 rounded-lg lg:h-9"
        onClick={() => {
          setOpen(true);
          setCurrent(null);
          load();
        }}
      >
        {trigger}
      </Button>
      <Sheet open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader className="pr-12">
            <SheetTitle className="type-h3">{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4 pb-6">
            {current === null ? (
              <>
                <p className="m-0 text-sm text-fg-muted" role="status">
                  {pending ? "Checking each one…" : ""}
                </p>
                <FormAlert message={error ?? undefined} />
                {error && !pending ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 rounded-lg"
                    onClick={load}
                  >
                    Check again
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <p className="m-0 text-sm font-medium" data-testid="bulk-summary" role="status">
                  {current.summary}
                </p>
                {current.passing.length > 0 ? (
                  <ItemList label="Goes ahead" items={current.passing} />
                ) : null}
                {current.skipped.length > 0 ? (
                  <ItemList label="Skipped" items={current.skipped} />
                ) : null}
                <FormAlert message={error ?? undefined} />
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 rounded-lg"
                    disabled={pending}
                    onClick={close}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="h-11 rounded-lg"
                    data-testid="bulk-confirm"
                    disabled={pending || current.passing.length === 0}
                    onClick={() =>
                      start(async () => {
                        setError(null);
                        const result = await confirm({
                          expectedDigest: current.digest,
                          actIds: current.act,
                        });
                        if (!result.ok) {
                          setError(result.message);
                          // The list changed since the preview: show a fresh one.
                          if (result.changed) {
                            const again = await preview();
                            setCurrent(again.ok ? plan(again.value) : null);
                            if (!again.ok) setError(again.message);
                          }
                          return;
                        }
                        close();
                        onDone(result.message ?? "Done.");
                      })
                    }
                  >
                    {pending ? pendingLabel : confirmLabel(current.passing.length)}
                  </Button>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ItemList({ label, items }: { label: string; items: readonly BulkItem[] }) {
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="m-0 type-label text-fg-muted">
        {label} ({items.length.toLocaleString("en-NG")})
      </h3>
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0"
          >
            <span className="text-sm font-semibold">{item.title}</span>
            {item.detail ? <span className="text-[13px] text-fg-muted">{item.detail}</span> : null}
            {item.reason ? <span className="text-[13px] font-medium">{item.reason}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
