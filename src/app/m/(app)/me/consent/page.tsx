import type { Metadata } from "next";
import { Suspense } from "react";

import { formatDate, lagosToday } from "@/lib/dates";
import { workerMessages } from "@/lib/messages/worker";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { loadMyConsents } from "@/server/workforce/consents";

import { ConsentScreen } from "../../../_components/consent-screen";
import { WorkerTopBar } from "../../../_components/worker-top-bar";

export const metadata: Metadata = { title: "Location and selfie" };

const copy = workerMessages.consent;

/** The Lagos calendar day of a moment, as "14 Nov 2026". */
const day = (at: string | null) => (at ? formatDate(lagosToday(new Date(at))) : null);

async function Consents() {
  const session = await requireWorkerPageSession();
  const consents = await loadMyConsents({
    supabase: await createServerSupabase(),
    workerId: session.workerId,
  });
  return (
    <ConsentScreen
      consents={consents.map((c) => ({
        kind: c.kind,
        agreedOn: day(c.acceptedAt),
        withdrawnOn: day(c.withdrawnAt),
      }))}
    />
  );
}

/**
 * Me -> Location and selfie (slice 3.1): what the app collects at clock-in and the worker's
 * choice for each, which they can change at any time. Slice 3.5 shows the same screen before
 * the first clock-in.
 */
export default function ConsentPage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m/me", label: workerMessages.back.me }} inbox>
          <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
        </WorkerTopBar>
      </div>
      <div className="px-4 pt-2 pb-4">
        <Suspense fallback={<span aria-hidden className="block h-96 w-full rounded bg-surface" />}>
          <Consents />
        </Suspense>
      </div>
    </main>
  );
}
