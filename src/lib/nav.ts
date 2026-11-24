import { ALL_MODULES_ON, type ModuleId, type Modules } from "@/lib/modules";
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
  | "clients"
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
  /**
   * The module switch this page belongs to (slice 3.0). When the company has it off, the item
   * leaves the sidebar and the page, and every page below it, shows "This part is switched off".
   */
  module?: ModuleId;
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
        module: "shifts",
        href: "/app/roster",
        roles: ["owner", "admin", "ops_manager"],
        icon: "roster",
        description: "Who works where, and when.",
        empty: "No shifts yet. Publish a roster to start tracking attendance.",
      },
      {
        label: "Live attendance",
        module: "shifts",
        href: "/app/attendance",
        // Slice 3.7: the Phase 3 access table's punch readers (hr included).
        roles: ["owner", "admin", "hr", "ops_manager", "line_manager"],
        icon: "attendance",
        description: "Clock-ins as they happen, by site.",
        empty: "No one is on shift right now.",
      },
      {
        label: "Timesheets",
        module: "people",
        href: "/app/timesheets",
        roles: MANAGERS,
        icon: "timesheets",
        description: "Hours worked, overtime and exceptions to approve.",
        empty: "No timesheets to approve.",
      },
      {
        label: "People",
        module: "people",
        href: "/app/people",
        // Slice 4.0b (owner, 21 Nov 2026): line managers get the list, showing only their
        // reportees (public.my_reportees). Adding, importing, editing and invites stay closed
        // to them in EXTRA_PAGES, and every write action checks its own roles.
        roles: ["owner", "admin", "hr", "ops_manager", "line_manager"],
        icon: "people",
        description: "Every worker, their pay rate and where they are mapped.",
        empty: "No people yet. Import a staff list to add your team.",
      },
      {
        label: "My team",
        module: "people",
        href: "/app/team",
        // Slice 4.7: only line managers have reportees (public.my_reportees); hr and ops_manager
        // would see an empty page. Owner and admin keep every item, as always.
        roles: ["owner", "admin", "line_manager"],
        icon: "team",
        description: "The workers who report to you.",
        empty: "No one reports to you yet.",
      },
      {
        label: "Leave",
        module: "people",
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
        module: "payroll",
        href: "/app/payroll",
        // Slice 5.2: owner, hr and finance (admins see no payroll, PHASE_5 decision 8).
        roles: ["owner", "hr", "finance"],
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
        label: "Clients",
        href: "/app/clients",
        roles: ["owner", "admin", "finance", "ops_manager"],
        icon: "clients",
        description: "The companies you work for, their billing details and contacts.",
        empty: "No clients yet. Add the first company you work for.",
      },
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
        description: "Company details, pay cycle, team and connections.",
        empty: "Connections arrive in a later phase.",
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

/** True when the item belongs to no module, or to one the company has on. */
function moduleOn(item: NavItem, modules: Modules): boolean {
  return item.module === undefined || modules[item.module];
}

/**
 * The sidebar for `role` in a company with `modules` on: items the role may open whose module
 * is on, with empty groups dropped.
 */
export function navForRole(role: Role, modules: Modules = ALL_MODULES_ON): NavGroup[] {
  return NAV.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => item.roles.includes(role) && moduleOn(item, modules)),
  })).filter((group) => group.items.length > 0);
}

/**
 * Home's description and empty-state sentence, so they never point at a part that is switched
 * off (slice 3.0).
 */
export function homeCopy(modules: Modules): { description: string; empty: string } {
  const home = findNavItem("/app");
  if (modules.shifts) return { description: home.description, empty: home.empty };
  if (modules.people) {
    return {
      description: "Approvals and money that need you today.",
      empty: "Nothing needs you yet. Add a client and your people to get started.",
    };
  }
  return {
    description: "Clients, invoices and money that need you today.",
    empty: "Nothing needs you yet. Add your first client to get started.",
  };
}

/**
 * Pages that are not sidebar items but need their own roles: the setup wizard, settings
 * sections narrower than Settings itself, and the People pages that change data (the people
 * import included). A segment written `[name]` matches any one segment
 * (`/app/people/[id]/edit`). The most specific match (most segments) wins over NAV.
 */
export const EXTRA_PAGES: readonly {
  href: string;
  roles: readonly Role[];
  /** The module the page belongs to when it isn't its nav item's (Settings > Payroll rules). */
  module?: ModuleId;
}[] = [
  { href: "/app/setup", roles: ["owner", "admin"] },
  { href: "/app/settings/company", roles: ["owner", "admin"] },
  // Slice 2.3: the company's collection bank account. Finance approves changes to it.
  { href: "/app/settings/bank-account", roles: ["owner", "admin", "finance"] },
  { href: "/app/settings/departments", roles: ["owner", "admin", "hr"] },
  // Slice 4.1: leave types, presets, holidays and the working week.
  { href: "/app/settings/leave", roles: ["owner", "admin", "hr"] },
  { href: "/app/settings/holidays", roles: ["owner", "admin", "hr"] },
  // Slice 5.0: payroll rules. Owner, hr and finance read; owner and hr add a version (admins see
  // no payroll, PHASE_5 decision 8). Part of Payroll: hidden when the company has it off.
  { href: "/app/settings/payroll", roles: ["owner", "hr", "finance"], module: "payroll" },
  { href: "/app/settings/payroll/new", roles: ["owner", "hr"], module: "payroll" },
  // Slice 5.2: a payroll run's page (owner, hr, finance; hr and owner prepare, finance decides).
  { href: "/app/payroll/[id]", roles: ["owner", "hr", "finance"], module: "payroll" },
  // Slice 4.4: leave balances (and HR's adjustments). Ops managers read requests' dates and type
  // only, never balances. A request's own page follows Leave.
  { href: "/app/leave/balances", roles: ["owner", "admin", "hr", "line_manager"] },
  // Slice 1.12: inviting, re-roling and removing managers.
  { href: "/app/settings/team", roles: ["owner", "admin"] },
  { href: "/app/people/new", roles: ["owner", "admin", "hr"] },
  // Slice 2.1: adding and editing clients. Contacts are changed on the client page, which
  // finance opens too.
  { href: "/app/clients/new", roles: ["owner", "admin", "ops_manager"] },
  { href: "/app/clients/[id]/edit", roles: ["owner", "admin", "ops_manager"] },
  // Slice 2.2: adding a site, and the checkpoint QR sheet (only these roles read the codes).
  // The site page itself follows Clients, so finance reads it.
  { href: "/app/clients/[id]/sites/new", roles: ["owner", "admin", "ops_manager"] },
  {
    href: "/app/clients/[id]/sites/[id]/checkpoints/print",
    roles: ["owner", "admin", "ops_manager"],
  },
  // Slice 2.4: adding and editing contracts and their rate cards. The contract page itself is
  // read by every Clients reader (finance sets WHT rates there).
  { href: "/app/clients/[id]/contracts/new", roles: ["owner", "admin", "ops_manager"] },
  { href: "/app/clients/[id]/contracts/[id]/edit", roles: ["owner", "admin", "ops_manager"] },
  { href: "/app/clients/[id]/contracts/[id]/rates", roles: ["owner", "admin", "ops_manager"] },
  // Slice 2.5: adding and changing a draft contract's headcount rows.
  { href: "/app/clients/[id]/contracts/[id]/headcount", roles: ["owner", "admin", "ops_manager"] },
  // Slice 2.7: activating and ending a contract.
  { href: "/app/clients/[id]/contracts/[id]/activate", roles: ["owner", "admin", "ops_manager"] },
  { href: "/app/clients/[id]/contracts/[id]/end", roles: ["owner", "admin", "ops_manager"] },
  // Slice 2.8: changes to a live contract. A post's history page follows Clients (finance reads).
  { href: "/app/clients/[id]/contracts/[id]/posts/new", roles: ["owner", "admin", "ops_manager"] },
  {
    href: "/app/clients/[id]/contracts/[id]/posts/[id]/change",
    roles: ["owner", "admin", "ops_manager"],
  },
  {
    href: "/app/clients/[id]/contracts/[id]/posts/[id]/close",
    roles: ["owner", "admin", "ops_manager"],
  },
  { href: "/app/people/[id]/edit", roles: ["owner", "admin", "hr"] },
  // Slice 1.8: importing employees writes workers, pay and bank details. Owner and HR only since
  // pay is theirs (owner decision, 23 Nov 2026).
  { href: "/app/people/import", roles: ["owner", "hr"] },
  // Worker invites and PIN resets (slice 1.9): the roles that may create invites.
  { href: "/app/people/invites", roles: ["owner", "admin", "hr"] },
  // Bank-detail approvals (slice 1.7): finance approves too, without the People list.
  { href: "/app/people/approvals", roles: ["owner", "admin", "hr", "finance"] },
  // A worker's page (slice 1.11): line managers open their own reportees to unlock phone
  // sign-in; RLS shows them no one else. Last, so the named People pages above win the tie.
  { href: "/app/people/[id]", roles: ["owner", "admin", "hr", "ops_manager", "line_manager"] },
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

/** True when `role` may open `pathname` by role alone (see canAccessHref). */
function roleMayOpen(role: Role, pathname: string): boolean {
  const extra = extraPage(pathname);
  if (extra) return extra.roles.includes(role);
  const href = activeNavHref(pathname);
  if (!href || (href === "/app" && pathname !== "/app")) return false;
  return findNavItem(href).roles.includes(role);
}

/**
 * The module `pathname` belongs to: an extra page's own module (Settings > Payroll rules belongs
 * to Payroll), else the module of the nav item whose route contains it (`/app/people/[id]/edit`
 * and `/app/people/import` belong to People), or null.
 */
export function moduleForHref(pathname: string): ModuleId | null {
  const extra = extraPage(pathname);
  if (extra?.module) return extra.module;
  const href = activeNavHref(pathname);
  if (!href) return null;
  return findNavItem(href).module ?? null;
}

export type PageAccess = "allow" | "forbidden" | "switched_off";

/**
 * Whether `role` may open `pathname` in a company with `modules` on. The role comes first, so a
 * role that could never open the page is refused (no-access) whatever the switches say; a page
 * the role may open whose module is off is "switched_off".
 */
export function pageAccess(
  role: Role,
  pathname: string,
  modules: Modules = ALL_MODULES_ON,
): PageAccess {
  if (!roleMayOpen(role, pathname)) return "forbidden";
  const part = moduleForHref(pathname);
  if (part && !modules[part]) return "switched_off";
  return "allow";
}

/**
 * True when `role` may open `pathname` (a nav item's page or a page below it, or an extra page)
 * and, given `modules`, its module is on. Paths that sit under no nav item are refused, and Home
 * covers only /app itself, so a new page must be added to NAV or EXTRA_PAGES (with its roles)
 * before anyone can reach it.
 */
export function canAccessHref(
  role: Role,
  pathname: string,
  modules: Modules = ALL_MODULES_ON,
): boolean {
  return pageAccess(role, pathname, modules) === "allow";
}
