import { Suspense } from "react";

import { workerMessages } from "@/lib/messages/worker";
import { requireWorkerPageSession } from "@/server/identity/worker-session";

import { WorkerTopBar } from "./worker-top-bar";

type SoonKey = keyof typeof workerMessages.soon;

/** Checks the worker session (signed out goes to sign-in). Renders nothing. */
async function Gate() {
  await requireWorkerPageSession();
  return null;
}

/**
 * The screen's sentence. Clock and My shifts say the company doesn't use them when it has Shifts
 * switched off (slice 3.0); the nav and Home already hide their links.
 */
async function Body({ which }: { which: SoonKey }) {
  const copy = workerMessages.soon[which];
  if (which === "clock" || which === "shifts") {
    const worker = await requireWorkerPageSession();
    if (!worker.shiftsEnabled) return <>{workerMessages.shiftsOff}</>;
  }
  return <>{copy.body}</>;
}

/**
 * A worker screen whose feature arrives in a later phase (Clock and My shifts with rosters,
 * Leave, Payslips) or that is plain text (Help): a heading and one sentence.
 */
export function SoonPage({ which }: { which: SoonKey }) {
  const copy = workerMessages.soon[which];
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <Gate />
      </Suspense>
      {/* Same top row as Me and Request a change (Wk* boards: 12px above the back arrow). */}
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }} inbox>
          <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
        </WorkerTopBar>
      </div>
      <div className="px-4 pt-2 pb-4">
        <p className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]">
          <Suspense fallback={copy.body}>
            <Body which={which} />
          </Suspense>
        </p>
      </div>
    </main>
  );
}
