# Build plan

Ten phases, about 24 weeks for one person building with Claude Code. Do not start a phase until the previous phase's "done when" passes.

| Phase | Weeks | Scope | Done when |
| --- | --- | --- | --- |
| 0 Foundations | 2 | Repo, app shell, design tokens, Supabase + PostGIS, RLS everywhere, roles, audit log, CI, Vercel previews, Sentry, Resend domain | Isolation test proves two companies can never read each other's rows; every PR gets a preview |
| 1 Company setup and people | 2 | Sign-up, plan, business details, logo, invoice email; departments, line managers, employees, mapping; CSV import with row checks; worker invites (link/QR, staff ID + PIN); worker profile in PWA | A 162-row file imports with bad rows held back and explained; an invited worker signs in on a phone |
| 2 Clients and contracts | 2 | Client → contacts → sites (geofence, QR checkpoints) → contract → dated rate card → headcount → documents → activation | Activating a contract creates its posts and roster requirements |
| 3 Rosters and PWA attendance | 3 | Roster grid vs headcount, uncovered tray, publish; PWA install, offline queue, server geofence check, selfie; supervisor crew clock-in; live board | Offline punches sync later with server-corrected times; outside-site punches arrive flagged |
| 4 Timesheets, leave, line managers | 2 | Timesheets from punches, exception flags, approval; leave types, balances, two-step approval; My team: assign shifts, approve leave, queries | An approved timesheet creates billable Work Units; approved leave opens affected shifts |
| 5 Payroll | 3 | Dated rule tables, gross-to-net with trace, anomalies, two-person approval, payslip PDFs, bank file export, Flutterwave bulk transfer, statutory schedules, pay cycle (20th–19th, paid 25th), proration, overtime | Reproduces `fixtures/october-2026-golden.json` exactly |
| 6 Invoicing and Flutterwave | 3 | Unbilled queue, invoice drafts at contract rates + VAT, PDF + email, virtual account per client, checkout link, webhooks, matching, receipts, credit notes, ageing, reminders | A sandbox payment arrives, matches its invoice and emails a receipt with nobody touching it |
| 7 Other costs, materials store and Revenue Layer | 3 | Cost logging (one-off, recurring, spread, per worker), sector categories, overhead allocation, rebillable costs; materials store (items, stores, bulk purchases into stock, issues to sites, returns, write-offs, stock counts, weighted-average cost, low-stock email); margin dashboards | A site's P&L equals posted invoices − payroll cost − logged costs − materials issued − overhead share, to the kobo; a bulk purchase issued across three sites shows each site's share at weighted-average cost |
| 8 Projects | 2 | Projects, phases, sub-jobs, KPIs, phase review and approval, milestone billing | Approving a phase review adds its milestone to unbilled work |
| 9 Hardening and pilot | 2 | Security review, backup restore drill, data export, privacy notice and DPA, Metalira subscription billing, 3 pilot companies | 3 pilots run one real month: clock-in, payroll, invoices, payments |

## Running costs

- Build: free tiers (Supabase Free, Vercel Hobby, Resend Free, Sentry Free, Flutterwave test mode).
- Before the first paying customer: Supabase Pro (from $25/month), Vercel Pro ($20/seat/month; Hobby is non-commercial only), Resend Pro ($20/month; Free is 100 emails/day).
- Flutterwave: per-transaction collection and transfer fees; confirm current Nigerian pricing before pricing Metalira plans.

## Payment provider timeline

- Payment provider is Flutterwave (decided 15 Nov 2026, replacing Monnify).
- Phase 0: provider interface and a Flutterwave adapter stub only; no keys needed. `.env.example` lists the names.
- Phase 2 (contract activation creates a client virtual account): add Flutterwave **test** keys to `.env.local` and Vercel Preview.
- Phase 6: live keys in Vercel Production, webhook URL and secret hash set in the Flutterwave dashboard.

## Open decisions

- Flutterwave: test keys before Phase 2, live keys and compliance before Phase 6.
- Lawyer: whether triggering payouts from a customer's own Flutterwave balance needs a CBN licence; whether hosting in Supabase London is acceptable under NDPA.
- Tax adviser: confirm 2026 PAYE, pension and NHF settings before Phase 5 ends.
- Collect each pilot customer's bank bulk-payment template before Phase 5 ends.
