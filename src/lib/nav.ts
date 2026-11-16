import { MANAGER_ROLES, type Role } from "@/lib/roles";

/**
 * The manager app's navigation, in sidebar order. Pages, the sidebar and tests all read from here.
 * `icon` is a key into the icon map in src/components/shell/nav-icons.tsx.
 *
 * `roles` is the owner's role-to-nav decision (docs/PHASE_0.md "Roles and access"). It drives
 * both the sidebar and direct-URL access: a page whose item does not list the viewer's role
 * sends them to /no-access.
 */
export type NavIcon =
  | "home"
  | "roster"
  | "attendance"
  | "timesheets"
  | "people"
  | "team"
  | "leave"
  | "payroll"
  | "projects"
  | "unbilled"
  | "collections"
  | "revenue"
  | "settings";

export type NavItem = {
  label: string;
  href: string;
  icon: NavIcon;
  /** Roles that see this item and may open its page. Owner and admin see everything. */
  roles: readonly Role[];
  /** One line of context under the page title. */
  description: string;
  /** Empty-state sentence until the feature is built. */
  empty: string;
};

export type NavGroup = {
  /** Null for the ungrouped Home item at the top. */
  label: string | null;
  items: NavItem[];
};

const MANAGERS = MANAGER_ROLES;

export const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      {
        label: "Home",
        href: "/app",
        roles: MANAGERS,
        icon: "home",
        description: "Shifts, approvals and money that need you today.",
        empty: "Nothing needs you yet. Add a site and your people to get started.",
      },
    ],
  },
  {
    label: "Workforce",
    items: [
      {
        label: "Roster",
        href: "/app/roster",
        roles: ["owner", "admin", "ops_manager"],
        icon: "roster",
        description: "Who works where, and when.",
        empty: "No shifts yet. Publish a roster to start tracking attendance.",
      },
      {
        label: "Live attendance",
        href: "/app/attendance",
        roles: ["owner", "admin", "ops_manager", "line_manager"],
        icon: "attendance",
        description: "Clock-ins as they happen, by site.",
        empty: "No one is on shift right now.",
      },
      {
        label: "Timesheets",
        href: "/app/timesheets",
        roles: MANAGERS,
        icon: "timesheets",
        description: "Hours worked, overtime and exceptions to approve.",
        empty: "No timesheets to approve.",
      },
      {
        label: "People",
        href: "/app/people",
        roles: ["owner", "admin", "hr", "ops_manager"],
        icon: "people",
        description: "Every worker, their pay rate and where they are mapped.",
        empty: "No people yet. Import a staff list to add your team.",
      },
      {
        label: "My team",
        href: "/app/team",
        roles: ["owner", "admin", "hr", "ops_manager", "line_manager"],
        icon: "team",
        description: "The workers who report to you.",
        empty: "No one reports to you yet.",
      },
      {
        label: "Leave",
        href: "/app/leave",
        roles: ["owner", "admin", "hr", "ops_manager", "line_manager"],
        icon: "leave",
        description: "Requests, balances and who is away.",
        empty: "No leave requests waiting.",
      },
    ],
  },
  {
    label: "Payroll",
    items: [
      {
        label: "Payroll run",
        href: "/app/payroll",
        roles: ["owner", "admin", "hr", "finance"],
        icon: "payroll",
        description: "Pay cycle 20th to 19th, paid on the 25th.",
        empty: "No payroll runs yet. Approve timesheets to prepare the first run.",
      },
    ],
  },
  {
    label: "Business",
    items: [
      {
        label: "Projects",
        href: "/app/projects",
        roles: ["owner", "admin", "ops_manager"],
        icon: "projects",
        description: "Phases, deadlines and milestones by client.",
        empty: "No projects yet.",
      },
      {
        label: "Unbilled work",
        href: "/app/unbilled",
        roles: ["owner", "admin", "finance", "ops_manager"],
        icon: "unbilled",
        description: "Approved work that is not on an invoice yet.",
        empty: "No unbilled work.",
      },
      {
        label: "Collections",
        href: "/app/collections",
        roles: ["owner", "admin", "finance"],
        icon: "collections",
        description: "Invoices, payments received and what is overdue.",
        empty: "No invoices yet.",
      },
    ],
  },
  {
    label: "Revenue",
    items: [
      {
        label: "Revenue",
        href: "/app/revenue",
        roles: ["owner", "admin", "finance"],
        icon: "revenue",
        description: "Labour, contribution and true margin by site and client.",
        empty: "No revenue yet. Margins appear once invoices are posted.",
      },
    ],
  },
  {
    label: "Settings",
    items: [
      {
        label: "Settings",
        href: "/app/settings",
        roles: ["owner", "admin", "hr", "finance"],
        icon: "settings",
        description: "Company details, pay cycle, users and connections.",
        empty: "Users and connections arrive in a later phase.",
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((group) => group.items);

export function findNavItem(href: string): NavItem {
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (!item) throw new Error(`No nav item for ${href}`);
  return item;
}

/** The nav item whose route contains `pathname` (longest match wins). */
export function activeNavHref(pathname: string): string | undefined {
  return NAV_ITEMS.map((i) => i.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/** The sidebar for `role`: items the role may open, with empty groups dropped. */
export function navForRole(role: Role): NavGroup[] {
  return NAV.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => item.roles.includes(role)),
  })).filter((group) => group.items.length > 0);
}

/**
 * Pages that are not sidebar items but need their own roles: the setup wizard, settings
 * sections narrower than Settings itself, and the People pages that change data (the people
 * import included). A segment written `[name]` matches any one segment
 * (`/app/people/[id]/edit`). The most specific match (most segments) wins over NAV.
 */
export const EXTRA_PAGES: readonly { href: string; roles: readonly Role[] }[] = [
  { href: "/app/setup", roles: ["owner", "admin"] },
  { href: "/app/settings/company", roles: ["owner", "admin"] },
  { href: "/app/settings/departments", roles: ["owner", "admin", "hr"] },
  { href: "/app/people/new", roles: ["owner", "admin", "hr"] },
  { href: "/app/people/[id]/edit", roles: ["owner", "admin", "hr"] },
  // Slice 1.8: importing employees writes workers, pay and bank details.
  { href: "/app/people/import", roles: ["owner", "admin", "hr"] },
  // Worker invites and PIN resets (slice 1.9): the roles that may create invites.
  { href: "/app/people/invites", roles: ["owner", "admin", "hr"] },
];

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** True when `pathname` is `href` or below it, with `[name]` segments matching any segment. */
function pageMatches(href: string, pathname: string): boolean {
  const pattern = segments(href);
  const path = segments(pathname);
  if (path.length < pattern.length) return false;
  return pattern.every((part, i) =>
    /^\[[a-z]+\]$/.test(part) ? (path[i] ?? "") !== "" : part === path[i],
  );
}

function extraPage(pathname: string) {
  return EXTRA_PAGES.filter((p) => pageMatches(p.href, pathname)).sort(
    (a, b) => segments(b.href).length - segments(a.href).length,
  )[0];
}

/**
 * True when `role` may open `pathname` (a nav item's page or a page below it, or an extra page).
 * Paths that sit under no nav item are refused, and Home covers only /app itself, so a new page
 * must be added to NAV or EXTRA_PAGES (with its roles) before anyone can reach it.
 */
export function canAccessHref(role: Role, pathname: string): boolean {
  const extra = extraPage(pathname);
  if (extra) return extra.roles.includes(role);
  const href = activeNavHref(pathname);
  if (!href || (href === "/app" && pathname !== "/app")) return false;
  return findNavItem(href).roles.includes(role);
}
