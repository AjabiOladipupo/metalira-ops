import { Mail } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { workerMessages } from "@/lib/messages/worker";
import { createServerSupabase } from "@/lib/supabase/server";
import { lookupWorkerPageSession } from "@/server/identity/worker-session";
import { countMyUnread } from "@/server/workforce/inbox";

const copy = workerMessages.inbox;

function InboxIcon({ unread }: { unread: number }) {
  return (
    <Link
      href="/m/inbox"
      aria-label={unread > 0 ? copy.openUnread(unread) : copy.open}
      data-testid="inbox-link"
      data-unread={unread}
      className="relative flex size-11 shrink-0 items-center justify-center rounded-full text-foreground no-underline hover:bg-surface hover:text-foreground"
    >
      <Mail strokeWidth={1.75} className="size-[22px]" aria-hidden />
      {unread > 0 ? (
        <span
          aria-hidden
          data-testid="inbox-unread-dot"
          className="absolute top-2 right-2 size-2.5 rounded-full border-2 border-background bg-signal"
        />
      ) : null}
    </Link>
  );
}

async function InboxWithCount() {
  const lookup = await lookupWorkerPageSession();
  if (lookup.type !== "worker") return <InboxIcon unread={0} />;
  let unread = 0;
  try {
    unread = await countMyUnread(await createServerSupabase(), lookup.session.workerId);
  } catch {
    // The dot is a hint: a failed count never breaks the page.
  }
  return <InboxIcon unread={unread} />;
}

/**
 * The inbox button on the worker app header (slice 3.1), with a dot while anything is unread.
 * The count is read with the worker's own session, inside its own Suspense boundary.
 */
export function InboxLink() {
  return (
    <Suspense fallback={<InboxIcon unread={0} />}>
      <InboxWithCount />
    </Suspense>
  );
}
