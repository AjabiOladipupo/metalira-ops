# Metalira Ops

Workforce and business operations SaaS for Nigerian service companies (security, cleaning, facility management, staffing, field sales). Two tools that share one record:

- **Workforce Ops**: people, mapping, rosters, PWA clock-in, timesheets, leave, payroll.
- **Business Ops**: clients, sites, contracts, rate cards, projects, invoices, bank-statement collections, costs.
- **Revenue Layer**: joins both on the Work Unit to show labour margin, contribution margin and true margin.

Owner: Meta Lira Technology LTD. Product docs live in `docs/`. Read `docs/PRODUCT.md` and the current phase file before planning any work. Screens, brand and logos live in `docs/design/` (prototype screens in `docs/design/prototype/*.dc.html`, brand book and logos in `docs/design/brand/`); match their layouts.

## Stack

- Next.js 16 (App Router) + TypeScript (strict, `noUncheckedIndexedAccess`), Node 24, deployed on Vercel. One repo, one app. Next 16 differs from older versions: read the guide in `node_modules/next/dist/docs/` before using an unfamiliar API (see `AGENTS.md`).
- Supabase: Postgres + PostGIS, Auth, Storage, pg_cron. Migrations in `supabase/migrations`. The project uses Supabase's new keys: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` replaces the anon key and `SUPABASE_SECRET_KEY` replaces the service-role key. Where the docs say anon or service role, read publishable or secret.
- Tailwind CSS + shadcn/ui, styled per `docs/DESIGN_SYSTEM.md`.
- Resend + React Email for every outbound message. @react-pdf/renderer for invoices, receipts, payslips.
- Customers connect only their own business bank account: clients pay invoices by transfer into it (matched from uploaded bank statements) and payroll is a bank file the customer uploads to their own bank. Monnify is used only for Metalira's own subscription billing (Phase 9), behind `src/lib/payments/provider.ts`. No provider names outside `src/lib/payments/` and `src/server/billing/`.
- PWA: Serwist service worker + Dexie (IndexedDB) offline punch queue.
- Tests: Vitest (unit, money, RLS), Playwright (key flows). Sentry for errors.
- Package manager: pnpm.

## Rules that never break

1. **Money** is integer kobo (`bigint`) plus a `currency` column. Never floats, never `numeric` maths in JS. Format only at the edge with `formatNaira()`.
2. **Tenancy**: every business table has `organisation_id uuid not null` and row-level security enabled with policies using `private.user_org_ids()`. The service-role key is used only in server code under `src/server/`, never in client components.
3. **Versioned rates**: pay rates, rate cards and tax rule sets are dated versions (`effective_from`, `effective_to`). Never update a past version; insert a new one.
4. **Append-only records**: punches, audit log and ledger entries are insert-only. Corrections are new rows with a reason and actor.
5. **Posted documents** (invoices, payslips, payments, receipts) are never edited. Reverse or credit them.
6. **No custody of funds**: Metalira never holds or moves customer money. Customers connect only their own bank account; clients pay into it by transfer, and payroll is a bank file the customer uploads to their own bank. No customer payment-provider credentials are stored. Payroll bank files hold account numbers, so they follow rule 9 (private bucket, signed URL scoped to the organisation, never logged).
7. **Monnify webhooks** (Metalira's subscription billing): verify `monnify-signature` (HMAC-SHA512 of the raw body with the secret key, constant-time compare), accept only from Monnify's published IP as set by the platform (`x-real-ip` / `ipAddress()`, never `x-forwarded-for`), then re-fetch the transaction from Monnify. Find the organisation and invoice only from our own reference on the re-fetched transaction, never from webhook body fields, and give value only when the status is fully paid and the paid amount and currency equal that invoice. Never log the raw body or parsed event. Monnify credentials are server-only env under `src/server/`. Process each `transactionReference` exactly once (unique index + idempotent handler). Confirm the scheme and IP list in Monnify's current docs when Phase 9 starts.
8. **Notifications** are email via Resend or an in-app inbox item. No SMS, no WhatsApp.
9. **Personal data** (NIN, BVN, bank account numbers, RSA PIN) is encrypted at the column level and masked in the UI except for authorised roles. Selfies and location are collected only with recorded consent.
10. **Two-person rule**: payroll release and bank-detail changes need a second approver.

## Conventions

- Server logic in `src/server/<module>/` (identity, people, sites, workforce, payroll, business, billing, revenue, projects). UI in `src/app/`. Shared UI in `src/components/`.
- Database access through typed Supabase clients generated with `supabase gen types`.
- Every mutation writes an `audit_log` row (who, what, before, after).
- Validate all input with Zod at the server boundary.
- Copy follows the voice in `docs/DESIGN_SYSTEM.md`: sentence case, numbers first, no emoji.

## Commands

- `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`
- `supabase start` (local stack, needs Docker), `supabase db reset`, `supabase migration new <name>`, `supabase gen types typescript --local > src/types/db.ts`

## Definition of done for any slice

- Migration included and `supabase db reset` passes.
- RLS policy on every new table, and the isolation test (`tests/rls/isolation.test.ts`) passes.
- Unit tests for any money, tax or matching logic, including the fixtures in `fixtures/` where relevant.
- `pnpm typecheck && pnpm lint && pnpm test` green.
- Screen matches the design system; works at 390px and 1440px.
- Pull request description lists what changed and how to check it on the Vercel preview.

## How to work

- Start every phase or slice in plan mode. Propose tables, routes, screens and tests; wait for approval before editing.
- One slice at a time, end to end. Small pull requests.
- Before merging anything touching money, payroll, permissions or webhooks, run the `money-reviewer` or `security-reviewer` subagent.
- When a business rule is unclear, ask. Do not invent Nigerian tax or legal rules; use `docs/RULES_NIGERIA.md` and flag gaps.
