import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

import { ThemeScript } from "@/components/theme/theme-script";
import { siteUrl } from "@/lib/site";
import { cn } from "@/lib/utils";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  // Absolute URLs for the social card (app/opengraph-image.tsx) and canonical links.
  metadataBase: new URL(siteUrl()),
  title: { default: "Metalira Ops", template: "%s · Metalira Ops" },
  description: "Workforce and business operations for service companies.",
  openGraph: { siteName: "Metalira Ops", type: "website", locale: "en_NG" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("h-full antialiased", inter.variable, spaceGrotesk.variable)}
    >
      <head>
        <ThemeScript />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
