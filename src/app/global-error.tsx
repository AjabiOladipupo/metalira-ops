"use client";

import { useEffect } from "react";
import { Inter, Space_Grotesk } from "next/font/google";
import * as Sentry from "@sentry/nextjs";

import { Logo } from "@/components/logo";
import { applyThemeChoice, readThemeChoice } from "@/components/theme/theme";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import "./globals.css";

// Same fonts as the root layout, which this page replaces.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
});

// Replaces the root layout when it fails, so it brings its own <html>, styles, fonts and theme.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    applyThemeChoice(readThemeChoice());
  }, []);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("h-full antialiased", inter.variable, spaceGrotesk.variable)}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <title>Something went wrong · Metalira Ops</title>
        <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
          <Logo size={32} />
          <div className="flex max-w-md flex-col gap-2">
            <h1 className="m-0 type-h2">Something went wrong</h1>
            <p className="m-0 type-body-lg text-fg-muted">
              We have logged the error. Try again, or come back in a few minutes.
            </p>
          </div>
          <Button onClick={() => retry()}>Try again</Button>
        </main>
      </body>
    </html>
  );
}
