import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";

/** Crawlers may read the marketing pages; the manager app and the worker app stay out. */
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // "$" ends the match, so /app does not also block /apple-icon.png (or /m every /m… path).
      disallow: ["/app$", "/app/", "/m$", "/m/", "/api/", "/auth/"],
    },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
