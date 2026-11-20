import type { Metadata } from "next";
import Link from "next/link";

import { Illustration } from "@/components/illustration";
import { Button } from "@/components/ui/button";
import { workerMessages } from "@/lib/messages/worker";

import { WorkerTopBar } from "../_components/worker-top-bar";
import { WorkerBrand } from "../_components/worker-brand";
import { RetryButton } from "./retry-button";
import { SavedCount } from "./saved-count";

export const metadata: Metadata = { title: "No network" };

const copy = workerMessages.offline;

/**
 * The worker app's offline screen (slice 3.4). The service worker precaches it and shows it
 * when a worker page cannot load. Fully static and session-free (the proxy lets it through
 * signed out), so the cached copy never holds anyone's data; the saved count is read on the
 * phone.
 */
export default function OfflinePage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar>
          <WorkerBrand />
        </WorkerTopBar>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 pb-8 text-center">
        <Illustration name="offline" size="empty" decorative />
        <h1 className="m-0 font-display text-[25px] leading-tight font-bold">{copy.pageTitle}</h1>
        <p className="m-0 max-w-[32ch] text-[15px] text-fg-muted">{copy.pageBody}</p>
        <SavedCount />
        <div className="flex w-full max-w-xs flex-col gap-2 pt-2">
          <RetryButton />
          <Button asChild variant="outline" className="h-11 rounded-lg">
            <Link href="/m" prefetch={false}>
              {copy.home}
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
