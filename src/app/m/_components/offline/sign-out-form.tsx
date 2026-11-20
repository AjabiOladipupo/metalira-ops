"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { workerMessages } from "@/lib/messages/worker";
import { clearQueue, getActiveQueue } from "@/lib/offline/active-queue";
import { countUnsent } from "@/lib/offline/queue";
import { cn } from "@/lib/utils";

const copy = workerMessages.offline;

/**
 * The worker's sign-out button. Signing out deletes the worker's offline queue from the phone
 * (the next person on a shared phone must not send it), so when punches are still unsent it
 * warns first and only deletes them if the worker insists. With no network it refuses: the
 * sign-out request itself needs the network, and the queue must not be lost for nothing.
 */
export function WorkerSignOutForm({
  action,
  label,
  variant = "ghost",
  className,
  buttonClassName,
}: {
  action: () => Promise<void>;
  label: string;
  variant?: "ghost" | "outline";
  className?: string;
  buttonClassName?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const confirmed = useRef(false);
  const [unsent, setUnsent] = useState(0);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);

  async function clearAndSubmit() {
    setBusy(true);
    const queue = getActiveQueue();
    try {
      if (queue) await clearQueue(queue.owner);
    } catch {
      // The queue could not be deleted; sign out anyway (the next sign-in opens its own queue).
    }
    confirmed.current = true;
    formRef.current?.requestSubmit();
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (confirmed.current) return;
    event.preventDefault();
    if (navigator.onLine === false) {
      setOffline(true);
      return;
    }
    setOffline(false);
    const queue = getActiveQueue();
    const count = queue ? await countUnsent(queue.db).catch(() => 0) : 0;
    if (count > 0) {
      setUnsent(count);
      return;
    }
    await clearAndSubmit();
  }

  return (
    <form
      ref={formRef}
      action={action}
      onSubmit={onSubmit}
      className={cn("flex flex-col gap-3", className)}
    >
      {unsent > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border-[1.5px] border-foreground p-4"
        >
          <p className="m-0 font-display text-[17px] font-bold">{copy.signOutTitle(unsent)}</p>
          <p className="m-0 text-[15px]">{copy.signOutBody}</p>
          <Button
            type="button"
            className="h-11 rounded-lg"
            onClick={() => setUnsent(0)}
            disabled={busy}
          >
            {copy.signOutStay}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-lg"
            onClick={() => void clearAndSubmit()}
            disabled={busy}
          >
            {copy.signOutAnyway}
          </Button>
        </div>
      ) : (
        <Button type="submit" variant={variant} className={buttonClassName} disabled={busy}>
          {label}
        </Button>
      )}
      {offline ? (
        <p role="alert" className="m-0 text-[13px] text-fg-muted">
          {copy.signOutOffline}
        </p>
      ) : null}
    </form>
  );
}
