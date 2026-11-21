import { Suspense } from "react";

import { lookupCrewPageSession } from "@/server/workforce/crew-session";

import { QueueOwnerSync } from "../_components/offline/queue-owner";

/**
 * Opens the supervisor's offline queue (slice 3.4) for crew clock-in (slice 3.6), with the ids
 * from the verified session: a worker-supervisor's queue is their own worker queue; a line
 * manager's is keyed by their membership. Renders nothing for anyone else.
 */
async function CrewQueueOwner() {
  const lookup = await lookupCrewPageSession();
  if (lookup.type !== "crew") return null;
  return (
    <QueueOwnerSync
      organisationId={lookup.session.organisationId}
      workerId={lookup.session.actorId}
      userId={lookup.session.userId}
    />
  );
}

/**
 * Crew clock-in sits outside the worker tabs: a line manager opens it too, and has no worker
 * home to go back to. The page checks the session itself.
 */
export default function CrewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <CrewQueueOwner />
      </Suspense>
      <div className="flex flex-1 flex-col">{children}</div>
    </>
  );
}
