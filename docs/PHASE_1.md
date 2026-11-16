# Phase 1: company setup and people (about 2 weeks)

Goal: a company can set itself up, bring in its whole workforce from one file, map every worker to a department, line manager, site and project, and get each worker signed in on their own phone. Every later phase (rosters, timesheets, payroll) reads the people, pay rates and mapping built here.

Before starting: Phase 0 is done (signed off 16 Nov 2026). Owner must set `PII_ENCRYPTION_KEY` before 1.2 merges. Screens follow `docs/design/prototype/Setup.dc.html`, `People.dc.html`, `WkHome.dc.html` and `WkProfile.dc.html`.

Rules that apply to every slice here:
- Every new table has `organisation_id`, RLS using `private.user_org_ids()` / `private.has_role()`, and is added to `tests/rls/isolation.test.ts`.
- Every mutation writes `audit_log`. Personal data (NIN, bank account number, RSA PIN) never appears in `audit_log.before/after` in clear; log the masked value or `"changed"`.
- Money is integer kobo. Naira amounts from forms and CSV are parsed from strings to kobo; never through `Number` or `parseFloat`.
- Next 16: route protection lives in `src/proxy.ts` (Middleware was renamed Proxy in Next 16, see `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`) and does optimistic checks only; the real role check is repeated in each server action and route handler. With `cacheComponents: true`, any component reading the session (`cookies()`) sits behind `<Suspense>` (see `02-guides/authentication-with-cache-components.md`).
- Parallel agents: each slice adds its own timestamped migration; rebase on `main` and regenerate `src/types/db.ts` before opening the PR.

## Slices (one pull request each)

### 1.1 Company setup wizard and company settings
- Migration: add to `organisations` `trading_name`, `tin`, `industry`, `head_office_state`, `address`, `phone`, `invoice_number_start` (default 1), `payment_terms_days` (30), `vat_registered` (bool), `auto_email_receipts` (bool), `expected_workers`, `company_code` (short, unique, used for worker sign-in), `setup_completed_at`. `plan` and `invoice_email` already exist from 0.3.
- `/app/setup` wizard following the Setup board: steps Plan, Business details, Invoices and payments, Clients and contracts, Employees, Ready. Left rail "Setup N of 5 done"; "Everything here can be changed later in Settings."
- Plan step records the chosen plan and expected workers only. No prices, estimates or worker limits are shown until pricing is final (Phase 0 decision); no charging (Metalira billing is Phase 9).
- Business step: logo upload to a private Storage bucket `org-assets/{organisation_id}/logo.*` (PNG or SVG, under 1 MB, served by signed URL), registered name, trading name, RC number, TIN, industry, head office state, address, phone. Pay settings: monthly only. `pay_cycle_start_day` (1–28, default 20) and `pay_day` (1–31, default 25) already exist on `organisations`; the step edits them. "Last working day" and weekly pay from the board are not offered until payroll rules cover them.
- Invoices step: invoice email, first invoice number, payment terms, VAT registered. "Where clients pay" shows the company's own bank account only, as a "Connect in Phase 2" placeholder (no payment provider; see BUILD_PLAN.md "Payments model"); no provider names in UI code outside the allowed folders (render from a server-provided list).
- Clients step is a placeholder that links forward (clients arrive in Phase 2); Employees step hosts the import from 1.8 once it lands, and until then links to `/app/people`.
- Owner/admin only. `/app/settings/company` reuses the same forms. After sign-up, an owner with no `setup_completed_at` is sent to `/app/setup`.
- Zod schemas in `src/server/identity/company.ts`; RC number and TIN format checks only.

**Accept:** a new owner completes setup at 390px and 1440px, the logo shows in the shell, a non-admin gets 403 on the setup actions, and every save writes an audit row.

### 1.2 Personal data encryption and masking
- `src/server/crypto/pii.ts`: AES-256-GCM encrypt/decrypt with a random IV per value and a key version prefix, key from `PII_ENCRYPTION_KEY` (server only, added to `.env.example`). Values stored as `bytea` in `_enc` columns.
- `src/lib/mask.ts` (pure): `maskAccount` (`••••7712`), `maskRsaPin` (`PEN••••4421`), `maskPhone` (`0803 ••• 4410`), `maskNin`.
- `src/server/people/pii-access.ts`: `canSeePii(role, field)`; owner and hr see full values, finance sees full bank account, everyone else gets masked values; reveals are written to `audit_log` as `pii.reveal`.
- Store `_last4` siblings (`bank_account_last4`, `rsa_pin_last4`) so lists never decrypt.
- Unit tests: round trip, tamper detection, wrong key fails, masking output, role matrix. ESLint rule or test that `src/server/crypto` is never imported from a client component.

**Accept:** unit tests pass; a grep test proves `PII_ENCRYPTION_KEY` is read only under `src/server/`; security-reviewer has no high findings.

### 1.3 People schema
- Migration: `departments` (name, head_worker_id), `workers` (columns per `DATA_MODEL.md` People: staff_id unique per organisation, first/last name, phone, email null, job_title, department_id, line manager as exactly one of `line_manager_worker_id` → workers or `line_manager_membership_id` → memberships (a manager-app user who is not a worker), employment_type enum permanent/contract/casual/daily, start_date, end_date, status active/ended, bank_name, account_name, bank_account_enc, bank_account_last4, nin_enc, tin, tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in, annual_rent_declared_kobo + currency, next_of_kin_name, next_of_kin_phone, `needs_pay_details` (bool, set when pay or bank details are missing; payroll refuses to pay these workers), `supervisor_clock_in` (bool, set when the worker shares a phone number with another worker)), `pay_rates` (worker_id, pay_type monthly/daily/hourly, basic, housing, transport, other_allowances, daily_rate, all bigint kobo + currency, effective_from, effective_to), `worker_assignments` (worker_id, client_id, site_id, project_id, from, to).
- Minimal mapping targets so mapping works before Phase 2: `clients` (name), `sites` (client_id, name), `projects` (client_id, name). Phase 2 and Phase 8 extend these with `alter table`; no other columns now (owner decision).
- Constraints: no overlapping `pay_rates` per worker (exclusion constraint on a daterange); past versions are never updated (trigger blocks update of rows with `effective_from <= current_date` except closing `effective_to`); a worker cannot be their own line manager; line manager chain has no cycles (checked in the server helper). `staff_id` keeps the company's own IDs; when blank, the server generates the next free ID in the company's pattern (default `EMP-0001`).
- `memberships.worker_id` foreign key to `workers`.
- RLS: managers by role (owner, admin, hr read/write; ops_manager, finance read; line_manager reads own reportees); worker reads only their own row via `memberships.worker_id`. Isolation test covers all seven tables.
- Server helpers in `src/server/people/`: `createWorker`, `updateWorker`, `addPayRate` (closes the previous version the day before), `endEmployment`, all Zod-validated, audited and encrypting through 1.2.
- Unit tests for pay-rate versioning (insert new, close old, reject overlap, reject past edit).

**Accept:** `supabase db reset` passes; isolation test covers the new tables; pay-rate versioning tests pass; money-reviewer has no findings on the kobo columns.

### 1.4 Import validator (pure library)
- Accepts CSV and Excel (.xlsx, first sheet). Excel is read on the server only with one maintained parser library, size-capped and with formulas ignored (values only).
- `src/server/people/import/` parses the header from `fixtures/employee_import_template.csv` (32 columns; `employee_id` maps to `staff_id`) and returns, per row, either a normalised worker + pay rate + mapping, or a list of problems in plain English with a suggested fix.
- Checks: required columns (the first 15 are enough to import; missing pay or bank columns import the worker but flag "needs pay details before payroll"), dates, employment type and pay type values, NUBAN is 10 digits, NIN is 11 digits, phone is a Nigerian mobile number, duplicate staff ID inside the file and against existing workers (held back), duplicate phone (imported and marked `supervisor_clock_in`, shown as a warning with the fix pre-applied), blank staff ID (generated), line manager resolves to a staff ID in the file or account, or to a manager-app user's email (two-pass resolve, cycle check), naira strings parsed to kobo exactly (`105000`, `105,000`, `105000.50`; reject anything else), monthly pay needs basic, daily pay needs daily rate, fuzzy match of client/project/site names to existing ones ("Coastline Logistic" suggests "Coastline Logistics").
- Summary: rows, ready, need fixing, and "Found 4 departments · 14 line managers · 3 clients · 4 projects · 5 sites".
- New fixture `fixtures/people-import-162.csv` (generated deterministically, fake names and numbers) with exactly the four held-back rows from the Setup board: row 23 unknown line manager, row 57 nine-digit account number, row 88 phone repeated from row 12 (listed with "Use supervisor clock-in" pre-applied), row 140 client "Coastline Logistic"; plus `fixtures/people-import-162.expected.json` with the expected summary and problems.
- Unit tests against both fixtures, including kobo parsing edge cases.

**Accept:** the 162-row fixture validates to 158 ready and 4 listed for attention with the expected messages (row 88 importable as-is with supervisor clock-in, the other 3 held back); the same file saved as .xlsx gives the same result; parsing never uses floats (money-reviewer).

### 1.5 People list, employees and departments
- `/app/people` per the People board: header "162 employees · N not fully mapped" with Import and Add employee actions, department tiles as filters (count and head), table Employee · Department · Line manager · Site · Projects · Mapping status (Mapped / Incomplete with dot). Search by name or staff ID. Empty state uses the `import-people` illustration slot.
- `/app/people/new` and `/app/people/[id]`: identity, job, department, line manager, employment, pay (current rate and dated history; "Change pay" inserts a new version from a chosen date), tax and pension, next of kin, end employment. PII shown masked with a reveal for permitted roles (1.2).
- `/app/settings/departments`: add, rename, set head.
- Server actions in `src/server/people/` check role per action.
- Playwright: HR adds a worker, changes pay from next month, sees two dated versions; a line manager cannot open the edit form.

**Accept:** list, add, edit and pay change work at 390px and 1440px; ops_manager sees masked bank details; e2e passes.

### 1.6 Mapping
- Mapping panel on `/app/people` (right column at 1440px, bottom sheet at 390px): department, line manager, site, projects (multi-select), "Save mapping".
- Saving closes the current `worker_assignments` rows the day before and inserts new ones from the next day ("Changes apply from the next shift"); history is kept, never overwritten.
- Mapping status = has department, line manager and site; shown in the table and counted in the header.
- Line manager is told by email (if they have one) via `src/server/email/send.ts`; the worker sees the change on their profile (1.10).
- Unit tests for assignment closing and overlap; Playwright for map, save and status flip.

**Accept:** remapping a worker keeps the old assignment with an end date, the Incomplete count drops, and the audit log shows before and after.

### 1.7 Bank-detail changes with two-person approval
- Migration: `bank_detail_changes` (worker_id, requested_by, bank_name, account_name, bank_account_enc, bank_account_last4, reason, status pending/approved/rejected/applied, approved_by, decided_at, applies_after = decided_at + 72 hours). Owner decision: after approval the new account takes effect for payouts only after the 72-hour hold; until then payouts use the previous account, and the worker is emailed when the change is approved and when it applies. Insert-only history; status moves by new decision columns guarded by a check that `approved_by <> requested_by`.
- Editing bank details on a worker (1.5) creates a request instead of writing to `workers`. A second HR, finance or owner user approves; only then, and once `applies_after` has passed, are `workers.bank_*` columns updated, in one transaction with audit rows. Payroll reads bank details as of the payout date.
- Approvals list at `/app/people/approvals` and a badge in the People header. Email to approvers when a request is raised.
- Workers can raise the same request from their phone (wired in 1.10).
- Unit and RLS tests: requester cannot approve own request, a worker cannot approve anything, rejected requests leave `workers` unchanged.

- Bank details on a new worker (recorded from the 1.3 review): one HR user could otherwise add a worker with their own account number and pay it without a second person seeing it. In 1.7, bank details entered when a worker is added one at a time (or by any import after setup) are held as a pending `bank_detail_changes` request and the worker keeps `needs_pay_details` until a second approver confirms; `create_worker` stops writing `workers.bank_*` directly for those paths. Staff IDs already can't be changed or reused (1.3), so a new row can't take over an existing worker's ID. **Owner to confirm:** whether the first bulk import at onboarding may stay single-approver. Until the owner confirms, every path holds them, setup finished or not: Add employee, the import (which creates each worker through `create_worker`), and direct database calls; signed-in users have no insert grant on the `workers` bank columns. If the owner allows the exception, it is limited to `commit_import_batch` during onboarding, run by the owner role, and recorded here.
- Approval checks the number (from the 1.7 review): the database has no key, so it can't check that a request's last four digits match its encrypted number. On approval the server decrypts the request and refuses a mismatch, or a request that changes nothing, so the last four digits on the card and in the emails are the account that will be paid.
- Worker notices (from the 1.7 review): any people editor can change a worker's email alone, so the approved and applied emails also go to every address the worker record held from 90 days before the request (from the audit log). An applied email that fails is retried by the next sweep for 7 days.

**Accept:** a change by user A stays pending until user B approves, then applies 72 hours later and appears masked on the worker; A approving their own request is refused by the database, not just the UI; security-reviewer has no high findings.

### 1.8 Import flow (CSV and Excel)
- Migration: `import_batches` (file_path, status uploaded/validated/committed/cancelled, counts, committed_at) and `import_rows` (batch_id, row_number, raw jsonb, normalised jsonb, errors jsonb, status ready/held/fixed/imported, worker_id null).
- Upload on Setup step 5 and from `/app/people/import`: "Download template (.csv)", upload CSV or .xlsx to private Storage `imports/{organisation_id}/{batch_id}.{csv,xlsx}`, validate with 1.4, store every row. Raw rows containing NIN, bank or RSA PIN are stored encrypted or stripped after normalising.
- Review screen: Rows · Ready · Need fixing counts, the found summary, a list of held-back rows with the problem and a one-click fix where 1.4 suggested one ("Set to Kola Adebayo", "Match to Coastline Logistics"), a preview table of ready rows, and "Download problems (.csv)".
- Commit "Import N employees": one transaction creates departments, unknown clients/sites/projects as name-only records ("New names become new clients you can finish later"), workers, first pay rates and assignments; held rows stay in the batch to fix and import later. Re-running a committed batch does nothing (idempotent on batch id and staff ID).
- Owner, admin and hr only. Audit one row per batch plus one per created worker.
- Playwright: upload `fixtures/people-import-162.csv`, see 4 listed with reasons (row 88 pre-fixed for supervisor clock-in), fix 1 more, import 160, then fix and import the rest.

**Accept:** the 162-row file imports with the 4 bad rows held back and explained; the People list shows the imported workers mapped; e2e passes.

### 1.9 Worker invites and PIN sign-in
- Migration: `worker_invites` (worker_id, token_hash, expires_at, used_at, sent_via email/print), `worker_credentials` (worker_id, auth_user_id, pin_hash, failed_attempts, locked_until, pin_set_at).
- Invite from the worker page, in bulk after import, or as a printable sheet of QR codes and links per site (for workers without email). Email invite via `send.ts` where the worker has an email. No SMS.
- `/m/invite/[token]`: confirm name and staff ID, set a PIN, consent notice. Creates the Supabase Auth user for the worker (synthetic, non-deliverable login identity managed in `src/server/identity/`), a `memberships` row with role `worker` and `worker_id`, and marks the invite used. Tokens are single-use, hashed, and expire in 7 days.
- `/m/sign-in` (designed in 0.4): company code + staff ID + PIN. Server route verifies the PIN hash, then mints a Supabase session with the secret key on the server and sets the session cookies. PINs are 6 digits. Five failures lock for 15 minutes; attempts are rate-limited per IP and per worker; lockouts are audited. HR can reset a PIN (new invite).
- `src/proxy.ts`: `/m/*` (except sign-in and invite) needs a session; a worker session hitting `/app/*` is sent to `/m`. Role checked again server side.
- Tests: PIN hashing and lockout unit tests; Playwright at 390px: invite link → set PIN → sign out → sign in with company code, staff ID and PIN → wrong PIN five times locks.

**Accept:** an invited worker signs in on a phone-sized browser and on a real Android phone on the Vercel preview; a worker session cannot read another worker's row (RLS test); security-reviewer has no high findings.

### 1.10 Worker app shell and profile
- `/m` layout for the worker PWA: bottom nav Home · Clock · Leave · Payslips · Me, 390px first, web app manifest and icons so it can be added to the home screen (service worker and offline queue come in Phase 3).
- English only. All worker copy goes through one messages module so languages can be added later; the board's language picker is hidden.
- Home per the WkHome board: "Hello, Musa", today's shift card shows "No shift today" until rosters exist, tiles for My shifts, Leave, Payslips, Help as placeholders, and the line "Your location is used only while you are clocked in."
- Me per the WkProfile board, Profile tab: Work (department, line manager, site, project, start date and type), Pay and pension (bank masked, pension masked, tax state, rent declared), Identity and contact (NIN on file or missing, phone masked, next of kin). Queries tab is shown disabled until Phase 4.
- "Request a change": bank details go through 1.7 with the copy from the board; other fields create a request HR sees on the worker page.
- All reads use the worker's own session (publishable key + RLS), never the secret key.

**Accept:** a signed-in worker sees their own profile with masked values at 390px, raises a bank change that appears in HR approvals, and cannot load any other worker's data.

## Open questions for the owner

- Backdated pay changes (from the 1.3 review): 1.3 refuses a new pay version that starts before today once the worker has a rate, so a raise effective from the start of the current pay cycle (20th to 19th) can't be recorded after that day, even though the cycle's payroll hasn't run. Should arrears or backdated raises be allowed back to the start of the earliest unposted pay period (wired up when payroll lands)? Versions already in force stay unchangeable either way.
- PIN lockout limits (from the 1.9 review): decision 6 (5 wrong tries lock for 15 minutes) is built as stated, plus a cap of 100 tries per network address per 15 minutes. The lock never escalates, which leaves two gaps. Anyone who knows the printed company code and a staff ID (often sequential) can keep that worker locked out by sending 5 tries every 15 minutes, so a few addresses could lock a whole site at shift start. In the other direction, a guesser spread over many addresses gets about 480 tries per worker per day; across 1,000 workers that is roughly a 40% daily chance of getting into some account. Options: (a) a daily cap per worker after repeated lockouts (for example, locked until HR resets the PIN after 3 lockouts in 24 hours), (b) a manager "unlock" action on the worker page, (c) a cap on tries per company per window, (d) a longer PIN. None is built until you choose.
- Staff ID typos (from the 1.3 review): a staff ID can't be changed once saved, so a mistyped ID is fixed by ending that record and adding the worker again. Confirm, or ask for an audited correction flow with a second approver.

## Phase 1 done when
- `fixtures/people-import-162.csv` imports with its 4 bad rows held back and each one explained, in CI (Playwright) and on the Vercel preview.
- An invited worker signs in on a phone with company code, staff ID and PIN, and sees their own profile.
- Isolation test covers every Phase 1 table; bank-detail changes provably need a second approver.

## Decisions (owner, 16 Nov 2026)

1. Clients, sites and projects: name-only tables in 1.3; Phase 2 and 8 extend them.
2. Staff ID: keep the company's IDs from the file; generate only where blank.
3. Line managers: a worker or a manager-app user who is not a worker.
4. Worker auth: one Supabase Auth user per worker with a synthetic login identity; the server opens the session after the PIN check.
5. Invites: email where the worker has one, otherwise a printable QR and link sheet. Managers notified by email. No SMS or WhatsApp.
6. PIN: 6 digits; 5 wrong tries lock the account for 15 minutes.
7. Unmasked personal data: owner and hr see all; finance sees bank account numbers only; everyone else sees masked values. Every reveal is audited.
8. NIN shows "On file" or "Missing" (11-digit format check), never "Verified".
9. Bank changes: two-person approval, then a 72-hour hold before a payroll bank file includes the new account.
10. Pay day: monthly only, configurable cycle start day (1–28) and pay day (1–31).
11. Paystack dropped; Flutterwave and bank transfer only. Superseded 16 Nov 2026: the company's own bank account only.
12. Plans: record the chosen plan and headcount; no prices or limits shown until pricing is final.
13. Import accepts CSV and Excel (.xlsx).
14. Rows missing pay or bank details import with a "needs pay details before payroll" flag.
15. Duplicate phone numbers import and are marked for supervisor clock-in.
16. Worker app is English only; copy goes through a messages module; the language picker is hidden.
