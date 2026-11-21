-- Slice 4.7: My team (docs/PHASE_4.md 4.7).
--
-- (Planned as 20261121170000; 170000 to 190000 were taken by 4.3, 4.4 and 4.5 first, so this runs
-- after 4.5's leave_roster. Nothing here replaces a function 4.5 changed: the approved-leave check
-- (MLRSL) and the leave lock live in private.shift_assignments_guard, which this file leaves alone,
-- so a line manager's assignment onto approved leave is refused exactly like ops'.)
--
-- 1. Line managers assign within their crews (deferred from Phase 3's role table):
--    private.assign_worker_to_shift and private.remove_assignment, replaced from their 3.2
--    versions with one change each: besides owner, admin and ops_manager, a line_manager may call
--    them when the worker is one of their reportees (private.my_reportee_ids, never their own
--    worker record) and the post's (or the assignment's) site is one of
--    private.line_manager_site_ids; a line manager removes only shifts that haven't started
--    (MLRS6), so a started shift or a no-show can't be hidden. Everything else is unchanged, and the guard on
--    shift_assignments still refuses, for every caller, a past day, a full shift, a clash, a
--    leaver, a closed post, an archived site and approved leave. Publishing (publish_roster),
--    copying a week (copy_last_week) and "Send notices again" stay with owner, admin and
--    ops_manager (private.require_roster_role, unchanged).
-- 2. Reads for /app/team (line managers only, 42501 for anyone else or an untrusted session):
--    * public.team_shifts(org, from, to): the reportees' assigned shifts (62 days at most) with
--      site and post names and whether the caller may take them off. Line managers read
--      reportees' assignments through RLS already, but not post names (posts are ops' table).
--    * public.team_open_shifts(org, from, to): post-days at the line manager's sites from today
--      (31 days at most) that still need people: staffed by the requirement in force, the site
--      in use, the shift not cancelled, not started yet, fewer assigned than required. Counts
--      only: never who else is on the shift.
--    * public.team_leave_open_shifts(org): for each step-1 request the caller decides, the shifts
--      HR's approval would open (4.5's private.leave_shifts_to_open, decide_leave_hr's open_shifts).
-- Worker-supervisors' /m/team (owner decision 2, 21 Nov 2026) is slice 4.7b, with its own migration.
--
-- No new table, so no new policy. Every write is audited by the row triggers on
-- shift_assignments, as before.

-- ---------------------------------------------------------------------------
-- 1. Line managers assign and remove within their crews
-- ---------------------------------------------------------------------------

-- May the caller assign this worker at this site? Owner, admin and ops_manager anyone; a
-- line_manager only their reportees (never their own record) at the sites of their team.
-- Trusted sessions only (every helper reads private.session_uid()).
create function private.roster_may_assign(p_organisation_id uuid, p_worker_id uuid, p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_uid() is not null
    and p_organisation_id is not null
    and (
      private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager'])
      or (
        private.has_role(p_organisation_id, array['line_manager'])
        and p_worker_id in (select private.my_reportee_ids())
        and p_worker_id not in (select private.my_worker_ids())
        and p_site_id in (select private.line_manager_site_ids())
      )
    )
$$;

revoke all on function private.roster_may_assign(uuid, uuid, uuid) from public, anon, authenticated;

-- The refusal for a caller who may not assign this worker here.
create function private.roster_assert_may_assign(p_organisation_id uuid, p_worker_id uuid, p_site_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Your role can''t change rosters.' using errcode = '42501';
  end if;
  if private.roster_may_assign(p_organisation_id, p_worker_id, p_site_id) then
    return;
  end if;
  if private.has_role(p_organisation_id, array['line_manager']) then
    raise exception 'You can assign only people who report to you, at your team''s sites.'
      using errcode = '42501';
  end if;
  raise exception 'Your role can''t change rosters.' using errcode = '42501';
end;
$$;

revoke all on function private.roster_assert_may_assign(uuid, uuid, uuid) from public, anon, authenticated;

-- Assigns a worker to a post on a day, making the shift row on the first assignment. Returns
-- {assignment_id, shift_id, mapped}. (3.2's version, with the line-manager scope above.)
create or replace function private.assign_worker_to_shift(
  p_organisation_id uuid,
  p_post_id uuid,
  p_shift_date date,
  p_worker_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift_id uuid;
  v_site_id uuid;
  v_id uuid;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager']) then
    raise exception 'Your role can''t change rosters.' using errcode = '42501';
  end if;
  if p_shift_date is null then
    raise exception 'Choose a day.' using errcode = '22023';
  end if;
  select p.site_id into v_site_id
  from public.posts p
  where p.id = p_post_id and p.organisation_id = p_organisation_id;
  if v_site_id is null then
    raise exception 'That post wasn''t found.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.workers w where w.id = p_worker_id and w.organisation_id = p_organisation_id
  ) then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.roster_assert_may_assign(p_organisation_id, p_worker_id, v_site_id);

  -- Shared with other assigns at the site, exclusive with copy_last_week, so a copy and a
  -- hand assignment on one site never interleave.
  perform pg_advisory_xact_lock_shared(hashtextextended('roster_copy:' || v_site_id::text, 0));
  v_shift_id := private.materialise_shift(p_organisation_id, p_post_id, p_shift_date);
  -- The guard fills the site, day and times, and checks everything else (approved leave too).
  insert into public.shift_assignments (
    organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at
  )
  values (
    p_organisation_id, v_shift_id, v_site_id, p_shift_date, p_worker_id,
    now(), now() + interval '1 minute'
  )
  returning id into v_id;

  return jsonb_build_object(
    'assignment_id', v_id,
    'shift_id', v_shift_id,
    'mapped', private.mapped_to_site(p_organisation_id, p_worker_id, v_site_id, p_shift_date)
  );
end;
$$;

-- Takes a worker off a shift: the row stays, marked removed with who, when and the reason.
-- (3.2's version, with the line-manager scope above.)
create or replace function private.remove_assignment(
  p_organisation_id uuid,
  p_assignment_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.shift_assignments%rowtype;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager']) then
    raise exception 'Your role can''t change rosters.' using errcode = '42501';
  end if;
  select * into v_row
  from public.shift_assignments a
  where a.id = p_assignment_id and a.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'That assignment wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.roster_assert_may_assign(p_organisation_id, v_row.worker_id, v_row.site_id);
  -- A line manager (not owner, admin or ops_manager) takes people off shifts that haven't
  -- started only, so a started or finished shift (and a no-show on it) can't be hidden.
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager'])
    and v_row.starts_at <= now() then
    raise exception 'This shift has started. Ask ops to change it.' using errcode = 'MLRS6';
  end if;
  if v_row.status = 'removed' then
    raise exception 'This assignment was already removed.' using errcode = 'MLRS8';
  end if;
  if v_reason is not null and (
    char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]' or v_reason ~* '(://|www\.)'
  ) then
    raise exception 'Keep the reason to 500 characters of plain text, without web addresses.'
      using errcode = 'MLRS0';
  end if;

  update public.shift_assignments a
  set status = 'removed',
    removed_at = now(),
    removed_by = private.session_uid(),
    removed_reason = v_reason
  where a.id = p_assignment_id;

  return jsonb_build_object(
    'assignment_id', p_assignment_id,
    'shift_id', v_row.shift_id,
    'worker_id', v_row.worker_id,
    'shift_date', v_row.shift_date
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Reads for /app/team (line managers)
-- ---------------------------------------------------------------------------

-- The reportees' assigned shifts from p_from to p_to (62 days at most), with names, and whether
-- the caller may take each one off (their team's site, not started). Line managers only.
create function private.team_shifts(p_organisation_id uuid, p_from date, p_to date)
returns table (
  assignment_id uuid,
  worker_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_id uuid,
  site_name text,
  post_id uuid,
  post_name text,
  can_remove boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['line_manager']) then
    raise exception 'Only line managers see their team''s shifts.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    raise exception 'Ask for 62 days or fewer at a time.' using errcode = '22023';
  end if;
  return query
  select a.id, a.worker_id, a.shift_date, a.starts_at, a.ends_at, a.site_id, si.name, s.post_id,
    po.name,
    a.site_id in (select private.line_manager_site_ids()) and a.starts_at > now()
  from public.shift_assignments a
  join public.shifts s on s.organisation_id = a.organisation_id and s.id = a.shift_id
  join public.posts po on po.organisation_id = s.organisation_id and po.id = s.post_id
  join public.sites si on si.organisation_id = a.organisation_id and si.id = a.site_id
  where a.organisation_id = p_organisation_id
    and a.status = 'assigned'
    and a.shift_date between p_from and p_to
    and a.worker_id in (select private.my_reportee_ids())
    and a.worker_id not in (select private.my_worker_ids())
  order by a.starts_at, a.id
  limit 2000;
end;
$$;

revoke all on function private.team_shifts(uuid, date, date) from public, anon;
grant execute on function private.team_shifts(uuid, date, date) to authenticated;

create function public.team_shifts(p_organisation_id uuid, p_from date, p_to date)
returns table (
  assignment_id uuid,
  worker_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_id uuid,
  site_name text,
  post_id uuid,
  post_name text,
  can_remove boolean
)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.team_shifts(p_organisation_id, p_from, p_to) $$;

revoke all on function public.team_shifts(uuid, date, date) from public, anon;
grant execute on function public.team_shifts(uuid, date, date) to authenticated;

-- Post-days at the line manager's sites from today to p_to (31 days at most) that still need
-- people: the requirement in force staffs the post that day, the site is in use, the shift (if
-- made yet) isn't cancelled and hasn't started, and fewer people are assigned than required.
-- Counts only, never who else is on it. Nothing while the company has Shifts off.
create function private.team_open_shifts(p_organisation_id uuid, p_from date, p_to date)
returns table (
  post_id uuid,
  post_name text,
  site_id uuid,
  site_name text,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  required_count integer,
  assigned_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['line_manager']) then
    raise exception 'Only line managers see their team''s open shifts.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30 then
    raise exception 'Ask for 31 days or fewer at a time.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organisations o where o.id = p_organisation_id and o.shifts_enabled
  ) then
    return;
  end if;
  v_from := greatest(p_from, private.org_today(p_organisation_id));
  if v_from > p_to then
    return;
  end if;
  return query
  select p.id, r.post_name, si.id, si.name, d.day::date, r.starts_at, r.ends_at,
    r.required_count, coalesce(n.assigned, 0)::integer
  from public.posts p
  join public.sites si
    on si.organisation_id = p.organisation_id and si.id = p.site_id and si.status = 'active'
  cross join generate_series(v_from::timestamp, p_to::timestamp, interval '1 day') as d (day)
  cross join lateral private.post_day_requirement(p_organisation_id, p.id, d.day::date) r
  left join public.shifts s
    on s.organisation_id = p.organisation_id and s.post_id = p.id and s.shift_date = d.day::date
  left join lateral (
    select count(*) as assigned
    from public.shift_assignments a
    where a.organisation_id = p.organisation_id and a.shift_id = s.id and a.status = 'assigned'
  ) n on true
  where p.organisation_id = p_organisation_id
    and p.site_id in (select private.line_manager_site_ids())
    and (s.id is null or s.status <> 'cancelled')
    and r.starts_at > now()
    and coalesce(n.assigned, 0) < r.required_count
  order by r.starts_at, r.post_name, p.id
  limit 300;
end;
$$;

revoke all on function private.team_open_shifts(uuid, date, date) from public, anon;
grant execute on function private.team_open_shifts(uuid, date, date) to authenticated;

create function public.team_open_shifts(p_organisation_id uuid, p_from date, p_to date)
returns table (
  post_id uuid,
  post_name text,
  site_id uuid,
  site_name text,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  required_count integer,
  assigned_count integer
)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.team_open_shifts(p_organisation_id, p_from, p_to) $$;

revoke all on function public.team_open_shifts(uuid, date, date) from public, anon;
grant execute on function public.team_open_shifts(uuid, date, date) to authenticated;

-- The shifts each step-1 request waiting for the caller would open when HR approves it: 4.5's
-- private.leave_shifts_to_open (the same rows decide_leave_hr's dry run lists as open_shifts), for
-- the requests pending_line_manager that the caller may decide (private.leave_can_decide_step1).
-- Line managers only; nothing for anyone else's requests.
create function private.team_leave_open_shifts(p_organisation_id uuid)
returns table (
  request_id uuid,
  assignment_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_id uuid,
  site_name text,
  post_id uuid,
  post_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['line_manager']) then
    raise exception 'Only line managers see their team''s leave cover.' using errcode = '42501';
  end if;
  return query
  select r.id, o.assignment_id, o.shift_date, o.starts_at, o.ends_at, o.site_id, o.site_name,
    o.post_id, o.post_name
  from public.leave_requests r
  cross join lateral private.leave_shifts_to_open(
    r.organisation_id, r.worker_id, r.start_date, r.end_date
  ) o
  where r.organisation_id = p_organisation_id
    and r.status = 'pending_line_manager'
    and r.worker_id in (select private.my_reportee_ids())
    and private.leave_can_decide_step1(r.organisation_id, r.worker_id)
  order by r.id, o.starts_at, o.assignment_id
  limit 2000;
end;
$$;

revoke all on function private.team_leave_open_shifts(uuid) from public, anon;
grant execute on function private.team_leave_open_shifts(uuid) to authenticated;

create function public.team_leave_open_shifts(p_organisation_id uuid)
returns table (
  request_id uuid,
  assignment_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_id uuid,
  site_name text,
  post_id uuid,
  post_name text
)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.team_leave_open_shifts(p_organisation_id) $$;

revoke all on function public.team_leave_open_shifts(uuid) from public, anon;
grant execute on function public.team_leave_open_shifts(uuid) to authenticated;
