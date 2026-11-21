"use client";

import { useEffect } from "react";

import { activateQueue, deactivateQueue } from "@/lib/offline/active-queue";
import { setQueueSender } from "@/lib/offline/senders";
import { requestPersistentStorage } from "@/lib/offline/storage";
import type { QueueOwner } from "@/lib/offline/types";
import { createCrewSender } from "@/lib/punches/crew-sender";
import { createPunchSender } from "@/lib/punches/sender";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { recordCheckpointScanAction } from "@/server/workforce/checkpoint-scan-actions";
import { recordCrewPunchAction, uploadCrewPhotoAction } from "@/server/workforce/crew-actions";
import { recordPunchAction, uploadPunchSelfieAction } from "@/server/workforce/punch-actions";

/**
 * Punches (slice 3.5), patrol scans (slice 3.8) and crew punches (slice 3.6) reach the server
 * through these Server Actions: the crew sender takes `crew_in` / `crew_out` and hands every
 * other kind on to the punch sender.
 */
const punchSender = createCrewSender(
  { recordCrewPunch: recordCrewPunchAction, uploadCrewPhoto: uploadCrewPhotoAction },
  createPunchSender({
    recordPunch: recordPunchAction,
    uploadSelfie: uploadPunchSelfieAction,
    recordCheckpointScan: recordCheckpointScanAction,
  }),
);

/**
 * Test hooks only in the Playwright build (playwright.config.ts), and never in a Vercel build
 * even if the flag leaked (next.config.ts also refuses it there). Both values are inlined at
 * build time, so in production the import below is dead code and its module is not bundled.
 */
const TEST_HOOKS =
  process.env.NEXT_PUBLIC_OFFLINE_TEST_SENDER === "1" && !process.env.NEXT_PUBLIC_VERCEL_ENV;

/**
 * True while the browser's Supabase session is still `userId` (read from the session cookie,
 * no network unless the token needs a refresh). Another worker signing in on this phone, or a
 * sign-out in another tab, stops this tab's queue from sending (security review M2).
 */
function sessionIs(userId: string): () => Promise<boolean> {
  return async () => {
    try {
      const { data } = await createBrowserSupabase().auth.getSession();
      return data.session?.user.id === userId;
    } catch {
      return false;
    }
  };
}

/**
 * Opens the signed-in worker's offline queue and starts its sync engine. Rendered by the
 * signed-in worker layout with ids from the verified session, so the queue always belongs to
 * the worker and organisation the server says are signed in. Renders nothing.
 */
export function QueueOwnerSync({
  organisationId,
  workerId,
  userId,
}: QueueOwner & { userId: string }) {
  useEffect(() => {
    let cancelled = false;
    let activated = false;

    const start = (installTestHooks?: () => void) => {
      if (cancelled) return;
      setQueueSender(punchSender);
      // Test builds: wrap the sender before the engine's first drain. Installed after it, the
      // "start" drain (already holding the plain punch sender while it checks the session)
      // could pick up the test ping and the punch sender would refuse it as `invalid`, so it
      // never counted as saved on the phone (the flaky tests/e2e/offline.spec.ts).
      installTestHooks?.();
      try {
        activateQueue({ organisationId, workerId }, { isOwnerSignedIn: sessionIs(userId) });
      } catch {
        // IndexedDB unavailable (some private modes): the app works online without the queue.
        return;
      }
      activated = true;
      void requestPersistentStorage();
    };

    if (TEST_HOOKS) {
      void import("@/lib/offline/test-hooks").then(({ installTestHooks }) =>
        start(installTestHooks),
      );
    } else {
      start();
    }
    return () => {
      cancelled = true;
      if (activated) deactivateQueue();
    };
  }, [organisationId, workerId, userId]);
  return null;
}
