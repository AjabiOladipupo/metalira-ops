import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { workerMessages } from "@/lib/messages/worker";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireWorkerPageSession } from "@/server/identity/worker-session";
import { hasOpenBankChange, loadMyBankChanges } from "@/server/people/my-profile";

import { ChangeForms } from "./change-forms";

export const metadata: Metadata = { title: "Request a change" };

const copy = workerMessages.change;

async function Forms() {
  const session = await requireWorkerPageSession();
  const changes = await loadMyBankChanges(await createServerSupabase(), session);
  return <ChangeForms bankOpen={hasOpenBankChange(changes)} />;
}

/**
 * "Request a change" from the Me screen (slice 1.10). Bank details go through the two-person
 * bank-detail change (slice 1.7) with the board's copy; anything else becomes a request HR sees
 * on the worker page.
 */
export default function ChangePage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 pt-3 pb-1">
        <Link
          href="/m/me"
          aria-label={workerMessages.me.back}
          className="flex size-11 items-center justify-center text-foreground"
        >
          <ChevronLeft strokeWidth={1.75} className="size-[22px]" aria-hidden />
        </Link>
        <h1 className="m-0 font-display text-xl font-bold">{copy.title}</h1>
      </div>
      <div className="flex flex-col gap-5 px-4 pt-2 pb-4">
        <p className="m-0 text-[15px] text-fg-muted">{copy.intro}</p>
        <Suspense fallback={<span aria-hidden className="h-64 w-full rounded bg-surface" />}>
          <Forms />
        </Suspense>
      </div>
    </main>
  );
}
