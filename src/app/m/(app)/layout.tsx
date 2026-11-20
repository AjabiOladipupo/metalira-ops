import { Suspense } from "react";

import { lookupWorkerPageSession } from "@/server/identity/worker-session";

import { BottomNav } from "../_components/bottom-nav";

/** The bottom nav without Clock when the worker's company has Shifts off (slice 3.0). */
async function WorkerBottomNav() {
  const lookup = await lookupWorkerPageSession();
  return <BottomNav shiftsEnabled={lookup.type !== "worker" || lookup.session.shiftsEnabled} />;
}

/**
 * Signed-in worker screens (slice 1.10): the page above, the bottom nav below. Sign-in and
 * invite links sit outside this group, so they have no nav. Each page checks the worker
 * session itself, inside its own Suspense boundary.
 */
export default function WorkerAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="flex flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
      <Suspense fallback={<BottomNav />}>
        <WorkerBottomNav />
      </Suspense>
    </>
  );
}
