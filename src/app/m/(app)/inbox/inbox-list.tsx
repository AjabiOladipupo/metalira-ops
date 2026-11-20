"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { workerMessages } from "@/lib/messages/worker";
import { markInboxReadAction } from "@/server/workforce/inbox-actions";

const copy = workerMessages.inbox;

export interface InboxRow {
  id: string;
  title: string;
  body: string;
  linkPath: string | null;
  /** "14 Nov 2026, 09:30", already formatted. */
  sentAt: string;
  unread: boolean;
}

function MarkButton({ label, className }: { label: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="outline"
      disabled={pending}
      aria-disabled={pending}
      className={className ?? "h-11 rounded-lg px-4"}
    >
      {pending ? copy.marking : label}
    </Button>
  );
}

function MarkRead({ id, label }: { id: string; label: string }) {
  const [state, action] = useActionState(markInboxReadAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <MarkButton label={label} />
      {state && !state.ok ? (
        <p role="alert" className="m-0 text-sm">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/** The worker's messages, newest first, each marked read with its own button (slice 3.1). */
export function InboxList({ items }: { items: readonly InboxRow[] }) {
  const unread = items.filter((item) => item.unread).length;
  return (
    <div className="flex flex-col gap-3">
      {unread > 1 ? <MarkRead id="all" label={copy.markAllRead} /> : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid="inbox-item"
            data-unread={item.unread ? "yes" : "no"}
            className="flex flex-col gap-1.5 rounded-xl border border-line px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="text-[15px] font-semibold break-words">{item.title}</span>
              {item.unread ? <Status tone="action">{copy.unread}</Status> : null}
            </div>
            <p className="m-0 text-[15px] break-words whitespace-pre-line">{item.body}</p>
            <span className="text-xs text-fg-muted">{item.sentAt}</span>
            {item.linkPath || item.unread ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {item.linkPath ? (
                  <Button asChild variant="default" className="h-11 rounded-lg px-4">
                    <Link href={item.linkPath}>{copy.openLink}</Link>
                  </Button>
                ) : null}
                {item.unread ? <MarkRead id={item.id} label={copy.markRead} /> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
