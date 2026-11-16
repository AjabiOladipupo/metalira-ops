import type { Metadata } from "next";
import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { workerMessages } from "@/lib/messages/worker";
import { signOutWorker } from "@/server/identity/worker-actions";
import { requireWorkerSession } from "@/server/identity/worker-session";

import { WorkerBrand } from "./_components/worker-brand";

export const metadata: Metadata = { title: "Home" };

const copy = workerMessages.home;

async function Greeting() {
  const worker = await requireWorkerSession();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="type-label text-fg-muted">{worker.organisationName}</span>
      <h1 className="m-0 font-display text-[25px] leading-tight font-bold">
        {copy.hello(worker.firstName)}
      </h1>
      <p className="m-0 text-[15px] text-fg-muted">Staff ID {worker.staffId}</p>
    </div>
  );
}

/**
 * Worker home. Slice 1.10 builds the full screen from the WkHome board (shift card, tiles,
 * bottom nav); until then it greets the signed-in worker and offers sign-out.
 */
export default function WorkerHomePage() {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 pt-4 pb-8">
      <div className="flex h-10 items-center justify-between gap-2">
        <WorkerBrand />
        <form action={signOutWorker}>
          <Button type="submit" variant="outline" className="h-10">
            {copy.signOut}
          </Button>
        </form>
      </div>
      <Suspense
        fallback={
          <div aria-hidden className="flex flex-col gap-2">
            <span className="h-3 w-24 rounded bg-surface" />
            <span className="h-8 w-48 rounded bg-surface" />
          </div>
        }
      >
        <Greeting />
      </Suspense>
      <p className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]">{copy.soon}</p>
      <p className="m-0 mt-auto text-center text-sm text-fg-muted">{copy.location}</p>
    </main>
  );
}
