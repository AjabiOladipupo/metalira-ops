/**
 * "Add to home screen" for the worker app. Android Chrome fires `beforeinstallprompt`, which the
 * app keeps and replays from its own button. iOS Safari has no such event, so the card explains
 * Share, then Add to Home Screen. Browser-only except the pure helpers.
 */

const DISMISSED_KEY = "metalira.installDismissed";

/** The event Chrome fires when the app can be installed (not in TypeScript's DOM types). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** True on iPhone and iPad Safari, where installing is a manual Share-menu step. */
export function isIosSafari(userAgent: string, maxTouchPoints = 0): boolean {
  const ios =
    /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  // Other iOS browsers (Chrome, Firefox, Edge) can add to home screen from iOS 16.4 too, but
  // their menus differ; the Safari wording is the one we can explain.
  return ios && !/CriOS|FxiOS|EdgiOS/.test(userAgent);
}

export function wasInstallDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberInstallDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage blocked: the card comes back next visit, which is harmless.
  }
}

/** True when the app is already running from the home screen. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true
  );
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let listening = false;

/** Starts keeping Chrome's install event. Call once, as early as possible on /m pages. */
export function captureInstallPrompt(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    for (const listener of listeners) listener();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    for (const listener of listeners) listener();
  });
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferred;
}

/** Shows Chrome's install dialog. The event can be used once. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = null;
  for (const listener of listeners) listener();
  await event.prompt();
  return (await event.userChoice).outcome;
}
