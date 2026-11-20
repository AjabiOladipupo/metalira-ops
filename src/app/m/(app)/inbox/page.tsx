import type { Metadata } from "next";
import { Suspense } from "react";

import { Illustration } from "@/components/illustration";
import { formatDateTime } from "@/lib/dates";
import { isWorkerAppPath } from "@/lib/inbox";
import { workerMessages } from "@/lib/messages/worker";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { loadMyInbox } from "@/server/workforce/inbox";

import { WorkerTopBar } from "../../_components/worker-top-bar";
import { InboxList } from "./inbox-list";

export const metadata: Metadata = { title: "Inbox" };

const copy = workerMessages.inbox;

async function Items() {
  const session = await requireWorkerPageSession();
  const items = await loadMyInbox(await createServerSupabase(), session.workerId);
  if (items.length === 0) {
    return (
      <section
        data-testid="inbox-empty"
        className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3"
      >
        <p className="m-0 min-w-0 flex-1 text-[15px] text-fg-muted">{copy.empty}</p>
        <Illustration name="inbox-empty" size="worker" decorative />
      </section>
    );
  }
  return (
    <InboxList
      items={items.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        // Checked again here: only a worker-app path becomes a link.
        linkPath: item.linkPath && isWorkerAppPath(item.linkPath) ? item.linkPath : null,
        sentAt: formatDateTime(item.createdAt),
        unread: item.readAt === null,
      }))}
    />
  );
}

/** The worker's inbox (slice 3.1): messages from their company, newest first. */
export default function InboxPage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }}>
          <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
        </WorkerTopBar>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Suspense fallback={<span aria-hidden className="block h-64 w-full rounded bg-surface" />}>
          <Items />
        </Suspense>
      </div>
    </main>
  );
}
