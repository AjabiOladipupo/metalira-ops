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
- Tables: `organisations`, `profiles` (1:1 with auth.users), `memberships` (user × organisation × role), `audit_log` (append-only).
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

## Phase 0 done when
- Isolation test passes in CI.
- Every PR gets a Vercel preview.
- `/design-system` page reviewed and approved.
