import type { Metadata } from "next";

import { workerMessages } from "@/lib/messages/worker";

import { CheckpointScan } from "../_components/checkpoint/checkpoint-scan";
import { WorkerTopBar } from "../_components/worker-top-bar";

export const metadata: Metadata = {
  title: "Checkpoint scan",
  // The page itself holds nothing, but keep it out of search results and link previews.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The page a patrol checkpoint's QR code opens: /m/checkpoint#<token> (slice 3.8).
 *
 * Static and session-free, like the offline page: the token is in the URL fragment, which the
 * browser never sends, so the server (and its logs) never sees it; the scan runs on the phone
 * (<CheckpointScan>), which asks the server who is signed in. The service worker precaches this
 * page and serves it for /m/checkpoint when there is no network, so a patrol works offline.
 */
export default function CheckpointPage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={{ href: "/m", label: workerMessages.back.home }}>
          <span className="font-display text-xl font-bold">{workerMessages.checkpoint.title}</span>
        </WorkerTopBar>
      </div>
      <CheckpointScan />
    </main>
  );
}
