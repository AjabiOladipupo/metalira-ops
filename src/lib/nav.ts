/**
 * The manager app's navigation, in sidebar order. Pages, the sidebar and tests all read from here.
 * `icon` is a key into the icon map in src/components/shell/nav-icons.tsx.
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

export const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      {
        label: "Home",
        href: "/app",
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
        icon: "roster",
        description: "Who works where, and when.",
        empty: "No shifts yet. Publish a roster to start tracking attendance.",
      },
      {
        label: "Live attendance",
        href: "/app/attendance",
        icon: "attendance",
        description: "Clock-ins as they happen, by site.",
        empty: "No one is on shift right now.",
      },
      {
        label: "Timesheets",
        href: "/app/timesheets",
        icon: "timesheets",
        description: "Hours worked, overtime and exceptions to approve.",
        empty: "No timesheets to approve.",
      },
      {
        label: "People",
        href: "/app/people",
        icon: "people",
        description: "Every worker, their pay rate and where they are mapped.",
        empty: "No people yet. Import a staff list to add your team.",
      },
      {
        label: "My team",
        href: "/app/team",
        icon: "team",
        description: "The workers who report to you.",
        empty: "No one reports to you yet.",
      },
      {
        label: "Leave",
        href: "/app/leave",
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
        icon: "projects",
        description: "Phases, deadlines and milestones by client.",
        empty: "No projects yet.",
      },
      {
        label: "Unbilled work",
        href: "/app/unbilled",
        icon: "unbilled",
        description: "Approved work that is not on an invoice yet.",
        empty: "No unbilled work.",
      },
      {
        label: "Collections",
        href: "/app/collections",
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
        icon: "settings",
        description: "Company details, pay cycle, users and connections.",
        empty: "Settings arrive with sign-in.",
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
