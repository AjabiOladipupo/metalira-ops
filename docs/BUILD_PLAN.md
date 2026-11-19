# Build plan

Ten phases, about 24 weeks for one person building with Claude Code. Do not start a phase until the previous phase's "done when" passes.

| Phase | Weeks | Scope | Done when |
| --- | --- | --- | --- |
| 0 Foundations | 2 | Repo, app shell, design tokens, Supabase + PostGIS, RLS everywhere, roles, audit log, CI, Vercel previews, Sentry, Resend domain | Isolation test proves two companies can never read each other's rows; every PR gets a preview |
| 1 Company setup and people | 2 | Sign-up, plan, business details, logo, invoice email; departments, line managers, employees, mapping; CSV import with row checks; worker invites (link/QR, staff ID + PIN); worker profile in PWA | A 162-row file imports with bad rows held back and explained; an invited worker signs in on a phone |
| 2 Clients and contracts | 2 | Client → contacts → sites (geofence, QR checkpoints) → contract → dated rate card → headcount → documents → activation | Activating a contract creates its posts and roster requirements |
| 3 Rosters and PWA attendance | 3 | Roster grid vs headcount, uncovered tray, publish; PWA install, offline queue, server geofence check, selfie; supervisor crew clock-in; live board | Offline punches sync later with server-corrected times; outside-site punches arrive flagged |
| 4 Timesheets, leave, line managers | 2 | Timesheets from punches, exception flags, approval; leave types, balances, two-step approval; My team: assign shifts, approve leave, queries | An approved timesheet creates billable Work Units; approved leave opens affected shifts |
| 5 Payroll | 3 | Dated rule tables, gross-to-net with trace, anomalies, two-person approval, payslip PDFs, bank file export (the customer uploads it to their own bank), statutory schedules, pay cycle (20th–19th, paid 25th), proration, overtime | Reproduces `fixtures/october-2026-golden.json` exactly |
| 6 Invoicing and collections | 3 | Unbilled queue, invoice drafts at contract rates + VAT, PDF + email showing the company's own bank account and the invoice number as transfer narration, bank statement import (CSV/XLSX), matching (exact, reference, net of WHT, partial), receipts, credit notes, ageing, reminders | An imported sample statement's exact match (amount and invoice number) pays its invoice and emails a receipt with nobody touching it; fuzzy matches wait in the suggested queue |
| 7 Other costs, materials store and Revenue Layer | 3 | Cost logging (one-off, recurring, spread, per worker), sector categories, overhead allocation, rebillable costs; materials store (items, stores, bulk purchases into stock, issues to sites, returns, write-offs, stock counts, weighted-average cost, low-stock email); margin dashboards | A site's P&L equals posted invoices − payroll cost − logged costs − materials issued − overhead share, to the kobo; a bulk purchase issued across three sites shows each site's share at weighted-average cost |
| 8 Projects | 2 | Projects, phases, sub-jobs, KPIs, phase review and approval, milestone billing | Approving a phase review adds its milestone to unbilled work |
| 9 Hardening and pilot | 2 | Security review, backup restore drill, data export, privacy notice and DPA, Metalira subscription billing on Monnify, 3 pilot companies | 3 pilots run one real month: clock-in, payroll, invoices, payments |

## Every phase

- Illustrations: every phase's empty states and onboarding use their illustration slot from the slot table in `docs/DESIGN_SYSTEM.md` ("Illustrations"), rendered with `<Illustration name>` at the slot size and beside a sentence of copy. When a phase needs a screen that has no slot, add the slot to that table and draw the scene in `src/components/illustrations/` in the same pull request.
- Lira groundwork (docs/LIRA.md, from Phase 2): register every new Server Action in `src/server/capabilities/registry.ts`; give each area's main reads a compact summary (counts, masked values only); give every write that changes several rows or money a preview; set the audit channel on new server paths; add 5–10 manager requests with expected outcomes to `fixtures/lira/<area>.md`. No AI calls or API keys until the owner decides.

## Running costs

- Build: free tiers (Supabase Free, Vercel Hobby, Resend Free, Sentry Free, Monnify sandbox).
- Before the first paying customer: Supabase Pro (from $25/month), Vercel Pro ($20/seat/month; Hobby is non-commercial only), Resend Pro ($20/month; Free is 100 emails/day).
- Monnify: per-transaction collection fees on Metalira's own subscription income; confirm current pricing before pricing Metalira plans. Customers pay their own bank charges.

## Payments model

- Customers connect only their own business bank account (decided 16 Nov 2026). Clients pay invoices by transfer into it, payments are matched from uploaded bank statements, and payroll is a bank file the customer uploads to their own bank. Metalira never holds or moves customer money and stores no customer payment-provider credentials.
- Monnify is the payment provider for Metalira's own subscription billing only (decided 16 Nov 2026, replacing Flutterwave). Metalira's Monnify account is activated.
- Phase 0: provider interface and a Monnify adapter stub only. `.env.example` lists the names.
- Phase 9: first code that calls Monnify (sandbox, then live); set the webhook URL in Metalira's Monnify dashboard.
- The design prototypes still show Paystack and Flutterwave (pay-online links, dedicated accounts per client). Those parts are superseded; match their layouts, not their payment options.

## Open decisions

- Monnify: sandbox keys before Phase 9 starts, live keys before subscription billing goes live.
- Lawyer: whether hosting in Supabase West EU (Ireland, eu-west-1; per DNS, confirm in the dashboard) is acceptable under NDPA. The plan first named London (eu-west-2). Vercel functions run in Dublin (`dub1`).
- Tax adviser: confirm 2026 PAYE, pension and NHF settings before Phase 5 ends; WHT base (VAT-exclusive subtotal or total) and rate per service type before Phase 6; whether VAT applies to Metalira's own subscription before Phase 9.
- Collect each pilot customer's bank bulk-payment template and a sample bank statement export before Phase 5 ends.
