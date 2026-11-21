-- Slice 4.2: timesheet days from punches.
--
-- 1. `timesheets`: one per worker per pay period (period_start the company's pay_cycle_start_day,
--    20 by default, to the day before it next month; owner decision 7). A container: its status is
--    worked out from its lines on read. Insert only.
-- 2. `timesheet_lines`: one per shift assignment worked or missed (the shift has started), plus
--    one per clock-in that matched no shift (`no_shift`). Minutes are integers, never negative:
--    scheduled, worked, late, early and overtime. `exceptions` lists the minute rules that fired
--    and the punch flags copied from the clock-in and clock-out; `needs_review` marks a day whose
--    punch time rests on the phone's word (delayed, late_sync, time_unverified; decision 12).
--    Status pending, approved, rejected or disputed (4.3 decides). Approved and rejected lines are
--    frozen: only 4.3's functions move their status and Work Unit. No money anywhere.
-- 3. `timesheet_corrections`: insert-only for every role, the secret key and the database owner
--    included (row guard and a statement-level truncate guard, as punches and roster
--    publications). Kinds set_clock_in, set_clock_out, set_minutes and void_punch, each with a
--    required plain-text reason (no web addresses, no runs of 10 or more digits) and the actor.
--    `add_timesheet_correction`: the worker's line manager, ops_manager, admin or owner, never on
--    their own line, only while the line is pending or disputed. It refreshes the line at once.
-- 4. `refresh_timesheet_lines(org, from, to, workers)`: rebuilds pending and disputed lines from
--    punches (kinds 'in' and 'out' only; patrol scans never count), shift assignments and the
--    latest correction of each kind. Approved and rejected lines are left as they are. A pending
--    line whose shift no longer counts (removed before anyone clocked in, or approved leave) is
--    deleted unless a correction points at it. The minute rules live in
--    private.timesheet_line_compute, mirrored in src/lib/timesheets/minutes.ts (the RLS suite
--    checks both agree, as slice 3.5 did for punch flags):
--    * clock-in within the grace period (organisations.late_grace_minutes): worked from the
--      rostered start (decision 4); beyond it: from the clock-in, late_minutes set, `late`;
--    * clock-out before the shift end: worked to the clock-out, early_minutes, `early_out` (no
--      grace for leaving early; open question 1); after it: worked stops at the shift end and the
--      rest is ot_minutes, `overtime`;
--    * no clock-out once the punch window has closed (end + 4 hours, slice 3.5's matching):
--      0 minutes, `no_clock_out` (decision 5); no clock-in no_show_after_minutes after the start:
--      0 minutes, `no_show`;
--    * a no-shift clock-in counts to the next clock-out within 20 hours (slice 3.5's pairing),
--      else 0 and `no_clock_out` once 20 hours have passed;
--    * times are truncated to the whole minute; the work date is the shift's day (a night shift
--      belongs to the day it starts), or the clock-in's day on the company's clock;
--    * copied flags: outside, near, no_location, no_selfie, clock_drift, double_in,
--      out_without_in, delayed, late_sync, time_unverified, plus `supervisor` for a crew punch
--      (slice 3.6) and `corrected` once a correction applies. A supervisor punch's no_location is
--      copied like any flag; only delayed, late_sync and time_unverified set needs_review.
--    * a worker on approved leave that day gets no line (private.timesheet_on_leave: false until
--      slice 4.4 adds leave; 4.4 MUST replace it).
--    * every minute count is clamped to 0..1440 (a day is at most 24 hours).
--    * a decided (approved or rejected) line is frozen; when a clock punch for its shift arrives
--      after the decision it only gains `late_punch_after_decision` (4.3 reopens it to count it).
--    Callers: owner, admin, hr and ops_manager for any worker of the company (62 days at most); a
--    line manager for their reportees (and themselves); a worker for themselves (35 days at
--    most); the secret key for the daily cron (`refresh_timesheets_recent`: the last 7 days, per
--    company, in batches of 50 workers; a failing worker is skipped and counted). Worker-scoped
--    refreshes lock per worker (private.timesheet_lock), company-wide ones lock the company.
-- 5. private.punch_under_review (slice 3.5 placeholder) now reads the lines (decision 12); see
--    its comment in section 7 for the four cases. In short: a punch a line uses follows that
--    line (kept while pending or disputed); a punch no line uses is kept while its shift's line
--    is open, when it arrived after that line was decided, or while it is under 90 days old.
-- 6. private.worker_has_work_records (slice 1.11 hook) checks timesheet_lines instead of failing
--    closed on the table's existence. Lines reference workers by a composite foreign key, so an
--    insert takes a key-share lock on the worker row and can't race a staff ID approval.
--
-- Refusals (SQLSTATE), mapped in src/server/workforce/timesheets.ts:
--   MLTS0 a change the guards never allow (corrections and timesheets are insert-only; decided
--         lines are frozen)
--   MLTS1 a correction on your own line            MLTS2 the day is already approved or rejected
--   MLTS3 the correction's values aren't valid     MLTS4 the reason isn't plain text
--   42501 the wrong role or an untrusted session   22023 a range that isn't valid (62 days at most)
--   P0002 the line isn't in the company
-- Nothing here stores money.

-- ---------------------------------------------------------------------------
-- 1. Pure helpers (mirrored in src/lib/timesheets/minutes.ts)
-- ---------------------------------------------------------------------------

-- Every exception a line can carry, in the order they are listed.
create function private.timesheet_exception_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'no_shift', 'late', 'early_out', 'overtime', 'no_clock_out', 'no_show', 'shift_removed',
    'outside', 'near', 'no_location', 'no_selfie', 'clock_drift', 'double_in', 'out_without_in',
    'delayed', 'late_sync', 'time_unverified', 'supervisor', 'corrected',
    'late_punch_after_decision'
  ]
$$;

-- The first day of the pay period holding `p_date`: the start day of its month when the date is
-- on or after it, else the start day of the month before (pay_cycle_start_day is 1 to 28).
create function private.timesheet_period_start(p_date date, p_start_day integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when extract(day from p_date)::integer >= p_start_day
      then make_date(extract(year from p_date)::integer, extract(month from p_date)::integer, p_start_day)
    else (make_date(extract(year from p_date)::integer, extract(month from p_date)::integer, p_start_day)
      - interval '1 month')::date
  end
$$;

-- The last day of the pay period starting `p_period_start`.
create function private.timesheet_period_end(p_period_start date)
returns date
language sql
immutable
set search_path = ''
as $$
  select ((p_period_start + interval '1 month')::date - 1)
$$;

-- A correction's reason: plain text, 1 to 500 characters, no web addresses and no runs of 10 or
-- more digits (no phone, account or ID numbers; rule 9).
create function private.timesheet_reason_ok(p_reason text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_reason is not null
    and p_reason = btrim(p_reason)
    and char_length(p_reason) between 1 and 500
    and p_reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    and p_reason !~* '(://|www\.)'
    and p_reason !~ '[0-9]([ -]*[0-9]){9,}'
$$;

-- The minutes and exceptions of one line. Pure: the same inputs always give the same answer.
-- Times are truncated to whole minutes. p_starts_at null means a no-shift clock-in.
create function private.timesheet_line_compute(
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_in_at timestamptz,
  p_out_at timestamptz,
  p_set_minutes integer,
  p_set_ot_minutes integer,
  p_in_flags text[],
  p_out_flags text[],
  p_by_supervisor boolean,
  p_corrected boolean,
  p_shift_removed boolean,
  p_grace_minutes integer,
  p_no_show_after_minutes integer,
  p_now timestamptz
)
returns table (
  scheduled_minutes integer,
  worked_minutes integer,
  late_minutes integer,
  early_minutes integer,
  ot_minutes integer,
  exceptions text[],
  needs_review boolean
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- Punch flags the line copies. no_shift, late and early_out are the line's own rules.
  v_copied constant text[] := array[
    'outside', 'near', 'no_location', 'no_selfie', 'clock_drift', 'double_in', 'out_without_in',
    'delayed', 'late_sync', 'time_unverified'
  ];
  v_review constant text[] := array['delayed', 'late_sync', 'time_unverified'];
  v_grace bigint := greatest(coalesce(p_grace_minutes, 0), 0);
  v_no_show bigint := greatest(coalesce(p_no_show_after_minutes, 60), 0);
  v_now bigint := floor(extract(epoch from p_now) / 60);
  v_s bigint;
  v_e bigint;
  v_i bigint;
  v_o bigint;
  v_start bigint;
  v_end bigint;
  v_sched bigint := 0;
  v_worked bigint := 0;
  v_late bigint := 0;
  v_early bigint := 0;
  v_ot bigint := 0;
  v_hits text[] := '{}';
  v_flags text[] := coalesce(p_in_flags, '{}') || coalesce(p_out_flags, '{}');
begin
  if p_in_at is not null then
    v_i := floor(extract(epoch from p_in_at) / 60);
  end if;
  if p_out_at is not null then
    v_o := floor(extract(epoch from p_out_at) / 60);
  end if;

  if p_starts_at is null then
    v_hits := v_hits || 'no_shift'::text;
    if p_set_minutes is not null then
      v_worked := p_set_minutes;
      v_ot := coalesce(p_set_ot_minutes, 0);
    elsif v_i is not null then
      if v_o is not null then
        v_worked := greatest(0, v_o - v_i);
      elsif v_now >= v_i + 1200 then
        v_hits := v_hits || 'no_clock_out'::text;
      end if;
    end if;
  else
    v_s := floor(extract(epoch from p_starts_at) / 60);
    v_e := floor(extract(epoch from p_ends_at) / 60);
    v_sched := greatest(0, v_e - v_s);
    if p_set_minutes is not null then
      v_worked := p_set_minutes;
      v_ot := coalesce(p_set_ot_minutes, 0);
    elsif v_i is null then
      if v_now >= v_s + v_no_show then
        v_hits := v_hits || 'no_show'::text;
      end if;
    else
      if v_i > v_s + v_grace then
        v_start := v_i;
        v_late := least(v_i - v_s, v_sched);
        v_hits := v_hits || 'late'::text;
      else
        v_start := v_s;
      end if;
      if v_o is null then
        if v_now >= v_e + 240 then
          v_hits := v_hits || 'no_clock_out'::text;
        end if;
      else
        if v_o < v_e then
          v_end := v_o;
          v_early := least(v_e - v_o, v_sched);
          v_hits := v_hits || 'early_out'::text;
        else
          v_end := v_e;
          v_ot := greatest(0, v_o - greatest(v_e, v_i));
          if v_ot > 0 then
            v_hits := v_hits || 'overtime'::text;
          end if;
        end if;
        v_worked := greatest(0, v_end - v_start);
      end if;
    end if;
  end if;

  -- A day is at most 24 hours: every minute count is clamped to 0..1440 (security review M1), so
  -- no correction or punch pairing can make a line break its range checks.
  scheduled_minutes := least(v_sched, 1440);
  worked_minutes := least(greatest(v_worked, 0), 1440);
  late_minutes := least(v_late, 1440);
  early_minutes := least(v_early, 1440);
  ot_minutes := least(greatest(v_ot, 0), 1440);
  select coalesce(array_agg(n.name order by n.ord), '{}'::text[]) into exceptions
  from unnest(private.timesheet_exception_names()) with ordinality as n (name, ord)
  where n.name = any (v_hits)
    or (n.name = any (v_copied) and n.name = any (v_flags))
    or (n.name = 'supervisor' and coalesce(p_by_supervisor, false))
    or (n.name = 'corrected' and coalesce(p_corrected, false))
    or (n.name = 'shift_removed' and coalesce(p_shift_removed, false));
  needs_review := v_flags && v_review;
  return next;
end;
$$;

revoke all on function private.timesheet_exception_names() from public, anon, authenticated;
revoke all on function private.timesheet_period_start(date, integer) from public, anon, authenticated;
revoke all on function private.timesheet_period_end(date) from public, anon, authenticated;
revoke all on function private.timesheet_reason_ok(text) from public, anon, authenticated;
revoke all on function private.timesheet_line_compute(
  timestamptz, timestamptz, timestamptz, timestamptz, integer, integer, text[], text[], boolean,
  boolean, boolean, integer, integer, timestamptz
) from public, anon, authenticated;

-- Is the worker on approved leave that day? Phase 4.2 has no leave: slice 4.4 MUST replace this
-- function with a real check of its table. Until then nobody is.
create function private.timesheet_on_leave(p_organisation_id uuid, p_worker_id uuid, p_date date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select false
$$;

revoke all on function private.timesheet_on_leave(uuid, uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- Rebuilding a line looks up a shift's punches by assignment.
create index if not exists punches_assignment_idx on public.punches (shift_assignment_id)
  where shift_assignment_id is not null;

create table public.timesheets (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  period_start date not null,
  period_end date not null,
  created_at timestamptz not null default now(),
  constraint timesheets_organisation_id_id_key unique (organisation_id, id),
  constraint timesheets_org_id_worker_key unique (organisation_id, id, worker_id),
  constraint timesheets_worker_period_key unique (organisation_id, worker_id, period_start),
  constraint timesheets_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint timesheets_period check (
    period_end = private.timesheet_period_end(period_start)
  )
);

comment on table public.timesheets is
  'One per worker per pay period (slice 4.2): the 20th (pay_cycle_start_day) to the day before it next month. A container; its status is worked out from its lines. Insert only.';

create table public.timesheet_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  timesheet_id uuid not null,
  worker_id uuid not null,
  -- The shift's day (a night shift belongs to the day it starts), or the no-shift clock-in's day
  -- on the company's clock.
  work_date date not null,
  shift_assignment_id uuid,
  -- The clock-in that made a no-shift line (its identity; set exactly when there is no shift).
  no_shift_punch_id uuid,
  shift_id uuid,
  post_id uuid,
  site_id uuid,
  in_punch_id uuid,
  out_punch_id uuid,
  scheduled_minutes integer not null default 0
    constraint timesheet_lines_scheduled_range check (scheduled_minutes between 0 and 1440),
  worked_minutes integer not null default 0
    constraint timesheet_lines_worked_range check (worked_minutes between 0 and 1440),
  late_minutes integer not null default 0
    constraint timesheet_lines_late_range check (late_minutes between 0 and 1440),
  early_minutes integer not null default 0
    constraint timesheet_lines_early_range check (early_minutes between 0 and 1440),
  ot_minutes integer not null default 0
    constraint timesheet_lines_ot_range check (ot_minutes between 0 and 1440),
  exceptions text[] not null default '{}'
    constraint timesheet_lines_exceptions_known check (exceptions <@ private.timesheet_exception_names()),
  needs_review boolean not null default false,
  status text not null default 'pending'
    constraint timesheet_lines_status_value check (status in ('pending', 'approved', 'rejected', 'disputed')),
  -- Filled by slice 4.3's approval.
  work_unit_id uuid,
  -- When the line last became approved or rejected (set by the guard; null while pending or
  -- disputed). A clock punch received after it is a late punch (exception
  -- late_punch_after_decision) and keeps its selfie until the day is reopened.
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timesheet_lines_organisation_id_id_key unique (organisation_id, id),
  constraint timesheet_lines_org_id_worker_key unique (organisation_id, id, worker_id),
  constraint timesheet_lines_assignment_key unique (shift_assignment_id),
  constraint timesheet_lines_no_shift_punch_key unique (no_shift_punch_id),
  constraint timesheet_lines_timesheet_fkey foreign key (organisation_id, timesheet_id, worker_id)
    references public.timesheets (organisation_id, id, worker_id),
  constraint timesheet_lines_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint timesheet_lines_assignment_fkey foreign key (organisation_id, shift_assignment_id)
    references public.shift_assignments (organisation_id, id),
  constraint timesheet_lines_shift_fkey foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id),
  constraint timesheet_lines_post_fkey foreign key (organisation_id, post_id)
    references public.posts (organisation_id, id),
  constraint timesheet_lines_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id),
  constraint timesheet_lines_in_punch_fkey foreign key (organisation_id, in_punch_id)
    references public.punches (organisation_id, id),
  constraint timesheet_lines_out_punch_fkey foreign key (organisation_id, out_punch_id)
    references public.punches (organisation_id, id),
  constraint timesheet_lines_no_shift_punch_fkey foreign key (organisation_id, no_shift_punch_id)
    references public.punches (organisation_id, id),
  constraint timesheet_lines_one_source check (
    (shift_assignment_id is null) <> (no_shift_punch_id is null)
  ),
  constraint timesheet_lines_shift_parts check (
    shift_assignment_id is null or (shift_id is not null and post_id is not null)
  )
);

create index timesheet_lines_org_date_idx on public.timesheet_lines (organisation_id, work_date);
create index timesheet_lines_worker_date_idx on public.timesheet_lines (worker_id, work_date);
create index timesheet_lines_timesheet_idx on public.timesheet_lines (timesheet_id);
create index timesheet_lines_in_punch_idx on public.timesheet_lines (in_punch_id)
  where in_punch_id is not null;
create index timesheet_lines_out_punch_idx on public.timesheet_lines (out_punch_id)
  where out_punch_id is not null;

comment on table public.timesheet_lines is
  'One per shift assignment worked or missed, plus one per no-shift clock-in (slice 4.2). Integer minutes, exceptions and needs_review from punches and corrections, rebuilt by refresh_timesheet_lines while pending or disputed. Approved and rejected lines are frozen. No money.';

create table public.timesheet_corrections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  line_id uuid not null,
  -- The line's worker (composite foreign key), so the worker reads their own corrections.
  worker_id uuid not null,
  kind text not null
    constraint timesheet_corrections_kind_value check (
      kind in ('set_clock_in', 'set_clock_out', 'set_minutes', 'void_punch')
    ),
  corrected_at timestamptz,
  minutes integer
    constraint timesheet_corrections_minutes_range check (minutes between 0 and 1440),
  ot_minutes integer
    constraint timesheet_corrections_ot_range check (ot_minutes between 0 and 1440),
  punch_id uuid,
  reason text not null
    constraint timesheet_corrections_reason_text check (private.timesheet_reason_ok(reason)),
  actor_id uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  -- Order of corrections (the latest of each kind applies).
  seq bigint generated always as identity,
  constraint timesheet_corrections_organisation_id_id_key unique (organisation_id, id),
  constraint timesheet_corrections_line_fkey foreign key (organisation_id, line_id, worker_id)
    references public.timesheet_lines (organisation_id, id, worker_id),
  constraint timesheet_corrections_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint timesheet_corrections_punch_fkey foreign key (organisation_id, punch_id)
    references public.punches (organisation_id, id),
  constraint timesheet_corrections_values check (
    ((kind in ('set_clock_in', 'set_clock_out')) = (corrected_at is not null))
    and ((kind = 'set_minutes') = (minutes is not null))
    and (kind = 'set_minutes' or ot_minutes is null)
    and ((kind = 'void_punch') = (punch_id is not null))
  )
);

create index timesheet_corrections_line_idx on public.timesheet_corrections (line_id, kind, seq desc);
create index timesheet_corrections_punch_idx on public.timesheet_corrections (punch_id)
  where punch_id is not null;

comment on table public.timesheet_corrections is
  'Corrections to a timesheet line (slice 4.2; owner decision 5): insert-only for every role, the secret key and the database owner included. The latest of each kind applies at the next refresh; the punches never change.';

-- ---------------------------------------------------------------------------
-- 3. Guards and audit
-- ---------------------------------------------------------------------------

-- timesheets: insert only.
create function private.timesheets_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'A timesheet never changes and is never deleted.' using errcode = 'MLTS0';
end;
$$;

-- timesheet_lines: new lines are pending with no Work Unit; a line's identity never changes;
-- an approved or rejected line changes only its status and Work Unit (slice 4.3's functions);
-- only a pending line is ever deleted (by the refresh).
create function private.timesheet_lines_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_decided constant text[] := array['status', 'work_unit_id', 'updated_at', 'decided_at', 'exceptions'];
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.work_unit_id is not null then
      raise exception 'A new timesheet day starts pending.' using errcode = 'MLTS0';
    end if;
    new.created_at := now();
    new.updated_at := now();
    new.decided_at := null;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'pending' then
      raise exception 'A decided or disputed timesheet day is never deleted.' using errcode = 'MLTS0';
    end if;
    return old;
  end if;
  if (new.id, new.organisation_id, new.worker_id, new.work_date, new.shift_assignment_id,
      new.no_shift_punch_id, new.created_at)
    is distinct from
     (old.id, old.organisation_id, old.worker_id, old.work_date, old.shift_assignment_id,
      old.no_shift_punch_id, old.created_at) then
    raise exception 'A timesheet day''s worker, date and shift never change.' using errcode = 'MLTS0';
  end if;
  if old.status in ('approved', 'rejected') then
    -- A decided day changes only its status and Work Unit (slice 4.3's functions), and may gain
    -- the late_punch_after_decision flag (the refresh, while it stays decided); nothing else.
    if (to_jsonb(new) - v_decided) is distinct from (to_jsonb(old) - v_decided)
      or (
        new.exceptions is distinct from old.exceptions
        and not (
          new.status = old.status
          and new.exceptions @> old.exceptions
          and new.exceptions <@ (old.exceptions || 'late_punch_after_decision'::text)
        )
      ) then
      raise exception 'An approved or rejected day never changes. Reopen it first.' using errcode = 'MLTS0';
    end if;
  end if;
  if new.status in ('approved', 'rejected') then
    if old.status is distinct from new.status then
      new.decided_at := now();
    else
      new.decided_at := old.decided_at;
    end if;
  else
    new.decided_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- timesheet_corrections: insert only; the actor and time are the server's.
create function private.timesheet_corrections_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A correction never changes. Add a new one instead.' using errcode = 'MLTS0';
  end if;
  new.actor_id := coalesce(private.session_uid(), auth.uid(), new.actor_id);
  new.created_at := now();
  return new;
end;
$$;

create function private.timesheets_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Timesheets, their days and corrections are never deleted.' using errcode = 'MLTS0';
end;
$$;

revoke all on function private.timesheets_guard() from public, anon, authenticated;
revoke all on function private.timesheet_lines_guard() from public, anon, authenticated;
revoke all on function private.timesheet_corrections_guard() from public, anon, authenticated;
revoke all on function private.timesheets_no_truncate() from public, anon, authenticated;

create trigger timesheets_guard before update or delete on public.timesheets
  for each row execute function private.timesheets_guard();
create trigger timesheets_no_truncate before truncate on public.timesheets
  for each statement execute function private.timesheets_no_truncate();
create trigger timesheets_audit after insert on public.timesheets
  for each row execute function private.audit_row_change();

create trigger timesheet_lines_guard before insert or update or delete on public.timesheet_lines
  for each row execute function private.timesheet_lines_guard();
create trigger timesheet_lines_no_truncate before truncate on public.timesheet_lines
  for each statement execute function private.timesheets_no_truncate();
create trigger timesheet_lines_audit after insert or update or delete on public.timesheet_lines
  for each row execute function private.audit_row_change();

create trigger timesheet_corrections_guard
  before insert or update or delete on public.timesheet_corrections
  for each row execute function private.timesheet_corrections_guard();
create trigger timesheet_corrections_no_truncate before truncate on public.timesheet_corrections
  for each statement execute function private.timesheets_no_truncate();
create trigger timesheet_corrections_audit after insert on public.timesheet_corrections
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants
-- ---------------------------------------------------------------------------
-- Read (PHASE_4 Roles): owner, admin, hr and ops_manager every row of the company; a line
-- manager their reportees'; the worker their own. No write grants for anyone, the secret key
-- included: the functions below are the only writers.

alter table public.timesheets enable row level security;
alter table public.timesheet_lines enable row level security;
alter table public.timesheet_corrections enable row level security;

create policy timesheets_select on public.timesheets for select to authenticated
  using (
    worker_id in (select private.my_worker_ids())
    or organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr', 'ops_manager']))
    or worker_id in (select private.my_reportee_ids())
  );

create policy timesheet_lines_select on public.timesheet_lines for select to authenticated
  using (
    worker_id in (select private.my_worker_ids())
    or organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr', 'ops_manager']))
    or worker_id in (select private.my_reportee_ids())
  );

create policy timesheet_corrections_select on public.timesheet_corrections for select to authenticated
  using (
    worker_id in (select private.my_worker_ids())
    or organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr', 'ops_manager']))
    or worker_id in (select private.my_reportee_ids())
  );

revoke all on table public.timesheets from anon, authenticated;
revoke all on table public.timesheet_lines from anon, authenticated;
revoke all on table public.timesheet_corrections from anon, authenticated;
revoke insert, update, delete, truncate on table public.timesheets from service_role;
revoke insert, update, delete, truncate on table public.timesheet_lines from service_role;
revoke insert, update, delete, truncate on table public.timesheet_corrections from service_role;
grant select on table public.timesheets to authenticated;
grant select on table public.timesheet_lines to authenticated;
grant select on table public.timesheet_corrections to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The refresh
-- ---------------------------------------------------------------------------

-- The refresh's locks (security review L3). A company-wide refresh (p_worker_ids null, or more
-- than 200 workers) holds the company lock exclusively. A worker-scoped one holds it shared, plus
-- one lock per worker in id order, so refreshes of different workers never wait for each other
-- (a worker looping their own refresh can't hold up the company) while two refreshes of the same
-- worker, or a company-wide one, queue.
create function private.timesheet_lock(p_organisation_id uuid, p_worker_ids uuid[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_worker uuid;
begin
  if p_worker_ids is null or cardinality(p_worker_ids) > 200 then
    perform pg_advisory_xact_lock(hashtextextended('timesheets:' || p_organisation_id::text, 0));
    return;
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('timesheets:' || p_organisation_id::text, 0));
  for v_worker in
    select distinct u.w from unnest(p_worker_ids) as u (w) where u.w is not null order by u.w
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('timesheets:' || p_organisation_id::text || ':' || v_worker::text, 0)
    );
  end loop;
end;
$$;

revoke all on function private.timesheet_lock(uuid, uuid[]) from public, anon, authenticated;

-- Rebuilds the lines of `p_organisation_id` with work dates from `p_from` to `p_to`, for
-- `p_worker_ids` (null: every worker). No role check: only the definers below call it, after
-- theirs. Returns {inserted, updated, deleted}.
create function private.timesheet_refresh(
  p_organisation_id uuid,
  p_from date,
  p_to date,
  p_worker_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_zone text;
  v_grace integer;
  v_no_show integer;
  v_start_day integer;
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_flagged integer := 0;
begin
  if p_organisation_id is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid range of days.' using errcode = '22023';
  end if;
  if p_worker_ids is not null and cardinality(p_worker_ids) = 0 then
    return jsonb_build_object('inserted', 0, 'updated', 0, 'deleted', 0);
  end if;

  select coalesce(o.timezone, 'Africa/Lagos'), o.late_grace_minutes, o.no_show_after_minutes,
    o.pay_cycle_start_day
  into v_zone, v_grace, v_no_show, v_start_day
  from public.organisations o
  where o.id = p_organisation_id;
  if v_zone is null then
    raise exception 'That company wasn''t found.' using errcode = 'P0002';
  end if;

  perform private.timesheet_lock(p_organisation_id, p_worker_ids);

  v_from_ts := p_from::timestamp at time zone v_zone;
  v_to_ts := (p_to + 1)::timestamp at time zone v_zone;

  drop table if exists pg_temp.timesheet_calc;
  create temporary table timesheet_calc on commit drop as
  with shift_src as (
    select sa.id as assignment_id, sa.worker_id, sa.shift_id, s.post_id, sa.site_id,
      sa.shift_date as work_date, sa.starts_at, sa.ends_at,
      (sa.status = 'removed' or s.status = 'cancelled') as shift_removed
    from public.shift_assignments sa
    join public.shifts s on s.organisation_id = sa.organisation_id and s.id = sa.shift_id
    where sa.organisation_id = p_organisation_id
      and sa.shift_date between p_from and p_to
      -- Worked or missed: the shift has started. Future shifts get their line once they start.
      and sa.starts_at <= v_now
      and (p_worker_ids is null or sa.worker_id = any (p_worker_ids))
      and (
        (sa.status = 'assigned' and s.status = 'open')
        or exists (
          select 1 from public.punches p
          where p.organisation_id = sa.organisation_id and p.shift_assignment_id = sa.id
            and p.kind in ('in', 'out')
        )
      )
      and not private.timesheet_on_leave(sa.organisation_id, sa.worker_id, sa.shift_date)
  ),
  shift_rows as (
    select 'shift'::text as source, ss.assignment_id, null::uuid as no_shift_punch_id,
      ss.worker_id, ss.shift_id, ss.post_id, ss.site_id, ss.work_date, ss.starts_at, ss.ends_at,
      ss.shift_removed, l.id as line_id, l.status as line_status,
      c.set_in, c.set_out, c.set_minutes, c.set_ot, c.corrected,
      pin.id as in_id, pin.recorded_at as in_at, pin.flags as in_flags, pin.source as in_source,
      pout.id as out_id, pout.recorded_at as out_at, pout.flags as out_flags,
      pout.source as out_source
    from shift_src ss
    left join public.timesheet_lines l
      on l.organisation_id = p_organisation_id and l.shift_assignment_id = ss.assignment_id
    left join lateral (
      select
        (select x.corrected_at from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_clock_in' order by x.seq desc limit 1) as set_in,
        (select x.corrected_at from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_clock_out' order by x.seq desc limit 1) as set_out,
        (select x.minutes from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_minutes' order by x.seq desc limit 1) as set_minutes,
        (select x.ot_minutes from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_minutes' order by x.seq desc limit 1) as set_ot,
        (select x.punch_id from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'void_punch' order by x.seq desc limit 1) as void_id,
        exists (select 1 from public.timesheet_corrections x where x.line_id = l.id) as corrected
    ) c on true
    left join lateral (
      select p.id, p.recorded_at, p.flags, p.source
      from public.punches p
      where p.organisation_id = p_organisation_id and p.shift_assignment_id = ss.assignment_id
        and p.kind = 'in' and p.id is distinct from c.void_id
      order by p.recorded_at, p.created_at
      limit 1
    ) pin on true
    left join lateral (
      select p.id, p.recorded_at, p.flags, p.source
      from public.punches p
      where p.organisation_id = p_organisation_id and p.shift_assignment_id = ss.assignment_id
        and p.kind = 'out' and p.id is distinct from c.void_id
        and (pin.recorded_at is null or p.recorded_at >= pin.recorded_at)
      order by p.recorded_at desc, p.created_at desc
      limit 1
    ) pout on true
  ),
  lone_src as (
    select p.id as punch_id, p.worker_id, p.site_id, p.recorded_at as lone_at,
      (p.recorded_at at time zone v_zone)::date as work_date
    from public.punches p
    where p.organisation_id = p_organisation_id
      and p.kind = 'in'
      and p.shift_assignment_id is null
      and p.recorded_at >= v_from_ts and p.recorded_at < v_to_ts
      and (p_worker_ids is null or p.worker_id = any (p_worker_ids))
      and not private.timesheet_on_leave(
        p.organisation_id, p.worker_id, (p.recorded_at at time zone v_zone)::date
      )
  ),
  lone_rows as (
    select 'lone'::text as source, null::uuid as assignment_id, ls.punch_id as no_shift_punch_id,
      ls.worker_id, null::uuid as shift_id, null::uuid as post_id, ls.site_id, ls.work_date,
      null::timestamptz as starts_at, null::timestamptz as ends_at, false as shift_removed,
      l.id as line_id, l.status as line_status,
      c.set_in, c.set_out, c.set_minutes, c.set_ot, c.corrected,
      pin.id as in_id, pin.recorded_at as in_at, pin.flags as in_flags, pin.source as in_source,
      pout.id as out_id, pout.recorded_at as out_at, pout.flags as out_flags,
      pout.source as out_source
    from lone_src ls
    left join public.timesheet_lines l
      on l.organisation_id = p_organisation_id and l.no_shift_punch_id = ls.punch_id
    left join lateral (
      select
        (select x.corrected_at from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_clock_in' order by x.seq desc limit 1) as set_in,
        (select x.corrected_at from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_clock_out' order by x.seq desc limit 1) as set_out,
        (select x.minutes from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_minutes' order by x.seq desc limit 1) as set_minutes,
        (select x.ot_minutes from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'set_minutes' order by x.seq desc limit 1) as set_ot,
        (select x.punch_id from public.timesheet_corrections x
          where x.line_id = l.id and x.kind = 'void_punch' order by x.seq desc limit 1) as void_id,
        exists (select 1 from public.timesheet_corrections x where x.line_id = l.id) as corrected
    ) c on true
    left join lateral (
      select p.id, p.recorded_at, p.flags, p.source
      from public.punches p
      where p.organisation_id = p_organisation_id and p.id = ls.punch_id
        and p.id is distinct from c.void_id
    ) pin on true
    left join lateral (
      -- The next clock-out within 20 hours that matched no shift, before any later clock-in.
      select p.id, p.recorded_at, p.flags, p.source
      from public.punches p
      where p.organisation_id = p_organisation_id and p.worker_id = ls.worker_id
        and p.kind = 'out' and p.shift_assignment_id is null
        and p.id is distinct from c.void_id
        and p.recorded_at >= ls.lone_at and p.recorded_at <= ls.lone_at + interval '20 hours'
        and not exists (
          select 1 from public.punches q
          where q.organisation_id = p_organisation_id and q.worker_id = ls.worker_id
            and q.kind = 'in' and q.id <> ls.punch_id
            and q.recorded_at > ls.lone_at and q.recorded_at <= p.recorded_at
        )
      order by p.recorded_at, p.created_at
      limit 1
    ) pout on true
  ),
  all_rows as (
    select * from shift_rows
    union all
    select * from lone_rows
  )
  select r.source, r.assignment_id, r.no_shift_punch_id, r.worker_id, r.shift_id, r.post_id,
    r.site_id, r.work_date, r.line_id, r.line_status, r.in_id, r.out_id,
    private.timesheet_period_start(r.work_date, v_start_day) as period_start,
    m.scheduled_minutes, m.worked_minutes, m.late_minutes, m.early_minutes, m.ot_minutes,
    m.exceptions, m.needs_review
  from all_rows r
  cross join lateral private.timesheet_line_compute(
    r.starts_at, r.ends_at,
    coalesce(r.set_in, r.in_at), coalesce(r.set_out, r.out_at),
    r.set_minutes, r.set_ot,
    r.in_flags, r.out_flags,
    coalesce(r.in_source = 'supervisor', false) or coalesce(r.out_source = 'supervisor', false),
    coalesce(r.corrected, false), r.shift_removed,
    v_grace, v_no_show, v_now
  ) m;

  insert into public.timesheets (organisation_id, worker_id, period_start, period_end)
  select distinct p_organisation_id, c.worker_id, c.period_start,
    private.timesheet_period_end(c.period_start)
  from pg_temp.timesheet_calc c
  where c.line_id is null or c.line_status in ('pending', 'disputed')
  on conflict (organisation_id, worker_id, period_start) do nothing;

  update public.timesheet_lines l
  set timesheet_id = t.id,
    shift_id = c.shift_id,
    post_id = c.post_id,
    site_id = c.site_id,
    in_punch_id = c.in_id,
    out_punch_id = c.out_id,
    scheduled_minutes = c.scheduled_minutes,
    worked_minutes = c.worked_minutes,
    late_minutes = c.late_minutes,
    early_minutes = c.early_minutes,
    ot_minutes = c.ot_minutes,
    exceptions = c.exceptions,
    needs_review = c.needs_review
  from pg_temp.timesheet_calc c
  join public.timesheets t
    on t.organisation_id = p_organisation_id and t.worker_id = c.worker_id
   and t.period_start = c.period_start
  where l.id = c.line_id
    and l.status in ('pending', 'disputed')
    and (l.timesheet_id, l.shift_id, l.post_id, l.site_id, l.in_punch_id, l.out_punch_id,
         l.scheduled_minutes, l.worked_minutes, l.late_minutes, l.early_minutes, l.ot_minutes,
         l.exceptions, l.needs_review)
      is distinct from
        (t.id, c.shift_id, c.post_id, c.site_id, c.in_id, c.out_id,
         c.scheduled_minutes, c.worked_minutes, c.late_minutes, c.early_minutes, c.ot_minutes,
         c.exceptions, c.needs_review);
  get diagnostics v_updated = row_count;

  insert into public.timesheet_lines (
    organisation_id, timesheet_id, worker_id, work_date, shift_assignment_id, no_shift_punch_id,
    shift_id, post_id, site_id, in_punch_id, out_punch_id, scheduled_minutes, worked_minutes,
    late_minutes, early_minutes, ot_minutes, exceptions, needs_review
  )
  select p_organisation_id, t.id, c.worker_id, c.work_date, c.assignment_id, c.no_shift_punch_id,
    c.shift_id, c.post_id, c.site_id, c.in_id, c.out_id, c.scheduled_minutes, c.worked_minutes,
    c.late_minutes, c.early_minutes, c.ot_minutes, c.exceptions, c.needs_review
  from pg_temp.timesheet_calc c
  join public.timesheets t
    on t.organisation_id = p_organisation_id and t.worker_id = c.worker_id
   and t.period_start = c.period_start
  where c.line_id is null;
  get diagnostics v_inserted = row_count;

  -- A clock punch received after its shift's line was decided (security review L2). The decided
  -- line is frozen, so it only gains the flag late_punch_after_decision for slice 4.3's screen
  -- (reopen the day to count the punch); the punch keeps its selfie meanwhile
  -- (private.punch_under_review, case 3).
  update public.timesheet_lines l
  set exceptions = l.exceptions || 'late_punch_after_decision'::text
  where l.organisation_id = p_organisation_id
    and l.work_date between p_from and p_to
    and (p_worker_ids is null or l.worker_id = any (p_worker_ids))
    and l.status in ('approved', 'rejected')
    and l.shift_assignment_id is not null
    and not ('late_punch_after_decision' = any (l.exceptions))
    and exists (
      select 1 from public.punches p
      where p.organisation_id = p_organisation_id
        and p.shift_assignment_id = l.shift_assignment_id
        and p.kind in ('in', 'out')
        and p.id is distinct from l.in_punch_id
        and p.id is distinct from l.out_punch_id
        and p.received_at > l.decided_at
    );
  get diagnostics v_flagged = row_count;
  v_updated := v_updated + v_flagged;

  -- Pending lines whose shift no longer counts. A line a correction points at stays (slice 4.3:
  -- a line with decisions must stay too; add that table here when it lands).
  delete from public.timesheet_lines l
  where l.organisation_id = p_organisation_id
    and l.work_date between p_from and p_to
    and (p_worker_ids is null or l.worker_id = any (p_worker_ids))
    and l.status = 'pending'
    and not exists (
      select 1 from pg_temp.timesheet_calc c
      where c.assignment_id = l.shift_assignment_id or c.no_shift_punch_id = l.no_shift_punch_id
    )
    and not exists (select 1 from public.timesheet_corrections x where x.line_id = l.id);
  get diagnostics v_deleted = row_count;

  drop table if exists pg_temp.timesheet_calc;

  if v_inserted + v_updated + v_deleted > 0 then
    insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
    values (
      p_organisation_id, auth.uid(), 'timesheet.lines_refreshed', 'timesheet_lines', null, null,
      jsonb_build_object(
        'from', p_from, 'to', p_to,
        'workers', case when p_worker_ids is null then null else cardinality(p_worker_ids) end,
        'inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted
      )
    );
  end if;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted);
end;
$$;

revoke all on function private.timesheet_refresh(uuid, date, date, uuid[]) from public, anon, authenticated;

-- The screens' refresh (4.3 calls it when the timesheet screen opens) and the worker's own.
-- owner, admin, hr and ops_manager: any workers of the company (null: all); a line manager:
-- their reportees and themselves; a worker: themselves. 62 days at most. The secret key may
-- call it for any company.
create function private.refresh_timesheet_lines(
  p_organisation_id uuid,
  p_from date,
  p_to date,
  p_worker_ids uuid[] default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_workers uuid[];
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a range of 62 days or fewer.' using errcode = '22023';
  end if;
  if p_worker_ids is not null and cardinality(p_worker_ids) > 5000 then
    raise exception 'At most 5,000 employees at a time.' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    v_workers := p_worker_ids;
  elsif v_uid is null or p_organisation_id is null then
    raise exception 'Sign in to see timesheets.' using errcode = '42501';
  elsif private.has_role(p_organisation_id, array['owner', 'admin', 'hr', 'ops_manager']) then
    v_workers := p_worker_ids;
  elsif private.has_role(p_organisation_id, array['line_manager']) then
    select coalesce(array_agg(w.id), '{}'::uuid[]) into v_workers
    from public.workers w
    where w.organisation_id = p_organisation_id
      and (
        w.id in (select private.my_reportee_ids())
        or w.id in (select private.my_worker_ids())
      )
      and (p_worker_ids is null or w.id = any (p_worker_ids));
  else
    select coalesce(array_agg(m.worker_id), '{}'::uuid[]) into v_workers
    from public.memberships m
    where m.organisation_id = p_organisation_id
      and m.user_id = v_uid
      and m.role = 'worker'
      and m.worker_id is not null
      and (p_worker_ids is null or m.worker_id = any (p_worker_ids));
    -- A worker refreshes at most 35 days of their own (security review L3).
    if p_to - p_from > 35 then
      raise exception 'Choose a range of 35 days or fewer.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.memberships m
      where m.organisation_id = p_organisation_id and m.user_id = v_uid and m.role = 'worker'
    ) then
      raise exception 'Your role can''t see timesheets.' using errcode = '42501';
    end if;
  end if;
  return private.timesheet_refresh(p_organisation_id, p_from, p_to, v_workers);
end;
$$;

revoke all on function private.refresh_timesheet_lines(uuid, date, date, uuid[]) from public, anon;
grant execute on function private.refresh_timesheet_lines(uuid, date, date, uuid[])
  to authenticated, service_role;

create function public.refresh_timesheet_lines(
  p_organisation_id uuid,
  p_from date,
  p_to date,
  p_worker_ids uuid[] default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.refresh_timesheet_lines(p_organisation_id, p_from, p_to, p_worker_ids)
$$;

revoke all on function public.refresh_timesheet_lines(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.refresh_timesheet_lines(uuid, date, date, uuid[])
  to authenticated, service_role;

-- Secret key only (the daily cron): the companies to refresh after `p_after` (by id), at most
-- `p_limit`. Every company with Shifts on, and any with a clock punch in the last 3 days (a
-- company that switched Shifts off still gets its last days' lines, so their selfies follow the
-- review rule).
create function private.timesheet_cron_organisations(p_after uuid default null, p_limit integer default 50)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server runs the timesheet refresh.' using errcode = '42501';
  end if;
  return query
    select o.id
    from public.organisations o
    where (p_after is null or o.id > p_after)
      and (
        o.shifts_enabled
        or exists (
          select 1 from public.punches p
          where p.organisation_id = o.id and p.kind in ('in', 'out')
            and p.recorded_at > now() - interval '3 days'
        )
      )
    order by o.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- Secret key only (the daily cron): refreshes the last 7 days on the company's clock, so a missed
-- run catches up (security review L1), in batches of 50 workers, each in its own subtransaction.
-- A batch that fails is retried worker by worker, and a worker that still fails is counted and
-- skipped, so one bad row never blocks the company (security review M1).
-- Returns {inserted, updated, deleted, workers, failed}.
create function private.refresh_timesheets_recent(p_organisation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_from date;
  v_to date;
  v_zone text;
  v_workers uuid[];
  v_batch uuid[];
  v_worker uuid;
  v_result jsonb;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_failed integer := 0;
  v_i integer := 1;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server runs the timesheet refresh.' using errcode = '42501';
  end if;
  perform set_config('metalira.audit_channel', 'system', true);
  v_today := private.org_today(p_organisation_id);
  v_from := v_today - 7;
  v_to := v_today - 1;
  select coalesce(o.timezone, 'Africa/Lagos') into v_zone
  from public.organisations o where o.id = p_organisation_id;

  select coalesce(array_agg(x.worker_id order by x.worker_id), '{}'::uuid[]) into v_workers
  from (
    select sa.worker_id from public.shift_assignments sa
    where sa.organisation_id = p_organisation_id and sa.shift_date between v_from and v_to
    union
    select p.worker_id from public.punches p
    where p.organisation_id = p_organisation_id and p.kind in ('in', 'out')
      and p.recorded_at >= v_from::timestamp at time zone v_zone
      and p.recorded_at < (v_to + 1)::timestamp at time zone v_zone
    union
    select l.worker_id from public.timesheet_lines l
    where l.organisation_id = p_organisation_id and l.work_date between v_from and v_to
  ) x;

  while v_i <= cardinality(v_workers) loop
    v_batch := v_workers[v_i:v_i + 49];
    begin
      v_result := private.timesheet_refresh(p_organisation_id, v_from, v_to, v_batch);
      v_inserted := v_inserted + (v_result ->> 'inserted')::integer;
      v_updated := v_updated + (v_result ->> 'updated')::integer;
      v_deleted := v_deleted + (v_result ->> 'deleted')::integer;
    exception when others then
      foreach v_worker in array v_batch loop
        begin
          v_result := private.timesheet_refresh(p_organisation_id, v_from, v_to, array[v_worker]);
          v_inserted := v_inserted + (v_result ->> 'inserted')::integer;
          v_updated := v_updated + (v_result ->> 'updated')::integer;
          v_deleted := v_deleted + (v_result ->> 'deleted')::integer;
        exception when others then
          v_failed := v_failed + 1;
        end;
      end loop;
    end;
    v_i := v_i + 50;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted,
    'workers', cardinality(v_workers), 'failed', v_failed
  );
end;
$$;

revoke all on function private.timesheet_cron_organisations(uuid, integer) from public, anon, authenticated;
revoke all on function private.refresh_timesheets_recent(uuid) from public, anon, authenticated;
grant execute on function private.timesheet_cron_organisations(uuid, integer) to service_role;
grant execute on function private.refresh_timesheets_recent(uuid) to service_role;

create function public.timesheet_cron_organisations(p_after uuid default null, p_limit integer default 50)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.timesheet_cron_organisations(p_after, p_limit) $$;

create function public.refresh_timesheets_recent(p_organisation_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.refresh_timesheets_recent(p_organisation_id) $$;

revoke all on function public.timesheet_cron_organisations(uuid, integer) from public, anon, authenticated;
revoke all on function public.refresh_timesheets_recent(uuid) from public, anon, authenticated;
grant execute on function public.timesheet_cron_organisations(uuid, integer) to service_role;
grant execute on function public.refresh_timesheets_recent(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Corrections
-- ---------------------------------------------------------------------------

-- Adds one correction to a pending or disputed line and refreshes the line. The worker's line
-- manager, ops_manager, admin or owner (trusted sessions only), never on their own line.
--   set_clock_in / set_clock_out  p_corrected_at: not in the future, within 12 hours before the
--                                 shift starts (or the clock-in) and 24 hours after it ends
--   set_minutes                   p_minutes worked (0 to 1440), p_ot_minutes overtime (0 default)
--   void_punch                    p_punch_id: the line's clock-in or clock-out
-- Returns {correction_id, line_id, worked_minutes, ot_minutes, exceptions}.
create function private.add_timesheet_correction(
  p_organisation_id uuid,
  p_line_id uuid,
  p_kind text,
  p_corrected_at timestamptz,
  p_minutes integer,
  p_ot_minutes integer,
  p_punch_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
  v_line public.timesheet_lines;
  v_from timestamptz;
  v_to timestamptz;
  v_id uuid;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in to correct a timesheet.' using errcode = '42501';
  end if;
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager']) then
    raise exception 'Your role can''t correct timesheets.' using errcode = '42501';
  end if;

  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id;
  if not found then
    raise exception 'That timesheet day wasn''t found.' using errcode = 'P0002';
  end if;
  -- The refresh's lock for this worker, so a correction and a refresh of the same worker queue.
  perform private.timesheet_lock(p_organisation_id, array[v_line.worker_id]);
  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id
  for update;
  if v_line.worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t correct your own timesheet.' using errcode = 'MLTS1';
  end if;
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager'])
    and v_line.worker_id not in (select private.my_reportee_ids()) then
    raise exception 'You can correct only the timesheets of people who report to you.'
      using errcode = '42501';
  end if;
  if v_line.status not in ('pending', 'disputed') then
    raise exception 'This day is already decided. Reopen it to correct it.' using errcode = 'MLTS2';
  end if;
  if v_reason is null or not private.timesheet_reason_ok(v_reason) then
    raise exception 'Give a reason in plain text, without web addresses or long numbers.'
      using errcode = 'MLTS4';
  end if;

  if p_kind in ('set_clock_in', 'set_clock_out') then
    if v_line.shift_assignment_id is not null then
      select a.starts_at - interval '12 hours', a.ends_at + interval '24 hours' into v_from, v_to
      from public.shift_assignments a
      where a.organisation_id = p_organisation_id and a.id = v_line.shift_assignment_id;
    else
      -- A no-shift day spans at most 24 hours (security review M1): 4 hours before the clock-in
      -- that made it to 20 hours after it (its clock-out pairing window).
      select p.recorded_at - interval '4 hours', p.recorded_at + interval '20 hours'
      into v_from, v_to
      from public.punches p
      where p.organisation_id = p_organisation_id and p.id = v_line.no_shift_punch_id;
    end if;
    if p_corrected_at is null or p_corrected_at > now()
      or p_corrected_at < v_from or p_corrected_at > v_to
      or p_minutes is not null or p_ot_minutes is not null or p_punch_id is not null then
      raise exception 'Give a time on the day of this shift (within 24 hours for a day with no shift), not in the future.'
        using errcode = 'MLTS3';
    end if;
  elsif p_kind = 'set_minutes' then
    if p_minutes is null or p_minutes not between 0 and 1440
      or (p_ot_minutes is not null and p_ot_minutes not between 0 and 1440)
      or p_corrected_at is not null or p_punch_id is not null then
      raise exception 'Give the minutes worked, from 0 to 1,440.' using errcode = 'MLTS3';
    end if;
  elsif p_kind = 'void_punch' then
    if p_punch_id is null or p_punch_id not in (
        coalesce(v_line.in_punch_id, '00000000-0000-0000-0000-000000000000'::uuid),
        coalesce(v_line.out_punch_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
      or p_corrected_at is not null or p_minutes is not null or p_ot_minutes is not null then
      raise exception 'Choose this day''s clock-in or clock-out to set aside.' using errcode = 'MLTS3';
    end if;
  else
    raise exception 'Choose what to correct.' using errcode = 'MLTS3';
  end if;

  insert into public.timesheet_corrections (
    organisation_id, line_id, worker_id, kind, corrected_at, minutes, ot_minutes, punch_id,
    reason, actor_id
  ) values (
    p_organisation_id, v_line.id, v_line.worker_id, p_kind, p_corrected_at, p_minutes,
    case when p_kind = 'set_minutes' then coalesce(p_ot_minutes, 0) end, p_punch_id,
    v_reason, v_uid
  )
  returning id into v_id;

  perform private.timesheet_refresh(
    p_organisation_id, v_line.work_date, v_line.work_date, array[v_line.worker_id]
  );

  select l.* into v_line from public.timesheet_lines l where l.id = v_line.id;
  return jsonb_build_object(
    'correction_id', v_id,
    'line_id', v_line.id,
    'worked_minutes', v_line.worked_minutes,
    'ot_minutes', v_line.ot_minutes,
    'exceptions', to_jsonb(v_line.exceptions)
  );
end;
$$;

revoke all on function private.add_timesheet_correction(
  uuid, uuid, text, timestamptz, integer, integer, uuid, text
) from public, anon;
grant execute on function private.add_timesheet_correction(
  uuid, uuid, text, timestamptz, integer, integer, uuid, text
) to authenticated;

create function public.add_timesheet_correction(
  p_organisation_id uuid,
  p_line_id uuid,
  p_kind text,
  p_reason text,
  p_corrected_at timestamptz default null,
  p_minutes integer default null,
  p_ot_minutes integer default null,
  p_punch_id uuid default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_timesheet_correction(
    p_organisation_id, p_line_id, p_kind, p_corrected_at, p_minutes, p_ot_minutes, p_punch_id,
    p_reason
  )
$$;

revoke all on function public.add_timesheet_correction(
  uuid, uuid, text, text, timestamptz, integer, integer, uuid
) from public, anon;
grant execute on function public.add_timesheet_correction(
  uuid, uuid, text, text, timestamptz, integer, integer, uuid
) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Selfie retention: timesheet review replaces the placeholder (owner decision 12)
-- ---------------------------------------------------------------------------

-- Is the punch under review, so its selfie is kept past 90 days (decision 12)? Only the
-- secret-key sweep functions (punch_selfies_due, clear_punch_selfies, crew_photos_due,
-- clear_crew_photos) call it.
-- 1. A line uses the punch (its clock-in, clock-out or no-shift clock-in, or one of the line's
--    corrections sets it aside): under review while any such line is pending or disputed; not
--    once every one is approved or rejected.
-- 2. No line uses it, but its shift's line is pending or disputed: under review (the refresh
--    hasn't picked it, or it is a second clock-in the reviewer may still want).
-- 3. No line uses it and it was received after its shift's line was decided (a late punch,
--    security review L2): under review, so nothing is swept unseen; the line carries
--    late_punch_after_decision until slice 4.3 reopens it.
-- 4. Otherwise no line uses it: under review only while under 90 days old (security review L1),
--    so a punch no line ever takes (a company that switched Shifts off, a leave day) doesn't
--    keep its selfie forever. The daily cron refreshes the last 7 days, so a punch that should
--    have a line has one long before 90 days.
create or replace function private.punch_under_review(p_organisation_id uuid, p_punch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select pu.id, pu.shift_assignment_id, pu.kind, pu.received_at, pu.created_at
    from public.punches pu
    where pu.organisation_id = p_organisation_id and pu.id = p_punch_id
  ),
  uses as (
    select l.status
    from public.timesheet_lines l
    join p on l.in_punch_id = p.id or l.out_punch_id = p.id or l.no_shift_punch_id = p.id
    where l.organisation_id = p_organisation_id
    union all
    select l.status
    from public.timesheet_corrections c
    join public.timesheet_lines l on l.id = c.line_id
    where c.organisation_id = p_organisation_id and c.punch_id = p_punch_id
  ),
  shift_line as (
    select l.status, l.decided_at
    from public.timesheet_lines l
    join p on p.shift_assignment_id is not null and l.shift_assignment_id = p.shift_assignment_id
    where l.organisation_id = p_organisation_id
  )
  select case
    when exists (select 1 from uses) then
      exists (select 1 from uses u where u.status in ('pending', 'disputed'))
    when exists (select 1 from shift_line sl where sl.status in ('pending', 'disputed')) then true
    when exists (
      select 1 from shift_line sl, p
      where sl.status in ('approved', 'rejected') and p.kind in ('in', 'out')
        and p.received_at > sl.decided_at
    ) then true
    else coalesce((select p.created_at > now() - interval '90 days' from p), true)
  end
$$;

revoke all on function private.punch_under_review(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Staff ID corrections: timesheet lines are work records (slice 1.11 hook)
-- ---------------------------------------------------------------------------

-- True when the worker has punches or timesheet lines (a line is made from a punch or a shift
-- worked or missed; timesheets are their containers and corrections hang off lines), or when a
-- pay table exists (Phase 5 MUST replace those checks with real ones; until then they fail
-- closed, as before). Slices 4.4 (leave) and 4.6 (queries) add their tables here if they are
-- work records.
create or replace function private.worker_has_work_records(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_organisation_id is null or p_worker_id is null then
    return true;
  end if;
  return exists (
      select 1 from public.punches p
      where p.organisation_id = p_organisation_id and p.worker_id = p_worker_id
    )
    or exists (
      select 1 from public.timesheet_lines l
      where l.organisation_id = p_organisation_id and l.worker_id = p_worker_id
    )
    or to_regclass('public.payroll_lines') is not null
    or to_regclass('public.payslips') is not null;
end;
$$;
