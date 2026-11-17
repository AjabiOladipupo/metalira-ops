import type { IllustrationName } from "@/components/illustration";

export type RoleSlug = "owners" | "hr" | "finance" | "operations" | "workers";

export type Role = {
  slug: RoleSlug;
  href: `/for/${RoleSlug}`;
  /** Menu and footer link text. */
  nav: string;
  /** Eyebrow above the headline. */
  eyebrow: string;
  illustration: Extract<IllustrationName, `role-${string}`>;
  headline: string;
  subline: string;
  /** Page <title> and description. */
  title: string;
  description: string;
  /** Problem then outcome, three per role. */
  blocks: readonly { problem: string; outcome: string }[];
  /** "What you do in Metalira Ops". */
  tasks: readonly string[];
};

export const ROLES: readonly Role[] = [
  {
    slug: "owners",
    href: "/for/owners",
    nav: "For owners",
    eyebrow: "For owners and directors",
    illustration: "role-owner",
    headline: "Know what each site earns after payroll.",
    subline:
      "See margin per site and client, the work you have not billed yet, and whether this month's collections cover the next payroll.",
    title: "For owners",
    description:
      "Margin per site and client, unbilled work and cash collected against the next payroll, from the same record your supervisors and finance team use.",
    blocks: [
      {
        problem: "You find out a site lost money months later, when the accounts come in.",
        outcome:
          "Margin per site, client and project, worked out from approved hours, logged costs and payroll.",
      },
      {
        problem: "Payday comes before the client pays, and you only see the gap the day before.",
        outcome:
          "Cash collected sits next to the next payroll, so you see a shortfall weeks earlier.",
      },
      {
        problem: "Shifts your people worked never make it onto an invoice.",
        outcome: "Work done but not yet invoiced shows as a list you can bill today.",
      },
    ],
    tasks: [
      "Check margin by site, client, project and month",
      "See labour cost as a share of what you billed",
      "Spot work that is done but not yet invoiced",
      "Compare cash collected with the next payroll",
      "Download everything at any time",
    ],
  },
  {
    slug: "hr",
    href: "/for/hr",
    nav: "For HR",
    eyebrow: "For HR",
    illustration: "role-hr",
    headline: "One record for every worker.",
    subline:
      "Staff, line managers, sites, clients and projects in one place. Invite workers to the app and keep bank changes under two approvers.",
    title: "For HR",
    description:
      "One record of your people, mapped to line managers, sites and clients, with worker invites and bank-detail changes that need two approvers.",
    blocks: [
      {
        problem: "Your staff list lives in three spreadsheets and none of them agree.",
        outcome:
          "Import once from our template. Each person is mapped to a department, line manager, site, client and projects.",
      },
      {
        problem: "New workers wait days before they can use any system.",
        outcome:
          "Send an invite by email, or print a sheet of invite QR codes for workers with no email. They sign in on their own phone.",
      },
      {
        problem: "One changed account number can send a salary to the wrong person.",
        outcome:
          "Every bank-detail change needs a second approver before payroll uses it, and both names stay on the record.",
      },
    ],
    tasks: [
      "Import and map your people from a spreadsheet",
      "Invite workers to the mobile app",
      "Approve leave after line managers",
      "Prepare payroll and statutory schedules",
      "Approve bank-detail changes as one of two approvers",
    ],
  },
  {
    slug: "finance",
    href: "/for/finance",
    nav: "For finance",
    eyebrow: "For finance",
    illustration: "role-finance",
    headline: "Payroll and invoices from the same approved hours.",
    subline:
      "Payroll inputs, client invoices and bank-statement matching built on one record, so the numbers agree before you send them.",
    title: "For finance",
    description:
      "Payroll inputs from approved timesheets, invoices drafted from the same hours, and bank statements matched to invoices.",
    blocks: [
      {
        problem: "Payroll inputs arrive late, on paper, with overtime nobody can explain.",
        outcome:
          "Approved timesheets feed payroll, with PAYE, pension, NSITF and ITF worked out and an explanation for each worker.",
      },
      {
        problem: "Invoices are typed up from memory and miss shifts.",
        outcome:
          "Draft invoices come from approved hours at contract rates, with 7.5% VAT, ready to send.",
      },
      {
        problem: "Matching transfers to invoices takes days every month.",
        outcome:
          "Upload your bank statement and each credit is matched to an invoice, including part payments and amounts net of WHT. Receipts go out by email.",
      },
    ],
    tasks: [
      "Approve payroll and download the bank file for your bank",
      "Send invoices built from approved hours",
      "Upload bank statements and confirm matches",
      "Log costs against sites, clients and projects",
      "Upload PAYE and pension receipts",
    ],
  },
  {
    slug: "operations",
    href: "/for/operations",
    nav: "For operations",
    eyebrow: "For operations managers",
    illustration: "role-operations",
    headline: "Every post covered, every shift seen.",
    subline:
      "Build rosters against each site's headcount, watch clock-ins as they happen and fill uncovered shifts before the client calls.",
    title: "For operations",
    description:
      "Rosters built against each contract's headcount, live attendance by site, and one tray for uncovered shifts.",
    blocks: [
      {
        problem: "Rosters live in a spreadsheet that does not know what each contract needs.",
        outcome:
          "Rosters are built against the headcount on each contract, so short posts show before you publish.",
      },
      {
        problem: "You learn a guard did not turn up when the client calls.",
        outcome:
          "Live attendance shows who has clocked in at each site, with the location checked against the site.",
      },
      {
        problem: "Uncovered shifts get lost between supervisors.",
        outcome:
          "Uncovered shifts sit in one tray until someone is assigned. Publishing a roster emails the workers.",
      },
    ],
    tasks: [
      "Set up clients, sites and contracts",
      "Build and publish rosters",
      "Watch live attendance by site",
      "Fill uncovered shifts",
      "Run projects with phases, KPIs and review calls",
    ],
  },
  {
    slug: "workers",
    href: "/for/workers",
    nav: "For workers",
    eyebrow: "For workers",
    illustration: "role-worker",
    headline: "Clock in from your phone, even with no data.",
    subline:
      "See your shifts, ask for leave and read your payslips in one app that works on a cheap Android phone.",
    title: "For workers",
    description:
      "Clock in on a cheap phone even offline, see your shifts, leave and payslips, and change your details safely.",
    blocks: [
      {
        problem: "No data at the gate means no record that you came to work.",
        outcome: "Your clock-in saves on the phone and sends when the network returns.",
      },
      {
        problem: "You hear about shift changes late, and leave requests get lost.",
        outcome: "See your shifts, ask for leave and follow each approval in the app.",
      },
      {
        problem: "Payslips arrive late, and changing your bank account feels risky.",
        outcome:
          "Read every payslip in the app. Bank-detail changes need a second approver, so nobody can quietly redirect your pay.",
      },
    ],
    tasks: [
      "Clock in and out at your site",
      "See this week's shifts",
      "Ask for leave and see your balance",
      "Read your payslips",
      "Update your details and bank account safely",
    ],
  },
];

export function roleBySlug(slug: RoleSlug): Role {
  const role = ROLES.find((r) => r.slug === slug);
  if (!role) throw new Error(`Unknown role ${slug}`);
  return role;
}
