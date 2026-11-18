import type { Metadata, Viewport } from "next";

import { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@/components/theme/theme";

/**
 * The worker app's web app manifest and home-screen icons (slice 1.10), so a worker can add it
 * to their phone's home screen. The manifest is a static file in public/ (the proxy never runs
 * on it, so the browser can fetch it before sign-in); its scope is /m, the worker app only.
 * The service worker and offline punch queue come in Phase 3.
 */
export const metadata: Metadata = {
  manifest: "/worker.webmanifest",
  applicationName: "Metalira Ops",
  appleWebApp: { capable: true, title: "Metalira Ops", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/worker-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/worker-apple-180.png", sizes: "180x180" }],
  },
};

/**
 * `viewportFit: "cover"` lets the bottom nav's env(safe-area-inset-bottom) padding take effect:
 * without it iOS reports a 0 inset and the home indicator sits over the nav labels.
 */
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR_DARK },
  ],
};

/** Worker app frame, from the Wk* boards: a single phone-width column, no sidebar. */
export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh justify-center bg-background text-foreground">
      <div className="flex w-full max-w-[430px] min-w-0 flex-col">{children}</div>
    </div>
  );
}
