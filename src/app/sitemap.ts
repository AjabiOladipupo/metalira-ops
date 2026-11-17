import type { MetadataRoute } from "next";

import { MARKETING_PATHS, siteUrl } from "@/lib/site";

/** The public pages: the landing page and the five role pages. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return MARKETING_PATHS.map((path) => ({
    url: path === "/" ? base : `${base}${path}`,
    changeFrequency: "monthly",
    priority: path === "/" ? 1 : 0.8,
  }));
}
