-- Slice 4.3: timesheet approval and Work Units.
--
-- 1. `timesheet_decisions`: insert-only for every role, the secret key and the database owner
--    included (row guard and a statement-level truncate guard). One row per decision on a
--    timesheet line: approved, rejected, disputed (the worker) or reopened, with a reason
--    (required except for approved; plain text, no web addresses, no runs of 10 or more digits),
--    the actor and a snapshot of the minutes and exceptions decided. A line's status follows its
--    latest decision and is set only by the functions below.
-- 2. `work_units`: one per approved timesheet day on a post that counted minutes (worked or
--    overtime above 0): contract, site, post, shift, worker, line, kind shift_post, date, the
--    post's unit (shift, hour or visit), quantity_minutes, ot_minutes, billable (manned_post and
--    per_visit contracts; fixed_monthly and per_job are recorded but billed by month or job in
--    Phase 6), status approved or cancelled. Minutes only: no money, no kobo; Phase 6 prices a
--    unit from the rate card in force on its date. Insert-only like the decisions, except that a
--    unit moves from approved to cancelled exactly once, naming the reopen (or the worker's
--    dispute of an approved day) that cancelled it. At most one approved unit per line (partial
--    unique index); a reopened line keeps its cancelled unit and a new approval makes a new one.
--    No-shift days and days with 0 minutes make none. shifts.work_unit_id stays null: a shift can
--    hold several people, so the unit hangs off the line.
-- 3. Decisions, each one transaction under the worker's refresh lock (private.timesheet_lock):
--    approve_timesheet_line, reject_timesheet_line, approve_clean_timesheet_lines (multi-row,
--    with a dry run for the preview; refuses the rest by name), reopen_timesheet_line (owner,
--    admin, ops_manager; refused once Phase 5 posts the period, a hook that returns false for now)
--    and dispute_timesheet_line (the worker, own day, pending or approved, the period open, at
--    most 3 times). Approvers (owner decision 6): the worker's line manager, ops_manager, admin or
--    owner, never the worker themselves. Every function refreshes the line first, so a decision
--    never freezes a day that misses a punch already received.
-- 4. "Clean" (Approve N clean): pending, needs_review false, the shift finished, and no
--    exceptions except informational ones: `supervisor`, plus `no_location` and `no_selfie` when
--    every punch on the line carrying them was made by a supervisor (crew clock-in, slice 3.6).
--    Mirrored in src/lib/timesheets/approval.ts.
-- 5. The refresh (private.timesheet_refresh, replaced): a stale pending line with decisions is
--    kept (must-do 1); late punches are flagged by private.timesheet_flag_late_punches, keyed on
--    the punch's line (shift lines by assignment, no-shift lines by the clock-out pairing), from a
--    punches trigger as the punch arrives and from a catch-up over punches received in the last 7
--    days (must-do 6).
-- 6. private.punch_under_review: a punch that arrived after its line was decided is kept until the
--    line is reopened and decided again, or 180 days from when it arrived at most; no-shift lines
--    count too.
-- 7. refresh_timesheets_recent returns the distinct SQLSTATE codes of the workers that failed
--    (codes only); the cron route logs them and answers 500.
-- 8. Reads for the screens: timesheet_review_days (managers) and my_timesheet_days (the worker);
--    preview_timesheet_correction (current against new minutes, nothing saved).
--
-- Refusals (SQLSTATE), mapped in src/server/workforce/timesheet-approval.ts:
--   MLTA0 a change the guards never allow (decisions and Work Units are insert-only)
--   MLTA1 a decision on your own day           MLTA2 the day isn't in a state that allows it
--   MLTA3 the shift hasn't finished yet          MLTA4 the reason is missing or isn't plain text
--   MLTA5 the pay period is posted (Phase 5)     MLTA6 the day was disputed 3 times already
--   MLTA7 the day changed since it was opened    42501 the wrong role or an untrusted session
--   P0002 the day isn't in the company (or no longer counts)   22023 an input that isn't valid
-- Nothing here stores money.

-- ---------------------------------------------------------------------------
-- 1. Hooks and pure helpers (mirrored in src/lib/timesheets/approval.ts)
-- ---------------------------------------------------------------------------

-- Has Phase 5 posted the pay period holding this day? Reopening and disputing are refused once it
-- has. Phase 5 MUST replace this with a real check of its posted runs; until then nothing is.
create function private.timesheet_period_posted(p_organisation_id uuid, p_work_date date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select false
$$;

-- Is a Work Unit on a contract of this type billable? manned_post and per_visit are billed by the
-- unit; fixed_monthly and per_job are billed by month or job (Phase 6), so their units are
-- recorded but not billable.
create function private.work_unit_billable(p_contract_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_contract_type in ('manned_post', 'per_visit'), false)
$$;

-- Is a line clean (Approve N clean)? Pending, nothing to review, and no exceptions except the
-- informational ones: `supervisor`, and `no_location` / `no_selfie` when no punch on the line
-- that carries them was made by the worker themselves (a crew clock-in has neither by design).
create function private.timesheet_line_is_clean(
  p_status text,
  p_exceptions text[],
  p_needs_review boolean,
  p_in_source text,
  p_in_flags text[],
  p_out_source text,
  p_out_flags text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_status = 'pending', false)
    and not coalesce(p_needs_review, true)
    and not exists (
      select 1
      from unnest(coalesce(p_exceptions, '{}'::text[])) as e (name)
      where e.name <> 'supervisor'
        and not (
          e.name in ('no_location', 'no_selfie')
          and 'supervisor' = any (coalesce(p_exceptions, '{}'::text[]))
          and not (
            coalesce(p_in_source, 'self') <> 'supervisor'
            and e.name = any (coalesce(p_in_flags, '{}'::text[]))
          )
          and not (
            coalesce(p_out_source, 'self') <> 'supervisor'
            and e.name = any (coalesce(p_out_flags, '{}'::text[]))
          )
        )
    )
$$;

revoke all on function private.timesheet_period_posted(uuid, date) from public, anon, authenticated;
revoke all on function private.work_unit_billable(text) from public, anon, authenticated;
revoke all on function private.timesheet_line_is_clean(text, text[], boolean, text, text[], text, text[])
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.timesheet_decisions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  line_id uuid not null,
  -- The line's worker (composite foreign key), so the worker reads their own decisions.
  worker_id uuid not null,
  decision text not null
    constraint timesheet_decisions_decision_value check (
      decision in ('approved', 'rejected', 'disputed', 'reopened')
    ),
  reason text
    constraint timesheet_decisions_reason_text check (
      reason is null or private.timesheet_reason_ok(reason)
    ),
  actor_id uuid not null default auth.uid(),
  -- The minutes and exceptions the decision was made on.
  scheduled_minutes integer not null
    constraint timesheet_decisions_scheduled_range check (scheduled_minutes between 0 and 1440),
  worked_minutes integer not null
    constraint timesheet_decisions_worked_range check (worked_minutes between 0 and 1440),
  late_minutes integer not null
    constraint timesheet_decisions_late_range check (late_minutes between 0 and 1440),
  early_minutes integer not null
    constraint timesheet_decisions_early_range check (early_minutes between 0 and 1440),
  ot_minutes integer not null
    constraint timesheet_decisions_ot_range check (ot_minutes between 0 and 1440),
  exceptions text[] not null default '{}'
    constraint timesheet_decisions_exceptions_known check (
      exceptions <@ private.timesheet_exception_names()
    ),
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  -- Order of decisions (the latest one is the line's status).
  seq bigint generated always as identity,
  constraint timesheet_decisions_organisation_id_id_key unique (organisation_id, id),
  constraint timesheet_decisions_org_id_line_key unique (organisation_id, id, line_id),
  constraint timesheet_decisions_line_fkey foreign key (organisation_id, line_id, worker_id)
    references public.timesheet_lines (organisation_id, id, worker_id),
  constraint timesheet_decisions_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint timesheet_decisions_reason_needed check (decision = 'approved' or reason is not null)
);

create index timesheet_decisions_line_idx on public.timesheet_decisions (line_id, seq desc);
create index timesheet_decisions_worker_idx on public.timesheet_decisions (worker_id);

comment on table public.timesheet_decisions is
  'Decisions on timesheet days (slice 4.3): approved, rejected, disputed, reopened, with a reason (required except approved), the actor and the minutes decided. Insert-only for every role, the secret key and the database owner included. A line''s status follows its latest decision.';

create table public.work_units (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  contract_id uuid not null,
  site_id uuid not null,
  post_id uuid not null,
  shift_id uuid not null,
  timesheet_line_id uuid not null,
  worker_id uuid not null,
  -- Phase 8's projects; null for shift work.
  project_id uuid,
  kind text not null default 'shift_post'
    constraint work_units_kind_value check (kind in ('shift_post', 'visit', 'job', 'milestone')),
  work_date date not null,
  -- Copied from the post: what Phase 6 prices by.
  unit text not null
    constraint work_units_unit_value check (unit in ('shift', 'hour', 'visit')),
  quantity_minutes integer not null
    constraint work_units_quantity_range check (quantity_minutes between 0 and 1440),
  ot_minutes integer not null default 0
    constraint work_units_ot_range check (ot_minutes between 0 and 1440),
  -- The contract's type when the unit was made, and whether that makes it billable.
  contract_type text not null
    constraint work_units_contract_type_value check (
      contract_type in ('manned_post', 'per_visit', 'fixed_monthly', 'per_job')
    ),
  billable boolean not null,
  status text not null default 'approved'
    constraint work_units_status_value check (status in ('approved', 'cancelled')),
  -- The approval that made it.
  approved_decision_id uuid not null,
  -- The reopen (or the worker's dispute of an approved day) that cancelled it.
  cancelled_by_decision_id uuid,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint work_units_organisation_id_id_key unique (organisation_id, id),
  constraint work_units_contract_fkey foreign key (organisation_id, contract_id)
    references public.contracts (organisation_id, id),
  constraint work_units_post_fkey foreign key (organisation_id, post_id, contract_id, site_id)
    references public.posts (organisation_id, id, contract_id, site_id),
  constraint work_units_shift_fkey foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id),
  constraint work_units_line_fkey foreign key (organisation_id, timesheet_line_id, worker_id)
    references public.timesheet_lines (organisation_id, id, worker_id),
  constraint work_units_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint work_units_project_fkey foreign key (organisation_id, project_id)
    references public.projects (organisation_id, id),
  constraint work_units_approved_decision_fkey
    foreign key (organisation_id, approved_decision_id, timesheet_line_id)
    references public.timesheet_decisions (organisation_id, id, line_id),
  constraint work_units_cancelled_decision_fkey
    foreign key (organisation_id, cancelled_by_decision_id, timesheet_line_id)
    references public.timesheet_decisions (organisation_id, id, line_id),
  constraint work_units_billable_rule check (
    billable = (contract_type in ('manned_post', 'per_visit'))
  ),
  constraint work_units_cancelled check (
    (status = 'cancelled') = (cancelled_by_decision_id is not null)
    and (status = 'cancelled') = (cancelled_at is not null)
  )
);

-- One Work Unit per approved line.
create unique index work_units_one_approved_per_line on public.work_units (timesheet_line_id)
  where status = 'approved';
create index work_units_org_date_idx on public.work_units (organisation_id, work_date);
create index work_units_contract_date_idx on public.work_units (contract_id, work_date);
create index work_units_line_idx on public.work_units (timesheet_line_id);

comment on table public.work_units is
  'Billable work (slice 4.3): one per approved timesheet day on a post with minutes. Minutes only, no money; Phase 6 prices it from the rate card in force on its date. Insert-only, except approved to cancelled once by a reopen (or a dispute of an approved day). Never deleted.';

-- A line's Work Unit (filled by the approval).
alter table public.timesheet_lines
  add constraint timesheet_lines_work_unit_fkey foreign key (organisation_id, work_unit_id)
    references public.work_units (organisation_id, id);

-- The late-punch scan reads punches by when they arrived.
create index if not exists punches_org_received_idx on public.punches (organisation_id, received_at);

-- ---------------------------------------------------------------------------
-- 3. Guards and audit
-- ---------------------------------------------------------------------------

-- timesheet_decisions: insert only; the actor and time are the server's.
create function private.timesheet_decisions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A timesheet decision never changes. Add a new one instead.' using errcode = 'MLTA0';
  end if;
  new.actor_id := coalesce(private.session_uid(), auth.uid(), new.actor_id);
  new.created_at := now();
  return new;
end;
$$;

-- work_units: a new unit is approved; an approved unit becomes cancelled once, naming a reopen or
-- dispute decision on its own line, and nothing else ever changes; never deleted.
create function private.work_units_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving constant text[] := array['status', 'cancelled_by_decision_id', 'cancelled_at'];
  v_kind text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'approved' or new.cancelled_by_decision_id is not null then
      raise exception 'A new Work Unit starts approved.' using errcode = 'MLTA0';
    end if;
    new.created_at := now();
    new.cancelled_at := null;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A Work Unit is never deleted. Reopen its day to cancel it.' using errcode = 'MLTA0';
  end if;
  if old.status <> 'approved' or new.status <> 'cancelled' or new.cancelled_by_decision_id is null
    or (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'A Work Unit never changes, except to be cancelled once by reopening its day.'
      using errcode = 'MLTA0';
  end if;
  select d.decision into v_kind
  from public.timesheet_decisions d
  where d.organisation_id = new.organisation_id
    and d.id = new.cancelled_by_decision_id
    and d.line_id = new.timesheet_line_id;
  if v_kind is null or v_kind not in ('reopened', 'disputed') then
    raise exception 'Only reopening its day cancels a Work Unit.' using errcode = 'MLTA0';
  end if;
  new.cancelled_at := now();
  return new;
end;
$$;

create function private.timesheet_approval_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Timesheet decisions and Work Units are never deleted.' using errcode = 'MLTA0';
end;
$$;

revoke all on function private.timesheet_decisions_guard() from public, anon, authenticated;
revoke all on function private.work_units_guard() from public, anon, authenticated;
revoke all on function private.timesheet_approval_no_truncate() from public, anon, authenticated;

create trigger timesheet_decisions_guard
  before insert or update or delete on public.timesheet_decisions
  for each row execute function private.timesheet_decisions_guard();
create trigger timesheet_decisions_no_truncate before truncate on public.timesheet_decisions
  for each statement execute function private.timesheet_approval_no_truncate();
create trigger timesheet_decisions_audit after insert on public.timesheet_decisions
  for each row execute function private.audit_row_change();

create trigger work_units_guard before insert or update or delete on public.work_units
  for each row execute function private.work_units_guard();
create trigger work_units_no_truncate before truncate on public.work_units
  for each statement execute function private.timesheet_approval_no_truncate();
create trigger work_units_audit after insert or update on public.work_units
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants
-- ---------------------------------------------------------------------------
-- Read (PHASE_4 Roles): decisions as the lines (owner, admin, hr and ops_manager every row; a
-- line manager their reportees'; the worker their own); Work Units owner, admin, finance and
-- ops_manager. No write grants for anyone, the secret key included: the functions below are the
-- only writers.

alter table public.timesheet_decisions enable row level security;
alter table public.work_units enable row level security;

create policy timesheet_decisions_select on public.timesheet_decisions for select to authenticated
  using (
    worker_id in (select private.my_worker_ids())
    or organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr', 'ops_manager']))
    or worker_id in (select private.my_reportee_ids())
  );

create policy work_units_select on public.work_units for select to authenticated
  using (
    organisation_id in (select private.role_org_ids(array['owner', 'admin', 'finance', 'ops_manager']))
  );

revoke all on table public.timesheet_decisions from anon, authenticated;
revoke all on table public.work_units from anon, authenticated;
revoke insert, update, delete, truncate on table public.timesheet_decisions from service_role;
revoke insert, update, delete, truncate on table public.work_units from service_role;
grant select on table public.timesheet_decisions to authenticated;
grant select on table public.work_units to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Late punches (must-do 6) and the refresh
-- ---------------------------------------------------------------------------

-- Flags the decided lines that a clock punch arrived after: a shift line whose assignment the
-- punch is on, or a no-shift line whose clock-in a no-shift clock-out pairs with (the next
-- clock-out within 20 hours, before any later clock-in, earlier than the line's own clock-out).
-- The punches are `p_punch_ids`, or those of `p_worker_ids` (null: every worker) received after
-- `p_since`. A decided line is frozen, so it only gains late_punch_after_decision; Reopen counts
-- the punch. Returns how many lines were flagged. No role check: only the trigger and the
-- refresh call it.
create function private.timesheet_flag_late_punches(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_since timestamptz,
  p_punch_ids uuid[]
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_organisation_id is null or (p_punch_ids is null and p_since is null) then
    return 0;
  end if;
  with recent as (
    select p.id, p.worker_id, p.kind, p.shift_assignment_id, p.recorded_at, p.received_at
    from public.punches p
    where p.organisation_id = p_organisation_id
      and p.kind in ('in', 'out')
      and (p_punch_ids is null or p.id = any (p_punch_ids))
      and (p_since is null or p.received_at > p_since)
      and (p_worker_ids is null or p.worker_id = any (p_worker_ids))
  ),
  hit as (
    select l.id
    from recent r
    join public.timesheet_lines l
      on l.organisation_id = p_organisation_id and l.shift_assignment_id = r.shift_assignment_id
    where r.shift_assignment_id is not null
      and l.status in ('approved', 'rejected')
      and r.id is distinct from l.in_punch_id
      and r.id is distinct from l.out_punch_id
      and r.received_at > l.decided_at
    union
    select l.id
    from recent r
    join public.timesheet_lines l
      on l.organisation_id = p_organisation_id and l.worker_id = r.worker_id
     and l.no_shift_punch_id is not null
    join public.punches pin
      on pin.organisation_id = p_organisation_id and pin.id = l.no_shift_punch_id
    left join public.punches pout
      on pout.organisation_id = p_organisation_id and pout.id = l.out_punch_id
    where r.shift_assignment_id is null
      and r.kind = 'out'
      and l.status in ('approved', 'rejected')
      and r.id is distinct from l.out_punch_id
      and r.received_at > l.decided_at
      and r.recorded_at >= pin.recorded_at
      and r.recorded_at <= pin.recorded_at + interval '20 hours'
      and (pout.id is null or r.recorded_at < pout.recorded_at)
      and not exists (
        select 1 from public.punches q
        where q.organisation_id = p_organisation_id and q.worker_id = r.worker_id
          and q.kind = 'in' and q.id <> pin.id
          and q.recorded_at > pin.recorded_at and q.recorded_at <= r.recorded_at
      )
  )
  update public.timesheet_lines l
  set exceptions = l.exceptions || 'late_punch_after_decision'::text
  where l.organisation_id = p_organisation_id
    and l.id in (select h.id from hit h)
    and l.status in ('approved', 'rejected')
    and not ('late_punch_after_decision' = any (l.exceptions));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.timesheet_flag_late_punches(uuid, uuid[], timestamptz, uuid[])
  from public, anon, authenticated;

-- As a clock punch arrives, flag the decided line it belongs to. Never blocks the punch: on any
-- error the refresh's 7-day catch-up flags it later.
create function private.punches_flag_late()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('in', 'out') then
    begin
      perform private.timesheet_flag_late_punches(new.organisation_id, null, null, array[new.id]);
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;

revoke all on function private.punches_flag_late() from public, anon, authenticated;

create trigger punches_flag_late after insert on public.punches
  for each row execute function private.punches_flag_late();

-- The refresh (slice 4.2), replaced: a stale pending line with decisions stays (must-do 1), and
-- late punches are flagged by private.timesheet_flag_late_punches over the last 7 days of
-- arrivals, whatever the line's work date (must-do 6). Everything else is as 4.2 built it.
create or replace function private.timesheet_refresh(
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

  -- Late punches (slice 4.3, must-do 6): a clock punch received after its line was decided only
  -- flags that line late_punch_after_decision (the line is frozen; Reopen counts the punch). The
  -- punches trigger flags it as the punch arrives; this catch-up scans every punch these workers
  -- sent in the last 7 days, whatever the line's work date, shift lines and no-shift lines alike.
  v_flagged := private.timesheet_flag_late_punches(
    p_organisation_id, p_worker_ids, v_now - interval '7 days', null
  );
  v_updated := v_updated + v_flagged;

  -- Pending lines whose shift no longer counts. A line a correction or a decision points at stays
  -- (a reopened line has decisions; slice 4.3, must-do 1).
  delete from public.timesheet_lines l
  where l.organisation_id = p_organisation_id
    and l.work_date between p_from and p_to
    and (p_worker_ids is null or l.worker_id = any (p_worker_ids))
    and l.status = 'pending'
    and not exists (
      select 1 from pg_temp.timesheet_calc c
      where c.assignment_id = l.shift_assignment_id or c.no_shift_punch_id = l.no_shift_punch_id
    )
    and not exists (select 1 from public.timesheet_corrections x where x.line_id = l.id)
    and not exists (select 1 from public.timesheet_decisions d where d.line_id = l.id);
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

-- The daily cron (slice 4.2), replaced: workers with a punch received in the last 7 days are
-- refreshed too (late punches), and the result names the distinct SQLSTATE codes of the workers
-- that failed (codes only, never a message, a row or a name; must-do 7).
create or replace function private.refresh_timesheets_recent(p_organisation_id uuid)
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
  v_code text;
  v_codes text[] := '{}';
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
    union
    -- Punches that arrived in the last 7 days, whatever day they claim (late punches, must-do 6).
    select p.worker_id from public.punches p
    where p.organisation_id = p_organisation_id and p.kind in ('in', 'out')
      and p.received_at > now() - interval '7 days'
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
          -- The SQLSTATE only (a fixed code, never a message, a row or a name).
          get stacked diagnostics v_code = returned_sqlstate;
          v_failed := v_failed + 1;
          if not (v_code = any (v_codes)) and cardinality(v_codes) < 20 then
            v_codes := v_codes || v_code;
          end if;
        end;
      end loop;
    end;
    v_i := v_i + 50;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted,
    'workers', cardinality(v_workers), 'failed', v_failed,
    'failed_codes', to_jsonb(v_codes)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Decisions
-- ---------------------------------------------------------------------------

-- May the caller decide this worker's days (owner decision 6)? Owner, admin and ops_manager for
-- any worker of the company; a line manager for their reportees; never anyone for their own
-- worker record. Trusted sessions only (the helpers read private.session_uid()).
create function private.timesheet_can_decide(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_uid() is not null
    and p_organisation_id is not null
    and p_worker_id is not null
    and p_worker_id not in (select private.my_worker_ids())
    and (
      private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager'])
      or (
        private.has_role(p_organisation_id, array['line_manager'])
        and p_worker_id in (select private.my_reportee_ids())
      )
    )
$$;

-- Raises the right refusal when the caller may not decide this worker's days.
create function private.timesheet_assert_decider(p_organisation_id uuid, p_worker_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t decide your own timesheet.' using errcode = 'MLTA1';
  end if;
  if not private.timesheet_can_decide(p_organisation_id, p_worker_id) then
    raise exception 'You can decide only the timesheets of people who report to you.'
      using errcode = '42501';
  end if;
end;
$$;

-- Is the line's day still running? A shift line until its shift ends, and while its clock-out
-- window (end + 4 hours) is open with a clock-in and no clock-out; a no-shift line while it has
-- no clock-out and its clock-in is under 20 hours old. A running day can't be approved.
create function private.timesheet_line_running(p_organisation_id uuid, p_line_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when l.shift_assignment_id is not null then exists (
        select 1 from public.shift_assignments a
        where a.organisation_id = l.organisation_id and a.id = l.shift_assignment_id
          and (
            a.ends_at > now()
            or (l.in_punch_id is not null and l.out_punch_id is null
                and a.ends_at + interval '4 hours' > now())
          )
      )
      else l.out_punch_id is null and exists (
        select 1 from public.punches p
        where p.organisation_id = l.organisation_id and p.id = l.no_shift_punch_id
          and p.recorded_at > now() - interval '20 hours'
      )
    end
    from public.timesheet_lines l
    where l.organisation_id = p_organisation_id and l.id = p_line_id
  ), false)
$$;

-- Is the line clean, reading its punches' sources and flags?
create function private.timesheet_line_clean(p_organisation_id uuid, p_line_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.timesheet_line_is_clean(
      l.status, l.exceptions, l.needs_review, pin.source, pin.flags, pout.source, pout.flags
    )
    from public.timesheet_lines l
    left join public.punches pin on pin.organisation_id = l.organisation_id and pin.id = l.in_punch_id
    left join public.punches pout on pout.organisation_id = l.organisation_id and pout.id = l.out_punch_id
    where l.organisation_id = p_organisation_id and l.id = p_line_id
  ), false)
$$;

-- Normalises a reason: spaces collapsed, trimmed, null when empty.
create function private.timesheet_clean_reason(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '')
$$;

-- Records one decision with the line's minutes. No checks: callers check first.
create function private.timesheet_record_decision(
  p_line public.timesheet_lines,
  p_decision text,
  p_reason text,
  p_uid uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.timesheet_decisions (
    organisation_id, line_id, worker_id, decision, reason, actor_id, scheduled_minutes,
    worked_minutes, late_minutes, early_minutes, ot_minutes, exceptions, needs_review
  ) values (
    p_line.organisation_id, p_line.id, p_line.worker_id, p_decision, p_reason, p_uid,
    p_line.scheduled_minutes, p_line.worked_minutes, p_line.late_minutes, p_line.early_minutes,
    p_line.ot_minutes, p_line.exceptions, p_line.needs_review
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Approves one line: the decision, its Work Unit (a shift line with minutes; billable by the
-- contract's type) and the line's status. No checks: callers check first.
-- Returns {decision_id, work_unit_id, billable}.
create function private.timesheet_approve_one(p_line public.timesheet_lines, p_reason text, p_uid uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_decision uuid;
  v_unit uuid;
  v_billable boolean;
  v_post record;
begin
  v_decision := private.timesheet_record_decision(p_line, 'approved', p_reason, p_uid);
  if p_line.shift_assignment_id is not null and p_line.post_id is not null
    and (p_line.worked_minutes > 0 or p_line.ot_minutes > 0) then
    select po.id, po.contract_id, po.site_id, po.unit, c.type as contract_type
    into v_post
    from public.posts po
    join public.contracts c on c.organisation_id = po.organisation_id and c.id = po.contract_id
    where po.organisation_id = p_line.organisation_id and po.id = p_line.post_id;
    if found then
      v_billable := private.work_unit_billable(v_post.contract_type);
      insert into public.work_units (
        organisation_id, contract_id, site_id, post_id, shift_id, timesheet_line_id, worker_id,
        kind, work_date, unit, quantity_minutes, ot_minutes, contract_type, billable,
        approved_decision_id
      ) values (
        p_line.organisation_id, v_post.contract_id, v_post.site_id, v_post.id, p_line.shift_id,
        p_line.id, p_line.worker_id, 'shift_post', p_line.work_date, v_post.unit,
        p_line.worked_minutes, p_line.ot_minutes, v_post.contract_type, v_billable, v_decision
      )
      returning id into v_unit;
    end if;
  end if;
  update public.timesheet_lines
  set status = 'approved', work_unit_id = v_unit
  where organisation_id = p_line.organisation_id and id = p_line.id;
  return jsonb_build_object('decision_id', v_decision, 'work_unit_id', v_unit, 'billable', v_billable);
end;
$$;

-- Takes the worker's lock, refreshes the line's day and returns the line locked for update, or
-- raises P0002 when it is gone (a pending day that no longer counts is deleted by the refresh).
create function private.timesheet_fresh_line(p_organisation_id uuid, p_line_id uuid)
returns public.timesheet_lines
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_line public.timesheet_lines;
begin
  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id;
  if not found then
    raise exception 'That timesheet day wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.timesheet_lock(p_organisation_id, array[v_line.worker_id]);
  if v_line.status in ('pending', 'disputed') then
    perform private.timesheet_refresh(
      p_organisation_id, v_line.work_date, v_line.work_date, array[v_line.worker_id]
    );
  end if;
  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id
  for update;
  if not found then
    raise exception 'That day no longer counts. Reload the page.' using errcode = 'P0002';
  end if;
  return v_line;
end;
$$;

revoke all on function private.timesheet_can_decide(uuid, uuid) from public, anon, authenticated;
revoke all on function private.timesheet_assert_decider(uuid, uuid) from public, anon, authenticated;
revoke all on function private.timesheet_line_running(uuid, uuid) from public, anon, authenticated;
revoke all on function private.timesheet_line_clean(uuid, uuid) from public, anon, authenticated;
revoke all on function private.timesheet_clean_reason(text) from public, anon, authenticated;
revoke all on function private.timesheet_record_decision(public.timesheet_lines, text, text, uuid)
  from public, anon, authenticated;
revoke all on function private.timesheet_approve_one(public.timesheet_lines, text, uuid)
  from public, anon, authenticated;
revoke all on function private.timesheet_fresh_line(uuid, uuid) from public, anon, authenticated;

-- Approves one pending or disputed day. The worker's line manager, ops_manager, admin or owner,
-- never their own day; the shift must have finished. The day is refreshed first: when that
-- changes its minutes or exceptions the approval is refused (MLTA7) so the approver sees them.
-- p_reason is optional. Returns {line_id, decision_id, work_unit_id, billable, worked_minutes,
-- ot_minutes}.
create function private.approve_timesheet_line(
  p_organisation_id uuid,
  p_line_id uuid,
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
  v_reason text := private.timesheet_clean_reason(p_reason);
  v_before public.timesheet_lines;
  v_line public.timesheet_lines;
  v_result jsonb;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in to decide timesheets.' using errcode = '42501';
  end if;
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager']) then
    raise exception 'Your role can''t decide timesheets.' using errcode = '42501';
  end if;
  select l.* into v_before
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id;
  if not found then
    raise exception 'That timesheet day wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.timesheet_assert_decider(p_organisation_id, v_before.worker_id);
  if v_reason is not null and not private.timesheet_reason_ok(v_reason) then
    raise exception 'Give a reason in plain text, without web addresses or long numbers.'
      using errcode = 'MLTA4';
  end if;
  v_line := private.timesheet_fresh_line(p_organisation_id, p_line_id);
  if v_line.status not in ('pending', 'disputed') then
    raise exception 'This day is already decided.' using errcode = 'MLTA2';
  end if;
  if private.timesheet_line_running(p_organisation_id, v_line.id) then
    raise exception 'This shift hasn''t finished yet. Approve it once it ends.' using errcode = 'MLTA3';
  end if;
  if (v_line.worked_minutes, v_line.ot_minutes, v_line.exceptions, v_line.needs_review)
    is distinct from
     (v_before.worked_minutes, v_before.ot_minutes, v_before.exceptions, v_before.needs_review) then
    raise exception 'This day changed since you opened it. Check it again.' using errcode = 'MLTA7';
  end if;
  v_result := private.timesheet_approve_one(v_line, v_reason, v_uid);
  return v_result || jsonb_build_object(
    'line_id', v_line.id, 'worked_minutes', v_line.worked_minutes, 'ot_minutes', v_line.ot_minutes
  );
end;
$$;

-- Rejects one pending or disputed day with a reason. Same approvers as approval. The worker is
-- told by the server (notifyWorker). Returns {line_id, decision_id}.
create function private.reject_timesheet_line(
  p_organisation_id uuid,
  p_line_id uuid,
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
  v_reason text := private.timesheet_clean_reason(p_reason);
  v_line public.timesheet_lines;
  v_decision uuid;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in to decide timesheets.' using errcode = '42501';
  end if;
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager']) then
    raise exception 'Your role can''t decide timesheets.' using errcode = '42501';
  end if;
  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id;
  if not found then
    raise exception 'That timesheet day wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.timesheet_assert_decider(p_organisation_id, v_line.worker_id);
  if v_reason is null or not private.timesheet_reason_ok(v_reason) then
    raise exception 'Give a reason in plain text, without web addresses or long numbers.'
      using errcode = 'MLTA4';
  end if;
  v_line := private.timesheet_fresh_line(p_organisation_id, p_line_id);
  if v_line.status not in ('pending', 'disputed') then
    raise exception 'This day is already decided.' using errcode = 'MLTA2';
  end if;
  v_decision := private.timesheet_record_decision(v_line, 'rejected', v_reason, v_uid);
  update public.timesheet_lines
  set status = 'rejected', work_unit_id = null
  where organisation_id = p_organisation_id and id = v_line.id;
  return jsonb_build_object(
    'line_id', v_line.id, 'decision_id', v_decision, 'worker_id', v_line.worker_id,
    'work_date', v_line.work_date
  );
end;
$$;

-- "Approve N clean": approves the listed lines that are clean (pending, nothing to review, the
-- shift finished, informational exceptions only; see private.timesheet_line_is_clean) and that
-- the caller may decide, after refreshing their days. Every other line is refused by name with a
-- fixed code: not_found (not in the company or not one the caller may read; no name given),
-- own, not_yours, decided, disputed, running, needs_review, flagged. At most 500 lines whose days
-- span at most 62 days. p_dry_run: works everything out, then rolls it all back (the preview).
-- Returns {dry_run, approved: [...], refused: [...]}.
create function private.approve_clean_timesheet_lines(
  p_organisation_id uuid,
  p_line_ids uuid[],
  p_dry_run boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_all_reader boolean;
  v_ids uuid[];
  v_workers uuid[];
  v_from date;
  v_to date;
  v_row record;
  v_line public.timesheet_lines;
  v_code text;
  v_result jsonb;
  v_approved jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_out jsonb;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in to decide timesheets.' using errcode = '42501';
  end if;
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager']) then
    raise exception 'Your role can''t decide timesheets.' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct u.id), '{}'::uuid[]) into v_ids
  from unnest(coalesce(p_line_ids, '{}'::uuid[])) as u (id)
  where u.id is not null;
  if cardinality(v_ids) = 0 or cardinality(v_ids) > 500 then
    raise exception 'Choose from 1 to 500 days.' using errcode = '22023';
  end if;
  v_all_reader := private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']);

  select coalesce(array_agg(distinct l.worker_id), '{}'::uuid[]), min(l.work_date), max(l.work_date)
  into v_workers, v_from, v_to
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = any (v_ids);
  if v_to - v_from > 62 then
    raise exception 'Choose days within 62 days of each other.' using errcode = '22023';
  end if;

  begin
    if cardinality(v_workers) > 0 then
      perform private.timesheet_lock(p_organisation_id, v_workers);
      perform private.timesheet_refresh(p_organisation_id, v_from, v_to, v_workers);
    end if;

    for v_row in
      select u.id as line_id, l.id as found_id, l.worker_id,
        nullif(btrim(concat_ws(' ', w.first_name, w.last_name)), '') as worker_name,
        l.work_date
      from unnest(v_ids) as u (id)
      left join public.timesheet_lines l
        on l.organisation_id = p_organisation_id and l.id = u.id
      left join public.workers w on w.organisation_id = l.organisation_id and w.id = l.worker_id
      order by l.work_date nulls last, worker_name, u.id
    loop
      -- A line the caller may not read is "not found", with no name.
      if v_row.found_id is null or not (
        v_all_reader
        or v_row.worker_id in (select private.my_reportee_ids())
        or v_row.worker_id in (select private.my_worker_ids())
      ) then
        v_refused := v_refused || jsonb_build_object('line_id', v_row.line_id, 'code', 'not_found');
        continue;
      end if;
      select l.* into v_line
      from public.timesheet_lines l
      where l.organisation_id = p_organisation_id and l.id = v_row.line_id
      for update;
      v_code := case
        when v_line.worker_id in (select private.my_worker_ids()) then 'own'
        when not private.timesheet_can_decide(p_organisation_id, v_line.worker_id) then 'not_yours'
        when v_line.status in ('approved', 'rejected') then 'decided'
        when v_line.status = 'disputed' then 'disputed'
        when private.timesheet_line_running(p_organisation_id, v_line.id) then 'running'
        when v_line.needs_review then 'needs_review'
        when not private.timesheet_line_clean(p_organisation_id, v_line.id) then 'flagged'
      end;
      if v_code is not null then
        v_refused := v_refused || jsonb_build_object(
          'line_id', v_line.id, 'code', v_code, 'worker_name', v_row.worker_name,
          'work_date', v_line.work_date, 'exceptions', to_jsonb(v_line.exceptions)
        );
        continue;
      end if;
      v_result := private.timesheet_approve_one(v_line, null, v_uid);
      v_approved := v_approved || jsonb_build_object(
        'line_id', v_line.id, 'worker_name', v_row.worker_name, 'work_date', v_line.work_date,
        'worked_minutes', v_line.worked_minutes, 'ot_minutes', v_line.ot_minutes,
        'work_unit_id', v_result -> 'work_unit_id', 'billable', v_result -> 'billable'
      );
    end loop;

    if not coalesce(p_dry_run, false) and jsonb_array_length(v_approved) > 0 then
      perform private.log_audit_impl(
        p_organisation_id, 'timesheet.clean_approved', 'timesheet_lines', null, null,
        jsonb_build_object(
          'approved', jsonb_array_length(v_approved), 'refused', jsonb_array_length(v_refused),
          'from', v_from, 'to', v_to
        ),
        null
      );
    end if;
    v_out := jsonb_build_object(
      'dry_run', coalesce(p_dry_run, false), 'approved', v_approved, 'refused', v_refused
    );
    if coalesce(p_dry_run, false) then
      -- The preview: undo every write in this block (variables keep their values).
      raise exception 'preview' using errcode = 'MLTAP';
    end if;
  exception when sqlstate 'MLTAP' then
    null;
  end;
  return v_out;
end;
$$;

-- Reopens an approved or rejected day so it can be decided again: a `reopened` decision with a
-- reason, its Work Unit cancelled (naming that decision), the line back to pending and refreshed,
-- so a late punch now counts. Owner, admin and ops_manager, never their own day; refused once
-- Phase 5 posts the period. Returns {line_id, decision_id, cancelled_work_unit_id,
-- worked_minutes, ot_minutes, exceptions}.
create function private.reopen_timesheet_line(
  p_organisation_id uuid,
  p_line_id uuid,
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
  v_reason text := private.timesheet_clean_reason(p_reason);
  v_line public.timesheet_lines;
  v_decision uuid;
  v_unit uuid;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in to reopen a timesheet.' using errcode = '42501';
  end if;
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t reopen timesheets.' using errcode = '42501';
  end if;
  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id;
  if not found then
    raise exception 'That timesheet day wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.timesheet_assert_decider(p_organisation_id, v_line.worker_id);
  if v_reason is null or not private.timesheet_reason_ok(v_reason) then
    raise exception 'Give a reason in plain text, without web addresses or long numbers.'
      using errcode = 'MLTA4';
  end if;
  perform private.timesheet_lock(p_organisation_id, array[v_line.worker_id]);
  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id
  for update;
  if v_line.status not in ('approved', 'rejected') then
    raise exception 'Only an approved or rejected day can be reopened.' using errcode = 'MLTA2';
  end if;
  if private.timesheet_period_posted(p_organisation_id, v_line.work_date) then
    raise exception 'Payroll for this period is posted. This day can''t be reopened.'
      using errcode = 'MLTA5';
  end if;
  v_decision := private.timesheet_record_decision(v_line, 'reopened', v_reason, v_uid);
  update public.work_units
  set status = 'cancelled', cancelled_by_decision_id = v_decision
  where organisation_id = p_organisation_id and timesheet_line_id = v_line.id
    and status = 'approved'
  returning id into v_unit;
  update public.timesheet_lines
  set status = 'pending', work_unit_id = null
  where organisation_id = p_organisation_id and id = v_line.id;
  perform private.timesheet_refresh(
    p_organisation_id, v_line.work_date, v_line.work_date, array[v_line.worker_id]
  );
  select l.* into v_line from public.timesheet_lines l where l.id = p_line_id;
  return jsonb_build_object(
    'line_id', v_line.id, 'decision_id', v_decision, 'cancelled_work_unit_id', v_unit,
    'worked_minutes', v_line.worked_minutes, 'ot_minutes', v_line.ot_minutes,
    'exceptions', to_jsonb(v_line.exceptions)
  );
end;
$$;

-- "This is wrong": the worker disputes their own day while it is pending or approved and its
-- period is open, with a reason, at most 3 times a day. The day goes back to the approver
-- (status disputed; its punches stay under review); an approved day's Work Unit is cancelled,
-- naming the dispute. The company comes from the line, which must be the caller's own.
-- Returns {line_id, decision_id, cancelled_work_unit_id}.
create function private.dispute_timesheet_line(p_line_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_reason text := private.timesheet_clean_reason(p_reason);
  v_line public.timesheet_lines;
  v_decision uuid;
  v_unit uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to send this.' using errcode = '42501';
  end if;
  select l.* into v_line
  from public.timesheet_lines l
  where l.id = p_line_id and l.worker_id in (select private.my_worker_ids());
  if not found then
    raise exception 'That day wasn''t found.' using errcode = 'P0002';
  end if;
  if v_reason is null or not private.timesheet_reason_ok(v_reason) then
    raise exception 'Say what is wrong in plain text, without web addresses or long numbers.'
      using errcode = 'MLTA4';
  end if;
  perform private.timesheet_lock(v_line.organisation_id, array[v_line.worker_id]);
  select l.* into v_line
  from public.timesheet_lines l
  where l.organisation_id = v_line.organisation_id and l.id = p_line_id
  for update;
  if v_line.status not in ('pending', 'approved') then
    raise exception 'This day is already with your manager or was decided.' using errcode = 'MLTA2';
  end if;
  if private.timesheet_period_posted(v_line.organisation_id, v_line.work_date) then
    raise exception 'Payroll for this period is posted. Speak to your manager.' using errcode = 'MLTA5';
  end if;
  if (
    select count(*) from public.timesheet_decisions d
    where d.organisation_id = v_line.organisation_id and d.line_id = v_line.id
      and d.decision = 'disputed'
  ) >= 3 then
    raise exception 'You have flagged this day 3 times. Speak to your manager.' using errcode = 'MLTA6';
  end if;
  perform set_config('metalira.audit_channel', 'worker_app', true);
  v_decision := private.timesheet_record_decision(v_line, 'disputed', v_reason, v_uid);
  update public.work_units
  set status = 'cancelled', cancelled_by_decision_id = v_decision
  where organisation_id = v_line.organisation_id and timesheet_line_id = v_line.id
    and status = 'approved'
  returning id into v_unit;
  update public.timesheet_lines
  set status = 'disputed', work_unit_id = null
  where organisation_id = v_line.organisation_id and id = v_line.id;
  return jsonb_build_object(
    'line_id', v_line.id, 'decision_id', v_decision, 'cancelled_work_unit_id', v_unit
  );
end;
$$;

-- "Adjust hours" preview (must-do 4): the minutes now and after the correction, nothing saved.
-- Runs add_timesheet_correction (every check, the insert and the refresh) and rolls it back.
-- Returns {line_id, current: {worked_minutes, ot_minutes, exceptions}, next: {...}}.
create function private.preview_timesheet_correction(
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
  v_before public.timesheet_lines;
  v_after jsonb;
begin
  begin
    v_after := private.add_timesheet_correction(
      p_organisation_id, p_line_id, p_kind, p_corrected_at, p_minutes, p_ot_minutes, p_punch_id,
      p_reason
    );
    raise exception 'preview' using errcode = 'MLTAP';
  exception when sqlstate 'MLTAP' then
    null;
  end;
  -- add_timesheet_correction checked the caller; read the day as it stands.
  select l.* into v_before
  from public.timesheet_lines l
  where l.organisation_id = p_organisation_id and l.id = p_line_id;
  return jsonb_build_object(
    'line_id', p_line_id,
    'current', jsonb_build_object(
      'worked_minutes', v_before.worked_minutes, 'ot_minutes', v_before.ot_minutes,
      'exceptions', to_jsonb(v_before.exceptions)
    ),
    'next', jsonb_build_object(
      'worked_minutes', v_after -> 'worked_minutes', 'ot_minutes', v_after -> 'ot_minutes',
      'exceptions', v_after -> 'exceptions'
    )
  );
end;
$$;

revoke all on function private.approve_timesheet_line(uuid, uuid, text) from public, anon;
revoke all on function private.reject_timesheet_line(uuid, uuid, text) from public, anon;
revoke all on function private.approve_clean_timesheet_lines(uuid, uuid[], boolean) from public, anon;
revoke all on function private.reopen_timesheet_line(uuid, uuid, text) from public, anon;
revoke all on function private.dispute_timesheet_line(uuid, text) from public, anon;
revoke all on function private.preview_timesheet_correction(
  uuid, uuid, text, timestamptz, integer, integer, uuid, text
) from public, anon;
grant execute on function private.approve_timesheet_line(uuid, uuid, text) to authenticated;
grant execute on function private.reject_timesheet_line(uuid, uuid, text) to authenticated;
grant execute on function private.approve_clean_timesheet_lines(uuid, uuid[], boolean) to authenticated;
grant execute on function private.reopen_timesheet_line(uuid, uuid, text) to authenticated;
grant execute on function private.dispute_timesheet_line(uuid, text) to authenticated;
grant execute on function private.preview_timesheet_correction(
  uuid, uuid, text, timestamptz, integer, integer, uuid, text
) to authenticated;

create function public.approve_timesheet_line(
  p_organisation_id uuid,
  p_line_id uuid,
  p_reason text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.approve_timesheet_line(p_organisation_id, p_line_id, p_reason) $$;

create function public.reject_timesheet_line(p_organisation_id uuid, p_line_id uuid, p_reason text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.reject_timesheet_line(p_organisation_id, p_line_id, p_reason) $$;

create function public.approve_clean_timesheet_lines(
  p_organisation_id uuid,
  p_line_ids uuid[],
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.approve_clean_timesheet_lines(p_organisation_id, p_line_ids, p_dry_run) $$;

create function public.reopen_timesheet_line(p_organisation_id uuid, p_line_id uuid, p_reason text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.reopen_timesheet_line(p_organisation_id, p_line_id, p_reason) $$;

create function public.dispute_timesheet_line(p_line_id uuid, p_reason text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.dispute_timesheet_line(p_line_id, p_reason) $$;

create function public.preview_timesheet_correction(
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
  select private.preview_timesheet_correction(
    p_organisation_id, p_line_id, p_kind, p_corrected_at, p_minutes, p_ot_minutes, p_punch_id,
    p_reason
  )
$$;

revoke all on function public.approve_timesheet_line(uuid, uuid, text) from public, anon;
revoke all on function public.reject_timesheet_line(uuid, uuid, text) from public, anon;
revoke all on function public.approve_clean_timesheet_lines(uuid, uuid[], boolean) from public, anon;
revoke all on function public.reopen_timesheet_line(uuid, uuid, text) from public, anon;
revoke all on function public.dispute_timesheet_line(uuid, text) from public, anon;
revoke all on function public.preview_timesheet_correction(
  uuid, uuid, text, text, timestamptz, integer, integer, uuid
) from public, anon;
grant execute on function public.approve_timesheet_line(uuid, uuid, text) to authenticated;
grant execute on function public.reject_timesheet_line(uuid, uuid, text) to authenticated;
grant execute on function public.approve_clean_timesheet_lines(uuid, uuid[], boolean) to authenticated;
grant execute on function public.reopen_timesheet_line(uuid, uuid, text) to authenticated;
grant execute on function public.dispute_timesheet_line(uuid, text) to authenticated;
grant execute on function public.preview_timesheet_correction(
  uuid, uuid, text, text, timestamptz, integer, integer, uuid
) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Reads for the screens
-- ---------------------------------------------------------------------------

-- The timesheet screen (/app/timesheets): every line from p_from to p_to (62 days at most) the
-- caller may read, with the worker's name, the site and post, the shift, both punches (times,
-- device against server time, distance and geofence, self or supervisor, whether a selfie is on
-- file; never the location), the contract type and whether its Work Unit is billable, the latest
-- decision and correction, and what the caller may do. Owner, admin, hr and ops_manager every
-- line; a line manager their reportees'. 42501 otherwise.
create function private.timesheet_review_days(p_organisation_id uuid, p_from date, p_to date)
returns table (
  line_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  work_date date,
  status text,
  shift_assignment_id uuid,
  site_id uuid,
  site_name text,
  post_name text,
  post_unit text,
  contract_type text,
  billable boolean,
  starts_at timestamptz,
  ends_at timestamptz,
  scheduled_minutes integer,
  worked_minutes integer,
  late_minutes integer,
  early_minutes integer,
  ot_minutes integer,
  exceptions text[],
  needs_review boolean,
  clean boolean,
  running boolean,
  can_decide boolean,
  can_reopen boolean,
  work_unit_id uuid,
  in_punch_id uuid,
  in_recorded_at timestamptz,
  in_device_time timestamptz,
  in_received_at timestamptz,
  in_time_source text,
  in_drift_seconds integer,
  in_distance_m integer,
  in_accuracy_m integer,
  in_geofence text,
  in_source text,
  in_has_selfie boolean,
  out_punch_id uuid,
  out_recorded_at timestamptz,
  out_device_time timestamptz,
  out_received_at timestamptz,
  out_time_source text,
  out_drift_seconds integer,
  out_distance_m integer,
  out_accuracy_m integer,
  out_geofence text,
  out_source text,
  out_has_selfie boolean,
  last_decision text,
  last_decision_reason text,
  last_decision_at timestamptz,
  last_correction_reason text,
  corrections integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_all boolean;
  v_crew boolean;
  v_reopen boolean;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Your role can''t see timesheets.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a range of 62 days or fewer.' using errcode = '22023';
  end if;
  v_all := private.has_role(p_organisation_id, array['owner', 'admin', 'hr', 'ops_manager']);
  v_crew := not v_all and private.has_role(p_organisation_id, array['line_manager']);
  if not (v_all or v_crew) then
    raise exception 'Your role can''t see timesheets.' using errcode = '42501';
  end if;
  v_reopen := private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']);

  return query
    select l.id, l.worker_id,
      nullif(btrim(concat_ws(' ', w.first_name, w.last_name)), ''),
      w.staff_id, l.work_date, l.status, l.shift_assignment_id, l.site_id, si.name, po.name,
      po.unit, c.type,
      case when c.type is null then null else private.work_unit_billable(c.type) end,
      sa.starts_at, sa.ends_at,
      l.scheduled_minutes, l.worked_minutes, l.late_minutes, l.early_minutes, l.ot_minutes,
      l.exceptions, l.needs_review,
      private.timesheet_line_is_clean(
        l.status, l.exceptions, l.needs_review, pin.source, pin.flags, pout.source, pout.flags
      ),
      private.timesheet_line_running(p_organisation_id, l.id),
      private.timesheet_can_decide(p_organisation_id, l.worker_id),
      v_reopen and private.timesheet_can_decide(p_organisation_id, l.worker_id)
        and l.status in ('approved', 'rejected')
        and not private.timesheet_period_posted(p_organisation_id, l.work_date),
      l.work_unit_id,
      pin.id, pin.recorded_at, pin.device_time, pin.received_at, pin.time_source,
      pin.clock_drift_seconds, pin.distance_m, pin.accuracy_m, pin.geofence_result, pin.source,
      pin.selfie_path is not null,
      pout.id, pout.recorded_at, pout.device_time, pout.received_at, pout.time_source,
      pout.clock_drift_seconds, pout.distance_m, pout.accuracy_m, pout.geofence_result,
      pout.source, pout.selfie_path is not null,
      d.decision, d.reason, d.created_at,
      x.reason, coalesce(x.n, 0)::integer
    from public.timesheet_lines l
    join public.workers w on w.organisation_id = l.organisation_id and w.id = l.worker_id
    left join public.sites si on si.organisation_id = l.organisation_id and si.id = l.site_id
    left join public.posts po on po.organisation_id = l.organisation_id and po.id = l.post_id
    left join public.contracts c on c.organisation_id = po.organisation_id and c.id = po.contract_id
    left join public.shift_assignments sa
      on sa.organisation_id = l.organisation_id and sa.id = l.shift_assignment_id
    left join public.punches pin on pin.organisation_id = l.organisation_id and pin.id = l.in_punch_id
    left join public.punches pout on pout.organisation_id = l.organisation_id and pout.id = l.out_punch_id
    left join lateral (
      select dd.decision, dd.reason, dd.created_at
      from public.timesheet_decisions dd
      where dd.organisation_id = l.organisation_id and dd.line_id = l.id
      order by dd.seq desc
      limit 1
    ) d on true
    left join lateral (
      select
        (select xx.reason from public.timesheet_corrections xx
          where xx.organisation_id = l.organisation_id and xx.line_id = l.id
          order by xx.seq desc limit 1) as reason,
        (select count(*) from public.timesheet_corrections xx
          where xx.organisation_id = l.organisation_id and xx.line_id = l.id) as n
    ) x on true
    where l.organisation_id = p_organisation_id
      and l.work_date between p_from and p_to
      and (v_all or l.worker_id in (select private.my_reportee_ids()))
    order by l.work_date, 3, l.id;
end;
$$;

revoke all on function private.timesheet_review_days(uuid, date, date) from public, anon;
grant execute on function private.timesheet_review_days(uuid, date, date) to authenticated;

create function public.timesheet_review_days(p_organisation_id uuid, p_from date, p_to date)
returns table (
  line_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  work_date date,
  status text,
  shift_assignment_id uuid,
  site_id uuid,
  site_name text,
  post_name text,
  post_unit text,
  contract_type text,
  billable boolean,
  starts_at timestamptz,
  ends_at timestamptz,
  scheduled_minutes integer,
  worked_minutes integer,
  late_minutes integer,
  early_minutes integer,
  ot_minutes integer,
  exceptions text[],
  needs_review boolean,
  clean boolean,
  running boolean,
  can_decide boolean,
  can_reopen boolean,
  work_unit_id uuid,
  in_punch_id uuid,
  in_recorded_at timestamptz,
  in_device_time timestamptz,
  in_received_at timestamptz,
  in_time_source text,
  in_drift_seconds integer,
  in_distance_m integer,
  in_accuracy_m integer,
  in_geofence text,
  in_source text,
  in_has_selfie boolean,
  out_punch_id uuid,
  out_recorded_at timestamptz,
  out_device_time timestamptz,
  out_received_at timestamptz,
  out_time_source text,
  out_drift_seconds integer,
  out_distance_m integer,
  out_accuracy_m integer,
  out_geofence text,
  out_source text,
  out_has_selfie boolean,
  last_decision text,
  last_decision_reason text,
  last_decision_at timestamptz,
  last_correction_reason text,
  corrections integer
)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.timesheet_review_days(p_organisation_id, p_from, p_to) $$;

revoke all on function public.timesheet_review_days(uuid, date, date) from public, anon;
grant execute on function public.timesheet_review_days(uuid, date, date) to authenticated;

-- The worker's own days (/m/hours) in the company from p_from to p_to (62 days at most): site,
-- post, shift, clock-in and clock-out times, minutes, exceptions, status, the latest decision and
-- its reason, the latest correction's reason, and whether "This is wrong" is open. Only lines of
-- the caller's own worker record.
create function private.my_timesheet_days(p_organisation_id uuid, p_from date, p_to date)
returns table (
  line_id uuid,
  work_date date,
  status text,
  site_name text,
  post_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  in_recorded_at timestamptz,
  out_recorded_at timestamptz,
  scheduled_minutes integer,
  worked_minutes integer,
  late_minutes integer,
  early_minutes integer,
  ot_minutes integer,
  exceptions text[],
  last_decision text,
  last_decision_reason text,
  last_correction_reason text,
  can_dispute boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to see your hours.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a range of 62 days or fewer.' using errcode = '22023';
  end if;
  return query
    select l.id, l.work_date, l.status, si.name, po.name, sa.starts_at, sa.ends_at,
      pin.recorded_at, pout.recorded_at,
      l.scheduled_minutes, l.worked_minutes, l.late_minutes, l.early_minutes, l.ot_minutes,
      l.exceptions, d.decision, d.reason, x.reason,
      l.status in ('pending', 'approved')
        and not private.timesheet_period_posted(l.organisation_id, l.work_date)
        and coalesce(dc.n, 0) < 3
    from public.timesheet_lines l
    left join public.sites si on si.organisation_id = l.organisation_id and si.id = l.site_id
    left join public.posts po on po.organisation_id = l.organisation_id and po.id = l.post_id
    left join public.shift_assignments sa
      on sa.organisation_id = l.organisation_id and sa.id = l.shift_assignment_id
    left join public.punches pin on pin.organisation_id = l.organisation_id and pin.id = l.in_punch_id
    left join public.punches pout on pout.organisation_id = l.organisation_id and pout.id = l.out_punch_id
    left join lateral (
      select dd.decision, dd.reason
      from public.timesheet_decisions dd
      where dd.organisation_id = l.organisation_id and dd.line_id = l.id
      order by dd.seq desc
      limit 1
    ) d on true
    left join lateral (
      select count(*) as n
      from public.timesheet_decisions dd
      where dd.organisation_id = l.organisation_id and dd.line_id = l.id
        and dd.decision = 'disputed'
    ) dc on true
    left join lateral (
      select xx.reason
      from public.timesheet_corrections xx
      where xx.organisation_id = l.organisation_id and xx.line_id = l.id
      order by xx.seq desc
      limit 1
    ) x on true
    where l.organisation_id = p_organisation_id
      and l.worker_id in (select private.my_worker_ids())
      and l.work_date between p_from and p_to
    order by l.work_date desc, sa.starts_at desc nulls last, l.id;
end;
$$;

revoke all on function private.my_timesheet_days(uuid, date, date) from public, anon;
grant execute on function private.my_timesheet_days(uuid, date, date) to authenticated;

create function public.my_timesheet_days(p_organisation_id uuid, p_from date, p_to date)
returns table (
  line_id uuid,
  work_date date,
  status text,
  site_name text,
  post_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  in_recorded_at timestamptz,
  out_recorded_at timestamptz,
  scheduled_minutes integer,
  worked_minutes integer,
  late_minutes integer,
  early_minutes integer,
  ot_minutes integer,
  exceptions text[],
  last_decision text,
  last_decision_reason text,
  last_correction_reason text,
  can_dispute boolean
)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.my_timesheet_days(p_organisation_id, p_from, p_to) $$;

revoke all on function public.my_timesheet_days(uuid, date, date) from public, anon;
grant execute on function public.my_timesheet_days(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Selfie retention (decision 12): an upper limit on late punches, and no-shift lines
-- ---------------------------------------------------------------------------

-- As slice 4.2's four cases, with two changes:
-- * the punch's line may be a no-shift line its clock-out pairs with (as the refresh pairs it);
-- * case 3 (the punch arrived after its line was decided) keeps the selfie until the line is
--   reopened and decided again (decided_at then passes the punch's arrival), or 180 days from
--   when it arrived at most.
create or replace function private.punch_under_review(p_organisation_id uuid, p_punch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select pu.id, pu.worker_id, pu.shift_assignment_id, pu.kind, pu.recorded_at, pu.received_at,
      pu.created_at
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
    union all
    select l.status, l.decided_at
    from public.timesheet_lines l
    join p on p.shift_assignment_id is null and p.kind = 'out' and l.worker_id = p.worker_id
    join public.punches pin
      on pin.organisation_id = p_organisation_id and pin.id = l.no_shift_punch_id
    where l.organisation_id = p_organisation_id
      and p.recorded_at >= pin.recorded_at
      and p.recorded_at <= pin.recorded_at + interval '20 hours'
  )
  select case
    when exists (select 1 from uses) then
      exists (select 1 from uses u where u.status in ('pending', 'disputed'))
    when exists (select 1 from shift_line sl where sl.status in ('pending', 'disputed')) then true
    when exists (
      select 1 from shift_line sl, p
      where sl.status in ('approved', 'rejected') and p.kind in ('in', 'out')
        and p.received_at > sl.decided_at
        and p.received_at > now() - interval '180 days'
    ) then true
    else coalesce((select p.created_at > now() - interval '90 days' from p), true)
  end
$$;

revoke all on function private.punch_under_review(uuid, uuid) from public, anon, authenticated;
