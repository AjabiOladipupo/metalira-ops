/**
 * Office sites (slice 6.11): the company's own Head office and branches, where staff who don't
 * work at a client's site (HR, finance, the operations manager, admin) are mapped.
 *
 * The database holds every rule (migration 20261127090000_head_office): an office has no client
 * and a client's site always has one; a site never changes kind; an office is never on a contract,
 * in headcount, on a post, a roster or a Work Unit; a mapping to an office takes no client or
 * projects. These pure helpers give the screens the same answers first, and the words.
 *
 * Phase 6 hook (6.1 unbilled queue, 6.2 invoices): nothing billable is ever made at an office (no
 * posts, so no Work Units), and both must still read sites through their client, so an office
 * never reaches an invoice. Phase 7's overhead allocation reads `sites.kind` from a person's
 * mapping: someone whose site of record is an office is overhead, not a client's labour cost.
 */

export const SITE_KINDS = ["client", "office"] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

/** The office every company has, made with the company. */
export const HEAD_OFFICE_NAME = "Head office";

/** How a mapped office reads wherever a person's site is shown. */
export const OVERHEAD_LABEL = "overhead";

export function isSiteKind(value: unknown): value is SiteKind {
  return typeof value === "string" && (SITE_KINDS as readonly string[]).includes(value);
}

/** True for an office. Anything the database didn't call an office is a client's site. */
export function isOffice(kind: string | null | undefined): boolean {
  return kind === "office";
}

/**
 * Why a site's kind and client don't fit, or null when they do (sites_kind_client): an office
 * has no client, and a client's site has one.
 */
export function siteKindProblem(site: { kind: SiteKind; clientId: string | null }): string | null {
  if (site.kind === "office" && site.clientId !== null) {
    return "An office belongs to your company, not to a client.";
  }
  if (site.kind === "client" && site.clientId === null) {
    return "Choose the client this site belongs to.";
  }
  return null;
}

/**
 * A site as pickers and the People pages show it: "Head office · overhead" for an office,
 * "Apapa Warehouse 3 · Coastline" for a client's site, or the name alone.
 */
export function siteLabel(site: {
  name: string;
  kind: string | null | undefined;
  clientName?: string | null;
}): string {
  if (isOffice(site.kind)) return `${site.name} · ${OVERHEAD_LABEL}`;
  return site.clientName ? `${site.name} · ${site.clientName}` : site.name;
}

/** Projects belong to a client, so an office takes none. */
export function siteTakesProjects(kind: string | null | undefined): boolean {
  return !isOffice(kind);
}

export const OFFICE_NO_PROJECTS =
  "An office has no projects. Choose the office alone, or a client's site for project work.";

/** Why a mapping to this site with these projects is refused, or null (MLHO5). */
export function officeMappingProblem(
  kind: string | null | undefined,
  projectCount: number,
): string | null {
  return isOffice(kind) && projectCount > 0 ? OFFICE_NO_PROJECTS : null;
}

/** Offices first (Head office before branches), then everything else by label. */
export function compareSiteOptions(
  a: { label: string; office: boolean; name?: string },
  b: { label: string; office: boolean; name?: string },
): number {
  if (a.office !== b.office) return a.office ? -1 : 1;
  if (a.office && b.office) {
    const aHead = a.name === HEAD_OFFICE_NAME;
    const bHead = b.name === HEAD_OFFICE_NAME;
    if (aHead !== bHead) return aHead ? -1 : 1;
  }
  return a.label.localeCompare(b.label, "en", { sensitivity: "base" });
}
