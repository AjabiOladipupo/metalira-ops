"use client";

import { Button } from "@/components/ui/button";
import { workerMessages } from "@/lib/messages/worker";

/** Reloads the screen the worker was trying to open (the URL is unchanged). */
export function RetryButton() {
  return (
    <Button type="button" className="h-11 rounded-lg" onClick={() => window.location.reload()}>
      {workerMessages.offline.retry}
    </Button>
  );
}
