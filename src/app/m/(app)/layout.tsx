import { Suspense } from "react";

import { lookupWorkerPageSession } from "@/server/identity/worker-session";

import { BottomNav } from "../_components/bottom-nav";
import { QueueOwnerSync } from "../_components/offline/queue-owner";

/**
 * Opens the signed-in worker's offline queue (slice 3.4) with the ids from the verified
 * session. Renders nothing; signed out or unlinked logins get no queue (the pages redirect).
 */
async function QueueOwner() {
  const lookup = await lookupWorkerPageSession();
  if (lookup.type !== "worker") return null;
  return (
    <QueueOwnerSync
      organisationId={lookup.session.organisationId}
      workerId={lookup.session.workerId}
    />
  );
}

/**
 * Signed-in worker screens (slice 1.10): the page above, the bottom nav below. Sign-in and
 * invite links sit outside this group, so they have no nav. Each page checks the worker
 * session itself, inside its own Suspense boundary.
 */
export default function WorkerAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <QueueOwner />
      </Suspense>
      <div className="flex flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
      <BottomNav />
    </>
  );
}
