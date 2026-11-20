"use client";

import { X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { workerMessages } from "@/lib/messages/worker";
import {
  getInstallPrompt,
  isIosSafari,
  isStandalone,
  promptInstall,
  rememberInstallDismissed,
  subscribeInstallPrompt,
  wasInstallDismissed,
} from "@/lib/offline/install";

const copy = workerMessages.offline;

type Mode = "hidden" | "android" | "ios";

/**
 * "Add to home screen" on worker home. Android Chrome: a button that opens Chrome's own install
 * dialog (beforeinstallprompt). iOS Safari: one line on the Share menu, as it has no such event.
 * Hidden once installed, in other browsers, and for good after "Not now".
 */
export function InstallCard() {
  const prompt = useSyncExternalStore(subscribeInstallPrompt, getInstallPrompt, () => null);
  const [ios, setIos] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // Browser-only facts, read after hydration so the server and first client render match.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of browser state
    setDismissed(wasInstallDismissed() || isStandalone());
    setIos(isIosSafari(navigator.userAgent, navigator.maxTouchPoints));
  }, []);

  const mode: Mode = dismissed ? "hidden" : prompt ? "android" : ios ? "ios" : "hidden";
  if (mode === "hidden") return null;

  const dismiss = () => {
    rememberInstallDismissed();
    setDismissed(true);
  };

  return (
    <section
      aria-labelledby="install-title"
      data-testid="install-card"
      className="flex flex-col gap-2 rounded-xl border border-line px-4 py-3.5"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="install-title" className="m-0 text-[17px] font-semibold">
          {copy.installTitle}
        </h2>
        <button
          type="button"
          onClick={dismiss}
          aria-label={copy.installDismiss}
          className="-mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:text-foreground"
        >
          <X className="size-5" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <p className="m-0 text-[15px] text-fg-muted">
        {mode === "ios" ? copy.installIos : copy.installBody}
      </p>
      {mode === "android" ? (
        <Button
          type="button"
          className="h-11 rounded-lg"
          onClick={() => {
            void promptInstall().then((outcome) => {
              if (outcome === "accepted") setDismissed(true);
            });
          }}
        >
          {copy.installButton}
        </Button>
      ) : null}
    </section>
  );
}
