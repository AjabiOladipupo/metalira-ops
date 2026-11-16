# Phase 0: foundations (about 2 weeks)

Goal: an empty but production-shaped app. Every later phase plugs into this without rework.

## Slices (one pull request each, in order)

### 0.1 Repo and tooling
- Next.js App Router + TypeScript strict, pnpm, ESLint, Prettier, path alias `@/`.
- Vitest and Playwright installed with one passing sample test each.
- GitHub Actions: on every PR run `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test`.
- `.env.example` listing every variable (Supabase URL/anon/service, Resend key, Flutterwave public key/secret key/encryption key/webhook secret hash/base URL, Sentry DSN, APP_URL).

**Accept:** CI is green on an empty PR.

### 0.2 Design system and app shell
- Tailwind + shadcn/ui themed exactly per `docs/DESIGN_SYSTEM.md` (tokens, fonts, type scale, radii, dark mode via class).
- Components: `Logo`, `Status`, `KpiTile`, `PageHeader`, `EmptyState`, `DataTable` (money columns right-aligned, tabular-nums).
- App shell: sidebar groups (Home · Workforce · Payroll · Business · Revenue · Settings), top bar (company switcher, site filter, search, user menu), mobile sheet nav. Placeholder pages for every route.
- `/design-system` page showing all tokens and components in light and dark.

**Accept:** `/design-system` matches the prototype look at 390px and 1440px.

### 0.3 Supabase project and tenancy core
- `supabase init`, local stack, PostGIS extension enabled in the first migration.
- Tables: `organisations`, `profiles` (1:1 with auth.users), `memberships` (user × organisation × role), `membership_invites` (email invites, accepted only by the invited, confirmed email), `audit_log` (append-only).
- Schema `private` with `private.user_org_ids()` (security definer, stable) returning the caller's organisation ids, and `private.has_role(org uuid, roles text[])`.
- RLS enabled on every table; policies use those functions. App connects with the anon key + user JWT; service role only in `src/server/`.
- Generated types in `src/types/db.ts`.

**Accept:** `tests/rls/isolation.test.ts` creates two organisations with one user each and proves, for every table, that neither user can select, insert, update or delete the other's rows (including that a blocked select returns zero rows).

### 0.4 Auth and roles
- Manager sign-in: email + password and magic link (Supabase Auth). Sign-up creates an organisation and an owner membership.
- Worker sign-in placeholder route `/m/sign-in` (company code + staff ID + PIN). Design only in Phase 0; implemented in Phase 1.
- Middleware protecting `/app/*`; role-aware sidebar; organisation switcher for users in more than one organisation.
- Every mutation helper writes to `audit_log`.

**Accept:** a new owner can sign up, sign out, sign back in, and only sees their own organisation.

### 0.5 Platform services
- Vercel project linked to the repo; preview deploy per PR; environment variables set for Preview and Production.
- Resend: sending domain verified (SPF, DKIM); `src/server/email/send.ts` with a React Email base layout in the design system; test email to the owner on sign-up.
- Sentry for client and server; source maps uploaded on build.
- Money utilities: `src/lib/money.ts` (kobo integers, `formatNaira`, `allocateKobo` for splits that always sum exactly) with tests.
- Payment provider interface `src/lib/payments/provider.ts` (types only) and a Flutterwave adapter stub.

**Accept:** a PR shows a working preview link; sign-up sends a branded email; a thrown test error appears in Sentry; money tests pass.

## Decisions (owner, 15 Nov 2026)

Approved together with the parallel build plan. Agents build to these; change them only with the owner.

**Build process**
- Phase 0 slices 0.3, 0.4 prework, 0.5a (money + payments stub), 0.5b (email) and 0.5c (Sentry) run in parallel on separate branches. 0.4 finishes after 0.3 merges. Merge order: deps → 0.5a → 0.5c → 0.3 → 0.5b → 0.4. Security reviewer on 0.3, 0.4 and 0.5a (webhook check); money reviewer on 0.5a.
- Every branch: one timestamped migration per slice; rebase on main, run `supabase db reset`, regenerate `src/types/db.ts` (never hand-merge) before the PR. Never hand-merge `pnpm-lock.yaml`.
- Contract between 0.3 and 0.4: 0.3 owns `src/lib/supabase/{env,client,server}.ts`, `supabase/*`, `tests/rls/*`. Organisation creation is `public.create_organisation(p_name)` (security invoker) over `private.create_organisation_impl` (security definer, `search_path=''`). Security-definer functions live only in schema `private`.
- Audit write path: AFTER triggers (`private.audit_row_change`) log table changes in the same transaction, stripping keys matching `_enc$`, `pin_hash`, `token_hash`. App-level events go through `public.log_audit` (invoker) → `private.log_audit_impl` (definer). No direct INSERT grant on `audit_log` for `authenticated`. Update, delete and truncate on `audit_log` are impossible for every role (revokes plus triggers).
- Column grants: revoke the table-level privilege first, then grant specific columns (a column-level revoke alone does nothing in Postgres).
- Local Postgres major version 17 (match the hosted project; confirm in Dashboard → Settings → Infrastructure).
- Hosted migrations: applied by the Supabase GitHub integration on merge to `main` (owner switches it on). Agents never run `db push --linked`.
- App URL variable: `NEXT_PUBLIC_APP_URL`. Webhook secret: `FLUTTERWAVE_WEBHOOK_SECRET_HASH`.
- With `cacheComponents: true`, do not export `runtime` from routes; proxy (`src/proxy.ts`, Next 16's renamed middleware) runs on Node only, so no Sentry edge config.

**Roles and access**
- Nav by role: owner and admin see everything. hr: Home, Timesheets, People, My team, Leave, Payroll run, Settings. finance: Home, Timesheets, Payroll run, Unbilled work, Collections, Revenue, Settings. ops_manager: Home, Roster, Live attendance, Timesheets, People, My team, Leave, Projects, Unbilled work. line_manager: Home, Live attendance, Timesheets, My team, Leave. worker: no `/app`, goes to `/m`. client_approver: a no-access page until a client portal exists. Direct URL access is enforced too, not only the sidebar.
- One role per user per organisation (unique `organisation_id, user_id`).
- Only owner and admin can read `audit_log`.
- Admins manage every role except owner; only owners manage owner rows; every organisation keeps at least one owner (last-owner guard).
- A user who is a worker in one organisation and a manager in another: the switcher lists manager memberships only; worker access is in `/m`.

**Sign-up**
- Fields: full name, email, password, company name. No trial or pricing copy until pricing is final.
- `organisations.plan` text, default `trial`, not editable by clients.
- Email confirmation on. Supabase Auth emails go through Resend SMTP once the Resend key exists.
- The welcome email goes to the signing-up owner only. Missing `RESEND_API_KEY`: skip with a log on previews and in development, error in production.

**Money**
- Rounding is half away from zero (symmetric) for negatives, so a reversal mirrors the original line.
- Dashboard whole-naira display rounds half up (₦642,312.50 → ₦642,313).
- `pay_cycle_start_day` 1–28, `pay_day` 1–31.

## Phase 0 done when
- Isolation test passes in CI.
- Every PR gets a Vercel preview.
- `/design-system` page reviewed and approved.
