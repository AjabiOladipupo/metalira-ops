import { Suspense } from "react";

import { workerMessages } from "@/lib/messages/worker";
import { requireWorkerPageSession } from "@/server/identity/worker-session";

import { WorkerBrand } from "./worker-brand";

type SoonKey = keyof typeof workerMessages.soon;

/** Checks the worker session (signed out goes to sign-in). Renders nothing. */
async function Gate() {
  await requireWorkerPageSession();
  return null;
}

/**
 * A worker screen whose feature arrives in a later phase (Clock and My shifts with rosters,
 * Leave, Payslips) or that is plain text (Help): a heading and one sentence.
 */
export function SoonPage({ which }: { which: SoonKey }) {
  const copy = workerMessages.soon[which];
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 pt-4 pb-4">
      <Suspense fallback={null}>
        <Gate />
      </Suspense>
      <div className="flex h-10 items-center">
        <WorkerBrand />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[25px] leading-tight font-bold">{copy.title}</h1>
        <p className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]">{copy.body}</p>
      </div>
    </main>
  );
}
