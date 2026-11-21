# Phase 3: rosters and PWA attendance (about 3 weeks)

Goal: the people a contract needs are rostered, and they clock in from a cheap phone, even with no data. Phase 2's posts and dated roster requirements (`required_shifts(org, from, to)`) become a roster grid per site and week; publishing it tells each worker their shifts; workers clock in and out through the installable worker app, offline if they must, with the location checked against the site's geofence on the server; supervisors clock in a crew that has no phones; managers watch it live. Phase 4 turns these punches into timesheets and Work Units.

Started 20 Nov 2026 ("Fire On"), from a `main` with all of Phase 2 merged (signed off 20 Nov). The screens follow the prototype boards `Roster.dc.html` (Required/Scheduled per post and day, Uncovered chips, the uncovered tray), `Attendance.dc.html` (tiles, list, By site), `WkHome.dc.html` and `WkClock.dc.html` (today's shift, clock-in with location and selfie, offline banner) and `WkShifts.dc.html`.

Parts of those boards that are superseded:
- "Notified by push / by SMS": rule 8 (email and the in-app inbox only).
- The WhatsApp button on the live board: Call only (owner decision 5).
- The worker app's language picker: English only for now (Phase 1 owner decision 16).
- The Payslips tile stays a "coming soon" page until Phase 5.
- Roster cost, billable and labour % columns: Phase 4/7 (owner decision 6).

Builds on: `posts`, `roster_requirements`, `required_shifts` (62-day cap), `private.site_geofence_check` (inside, near, outside), `site_checkpoints`, `workers.supervisor_clock_in`, `worker_credentials.privacy_notice_accepted_at`. The worker routes live in `src/app/m` (Clock and My shifts are "coming soon" pages until 3.3 and 3.5). Serwist and Dexie are not installed yet; Next 16's guide points at Serwist's Turbopack example (`node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md`).

## Rules that apply to every slice here (as in Phases 1 and 2)

- Every new table has `organisation_id uuid not null`, RLS through `private.user_org_ids()` / `private.has_role()` (both use `private.session_uid()`, so an untrusted password session reads and writes nothing), composite `(organisation_id, id)` foreign keys, and an entry in `tests/rls/tables/` for the isolation registry.
- Every mutation goes through `mutate()`. Multi-row writes are SQL functions (private security definer behind a public invoker wrapper, `search_path ''`, grants revoked from public and anon), each one transaction, audited with `log_audit` events as well as the row triggers.
- **Punches are append-only** (rule 4): insert-only, no update or delete grants, guards for every role and the database owner. A correction is a new row with a reason and an actor.
- **Time comes from the server.** A punch carries the device's clock and the device's elapsed time since the event; the server works out `recorded_at` from its own clock. Late syncs and clock drift are flagged, never trusted.
- **Location and selfies only with recorded consent** (rule 9). A worker who declines is clocked in by their supervisor (owner decision 8). Location is read only during a clock-in, never tracked.
- Photos go in a private bucket under `{organisation_id}/...`, are read by signed URL (60 s), are checked by their magic bytes, and are deleted after 90 days unless under review (owner decision 2).
- Email only through `src/server/email/send.ts`, plus the in-app inbox (rule 8). Resend Free sends 100 emails a day, so roster emails are batched.
- Code lives in `src/server/workforce/` (rosters, punches, attendance) and `src/app/m` (the worker app). Each slice has its own timestamped migration in its own range. Merge `main` in and regenerate `src/types/db.ts` before the PR. Merge main INTO branches; never rebase or force-push.
- Corners are 12px everywhere a person sees an edge; screens work at 390px and 1440px.
- A page belongs to a module (slice 3.0): Roster and Live attendance to **Shifts**, so a company with Shifts off never sees them, and the worker app hides Clock and My shifts.

## Owner decisions (20 Nov 2026)

The owner said "Fire On" and approved merging every Phase 3 PR after reviews and the labelled full CI run. No changes to the draft, so all eight recommendations apply:

1. **Selfie at clock-in only**, not at clock-out.
2. **Selfies are deleted after 90 days** unless the punch is under review.
3. **Late after 10 minutes, no-show after 60 minutes**, as organisation settings (`late_grace_minutes`, `no_show_after_minutes`).
4. **Crew clock-in by worker-supervisors** (the line manager of the crew) in the worker app, plus `line_manager` logins.
5. **Live board: Call only** (a `tel:` link). No WhatsApp.
6. **Roster cost, billable and labour %** are deferred to Phase 4/7.
7. **Patrol QR scans are in Phase 3** (slice 3.8).
8. **A worker who declines consent** is clocked in by their supervisor.

Also: Supabase Pro is needed before the first pilot (selfie storage).

9. **Freelancers and sole proprietors** (owner request, 20 Nov 2026): the landing page says Metalira Ops is also open to freelancers and sole proprietors, with its own `/for/freelancers` page. Slice 3.0 adds the business type and module switches that make the product fit them.

## Lira groundwork (every slice)

As in Phase 2 (docs/LIRA.md): every new Server Action is registered in `src/server/capabilities/registry.ts` (`tests/unit/capabilities/registry.test.ts` holds the line); each area's main reads get a compact summary; every write that changes several rows or money has a preview, used by the screen's confirm step; new server paths set the audit channel (`worker_app` for the worker app's punches); each slice adds 5–10 manager requests with expected outcomes to `fixtures/lira/<area>.md`. No AI calls and no API keys.

## Roles

| Thing | Read | Write |
| --- | --- | --- |
| Module switches, business type | every member (the company row) | owner, admin, through `set_company_modules` / `set_company_business_type` |
| Shifts, assignments, publications | owner, admin, hr, finance, ops_manager, line_manager (their crews); a worker reads their own published shifts | owner, admin, ops_manager (line_manager assigns within their crews in Phase 4) |
| Punches | owner, admin, hr, ops_manager, line_manager (their crews); a worker reads their own | the worker through `record_punch` (as themselves, organisation from the session); a worker-supervisor for their crew (3.6) |
| Consents | owner, admin, hr; the worker their own | the worker (insert-only) |
| Attendance settings | every manager | owner, admin |

## Slices (one pull request each)

### 3.0 Business type, module switches and landing for freelancers (independent)
- Migration `20261120100000_business_type_modules.sql`: `organisations.business_type` (`workforce` or `services`, default `workforce`), `shifts_enabled`, `people_enabled`, `payroll_enabled` (default true), with checks that payroll needs people and shifts need people. Existing companies stay workforce with everything on. Industries add `digital_services` and `professional_services`.
- `set_company_modules(org, shifts, people, payroll)`: owner or admin in a trusted session, audited, refuses payroll or shifts without people (`MLMO1`, `MLMO2`). Turning a module off never deletes data. A hook for Phase 3: refuse turning shifts off while future published shifts exist (`MLMO3`).
- Setup step 2 asks "What does your business do?": "We run staff at client sites" (workforce) or "We deliver services or projects to clients" (services). Services starts with all three modules off and skips the Employees step and the pay fields.
- `NavItem.module`; `navForRole(role, modules)`; pages in a switched-off module show "This part is switched off" (owners and admins get a link to Settings > Company > Modules). The worker app hides clock-in when Shifts is off. Home's copy never points at a switched-off part.
- Settings > Company > Modules: three switches with one sentence each and a confirm step when turning one off.
- Landing: a section saying Metalira Ops is also open to freelancers and sole proprietors, and a `/for/freelancers` role page (clients, contracts, rate cards, invoices with WHT and VAT, bank-statement matching). No prices.

- **As built (3.0):**
  - Migration `20261120100000_business_type_modules.sql`. The four columns are not granted for direct update (and are explicitly revoked), so no role, owner and admin included, can skip the functions through the Data API; the `organisations_update` policy already limits the granted columns to owner and admin. Check constraints `organisations_payroll_needs_people` and `organisations_shifts_need_people` hold even for the database owner.
  - `set_company_modules(org, shifts, people, payroll)` returns `{shifts_enabled, people_enabled, payroll_enabled, changed}`; the same values again change nothing and write no audit row. Each change is audited as `company.modules_changed` (before and after) plus the row trigger. Refusals: `42501` (not owner or admin, untrusted session, another company), `22023`, `MLMO1`, `MLMO2`.
  - `set_company_business_type(org, type)` (owner or admin, audited `company.business_type_set`): while setup is unfinished a change of type also sets the switches to the type's defaults (services all off, workforce all on); after setup only the type changes and the owner uses the Modules switches. The Business details form saves the other fields first and calls it last, so a refused save never changes the type or the switches (security review L3); a services business's form has no pay fields, and the saved pay days stay.
  - **Shifts guard:** `private.assert_shifts_can_be_switched_off(org)` is called whenever shifts go from on to off (also by a setup change to services). Once 3.2 merged, migration `20261120170000_shifts_switch_guard.sql` filled it: it refuses (`MLMO3`) while the company has `shift_assignments` with status `assigned` on or after its own today (`private.org_today`), naming the count and the first date ("2 assigned shifts are still on the roster from 24 Nov 2026. Remove them before turning Shifts off."). Past and removed assignments never block. The roster actions (assign, remove, copy last week) carry `module: "shifts"`.
  - Pure `src/lib/modules.ts` (business types, `MODULES`, `defaultModules`, `modulesProblem`, `describeModulesChange`) and `src/lib/company.ts` (`setupStepsFor`, `hasSetupStep`, `setupTotal`; `nextSetupStep`, `previousSetupStep`, `setupDoneCount` and `resumeSetupSlug` take the business type). A services wizard is Plan, Business details, Invoices and payments, Clients and contracts, Ready ("N of 4 done"); Continue on Clients finishes setup ("Finish setup"); `/app/setup/employees` sends a services company back to its step. The stored `setup_step` numbers are unchanged.
  - Navigation: `NavItem.module` (Roster and Live attendance: shifts; People, My team, Leave and Timesheets: people; Payroll run: payroll); `navForRole(role, modules)`; `moduleForHref`, `pageAccess` (`allow`, `forbidden`, `switched_off`; the role is checked first, so a role that could never open a page still goes to no-access); `canAccessHref(role, path, modules?)`. `RouteGate` renders `SwitchedOffPage` in place of a page in a switched-off module (pages below a module's item, such as `/app/people/[id]/edit` and `/app/people/import`, included). Home's description and empty state come from `homeCopy(modules)`; Ready offers "Add your clients" instead of "Add your people" when People is off.
  - Worker app: the worker session carries `shiftsEnabled`; with Shifts off the bottom nav drops Clock (four items), Home drops "Your shift today" and the My shifts tile, and `/m/clock` and `/m/shifts` say the company doesn't use clock-in or shifts.
  - `MutationSpec.module` (security review L1): `mutate()` refuses a change tagged with a module the company has off ("This part is switched off", `assertModuleOn`, read under RLS as the caller). Every People action is tagged `people` (workers, pay rates, mapping, the import, bank-detail and staff ID changes, change requests, sign-in unlocks, worker invites); there are no Leave, Payroll or roster actions yet, and each new one must carry its module. A product switch only: the Data API stays governed by RLS, unchanged. Enforcing Shifts on punches is slice 3.5 (L2).
  - Two audit rows per change on purpose (L4): the generic `organisations` row change and the named event; the migration header says why.
  - Settings > Company > Modules (`#modules`): three checkboxes, a live "Payroll needs People" message, and a confirm step ("Turns off 1 part: Shifts. Their pages leave the menu and nothing is deleted…") required by the server (`confirmed=yes`) whenever a part goes off.
  - Landing: section `#freelancers` ("Also open to freelancers and sole proprietors") linking `/for/freelancers`, a new role page in `src/components/marketing/roles.ts` with its own closing line ("Bring your client list. Leave with your first invoice.") and Lira line, listed in the sitemap, header menu and footer. New illustration slot `role-freelancer` (DESIGN_SYSTEM slot table): a freelancer holding up an invoice, a naira sign in a speech bubble as the one accent.
  - Capability `company.set_modules` (write, one row, preview `previewSetModules`, `agent: true`); `company.save_business` and `setup.continue_from_clients` descriptions updated. `fixtures/lira/modules.md`.
  - Tests: unit (nav filtering by module, `pageAccess`, Home copy, setup step skipping, the business schema and the mutations, the worker nav), database (`tests/rls/modules.test.ts`: role checks, untrusted session, cross-company refused, the two checks, direct updates refused for every role, the business type during and after setup, grants), Playwright (`tests/e2e/modules.spec.ts`: a services sign-up skips Employees and has no Roster or Payroll; turning Shifts off hides Roster and shows the switched-off page by URL; `landing.spec.ts`: `/for/freelancers` at 390px and 1440px).

**Accept:** a new company that chooses "We deliver services or projects to clients" finishes setup in four steps and never sees Roster, People or Payroll; an owner turns Shifts off and Roster leaves the menu and shows "This part is switched off" by URL, with nothing deleted; a manager can't change the switches.

### 3.1 Shared pieces
- `session_trusted` evaluated once per statement, with a benchmark on a 100k-row table (carried forward from Phase 1).
- `worker_consents` (location, selfie; notice version; accepted or withdrawn; insert-only).
- Worker `inbox_items` and a `/m` inbox.
- Organisation attendance settings: `late_grace_minutes` (10), `no_show_after_minutes` (60) (owner decision 3).

### 3.2 Roster grid
- `shifts` (one per post and day, made the first time someone is assigned), `shift_assignments` (worker, `starts_at`/`ends_at` copied, GiST exclusion so nobody is double-booked, status assigned or removed, never deleted), `roster_publications`.
- `/app/roster` per site per week: Required and Scheduled per day, Uncovered chips, assign and unassign, Copy last week, and the Uncovered tray with rule-based suggestions (mapped to the site, free, under the weekly standard hours; flags only).
- Refuses ended workers, closed posts and archived sites. Fills the 3.0 hook once published shifts exist (with 3.3).

### 3.3 Publish
- Publish and republish per site and week; changed-since-publish markers; only the workers affected are notified, by email (batched for Resend Free's 100 a day) and the inbox.
- `/m/shifts` and the worker home's "Your shift today".

### 3.4 PWA shell
- Serwist (Turbopack), app-shell caching for `/m`, the Dexie punch queue, an offline banner, sync on reconnect, the install prompt. Playwright offline test.

### 3.5 Clock-in and clock-out
- `punches`: insert-only; `client_event_id` unique per organisation; `device_time`; `recorded_at` corrected on the server from the device's elapsed time; location, accuracy, `geofence_result`; `outside_reason`; `selfie_path`; source `self` or `supervisor`; flags `outside`, `near`, `clock_drift`, `late_sync`, `no_selfie`, `by_supervisor`.
- `record_punch` SQL function as the caller, organisation from the session. The consent screen comes first.
- Private `punch-photos` bucket (about 35 KB WebP, magic-byte check, 90-day retention sweep).
- Replaces `private.worker_has_work_records` with a real punches check. Security review.
- As built (migration `20261120190000_punches.sql`):
  - `punches` is unique on (organisation, worker, `client_event_id`) (3.4 review: a duplicate id counts only for the same worker). `record_punch` takes the worker and company from the caller's own worker membership; the queue owner the phone sends is only compared (`MLPU9`, `wrong_session`, the item stays queued). Refusals `MLPU1`-`MLPU9` (`src/lib/punches/codes.ts`), mapped to the queue's fixed codes.
  - Time: `recorded_at` = received - elapsed (monotonic, same page session; `time_source` `elapsed`), else received - (sent - device) (`offset`), else the phone's clock clamped to [received - 7 days, received] (`device`, flagged `time_unverified`). `clock_drift_seconds` = device - recorded. Pure SQL (`private.punch_corrected_time`, `private.punch_flags`) mirrored in `src/lib/punches/time.ts` and `flags.ts`; the RLS suite checks they agree.
  - Flags: `outside`, `near`, `no_location`, `no_shift`, `late`, `early_out`, `no_selfie`, `clock_drift` (over 5 minutes), `delayed` (received over 5 minutes after the time it claims; a delayed clock-in is also `late` when it arrived after the grace period, security review M1), `late_sync` (over 2 hours), plus `time_unverified`, `double_in` and `out_without_in` (sequencing, 20-hour window). `by_supervisor` is `source = 'supervisor'` (3.6), not a flag. Late and early out use the company's grace minutes.
  - Shift: the assigned assignment whose window (start - 2 h to end + 4 h) holds `recorded_at`, nearest start first; a clock-out takes its open clock-in's assignment. Published-only matching waits for 3.3's publication rows. No match: recorded, `no_shift`.
  - Site: the shift's; else one the worker is mapped to or rostered at (`MLPU7` otherwise, another company's included); else, for a clock-out, the clock-in's. Geofence by `private.site_geofence_check` with the session's company; `distance_m` from the centre.
  - Refused: no location consent (`MLPU6`), Shifts off (`MLPU4`, 3.0 review L2), a leaver (`MLPU3`), over 20 punches an hour (`MLPU8`), bad values or a note with a web address or a 10-digit run (`MLPU5`). Without selfie consent a clock-in is recorded with `no_selfie`.
  - Location (rule 9): `location` is not granted to anyone; owner and admin read coordinates through `punch_locations` (audited `punch.location_viewed`); everyone who reads punches sees the result, distance and accuracy. The punches audit trigger leaves the point out.
  - Selfies: the server checks the bytes and uploads with the secret key, then `attach_punch_selfie` (secret key only) checks actor, path, size and type. No storage insert/update/delete for signed-in users. Read by owner, admin, ops_manager, hr (as the selfie notice says) and the line manager (60-second signed URLs, `punchSelfieLinkAction`). Uploads: 30 an hour per login and refused with Shifts off (`begin_punch_selfie_upload`); attach re-checks selfie consent; the audit actor of an attach is the worker (`metalira.audit_actor`). Daily `/api/cron/punch-photos` (one `clear_punch_selfies` call per chunk) deletes selfies after 90 days unless `private.punch_under_review` (false until Phase 4's review table replaces it) and uploads no punch kept.
  - Worker app: `/m/clock` (consent first, location 20 s, distance preview, reason chips, selfie with the oval, camera-app fallback, done screen watching the queue) and the round Clock in / Clock out button with "Your shift today" on home (`public.my_clock_context`).

### 3.6 Supervisor crew clock-in (`/m`)
- Worker-supervisors (the line manager of the crew) on shift at the site: a checklist, mark present, an optional group photo (missing is flagged); each punch `by_supervisor`. Security review.
- As built (migration `20261120230000_crew_punches.sql`):
  - Supervisors: a worker login whose worker record is `line_manager_worker_id` of the crew, on shift at the site (assignment window start - 2 h to end + 4 h); or a `line_manager` login for `private.my_reportee_ids()` (on shift too when linked to a worker record; a line manager with no worker record can't be rostered, so only the crew's shifts are checked). `private.my_crew_ids()` is the set helper.
  - `crew_punch_batches` (insert-only; only the group photo path is set once and cleared once) and `punches.crew_batch_id` (null exactly when `source = 'self'`). `record_crew_punch` (definer, as the caller, `search_path ''`): company and supervisor from the session, the queue owner (company, actor = worker record or membership) only compared (`MLPU9`); each worker in the crew (`MLCR1`), not ended (`MLPU3`), on a shift at that site now (`MLCR3`); supervisor on shift (`MLCR2`); Shifts off `MLPU4`; untrusted session `42501`. All or nothing; idempotent on (company, supervisor login, `client_batch_id`); `client_event_id` stays unique per worker. 30 batches an hour per supervisor, 20 punches an hour per worker. Audited: row triggers plus `crew.clocked_in` / `crew.clocked_out`.
  - Flags reuse 3.5's: no group photo is `no_selfie`, no supervisor location is `no_location`. The supervisor's own location is optional, needs their own location consent (`MLPU6`), and only the geofence result, distance and accuracy are kept, never the point.
  - Group photo (rule 9): offered and accepted only when everyone in the batch agreed to photos (re-checked at attach). Same bucket and path shape as selfies, `begin_punch_selfie_upload` with a punch of the batch, `attach_crew_photo` (secret key), read by owner, admin, ops_manager and hr; `crew_photos_due` / `clear_crew_photos` in the daily sweep; `punch_photo_orphans` skips crew photos.
  - `/m/crew` (route group `(crew)`, its own queue owner) with a "Clock in crew" card on worker home for supervisors. Line managers open `/m/crew` from the manager login. Queue kinds `crew_in` / `crew_out`, one item per batch.
  - Capabilities `crew.record_punch`, `crew.upload_photo` (worker app, not for the agent) and `attendance.crew_summary` (read). `fixtures/lira/crew.md`.

### 3.7 Live board `/app/attendance`
- Tiles: On site, Late, No-show, Starting in 2 h, Clocked out; the list; By site with the last sync; Call (`tel:`); Send replacement (opens the tray). Worked out on read and polled every 30 s; no cron.
- As built (migration `20261120210000_attendance_board.sql`):
  - `public.attendance_board(org)`: invoker wrapper over a private definer (`search_path ''`), one statement per poll: assignments in the window by `(organisation_id, starts_at)`, their punches by the new `punches_org_assignment_idx`, each site's last sync by `(organisation_id, recorded_at)`. Window: assigned shifts (not cancelled) that end after the company's midnight and start within 2 hours. Nothing while Shifts is off.
  - Roles: owner, admin, hr, ops_manager every row; a line manager their reportees' rows only (their crews); finance, other companies and untrusted sessions get 42501. The nav item gains hr to match the access table. The phone comes back in full only to roles that read it on the people record (all board roles today); the last four digits always, for masking.
  - Status (`private.attendance_status`, mirrored in `src/lib/attendance-board.ts`): latest punch out = clocked out; latest punch in = on site (with "N min late" when the clock-in was after the grace); no clock-in = starting (before the start or within the grace), late (after the grace), no-show (after `no_show_after_minutes`, or once the shift ended). Boundaries as the punches' late flag: exactly at the grace is on time.
  - Screen: tiles filter the list (worker, site · post, shift, last punch, status, flags incl. `delayed`, "By supervisor" and "Not published"), search by name, staff ID or post, a site filter, By site (rostered now, on site, late, no-show, last sync, punches sent late today). Call (`tel:`) and Send replacement on late and no-show rows; Send replacement only for roster editors. Cards below `md`, a table above. Polls by `attendanceBoardAction` every 30 s while the tab is visible.
  - Send replacement opens `/app/roster?site&week&post&date&replace`: "Remove from shift" prefilled "No-show" for that worker, then the assign picker for the same post-day (or the picker at once if the place is open). Past days can't change (MLRS6).
  - Capability `attendance.live_board` (read, `agent: true`, phones stripped for Lira); `fixtures/lira/attendance.md` requests 9 to 14.

### 3.8 QR checkpoint scans (patrols)
- The scan page follows the carried-forward rule below; scans are punches of kind `checkpoint`. Security review.

## Order and parallel work

```
3.0 business type and modules (independent)
3.1 shared pieces ──┐
3.2 roster grid ────┼── 3.3 publish
3.4 PWA shell ──────┴── 3.5 clock-in ──┬── 3.6 crew clock-in
                                       ├── 3.7 live board
                                       └── 3.8 patrol scans
```
Wave 1: 3.0, 3.1, 3.2, then 3.4 (at most three agents at once: 7.8 GB RAM). Wave 2: 3.3 off 3.2; 3.5 off 3.4 and 3.2. Wave 3: 3.6, 3.7 and 3.8 off 3.5. security-reviewer runs on 3.0, 3.1, 3.5, 3.6 and 3.8. No money-reviewer: there is no pay maths in Phase 3.

## Illustrations
- `roster-empty` (160) on an empty roster week and `all-covered` (160) when nothing is uncovered (3.2); `offline` (160) for the worker app's offline state (3.4). All three are already drawn.
- `role-freelancer` (160) on `/for/freelancers` (3.0, new).

## Phase 3 done when
- Offline punches sync later with server-corrected times, and outside-site punches arrive flagged (BUILD_PLAN). Proven in CI (database test and Playwright offline test) and on the Vercel preview.
- A published roster emails only the affected workers and shows on their phones.
- Every Phase 3 table is in the isolation test; punches can't be edited or deleted by anyone.
- Roster, clock-in, crew clock-in and the live board work at 390px and 1440px.
- Every Phase 3 Server Action is in the capability registry, and every multi-row write has a preview.

## Carried forward
From Phases 1 and 2, closed in this phase:
- The QR scan page reads the checkpoint token from the URL fragment and requires a signed-in worker assigned to the site; the organisation for `site_geofence_check` comes from the verified session only (3.8).
- Benchmark and restructure the RLS trust check (`session_trusted`) on large tables before punches arrive (3.1).
- Replace `private.worker_has_work_records` with a real punches check: `tests/rls/work-records-hook.test.ts` moves punches into `WORK_RECORD_TABLES` and assignments and consents into `NOT_WORK_RECORDS` (3.5).

Still open for later phases (from the Phase 2 sign-off): Phase 5 bank code in `worker_bank_details_as_of`; Phase 6 pricing from posts, requirements and Work Units, WHT per line, matching net of WHT and VAT, fixed-monthly billing from go-live; the low hardening follow-ups.

From 3.0: punches (3.5) and roster actions (3.2) carry `module: "shifts"` and `record_punch` refuses when Shifts is off (security review L2).
