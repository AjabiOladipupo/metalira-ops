# Phase 4: timesheets, leave and line managers (about 2 weeks)

Goal: every punch becomes a timesheet day a manager can approve, and every approved day on a priced post becomes a billable Work Unit. Workers ask for leave on their phones; the line manager, then HR, approves it; approved leave takes the worker off their shifts so ops can fill them. Line managers get one page for their people: shifts, leave, timesheets and queries. Phase 5 pays from approved timesheet days and leave; Phase 6 bills from Work Units.

Planned 21 Nov 2026, from a `main` with Phase 3 slices 3.0 to 3.5 merged (3.6 to 3.8 may still be open; nothing here depends on them except the `by_supervisor` source, which Phase 4 reads from `punches.source`). The screens follow the prototype boards `Timesheets.dc.html` (the list of flagged days, the detail panel with clock in and out, distance, device vs server time, method, Approve, Adjust hours, Reject, "Approve 18 clean"), `Leave.dc.html` (HR view: tiles, Requests, Calendar, Policies), `Team.dc.html` (My team: Reportees, Leave requests, Queries; Assign a shift; New query with a reply-by date), `WkLeave.dc.html` (balances, ask for leave, "3 working days. Covers 3 rostered shifts") and `SupHome.dc.html` (the worker-supervisor's Approvals tile).

Parts of those boards that are superseded:
- The pay and bill rate line in the timesheet detail ("₦8,000 · ₦12,500 a shift"): no money on timesheets in Phase 4. Pay is Phase 5, billing Phase 6.
- "The system closed the shift at the rostered end" (Timesheets, no clock-out): decision 5. A missing clock-out counts no hours until the line manager fixes it.
- "Overtime ... the contract allows billing night overtime at 1.5×": overtime minutes are counted and shown; what they pay or bill is Phase 5 and 6.
- The Policies tab's sample rows ("Builds up 1.25 days a month; carry over up to 5 days", "Casual 3"): replaced by the two presets (decision 14) and the company's own types.
- "Doctor's note attached (PDF, 180 KB)" (Team): no leave attachments in Phase 4. The approver ticks "Certificate seen" (carried forward).
- "Deducted pro rata in payroll", "pays at the policy rate and shows on the payslip": Phase 5.
- Any SMS or push wording: rule 8 (email and the in-app inbox only).

Builds on: `punches` (flags `outside`, `near`, `no_location`, `no_shift`, `late`, `early_out`, `no_selfie`, `clock_drift`, `delayed`, `late_sync`, `time_unverified`, `double_in`, `out_without_in`; `source` self or supervisor; `recorded_at` server-corrected), `shifts`, `shift_assignments` (status assigned or removed, `removed_reason`), `roster_publications` and `publish_roster`, `inbox_items` and `notifyWorker` (`src/server/workforce/notify.ts`), `worker_consents`, `organisations.late_grace_minutes` (10) and `no_show_after_minutes` (60), `pay_cycle_start_day` (20), `standard_shift_minutes` (480), `private.org_today`, `private.punch_under_review` (a placeholder returning false), `private.worker_has_work_records` (fails closed once a table named `timesheets` or `timesheet_lines` exists), `private.my_reportee_ids`, `private.my_line_manager_keys`, `private.line_manager_site_ids`, `private.role_org_ids`.

## Rules that apply to every slice here (as in Phases 1 to 3)

- Every new table has `organisation_id uuid not null`, RLS written in the set-helper form from slice 3.1 (`organisation_id in (select private.role_org_ids(array[...]))`, `worker_id in (select private.my_worker_ids())`, `worker_id in (select private.my_reportee_ids())`; never a per-row `has_role` call, which `tests/rls/policy-speed.test.ts` refuses), composite `(organisation_id, id)` foreign keys, and an entry in `tests/rls/tables/` for the isolation registry.
- Every table with a `worker_id` is declared in `tests/rls/work-records-hook.test.ts`, and each work record gets a real check in `private.worker_has_work_records`.
- Every mutation goes through `mutate()` and carries its module (`people` for leave, queries and My team; `shifts` for timesheets and roster changes). Multi-row writes are SQL functions (private security definer behind a public invoker wrapper, `search_path ''`, grants revoked from public and anon), one transaction each, audited with `log_audit` events as well as the row triggers.
- **Insert-only records** (rule 4): timesheet corrections, timesheet decisions, leave decisions, the leave ledger, query replies. A change of mind is a new row with a reason and an actor. Status columns move only inside the SQL functions, never by direct update.
- **Hours and minutes are integers.** Leave is counted in whole days (integers). No money and no pay maths in this phase: a Phase 4 table holds no kobo column.
- **Time comes from the server**: timesheets use `punches.recorded_at` and the company's timezone (`private.org_today`, Africa/Lagos), never the phone's clock.
- Email only through `src/server/email/send.ts` and `notifyWorker`, inside its caps (Resend Free: 100 a day for the account; at most 30 per company and 80 overall in 24 hours). Past a cap the worker still gets the inbox item. No SMS or WhatsApp.
- Crons are daily (Vercel Hobby). Anything that must be fresher is worked out on read.
- Code lives in `src/server/workforce/` (timesheets, Work Units, leave meets roster), `src/server/people/` (leave, queries, HR file, team reads), `src/app/app/` and `src/app/m`. Each slice has its own timestamped migration. Merge `main` in and regenerate `src/types/db.ts` before the PR. Merge main INTO branches; never rebase or force-push.
- Corners are 12px everywhere a person sees an edge; screens work at 390px and 1440px.

## Owner decisions (20 Nov 2026)

The owner answered every Phase 4 question with "all recommended":

1. **Leave types are set by each company.** Any statutory figure shown carries "check with your adviser".
2. **Leave year:** the calendar year (1 Jan to 31 Dec); joiners get a prorated entitlement; no carry-over unless the company sets a cap per leave type.
3. **Whole working days only.** A request counts the worker's working days between the two dates, skipping their off-days and the company's public holidays (each company keeps its own holiday list).
4. **Lateness:** a clock-in within the grace period (`late_grace_minutes`) counts as a full shift from the rostered start; beyond grace, the actual minutes are counted and the day is flagged late.
5. **Missing clock-out:** the day is flagged and counts no hours until the line manager fixes it with a reason. The fix is a correction row (insert-only); the punches never change.
6. **Timesheets are approved by the line manager**, else by an ops_manager or admin (owner too, as always).
7. **The timesheet period follows the pay cycle** (20th of the previous month to the 19th), and approval is day by day.
8. **Approved leave removes the worker from their shifts** (the shifts go back to uncovered) and tells ops.
9. **Leave approval has two steps:** line manager, then HR.
10. **Queries** (disciplinary and HR queries) carry a reply-by date and are kept on the HR file.
11. **Close the Phase 1 gap before My team:** line managers can still read reportees' bank and tax columns through `workers_select`. Its own early slice (4.0) with a security review.
12. **Timesheet review replaces `private.punch_under_review`:** a punch is under review while its timesheet day is unapproved or disputed, so its selfie is kept past 90 days. Delayed, time_unverified and late_sync punches are highlighted for review.
13. **Deferred low from 3.3:** `roster_affected_workers` skips workers whose employment ended after the publication.

And the owner's standing rule for unclear legal rules (20 Nov 2026):

14. **Leave presets, side by side.** Build them as selectable presets in leave setup, values editable per company, each labelled with its source and "These are starting values, not legal advice. Confirm them with an adviser.", never presented as legal advice. Figures and sources: RULES_NIGERIA.md "Leave presets (Phase 4)".
    - **Owner decision, 21 Nov 2026 (after review, overrides the three-preset plan):** keep two presets, A and B. Preset C ("Public-service aligned") was dropped by the owner and is not built.

| Preset | Annual | Sick | Maternity | Paternity | Compassionate |
| --- | --- | --- | --- | --- | --- |
| A, "Labour Act minimum" | 6 working days after 12 months' service | up to 12 paid working days a year with a medical certificate | 12 weeks (6 before and 6 after confinement, s.54(1)(a)/(b)); at no less than 50% pay only after 6 months' continuous service (s.54(1)(c)) | none | none |
| B, "Common private-sector practice" | 15 working days | 12 working days | 12 weeks full pay | 5 working days | 3 working days |

### Choices made in this plan (recommended defaults; the owner can overturn any)

These fill gaps the answers above leave open. None is a Nigerian legal rule.

- **Maternity counts calendar days**, not working days: 12 weeks is 84 days, because the Act states weeks. Each leave type has `counting` = `working_days` (decision 3, the default) or `calendar_days`.
- **Proration for joiners:** entitlement × days from the start date to 31 Dec ÷ days in the year, rounded half up once to a whole day. A type with a minimum service (preset A's annual leave: 12 months) can't be requested before the worker reaches it.
- **A worker's working days:** a day with an assigned shift is a working day; a day without one is an off-day. Beyond the last rostered day, the worker's usual days (`workers.usual_work_days`, else the company's `default_work_days`, Mon to Fri) stand in, and the count is checked again at each approval.
- **Early clock-out:** actual minutes, flagged `early_out`. The grace period applies to lateness only (decision 4 says nothing about early leaving). Open question 1.
- **Overtime minutes:** minutes worked past the assigned shift's end (RULES_NIGERIA "Overtime"), counted and flagged `overtime`. No rounding or threshold in Phase 4; Phase 5 decides what is paid.
- **Who may approve:** the worker's line manager, and any ops_manager, admin or owner. A line manager never approves their own day or their own leave. HR reads timesheets but doesn't approve them.
- **Leave removes shifts at the final (HR) approval.** The line manager's step shows which shifts will open.
- **A worker can dispute a day** from the worker app ("This is wrong" with a reason); the day goes back to the approver and its punches stay under review.
- **Work Units:** one per approved timesheet day on a post (one person on one shift). Billable on `manned_post` and `per_visit` contracts; recorded but not billable on `fixed_monthly` and `per_job` (those are billed by month or job in Phase 6). Days with no shift (`no_shift` punches) make no Work Unit.
- **Ops is told by email** when leave opens shifts: one email per approval to the ops managers of the affected sites, inside the shared caps, plus the "On leave" chip on the roster. There is no manager inbox yet.

## Lira groundwork (every slice)

As in Phases 2 and 3 (docs/LIRA.md): every new Server Action is registered in `src/server/capabilities/registry.ts` (`tests/unit/capabilities/registry.test.ts` holds the line); each area's main reads get a compact summary; every write that changes several rows has a preview, used by the screen's confirm step (bulk approve, apply a preset, final leave approval that removes shifts, holiday import); new server paths set the audit channel (`worker_app` for leave requests, disputes and query replies from `/m`); each slice adds 5 to 10 manager requests with expected outcomes to `fixtures/lira/<area>.md`. No AI calls and no API keys. Approving timesheets in bulk and the final leave approval are `agent: false` until the owner says otherwise; approving is a person's decision.

## Roles

| Thing | Read | Write |
| --- | --- | --- |
| Public holidays, working week | every manager; a worker sees the dates through their leave screen | owner, admin, hr |
| Leave types, entitlements, presets | every member of the company (names, days, paid or not) | owner, admin, hr |
| Leave balances and ledger | owner, admin, hr; line_manager (their reportees); the worker their own | the SQL functions only (yearly grant, approval, cancellation, HR adjustment with a reason) |
| Leave requests | owner, admin, hr, ops_manager (dates and type only, for the roster); line_manager (their reportees); the worker their own | the worker asks or cancels; line manager decides step 1; hr (owner, admin) decides step 2 |
| Timesheets, lines, corrections, decisions | owner, admin, hr, ops_manager; line_manager (their reportees); the worker their own | line_manager (reportees, never themselves), ops_manager, admin, owner; the worker disputes their own |
| Work Units | owner, admin, finance, ops_manager | the approval function only |
| Queries and replies | owner, admin, hr; the line manager who raised it and the worker's current line manager; the worker their own | line_manager (reportees), hr, admin, owner raise and close; the worker replies |
| Reportee details (People list, person page, My team) | the line manager, through `public.my_reportees` (no bank, tax, NIN, RSA or pay columns) | none |

## Slices (one pull request each)

### 4.0 Close the line-manager column gap (independent, first)
- Migration `20261121100000_line_manager_worker_columns.sql`.
- Drop the two line-manager branches from `workers_select` (owners, admin, hr, finance, ops_manager and the worker's own row stay). Line managers stop reading `public.workers` directly.
- `public.my_reportees(org)` (planned as `team_members`; that name was already Settings > Team's read from 1.12): a definer read for the caller's reportees (the same rule as `private.my_line_manager_keys`) returning safe columns only: id, staff_id, first and last name, phone, email, job title, department, employment type, status, start and end dates, line manager, `usual_work_days`, supervisor clock-in, and mapped sites. Never the `_enc`, `_last4`, bank name, account name, TIN, tax state, PFA, NHF or rent columns.
- Find every place a line manager reads `workers` today (People list and person page as line_manager, roster names, live board, crew clock-in, punches joins, `roster_assignment_details`) and move it to `my_reportees` or an existing definer read. Definer functions that already join `workers` stay as they are.
- `src/server/people/team.ts` `loadTeamMembers` with a summary (counts by status, no personal numbers).
- Tests: RLS (a line manager selecting `bank_account_last4`, `nin_enc`, `tin`, `rsa_pin_last4` from `workers` gets no rows; `my_reportees` returns only reportees and only the safe columns; a line manager of another company gets nothing; an untrusted session gets nothing), a column snapshot test that fails if a sensitive column is added to `my_reportees`, Playwright: a line manager's People and Roster pages still show names.
- **security-reviewer.**

**Accept:** a line manager calling the Data API for `workers?select=bank_account_last4` gets nothing, and their pages look the same as before.

### 4.1 Company calendar and leave setup (independent)
- Migration `20261121110000_leave_setup.sql`.
- `public_holidays` (date, name; unique per company and date; removed rows kept with `removed_at`, `removed_by`, never deleted). `organisations.default_work_days smallint[]` (ISO 1 to 7, default Mon to Fri) and `workers.usual_work_days smallint[] null`.
- `leave_types` (code, name, `counting` working_days or calendar_days, paid, `needs_certificate`, `min_service_months`, `preset` A, B or null (preset C dropped, owner 21 Nov 2026), `source_label`, status active or retired; retired, never deleted). Every type uses the two-step approval (decision 9).
- `leave_entitlements`: dated versions per leave type (`effective_from`, `effective_to`, `days_per_year` integer, `carry_over_cap_days` integer null, `pay_percent` integer 0 to 100, `pay_min_service_months` integer null: the service the pay needs, preset A's maternity pay 6). No overlaps (GiST). A version in force is never updated except to close it; a change is a new version from a future 1 January or from tomorrow (rule 3).
- Functions: `add_public_holiday`, `remove_public_holiday`, `copy_public_holidays(org, from_year, to_year)` (multi-row, preview; holidays are declared year by year, so it copies names and dates for the owner to edit), `save_leave_type`, `add_leave_entitlement_version`, `apply_leave_preset(org, preset)` (multi-row, preview: creates or versions the preset's types with their values and source labels; existing company types are never deleted).
- Pure `src/lib/leave/presets.ts`: the two presets with their figures, source labels and the "confirm with an adviser" line, matching RULES_NIGERIA.md exactly (a unit test compares them).
- Screens: Settings > Leave (`/app/settings/leave`): the preset picker with two cards side by side, each with its source and "These are starting values, not legal advice. Confirm them with an adviser."; the types table (the Leave board's Policies tab) with edit; Settings > Holidays (`/app/settings/holidays`) with "Copy last year".
- Tests: unit (presets match the doc, proration helper, entitlement version planning), RLS (isolation entries, hr writes, line_manager and worker read only, no overlap, no update of a version in force), Playwright: apply preset B, edit annual to 18, see "confirm with an adviser" on both preset cards.

**Accept:** an owner applies preset A or B, edits any figure, and every preset shows its source and "confirm with an adviser".

### 4.2 Timesheet days from punches (independent)
- Migration `20261121120000_timesheets.sql`.
- `timesheets`: one per worker per pay period (`period_start` the 20th, `period_end` the 19th, from `pay_cycle_start_day`), unique (org, worker, period_start). A container: its status is worked out from its lines.
- `timesheet_lines`: one per shift assignment worked or missed, plus one per unmatched clock-in (`no_shift`). Columns: timesheet, work date (the shift's day), `shift_assignment_id` (unique when set), `shift_id`, `post_id`, `site_id`, `in_punch_id`, `out_punch_id`, `scheduled_minutes`, `worked_minutes`, `late_minutes`, `early_minutes`, `ot_minutes` (all integers, never negative), `exceptions text[]`, `needs_review boolean`, status (pending, approved, rejected, disputed), `work_unit_id` (filled in 4.3).
- `refresh_timesheet_lines(org, from, to)` rebuilds pending lines from punches, assignments and corrections; approved and rejected lines are frozen (guard). Minute rules, mirrored in pure `src/lib/timesheets/minutes.ts` and checked against SQL in the RLS suite, as 3.5 did for punch flags:
  - Clock-in within grace: worked from the rostered start (decision 4). Beyond grace: from `recorded_at`, `late_minutes` set, exception `late`.
  - Clock-out before the shift end: actual, `early_minutes`, exception `early_out`. After it: worked minutes stop at the shift end and the rest is `ot_minutes`, exception `overtime`.
  - No clock-out once the shift's punch window has closed (end + 4 hours, as 3.5's matching): 0 minutes, exception `no_clock_out` (decision 5). Assigned with no clock-in after `no_show_after_minutes`: 0 minutes, `no_show`.
  - Copies the punches' flags onto the line (`outside`, `near`, `no_location`, `no_selfie`, `clock_drift`, `double_in`, `out_without_in`, supervisor). `delayed`, `time_unverified` and `late_sync` set `needs_review` (decision 12): the screen highlights them and bulk approval skips them.
  - A worker on approved leave that day gets no line (leave is its own record).
- `timesheet_corrections` (insert-only): line, kind (`set_clock_out`, `set_clock_in`, `set_minutes`, `void_punch`), the corrected time or minutes, reason (required, plain text, no web addresses), actor. `add_timesheet_correction` by the worker's line manager, ops_manager, admin or owner, never for their own line; the next refresh applies the latest correction of each kind.
- **Replace `private.punch_under_review`** (decision 12): true while any line using the punch is pending or disputed, or no line uses it yet; false once every line using it is approved or rejected. `tests/rls/punch-photos` gains cases for each state.
- **Replace `private.worker_has_work_records`**: real checks on `timesheet_lines` (and the 4.4 and 4.6 tables when they land), dropping the `to_regclass('public.timesheets')` fail-closed branch, which would otherwise mark every worker as having records. `timesheet_lines`, `timesheet_corrections` and `timesheets` go into `WORK_RECORD_TABLES` or `NOT_WORK_RECORDS` with a reason.
- Daily cron `/api/cron/timesheets` (04:00): refreshes yesterday and the day before for every company with Shifts on (secret key, chunked by company). Opening the timesheet screen refreshes the range it shows, so nobody waits for the cron.
- Tests: unit (every minute rule, night shifts across midnight, a shift on the 19th and 20th landing in the right period, grace edges at 10 and 11 minutes), RLS (isolation, worker reads own, line manager reads reportees, corrections insert-only for every role and the database owner, own-line correction refused, frozen lines unchanged by refresh, `punch_under_review` states).
- **security-reviewer** (selfie retention and work-records hook change).

**Accept:** a 07:00 to 19:00 shift clocked in at 07:08 and out at 19:20 shows 720 worked minutes and 20 overtime minutes; clocked in at 07:25 it shows 695 minutes, flagged late; with no clock-out it shows 0 until a correction with a reason sets one.

**As built (4.2, PR #62).** What later slices need to know:
- **Lines:** a line is made once its shift has started. A removed or cancelled assignment gets a line only when it has punches, flagged `shift_removed`. Times are truncated to the whole minute. Overtime counts only after the shift end. Every count is clamped to 0..1440.
- **No-shift days:** a no-shift clock-in pairs with the next clock-out within 20 hours. A no-shift correction must fall within 4 hours before to 20 hours after the clock-in (MLTS3), so the day spans 24 hours at most.
- **Corrections:**
  - `set_minutes` replaces worked and overtime minutes and clears the minute-rule exceptions.
  - Every correction adds `corrected`.
  - `void_punch` names only the line's current clock-in or clock-out.
  - The latest correction of each kind applies.
- **Refresh:** disputed lines are rebuilt like pending ones and keep their status. A pending line with no corrections is deleted when its shift no longer counts.
- **Decided lines:** `decided_at` is set by the guard when a line becomes approved or rejected, and cleared when it goes back to pending or disputed. A decided line is frozen except for status, `work_unit_id` and gaining `late_punch_after_decision`.
- **Locks:** company-wide refreshes take the company advisory lock exclusively. Worker-scoped refreshes (up to 200 workers) take it shared, plus one lock per worker. A worker's own refresh is capped at 35 days; managers can refresh up to 62.
- **Cron:** `/api/cron/timesheets` (04:00 Lagos) refreshes the last 7 days in batches of 50 workers. A worker whose refresh fails is skipped and counted.
- **Selfie retention:** `private.punch_under_review` keeps a selfie in these cases:
  - while a line pointing at the punch is pending or disputed;
  - while the punch's shift line is open;
  - when the punch arrived after its shift line was decided;
  - otherwise only while the punch is under 90 days old.
- **For 4.3:**
  - Add `timesheet_decisions` to the "no decisions" check in the refresh's delete of stale pending lines. Otherwise the refresh fails on the new foreign key.
  - Decide which exceptions are informational for "Approve N clean". A supervisor punch's `no_location`, `no_selfie` and `supervisor` are copied onto the line, so crew days are never clean if clean means "no exceptions" (3.7's board drops `no_location` for supervisor punches).
  - Show `late_punch_after_decision` and offer Reopen. The late punch keeps its selfie until the day is reopened and decided again.
  - Add a preview (current against new minutes) to `timesheets.correct`, then consider `agent: true`.
  - Call `refreshTimesheetRange` when the screen opens.
- **For 4.4:**
  - Replace `private.timesheet_on_leave` (a placeholder that returns false), so a worker on approved leave gets no line.
  - Add the leave tables to `private.worker_has_work_records` if they are work records.
  - Punches on a leave day get no line, so their selfies fall under the 90-day age rule.

### 4.3 Timesheet approval and Work Units (after 4.2)
- Migration `20261121130000_timesheet_approval.sql`.
- `timesheet_decisions` (insert-only): line, decision (approved, rejected, disputed, reopened), reason (required for rejected, disputed and reopened), actor, snapshot of the minutes decided. The line's status follows its latest decision, set only by the functions.
- `work_units`: `contract_id`, `site_id`, `post_id`, `shift_id`, `timesheet_line_id` (unique), `project_id` null, kind `shift_post`, date, unit (copied from the post: shift, hour or visit), `quantity_minutes`, `ot_minutes`, billable, status (approved, cancelled), `cancelled_by_decision_id`. No money: Phase 6 prices it from the rate card in force on the date. Never deleted; a reopened line cancels its unit and a new approval makes a new one.
- Functions: `approve_timesheet_line`, `reject_timesheet_line`, `approve_clean_timesheet_lines(org, line_ids)` (multi-row, preview: only pending lines with no exceptions and no `needs_review`; refuses the rest by name), `reopen_timesheet_line(org, line, reason)` (ops_manager, admin, owner; refused once Phase 5 posts the period: a hook that returns false until then), `dispute_timesheet_line(line, reason)` (the worker, own line, while pending or approved and the period is open).
- Approver check (decision 6): the worker's line manager, ops_manager, admin or owner, never the worker themselves.
- Screens: `/app/timesheets` per the Timesheets board: period picker (20th to 19th), "N timesheets to decide", the list (flagged first, `needs_review` highlighted with why: "Sent 3 h after the time it claims", "Phone time not checked"), the detail panel (clock in and out, distance and geofence result, device vs server time, method self or supervisor, the selfie by the existing 60-second link for the roles 3.5 allows, the Work Unit it will create), Approve, Adjust hours (a correction with a reason, from 4.2), Reject, and "Approve N clean" with its preview. `/m/hours`: the worker's days this period with minutes and "This is wrong".
- The worker is told by inbox (and email within the caps) when a day is rejected or adjusted.
- Tests: unit (clean-line selection, Work Unit billable by contract type), RLS (isolation, approver rules, own-day refused, decisions insert-only, one Work Unit per line, reopen cancels the unit), Playwright: approve clean, adjust a missing clock-out, dispute from `/m/hours`.
- **security-reviewer.** No money-reviewer: Work Units carry minutes, not kobo; Phase 6's money review covers how they are priced.

**Accept:** approving a timesheet day on a manned-post shift creates one billable Work Unit with the day's minutes (the BUILD_PLAN "done when"); a reopened day cancels it.

**As built (4.3).** Migration `20261121170000_timesheet_approval.sql` (renamed after 4.6 merged). What later slices need to know:
- **Decisions:** `timesheet_decisions` (approved, rejected, disputed, reopened; reason required except approved; minutes snapshot) and `work_units` are insert-only for every role, the secret key and the database owner, with truncate guards. A Work Unit moves approved to cancelled once, naming a `reopened` decision, or a `disputed` one when the worker disputes an approved day (the day goes back to the approver, so its unit can't stay billable).
- **Work Units:** one approved unit per line (partial unique index); made only for a shift day with minutes above 0 (no-shift days and 0-minute days make none). Billable on manned_post and per_visit. Carries `worker_id`, `unit` from the post, `contract_type`, `quantity_minutes`, `ot_minutes`; no money. `shifts.work_unit_id` stays null (a shift holds several people).
- **Clean (Approve N clean):** pending, needs_review false, the shift finished, and no exceptions except informational ones: `supervisor`, and `no_location` / `no_selfie` only when no self-made punch on the line carries them. `corrected` is not informational. Refusal codes: not_found (no name), own, not_yours, decided, disputed, running, needs_review, flagged.
- **Every decision refreshes the day first** under the worker's lock; a single approval is refused (MLTA7) if that changes the minutes or exceptions. A running shift can't be approved (MLTA3).
- **Reopen:** owner, admin, ops_manager, never their own day; refused when `private.timesheet_period_posted` says so (returns false until **Phase 5 replaces it**). Dispute: the worker's own day, pending or approved, at most 3 times.
- **Late punches:** flagged as they arrive by a punches trigger, keyed on the punch's line (shift lines by assignment, no-shift lines by the clock-out pairing), plus a refresh catch-up over punches received in the last 7 days. `punch_under_review` keeps a late punch's selfie until the day is reopened and decided again, or 180 days from arrival at most.
- **Cron:** `refresh_timesheets_recent` returns `failed_codes` (distinct SQLSTATEs); `/api/cron/timesheets` logs counts and codes and answers 500 when anything failed or the run stopped early.
- **For 4.7:** `/m/team` can reuse `approve_timesheet_line`, `reject_timesheet_line` and `timesheet_review_days` (a line manager sees their reportees). The HR file's "timesheet exceptions" placeholder (4.6) can read `timesheet_review_days`.

### 4.4 Leave requests and balances (after 4.1)
- Migration `20261121180000_leave_requests.sql`.
- `leave_ledger` (insert-only): worker, leave type, leave year, kind (`grant`, `carry_over`, `taken`, `returned`, `adjustment`), days (signed integer), request id null, reason (required for adjustments), actor. A balance is the sum, never a stored column.
- `ensure_leave_year(org, year)`: idempotent; for each active worker and type, inserts the year's `grant` from the entitlement in force on 1 January (prorated for joiners, decision 2) and, where the type has a cap, a `carry_over` of min(last year's remainder, cap). Run by the daily cron `/api/cron/leave-year` (05:00; it does real work on 1 January and for new joiners) and on first read of a balance.
- `leave_requests`: worker, leave type, `start_date`, `end_date`, `days` (whole days, decision 3), reason (optional, plain text), status (pending_line_manager, pending_hr, approved, declined, cancelled), `certificate_seen` (set by an approver on types that need one).
- `leave_decisions` (insert-only): request, step (line_manager, hr), decision (approved, declined), note, actor.
- Working-day counter, mirrored in SQL and `src/lib/leave/days.ts`: working-day types count the worker's working days in the range (assigned shifts first, then usual days) minus the company's holidays; calendar-day types count every day. Shown live on the request form ("3 working days. Covers 3 rostered shifts at Gate A").
- Functions: `request_leave` (the worker, from `/m`, as themselves; refuses overlap with another live request, a balance short of the days on a type with an entitlement, a type before `min_service_months`, a past start), `cancel_leave_request` (the worker before the final decision; HR after, which returns the days), `decide_leave_line_manager`, `decide_leave_hr`, `adjust_leave_balance` (hr, with a reason). Approval writes the `taken` ledger row; a cancellation after approval writes `returned`.
- Screens: `/m/leave` per WkLeave (balances, type chips, from and to, the live count, Send request, past requests, "You will get a message when it is decided"); `/app/leave` per the Leave board (tiles: On leave today, Waiting for HR, Starting in 14 days; Requests with line manager and HR columns; Calendar; Policies links to Settings > Leave).
- Notices: the line manager is emailed a new request (managers have no inbox; inside the caps), HR when step 1 approves, the worker by inbox and email at each decision.
- Tests: unit (working-day count across off-days, holidays, a roster edge, calendar-day types, proration, carry-over cap), RLS (isolation, ledger insert-only, step order, a line manager can't decide their own leave or step 2, HR can't decide step 1 for a worker who has a line manager, overlap refused), Playwright: a worker asks for 3 days, line manager and HR approve, the balance drops by 3.

**Accept:** a worker asks for leave on the phone, sees the working days counted, and the balance drops only after HR's approval.

### 4.5 Approved leave opens shifts (after 4.4)
- Migration `20261121190000_leave_roster.sql` (150000 was planned; 160000 to 180000 were taken first).
- Final approval (`decide_leave_hr`, approved) removes the worker's assigned shifts in the range (`shift_assignments.status = removed`, `removed_reason = 'on_leave'`, `removed_by` the approver), in the same transaction, with a preview listing each shift ("Opens 3 shifts: Gate A day, 4 to 6 Nov"). The shifts show as uncovered; a published week shows them as changed since publish.
- `shift_assignments_guard` and `assign_worker_to_shift` refuse a worker on approved leave that day (new code, plain message "On approved leave 4 to 6 Nov"); `copy_last_week` skips them. The uncovered tray's suggestions skip workers on approved leave and mark those with pending leave.
- Roster grid: an "On leave" chip on the worker's days.
- Ops told (decision 8): one email per approval to the ops managers of the affected sites, inside the caps, naming the count and the sites; the worker's inbox item says their manager arranges cover.
- Decision 13: `private.roster_affected_workers` leaves out workers whose employment ended after the publication (`end_date` before the week, or status ended), so a republish never notifies a leaver.
- Tests: RLS (approval removes exactly the range's assignments, nothing outside it; past days untouched; assignment onto leave refused; a declined or cancelled request removes nothing; affected workers skip leavers), Playwright: approve leave and see the shifts in the uncovered tray.
- **security-reviewer** (a definer function changing roster rows for another role).

**Accept:** HR approves 3 days of leave and the worker's 3 shifts appear in the uncovered tray, with ops emailed (the BUILD_PLAN "done when").

**As built (slice 4.5):**
- **Which shifts open:** the worker's assigned shifts dated inside the request whose start is still ahead (`private.leave_shifts_to_open`): a past day, or a shift today that has started, is left alone. They are removed in the approval's transaction (removed_reason `on_leave`, removed_by the approver), audited per row and as `roster.opened_by_leave`. The dry run's `open_shifts` lists them; the preview says "Opens 3 shifts: Gate A · Day, 4 to 6 Nov".
- **Refusing leave days:** the check lives in `shift_assignments_guard` (MLRSL, "On approved leave 4 to 6 Nov."), so `assign_worker_to_shift`, `copy_last_week`, the secret key and 4.7's line-manager assign all refuse it without replacing `assign_worker_to_shift` (4.7's migration, 20261121200000, runs after 190000 and replaces that function from its 3.2 version, which 4.5 never changed, so nothing of 4.5 is undone). If 4.7 or later replaces the guard, it must keep the leave check. `copy_last_week` lists those as skipped (code MLRSL).
- **Locks:** the guard takes the worker's leave lock (`leave_requests:<worker>`) shared; the leave functions take it exclusively. No site locks, so no cycle with publish.
- **Cancelling approved leave** gives the days back but doesn't put the worker back on the opened shifts (others may have filled them).
- **Roster reads:** `roster_leave(org, from, to)` (worker ids, dates, approved or pending; owner, admin, ops_manager) for the suggestions, and `roster_leave_removals(org, site, from, to)` for the "On leave" chips (only while the leave stands). Line managers and other roles get neither; the database still refuses their assignments onto leave.
- **Ops told:** one email per approval (`claim_manager_email`, kind `leave_cover`, inside the shared caps) to the company's ops managers, else admins and owners: ops managers aren't tied to sites, so all of them count as the affected sites' ops managers. Up to 5 recipients. It names the count, the sites and each post with its days, and links to the roster week.
- **Decision 13:** `private.roster_affected_workers` drops workers with status ended or an end date before the week, so publish and "Send notices again" never tell a leaver.

### 4.6 Queries and the HR file (after 4.0)
- Migration `20261121160000_staff_queries.sql`.
- `staff_queries`: worker, raised_by, kind (lateness, absence_without_leave, conduct, performance, other), subject, body, `reply_by` date (today or later), status (awaiting_reply, replied, closed, withdrawn), closed outcome note. `staff_query_replies` (insert-only): query, author (the worker or a manager), body. Plain text, no web addresses or personal numbers, as `inbox_items`.
- Functions: `raise_query` (line manager for reportees, hr, admin, owner), `reply_to_query` (the worker from `/m`; a manager may add a follow-up), `close_query`, `withdraw_query` (the raiser, with a reason). Never deleted.
- Overdue is worked out on read (`reply_by` passed, no reply). The daily cron `/api/cron/query-reminders` (06:00) sends one reminder the day before `reply_by` (inbox, email within the caps).
- HR file: a new "HR file" tab on the person page (`/app/people/[id]`, owner, admin, hr; line managers see their own reportees' queries only) listing queries with replies, leave history and balance, and timesheet exceptions counts by period.
- Worker app: `/m/queries` (list, reply), with the query's reply-by date shown first.
- Tests: RLS (isolation, who reads which query, replies insert-only, a worker replies only to their own, a former line manager who didn't raise the query can't read it), unit (text checks, overdue), Playwright: raise, reply on `/m`, see both on the HR file.
- **security-reviewer** (personal data on the HR file).

**Accept:** a line manager raises a lateness query with a reply-by date, the worker replies on the phone, and both show on the HR file.

**As built (slice 4.6):**
- The HR file is a section of `/app/people/[id]` (id `hr-file`), not a sub-route, so line managers keep exactly `/app/people` and `/app/people/[id]` (the 4.0b nav test is unchanged). Owner, admin, hr and line managers see it; RLS narrows line managers to their current reportees' queries and the ones they raised. Ops managers and finance don't see it.
- Leave history and balance (4.4) and timesheet exception counts (4.2, 4.3) are placeholders on the HR file ("coming soon", test ids `hr-file-leave-placeholder` and `hr-file-timesheet-placeholder`); those slices replace them.
- Statuses: awaiting_reply, replied (the worker's first reply), closed (owner, admin, hr, the current line manager or the raiser, with an outcome note), withdrawn (the raiser only, with a reason). A manager's follow-up is a reply row and doesn't change the status. Up to 25 worker replies and 5 manager follow-ups a query, counted apart and enforced by an insert trigger on the replies whoever inserts (the secret key included), which also refuses a reply to a closed or withdrawn query. The worker may reply more than once while it is open. Reply-by is today to 60 days ahead.
- The raiser keeps reading their query while they still hold a manager role (owner, admin, hr or line_manager) in the company, even after the worker moves to another line manager; a former line manager who didn't raise it reads nothing.
- Text rule: plain text, line breaks only in the body, no `<`/`>` or control characters, no web addresses (`://`, `www.` or a word ending in a common domain such as `.com` or `.ng`), no run of 10 or more digits with only spaces or hyphens between them (the inbox rule, so dates and times stay allowed). The worker's notices never carry the query text, only the subject and the date.
- `staff_queries` is declared in `NOT_WORK_RECORDS` (an HR record kept by worker id, not staff ID); `private.worker_has_work_records` is unchanged here because 4.2 replaces it.
- Worker app: `/m/queries`, a banner on Home ("1 query from Kola Adebayo · reply by Mon 2 Nov") and a link from Me's Queries tab. Replies are online only (no offline queue for replies yet).

### 4.7 My team (after 4.0, 4.3, 4.4 and 4.6)
- Migration `20261121200000_line_manager_assign.sql` (170000 was planned; 170000 to 190000 were taken first).
- Line managers assign within their crews (deferred from Phase 3's role table): `assign_worker_to_shift` and `remove_assignment` accept a line_manager when the worker is their reportee and the shift's site is one of `private.line_manager_site_ids`; publishing stays with ops_manager, admin and owner.
- `/app/team` per the Team board: "9 people report to you"; Reportees (today from punches: on site, late, no-show, off; hours this week from timesheet lines; annual leave left from the ledger; next shift; Assign shift; Query), Leave requests (step 1 with balance and the shifts it opens), Queries (raised, replies, New query with reply-by). Reportee details only through `my_reportees` (4.0).
- `/m/team` for worker-supervisors (line managers who use the worker app; the SupHome Approvals tile): timesheet days to approve, leave requests at step 1, queries awaiting reply. The same functions as the manager app.
- Summary read for the team (counts only) and `fixtures/lira/team.md`.
- Tests: RLS (line manager assigns only reportees at their sites; can't publish), Playwright: a line manager assigns an open shift, approves a leave request and raises a query from `/app/team` at 390px and 1440px.
- **security-reviewer.**

**Accept:** a line manager sees only their reportees, assigns one to an open shift at their site, and approves step 1 of a leave request, all from My team.

**As built (slice 4.7):**
- **Line-manager pages:** a line manager opens Home, Live attendance, Timesheets, People (the list and a person's page, their reportees only; 4.0b), My team and Leave. Everything about a reportee comes from `public.my_reportees` or a definer read; a line manager never selects `public.workers`.
- **Assign and remove:** `assign_worker_to_shift` and `remove_assignment` accept a line_manager for their own reportees (never their own record) at `private.line_manager_site_ids` (`private.roster_may_assign`; refusal 42501 "You can assign only people who report to you, at your team's sites."). The guard is unchanged, so 4.5's approved-leave check (MLRSL) and leave lock apply to them too. `publish_roster`, `copy_last_week` and "Send notices again" stay with owner, admin and ops_manager.
- **Reads (line managers only, 42501 otherwise):** `team_shifts` (reportees' assigned shifts with names, 62 days at most), `team_open_shifts` (post-days at the team's sites still needing people from today, 31 days at most, counts only) and `team_leave_open_shifts` (4.5's `private.leave_shifts_to_open` for each step-1 request the caller decides; shown with 4.5's `formatOpenedShifts`).
- **`/app/team`:** nav roles owner, admin and line_manager (hr and ops_manager dropped: they have no reportees). Today comes from `attendance_board`; hours this week from timesheet lines (refreshed on open); annual leave left from `leave_balances` (type code `annual`); leave decisions, queries and New query reuse the 4.4 and 4.6 actions and components. Counts only in `team.board_summary`.
- **`/m/team`** (worker-supervisors and line managers in the worker app, owner decision 2 of 21 Nov 2026) moved to slice 4.7b.


## Order and parallel work

```
4.0 line-manager columns ─────────────┬── 4.6 queries, HR file ──┐
4.1 leave setup ── 4.4 leave requests ┼── 4.5 leave opens shifts │
4.2 timesheet days ── 4.3 approval ───┴──────────────────────────┴── 4.7 My team
```

Wave 1: 4.0, 4.1 and 4.2 (independent; at most three agents at once). Wave 2: 4.3 off 4.2, 4.4 off 4.1, 4.6 off 4.0 (each starts from its dependency's open PR branch and merges `main` in once it lands). Wave 3: 4.5 off 4.4, 4.7 off 4.4 with 4.3 and 4.6 merged in.

Migrations in order: `20261121100000` (4.0), `20261121110000` (4.1), `20261121120000` (4.2), `20261121130000` (4.3), `20261121180000` (4.4), `20261121190000` (4.5), `20261121160000` (4.6), `20261121170000` (4.7). A slice that needs a fix-up migration takes the next free minute in its own hour (for example `20261121120500`).

security-reviewer runs on 4.0, 4.2, 4.3, 4.5, 4.6 and 4.7. No money-reviewer: there is no pay maths and no kobo in Phase 4.

New crons (daily, Hobby): `/api/cron/timesheets` 04:00, `/api/cron/leave-year` 05:00, `/api/cron/query-reminders` 06:00.

## Open questions for the owner (defaults above apply until answered)

1. Early clock-out: count actual minutes (the default), or treat an early clock-out within the grace period as a full shift, like lateness?
2. Maternity leave counted in calendar days (the default), or in working days like every other type?
3. Proration for joiners by days left in the year, rounded half up (the default), or by whole months?
4. Should a worker-supervisor approve timesheets in the worker app (the default in 4.7), or only line managers who use the manager app?
5. ~~Which two leave presets to drop~~: answered 21 Nov 2026, preset C dropped; A and B stay (decision 14).

## Illustrations
- `timesheets-clear` (160) when every day in the period is decided (4.3), `leave-empty` (160) on an empty Requests tab (4.4), `team-empty` (160) for a line manager with no reportees (4.7). Add each slot to DESIGN_SYSTEM.md's table and draw it in `src/components/illustrations/` in the slice that first shows it, unless a slot already fits.

## Phase 4 done when
- An approved timesheet creates billable Work Units, and approved leave opens the affected shifts (BUILD_PLAN). Proven in CI (database tests and Playwright) and on the Vercel preview.
- A missing clock-out counts no hours until a correction with a reason; the punches are unchanged.
- A punch's selfie is kept while its timesheet day is unapproved or disputed, and deleted after 90 days once decided.
- Both leave presets (A and B) are selectable and editable, each with its source and "confirm with an adviser".
- Line managers can't read reportees' bank, tax, NIN or RSA columns through the Data API.
- Every Phase 4 table is in the isolation test; corrections, decisions, the leave ledger and query replies can't be edited or deleted by anyone.
- Timesheets, Leave, My team, `/m/leave`, `/m/hours` and `/m/queries` work at 390px and 1440px.
- Every Phase 4 Server Action is in the capability registry, and every multi-row write has a preview.

## Carried forward
From Phases 1 to 3, closed in this phase:
- Line managers reading reportees' bank and tax columns through `workers_select` (Phase 1, 1.11): 4.0.
- Replace `private.worker_has_work_records` when timesheet tables arrive (Phase 1): 4.2, with 4.4 and 4.6 adding their tables.
- Replace `private.punch_under_review` with the review table (3.5): 4.2.
- `roster_affected_workers` skips workers ended after publish (3.3 low): 4.5.
- Line managers assign within their crews (Phase 3 roles table): 4.7.
- Backdated pay changes (Phase 1 decision 17) wait for posted payroll in Phase 5, not Phase 4.

Still open for later phases:
- Phase 5: pay from approved timesheet lines and leave (`pay_percent`, unpaid leave), overtime rounding, public-holiday work (RULES_NIGERIA open points 1 and 2), lock timesheet periods once a run is posted (the 4.3 hook), `worker_bank_details_as_of` bank code, last-4 checks at release.
- Phase 6: price Work Units from the rate card in force on their date through `private.rate_key_part`; the rest as listed in PHASE_2.md.
- Leave attachments (medical certificates): a private bucket and signed URLs like contract documents, with a security review. Until then the approver ticks "Certificate seen".
- A manager inbox, so "ops told" and "new leave request" don't spend email.
- The Phase 2 and 3 low hardening follow-ups.
