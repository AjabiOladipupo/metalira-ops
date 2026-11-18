/**
 * Copy for Lira, the planned operations assistant (owner decision, 19 Nov 2026). Lira is not
 * available yet: say "Coming soon", give no date or price, and name no vendor or model.
 * tests/unit/marketing-copy.test.ts checks every string here.
 */

export const LIRA = {
  status: "Coming soon",
  title: "Meet Lira",
  intro:
    "Lira is an assistant you chat with inside Metalira Ops. Ask in plain words and Lira does the admin work, then checks with you before anything changes.",
  capabilities: [
    {
      title: "Onboard your staff",
      request: "Add these 162 people from my spreadsheet.",
      body: "Lira reads the sheet and lists everyone it will add, with their site and line manager.",
    },
    {
      title: "Ask about attendance",
      request: "Who hasn't clocked in at Lekki today?",
      body: "Answers come from today's rosters and clock-ins, site by site.",
    },
    {
      title: "Prepare payroll and invoices",
      request: "Prepare November payroll for my approval.",
      body: "Lira drafts the pay run or the invoices and leaves them for you to approve.",
    },
    {
      title: "Collect what you are owed",
      request: "Which clients are overdue?",
      body: "Lira matches payments on your bank statement to invoices and drafts reminder emails to clients who are late.",
    },
  ],
  safetyTitle: "Lira checks with you first",
  safety: [
    "Lira only does what your role allows.",
    "It shows exactly what will change and waits for you to confirm.",
    "It never approves its own work. Approvals still need a second person.",
    "It never moves money. Payroll stays a bank file you upload to your own bank.",
  ],
} as const;

/** The "Coming soon: Lira" line on each manager role page. Workers do not use Lira. */
export const LIRA_FOR_ROLE = {
  owners:
    "Ask “How did each site do this month?” and Lira answers with margin, unbilled work and cash collected against the next payroll.",
  hr: "Hand Lira your staff spreadsheet and it lists everyone it will add, mapped to sites and line managers, for you to confirm.",
  finance:
    "Ask Lira to prepare the pay run or this month's invoices for your approval, and to match bank-statement payments to invoices. It never moves money.",
  operations:
    "Ask “Who hasn't clocked in at Lekki today?” or “Which posts are short this week?” and Lira answers from your rosters and clock-ins.",
} as const;

/** Every role page but /for/workers carries a Lira line. */
export type LiraRole = keyof typeof LIRA_FOR_ROLE;
