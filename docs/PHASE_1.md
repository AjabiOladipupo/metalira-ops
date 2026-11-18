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

- Bank details on a new worker (recorded from the 1.3 review): one HR user could otherwise add a worker with their own account number and pay it without a second person seeing it. In 1.7, bank details entered when a worker is added one at a time (or by any import after setup) are held as a pending `bank_detail_changes` request and the worker keeps `needs_pay_details` until a second approver confirms; `create_worker` stops writing `workers.bank_*` directly for those paths. Staff IDs already can't be changed or reused (1.3), so a new row can't take over an existing worker's ID. **Owner confirmed 17 Nov 2026 (decision 20):** the first bulk import at onboarding may stay single-approver, built in 1.11: the owner's `commit_import_batch` while setup is unfinished writes bank details directly and audits each worker. Every other path holds them: Add employee, imports by admin or hr or after setup, and direct database calls; signed-in users have no insert grant on the `workers` bank columns.
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
- Me per the WkProfile board, Profile tab: Work (department, line manager, site, project, start date and type), Pay and pension (bank masked, pension masked, tax state, rent declared), Identity and contact (NIN on file or missing, phone masked, next of kin). Queries tab opens to an empty state until Phase 4.
- "Request a change": bank details go through 1.7 with the copy from the board; other fields create a request HR sees on the worker page.
- All reads use the worker's own session (publishable key + RLS), never the secret key.

**Accept:** a signed-in worker sees their own profile with masked values at 390px, raises a bank change that appears in HR approvals, and cannot load any other worker's data.

### 1.11 PIN lockout rules, staff ID correction, first import
Builds owner decisions 18, 19 and 20 (17 Nov 2026). Branches from 1.12, which gives a company its second manager.

- Migration `20261117180000_pin_lockout_staff_id.sql`:
  - `worker_credentials.held_at` (locked until a new PIN). `private.auth_throttle` gains `ipwrong:` and `company:<sha256 of the typed code>` keys and the columns `in_flight`, `capped_until`, `alert_pending`, `lockout_times` and `held_at`, so a company code and staff ID with no login is counted, locked and held like a real one. A partial index on `audit_log` for `worker_auth.locked` rows. `worker_sign_in_begin` is recreated with two new outcomes (`held`, `company_throttled`) and the columns `holds_on_failure`, `alert_organisation_id` and `begun_at`; `worker_sign_in_finish` is recreated to take `p_begun_at` and return the outcome (now also `held`) with `alert_organisation_id`; `accept_worker_invite` also clears `held_at`.
  - `public.unlock_worker_sign_in(org, worker)` (definer behind an invoker wrapper) for owner, admin, hr and the worker's line manager. `public.worker_sign_in_status(org, worker)` gives line managers only whether there is a login, the last sign-in and the lock; they get no access to `worker_credentials` itself.
  - `public.staff_id_corrections` (worker_id, old_staff_id, new_staff_id, reason, requested_by, status pending/approved/rejected/cancelled, approved_by, rejected_by, cancelled_by, decided_at, decision_note): the bank-change pattern of 1.7. Insert-only history (only the status moves, checked by trigger), check constraints `approved_by <> requested_by` and `rejected_by <> requested_by`, no delete. On approval the trigger writes `workers.staff_id` in the same transaction.
  - `private.worker_has_work_records(org, worker)`: the hook later phases replace. Phase 1 has no punches, timesheets or payslips tables, so it returns false; it fails closed (returns true) as soon as a table named `punches`, `timesheets`, `timesheet_lines`, `payroll_lines` or `payslips` exists and the function has not been replaced. `tests/rls/work-records-hook.test.ts` lists every public table with a `worker_id` column and fails until a new one is declared a work record (and handled in the hook) or not. A work-record table must reference `workers` by foreign key (or take the `staff_id:` advisory lock) so an insert can't race an approval.
  - A BEFORE INSERT trigger on `workers` refuses a staff ID that a correction retired or a pending one reserves, under the same per-company advisory lock as approvals.
  - `commit_import_batch` rewritten for decision 20 (below).
- Rules, PIN (decision 18, on top of decision 6):
  - 5 wrong tries in a row lock sign-in for 15 minutes (unchanged). The 3rd lockout within 24 hours holds the login until a new PIN is set from an HR invite. Lockouts are counted from `worker_auth.locked` audit rows since the later of 24 hours ago and the last PIN set. A lockout inside a 15-minute window in which the company code reached its cap doesn't count, so a flood can't push workers into holds. Capped windows are kept on the company code's own counter (`capped_until`, 24 hours), so real and unknown codes behave the same. Manager unlocks don't reset the count. The PIN stays 6 digits.
  - "Unlock sign-in" on the worker page lifts a 15-minute lock. Owner, admin, hr and the worker's line manager can use it; never on one's own login, never for a leaver. It is audited as `worker_auth.unlocked`. A held login can't be unlocked; the page points to a new invite instead.
  - Caps on wrong PINs (`src/lib/pin-lockout.ts`, checked against the migration by a unit test). Only wrong PINs count, and a success never gives one back, so a valid login can't be used to reset a counter. Each counter also holds the tries begun but not yet finished (`in_flight`): begin refuses when wrong PINs plus tries in flight reach the cap, and otherwise reserves a try under the counter's row lock; finish releases it (only while the counter is still in the window the try was reserved in, so a try finishing after the window rolls can't free a reservation of the new window) and, on a wrong PIN only, counts it. A burst of parallel tries can't get past a cap that way. For a real login the message shown comes from finish, which knows whether the window was capped meanwhile.
    - `COMPANY_WRONG_PIN_CAP = 50` per company code per 15 minutes. **Owner confirmed 18 Nov 2026; review after the pilots.** At the cap, new sign-ins for that company are refused before any PIN is checked, and those refusals count against no worker; workers already signed in keep working. The moment the 50th wrong PIN is counted, the window is marked capped on the company code's counter, audited as `worker_auth.company_throttled` for a real company, and the call that counted that wrong PIN (begin for an unknown ID, finish for a real login; the next attempt as a fallback) hands the alert to the server, which emails the company's owner and HR members (confirmed addresses, once per capped window). The email says how many minutes sign-ins are paused, that signed-in workers are unaffected and that nobody was locked out.
    - `IP_WRONG_PIN_CAP = 15` per network address per 15 minutes, well below the company cap, so one address can't use up a company's allowance or hold its workers on its own (at most 3 lockouts per window).
    - `IP_ATTEMPT_LIMIT = 100` tries of any kind per network address per 15 minutes (slice 1.9), now without a refund for successes.
  - Why 50: workers stay signed in on their phones, so sign-ins (and typos) are rare, and even a mass sign-in of a few hundred workers at shift change makes well under 50 wrong tries. Without the cap, an attacker spraying guesses across 500 staff IDs gets 2,500 guesses per 15 minutes (5 per ID). With it they get 50, at most 15 from any one address, and lockouts in a capped window don't move anyone towards a hold. The trade-off: a sustained attack from many addresses can keep new sign-ins for one company closed 15 minutes at a time. It locks nobody out for longer, the audit row and the email tell the owner, and the email goes once per window so inboxes aren't flooded. A slow attack that stays just under the caps from several addresses can still push a few workers into holds per window; when it does reach the cap, the owner is alerted.
  - Lock, hold and unknown-ID answers stay indistinguishable. Unknown IDs keep their own lockout times (a sliding 24-hour window like a real worker's), and their holds survive the quiet-day purge for 90 days.
  - The server records a failed try when the PIN check itself throws, so a lock set by `begin` is always audited and counted. The client address comes from `x-real-ip` only, never `x-forwarded-for`.
- Rules, staff ID (decision 19): owner, admin and hr raise a correction with a reason; a different owner, admin or hr approves or rejects it; the requester can withdraw it.
  - It is refused while the worker has any punches, timesheets or pay records (`worker_has_work_records`; pay rates are not pay records), for a worker who has left, for a case-only change, and for an ID that any worker in the company has or had, that a past correction retired, or that a pending one reserves.
  - Everything is checked again on approval, including that the worker's ID hasn't changed meanwhile.
  - Approvers (owner, admin, hr; not the requester or the worker) get an email when a correction is raised. On approval the worker is emailed their new staff ID, if their record has an email address (owner, 18 Nov 2026), and sees it on Me. Names and IDs that look like web addresses are left out of emails.
  - The generator for blank IDs and the import treat retired IDs as taken.
  - Refusals: SQLSTATE `MLSI1` (requester deciding), `MLSI2` (own record), `MLSI3` (ID used or reserved), `MLSI4` (already decided or edited), `MLSI5` (employee left), `MLSI6` (work records), `MLSI7` (ID changed meanwhile). Unlock refusals: `MLPN1` (held), `MLPN2` (not locked, no login, or employee left), `MLPN3` (own login).
- Rules, first import (decision 20): the owner's first `commit_import_batch` while `organisations.setup_completed_at` is null writes each new worker's bank details straight to the worker and logs `people.bank_details_single_approver` per worker. A definer helper does the write after re-checking the owner role, unfinished setup (under a row lock), that no other batch has used the exception, and that the worker was created in this transaction without bank details. Once a batch has used it, later batches keep the hold, even during setup. Admin or hr imports, imports after setup, Add employee and direct `create_worker` calls keep the two-person hold.
- Routes and screens:
  - `/app/people/[id]` gains a "Phone sign-in" section (status, lock or hold, Unlock, or a link to send a new invite) and staff ID correction under "Identity and contact" (form, pending card with approve, reject and withdraw, history).
  - Line managers may open `/app/people/[id]` for their own reportees only (404 otherwise). They see job, contact and sign-in, but no pay, bank, tax or next of kin, and the server loads only those columns for them.
  - `/app/people/approvals` also lists pending staff ID corrections for owner, admin and hr.
  - `/app/people/invites` shows "Locked until a new PIN".
  - Worker sign-in has messages for a hold and for the company cap.
  - The import review tells the owner during setup that bank details are saved without a second approver.
- Emails: `staff-id-correction-requested` (approvers), `staff-id-changed` (the worker), `sign-in-paused` (owner and HR, once per capped window).
- **Known gap (must close before Phase 4's My team):** `workers` has table-wide select for signed-in users, and the `workers_select` policy lets a line manager select their reportees' whole rows, bank, tax, next-of-kin and `_enc` columns included, straight through the API. The app no longer loads those columns for line managers, but the database still allows it. Fix: drop the line-manager branch from `workers_select` and give line managers a security-definer read that returns only safe columns (name, staff ID, job title, department, phone, sites, status), then move every line-manager read of `workers` onto it.
- Tests:
  - Unit: `tests/unit/identity/pin-lockout.test.ts` (counting, holds, caps, once-per-window alert, constants match the migration); `tests/unit/people/staff-id-correction.test.ts` (schema, retired IDs in the generator and the import); `tests/unit/email/slice-1-11-templates.test.tsx`.
  - RLS: `tests/rls/pin-lockout.test.ts` (lockout counting, hold, unlock roles, caps, no refunds); `tests/rls/staff-id-corrections.test.ts` (two-person rule, never-used rule, work-records hook, audit); `tests/rls/import-single-approver.test.ts` (owner's first import during setup vs a second import, hr, admin and after setup); `tests/rls/work-records-hook.test.ts`; isolation registry `tests/rls/tables/staff_id.ts`.
  - e2e: `tests/e2e/pin-unlock.spec.ts`, `tests/e2e/staff-id-correction.spec.ts`.

**Accept:** a worker locked three times in a day stays locked until a new PIN; a line manager unlocks a 15-minute lock from the worker page and the audit log shows it; 50 wrong PINs across a company stop further sign-ins for that company without locking any more workers, and the owner and HR get one email; HR corrects a staff ID, a second manager approves it, the worker sees the new ID and the old one can never be used again in that company; the owner's first import during setup needs no bank approvals and every other path still does; works at 390px and 1440px.

### 1.12 Team: invite managers
Added on owner request (17 Nov 2026): the two-person rule (bank-detail changes now, payroll release later) needs a second manager, and there was no way to add one to a company. Built before 1.11, which branches from it.

- Migration `20261117120000_team_invites.sql`: extends `membership_invites` (0.3) rather than adding a second invite table: `revoked_at`, `revoked_by`, `sent_at`; new invites carry one manager role (check, `not valid` for older rows); one pending invite per address. Invites are cancelled, never deleted (delete grant and policy dropped). Signed-in users lose direct update and delete on `memberships`: roles change and managers leave only through the SQL functions below, so the rules hold for every client. The 0.3 audit triggers log every row change (who, what, before, after).
- SQL functions (private definer behind public invoker wrappers): `create_membership_invite` (rewritten), `resend_membership_invite` (new token, 7 more days, old link stops working), `revoke_membership_invite`, `accept_membership_invite` (rewritten), `team_members` (managers with their sign-in email, owner and admin only), `change_member_role`, `remove_member`, and `membership_invite_lookup` (server secret key only, for the join page). Refusals carry SQLSTATEs `MLTM1`-`MLTM9`. Invite emails (create and resend) are capped at 50 per company and 20 per inviter in any 24 hours (`private.team_invite_sends`, `MLTM9`); only the owner can replace a pending admin invite.
- Routes: `/app/settings/team` (owner and admin; card on Settings) lists managers (name, email, role, joined) and pending invites (role, sent, expiry) with invite, change role, remove, resend and cancel. `/join/[token]`: the invited person signs in, or creates an account with the invited address (no company is created), then accepts. `/app/team` stays "My team" for line managers (Phase 4).
- Rules: owners and admins invite by email with one role: admin, hr, finance, ops_manager or line_manager. Only the owner grants admin, and only the owner changes, removes, resends or cancels for an admin. Nobody changes their own role or removes themselves. The owner can't be removed or demoted. Workers and client approvers are managed in People, never here; a login that is a worker in the company can't be invited or accept. Accepting needs the invited address, confirmed, matched without case; the inviter must still be allowed to grant the role. Handled on the join page: already a member, expired, used, cancelled, wrong account signed in.
- Emails (`src/server/email/team.ts`): the invite, and a notice to the member when their role changes or they are removed. Only when email is deliberately off (no Resend key outside production) does the inviter see the link to pass on; a failed send says to use Resend and never shows the link. Links use the configured app address. A company or person name that looks like a web address is left out of the email (generic wording) so invites can't carry branded phishing. Addresses are never logged.
- Sign-up confirmation (`supabase/templates/confirmation.html`) now links to `next={{ .Data.next_path }}`, a path the app parks in user metadata at sign-up (`/app` for owners, `/join/<token>` for invited managers, cleared on acceptance), still checked by `safeNextPath`, so an invited manager confirming their email lands back on the invite. **Owner action:** copy the template into the hosted project (Authentication > Emails). Until then they land on the no-access page, which tells them to open the invite link again.
- Tests: `tests/unit/team.test.ts` (only the owner grants admin, no own role change, owner protected, invite states, routes), `tests/unit/email/team-templates.test.tsx`, `tests/rls/team.test.ts` and `tests/rls/memberships.test.ts` (every rule in the database, audit rows, other companies refused), team functions in `tests/rls/isolation.test.ts`, and `tests/e2e/team-invites.spec.ts`.

**Accept:** the owner invites an HR user from Settings > Team, the HR user signs in from the link and accepts, then approves a bank-detail change the owner raised (the two-person rule with two real managers); an admin can't grant admin; nobody can change their own role; the owner can't be removed; every change has an audit row; works at 390px and 1440px.

### 1.13 Owners and safer invite sign-up
Added on owner request on 18 Nov 2026, after the Phase 1 sign-off. A company can have more than one owner and hand over ownership, and nobody picks another person's password: invited managers and new owners choose theirs only after confirming their email.

- Migration `20261118120000_owners.sql`:
  - `public.owner_changes` (kind add/invite/remove/demote, target_membership_id, target_user_id, invite_email, new_role, reason, requested_by, owners_at_request, single_owner, status pending/approved/rejected/cancelled, approved_by, rejected_by, cancelled_by, cancel_reason, decided_at): the two-person pattern of 1.7 and 1.11. Insert-only history: a BEFORE UPDATE trigger lets only a pending row move, once, and only its status and decision columns; no delete; a truncate trigger refuses truncation. Check constraints `approved_by <> requested_by` and `rejected_by <> requested_by`. A request and a decision are recorded under the caller's name (requested_by, approved_by, rejected_by, cancelled_by = `auth.uid()`); a withdrawal is the requester's, unless the database withdraws it (cancel_reason set) while applying a removal or demotion. Approvers and rejecters must be owners. One pending request per member and per invited address. Owners and admins read it; signed-in users and the secret key have no insert, update or delete grant. Audited by the row triggers.
  - `membership_invites.owner_change_id` references `owner_changes`: a pending invite carries a manager role, or role `owner` with the approved request it came from (check constraint). `membership_invite_lookup` gains `invited_at`.
  - SQL functions (private definer behind public invoker wrappers): `request_owner_change(org, kind, membership, email, new_role, reason)`, `decide_owner_change(org, change, approve/reject/cancel)`, `end_other_sessions()` (deletes the caller's other `auth.sessions`), `email_link_allowed(keys)` (secret key only; counts in `private.email_link_sends`). Helpers `owner_count`, `lock_owners`, `assert_owner`, `owner_change_check` (run on request and again on approval), `owner_change_apply`, `owner_invite_usable`, `password_trusted`.
  - Lock order everywhere: the organisation row (`lock_owners`, the lock `memberships_keep_owner` also takes), then memberships, then the invite or request row. Request, decide, resend and accept all follow it.
  - Triggers on `memberships`: role `owner` is refused for a worker record or a worker's login (every insert and update), and the secret key (`current_user = service_role`) can never make someone an owner or change or remove an owner row. Owner changes run inside the definer functions.
  - Recreated for several owners: `assert_team_manager` (message), `create_membership_invite` (replacing a pending admin or owner invite needs an owner), `resend_membership_invite` and `revoke_membership_invite` (owner invites: owners only; a resend keeps the owner who asked as inviter), `accept_membership_invite` (owner invites: request approved, the owner who asked and the approver still owners, refused once a single-owner invite has been overtaken by a second owner; every invite: the password rule below), `team_target` (owners change only through owner requests), `import_bank_details_single_approver` (decision 20 messages say "an owner").
  - Backfill: every account already confirmed when the migration runs gets `app_metadata.password_set_at = now()`, so existing managers keep signing in with their password. Worker logins (PIN, synthetic address) are left alone.
- Passwords (the root-cause fix from the security reviews):
  - A password counts only once it was chosen after the address was confirmed, from an email-link session: `app_metadata.password_set_at >= email_confirmed_at` (`password_trusted`, `passwordTrusted`). The server writes `password_set_at` with the secret key right after the user sets a password from an email link, ends the account's other sessions (`end_other_sessions`, error codes logged) and refreshes the session.
  - Password sign-in on `/sign-in` with a password that isn't trusted opens nothing: the session is signed out and an email link to choose a password is sent ("To keep your account safe, we sent a link…", `/check-email?sent=password`).
  - `/set-password` (new): after an email link, the manager chooses their password. A password session that isn't trusted is offered an email link instead. The proxy sends a manager session whose token has no `password_set_at` there before any `/app` page, after one session refresh.
  - `accept_membership_invite` refuses any account whose password isn't trusted (`MLPW1`), whenever the address was confirmed.
  - Access tokens last 15 minutes (`jwt_expiry = 900`), so a token from an ended session expires soon.
- Routes and screens:
  - `/app/settings/team`: owners see "Owner" in the invite role list, "Make owner" on a manager's row, "Ask to change" and "Ask to remove" on another owner's row, "Step down" on their own row (or "You are the only owner. To hand over, make someone else an owner, then step down."), and "Owner changes waiting for approval" with Approve and Reject for a different owner and Withdraw for the requester. Admins see the list but can't decide.
  - `/join/[token]`: signed out, a new person only asks for an email link (`signInWithOtp`, the address fixed by the invite, `next_path` in user metadata, `safeNextPath` on the way back), capped at 5 links an hour per invite and 20 per visitor address (`x-real-ip`). The link brings them back signed in; they type their own name (recommended default, pending owner confirmation; written to `profiles` with their own client) and choose a password ("Set password and join"), then accept. A password session that isn't trusted is sent to an email link. The invite link is still shown to the inviter only when email is deliberately off.
  - `/sign-up` (new company): name, company name and email first (no password), capped at 5 an hour per address; the email link signs them in, the company is created (`ensureOrganisationForNewUser`, unchanged) and `/set-password` comes before anything opens.
- Rules:
  - With exactly one owner, that owner alone makes an existing manager an owner, or invites someone as owner (`single_owner`, recorded and audited). With two or more owners, adding an owner, removing one and demoting one (stepping down included) is a pending request that a different owner approves or rejects; the requester may withdraw it. Approval checks everything again.
  - The last owner can never be removed or demoted (`MLOW1`; `memberships_keep_owner` still backs it for every writer). Nobody removes themselves; an owner steps down to a manager role only while another owner remains. Hand-over = make someone an owner, then step down.
  - When an owner is removed or demoted, their own pending owner-change requests and pending requests about them are withdrawn in the same transaction (status cancelled, cancel_reason, cancelled_by the owner who made the change; never deleted). Recommended default, pending owner confirmation.
  - An owner invite sent by a single owner can't be accepted or resent once the company has two or more owners (`MLOW6`): ask again, and another owner approves. Two single-owner invites accepted at once add one owner.
  - Workers (a worker membership or a worker's login) and client approvers never become owners.
  - Every 1.12 rule that said "the owner" now means "an owner": only owners grant admin and change, remove, resend or cancel for admins and owners; nobody changes their own role except an owner stepping down as above.
  - Every owner change, and every request, rejection and withdrawal, emails all owners with a confirmed address (and a removed or demoted owner); accepting an owner invite emails all owners. Invited addresses are never shown in these emails ("check the address in Team settings before approving"); names that look like web addresses or that an email would refuse fall back to generic wording (`emailDisplayName`). Addresses are never logged.
  - Refusals: `MLPW1` password not trusted, `MLOW1` last owner, `MLOW2` requester deciding, `MLOW3` not eligible, `MLOW4` already decided (or withdrawn), `MLOW5` out of date, `MLOW6` owner invite needs a fresh approval, `MLOW7` a request already waiting.
- Single-owner assumptions checked: `private.has_role(org, array['owner'])` already meant "one of the owners", so People, bank changes, staff ID corrections, the 1.11 unlock roles, company settings and setup checks needed no change. The cap alert already went to every owner and HR user (`SIGN_IN_ALERT_ROLES`); its wording now says so. Decision 20's single-approver first import is "an owner's first import": the exception is still used once per company, whichever owner imports. `organisations.created_by` records who created the company, not who owns it. Billing (Phase 9) reads "owners". Copy that said "the owner" now says "an owner".
- Not done: a per-query check of `auth.sessions` in `user_org_ids` (cost on every query); instead other sessions are deleted and access tokens last 15 minutes. A password signed in straight through the Auth API (not the app) still gets a token until the user chooses a password; the app pages and every invite acceptance refuse it.
- Emails: `owner-change` (requested, done, rejected, withdrawn, joined), keyed by change, event and recipient.
- Tests: `tests/unit/owners.test.ts` (rules, choices, messages, password trust, proxy), `tests/unit/auth-schemas.test.ts`, `tests/unit/email/owner-change.test.tsx`, `tests/rls/owners.test.ts` (one owner alone; with two or more, no single owner adds, removes or demotes an owner through the functions or PostgREST; approver a different owner; approver demoted first; last owner; step-down; withdrawn requests; resend keeps the inviter; concurrent approvals and acceptances; workers; secret key; `MLPW1` before and after the invite; `end_other_sessions`; other companies), `tests/rls/memberships.test.ts`, isolation registry `tests/rls/tables/owners.ts`, e2e `tests/e2e/owners.spec.ts`, `tests/e2e/password-trust.spec.ts`, `tests/e2e/auth.spec.ts` (owner sign-up through email link then password), `tests/e2e/team-invites.spec.ts`. Test helpers record `password_set_at` for the accounts they create and seed extra owners as the database owner.
- **Owner actions:** set Access token expiry to 900 seconds in the hosted project (Authentication > Sessions / JWT settings). Keep email sign-ups enabled. No new email template: the 1.12 "Confirm signup" template already links to `next={{ .Data.next_path }}`; if a new owner or invitee lands on the no-access page after confirming, copy `supabase/templates/confirmation.html` into Authentication > Emails.

**Accept:** the only owner invites a second owner; the second owner asks for a link, confirms, types their name, sets their password and accepts; the first owner asks to step down and stays owner until the second owner approves; with two owners, no single owner adds, removes or demotes an owner alone (the database refuses); the last owner can't be removed or demoted; a new owner signs up without a password and chooses it after the email link; a password set before the address was confirmed opens nothing; every change has an audit row and emails the owners; works at 390px and 1440px.

## Phase 1 done when
- `fixtures/people-import-162.csv` imports with its 4 bad rows held back and each one explained, in CI (Playwright) and on the Vercel preview.
- An invited worker signs in on a phone with company code, staff ID and PIN, and sees their own profile.
- Isolation test covers every Phase 1 table; bank-detail changes provably need a second approver.

## Sign-off (owner, 18 Nov 2026)

Phase 1 is signed off. Slices 1.1–1.10, 1.11 (PIN lockout rules, staff ID correction, first import) and 1.12 (team invites, added on owner request) are merged, each after review and with CI green.

Owner checks on production (ops.metaliratech.com):
- The 162-row import: 158 rows ready, 4 held back and explained.
- An invited worker signed in on a real Android phone with company code, staff ID and PIN, installed the app and saw their own profile. Pages felt faster after the Dublin region move, and the Queries tab opens.
- Emails arrived: worker invite, line manager change from Edit details, team invite (a second manager joined as HR), and a bank-detail change raised to the second approver and approved by them.

Carried forward:
- Known gap from 1.11: line managers can still read reportees' bank and tax columns through the API (masked or encrypted, never in clear). Close it before Phase 4's My team.
- Phase 5: bank-file generation and payroll release must decrypt each account number and refuse a last-4 mismatch, including details saved by the first-import exception. Consider refusing payroll release while setup is unfinished.
- Phases 3 and 4: replace `private.worker_has_work_records` when punch, timesheet or pay tables arrive (a test fails until each `worker_id` table is declared).

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

## Answered questions (owner, 17 Nov 2026)

These came out of the slice reviews. Each is built in the follow-up slice 1.11 (planned and approved before work starts), except backdated pay, which lands with payroll.

17. Backdated pay changes (1.3 review): allowed. A new pay version may start as far back as the start of the earliest pay period that has not been posted. Versions already used by a posted payroll stay unchangeable. Wired up when payroll lands (Phase 4); until then 1.3's "not before today" rule stays.
18. PIN lockout limits (1.9 review): add three protections on top of decision 6.
    - After 3 lockouts in 24 hours, the worker stays locked until HR resets their PIN.
    - A manager unlock action on the worker page, for owner, admin, hr and the worker's line manager, audited.
    - A cap on wrong tries per company per 15-minute window, so a whole site can't be locked or guessed at once.
    - The PIN stays 6 digits.
19. Staff ID typos (1.3 review): an audited correction flow. A staff ID can be corrected with a reason and a second approver, only while the worker has no punches, timesheets or pay records. The new ID must be unused and never-used in the company. The audit log keeps before and after.
20. First bulk import at onboarding (1.7 review): may stay single-approver, limited to `commit_import_batch` run by the owner role while company setup is unfinished. The exception is recorded in the audit log for each worker. Every other path (Add employee, imports after setup, direct calls) keeps the two-person hold.
