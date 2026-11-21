-- Slice 3.7: the live attendance board (/app/attendance).
--
-- Worked out on read, polled every 30 seconds by the screen; no cron, no stored status.
--
-- 1. `private.attendance_status`: the status of one rostered worker at a moment, pure, mirrored in
--    src/lib/attendance-board.ts (tests/unit/workforce/attendance-board.test.ts; the RLS suite
--    checks both agree):
--      clocked_out  the worker's latest punch on the shift is a clock-out
--      on_site      the latest punch is a clock-in (early, on time or late; the lateness is
--                   reported beside it)
--      no_show      no clock-in and either the shift has ended or more than
--                   no_show_after_minutes have passed since the start
--      late         no clock-in and more than late_grace_minutes have passed since the start
--      starting     no clock-in yet: the shift starts within 2 hours, or started within the grace
--                   period
--    The boundaries follow the punches' own late flag (slice 3.5): a clock-in exactly at the end
--    of the grace period is on time, so a worker becomes late only after it; likewise a worker
--    becomes a no-show only after no_show_after_minutes (owner decision 3, 20 Nov 2026: 10 and 60
--    by default, organisations.late_grace_minutes and no_show_after_minutes).
-- 2. `public.attendance_board(org)`: one row per rostered worker whose shift touches the company's
--    today (ends after the company's midnight) and starts no more than 2 hours from now, with
--    the worker, site, post, shift times, their punches on that shift (first clock-in, latest
--    punch, every flag), the status, and each site's last synced punch. A security definer in
--    private with search_path '' behind a public invoker wrapper, as the roster reads are:
--    * the caller must be owner, admin, hr or ops_manager of the organisation (every row), or a
--      line_manager there (their reportees' rows only: "their crews"), in a trusted session
--      (private.has_role and private.my_reportee_ids use private.session_uid()); finance,
--      workers, other companies and untrusted password sessions get 42501. Matches the slice 3
--      access table: punches are read by owner, admin, hr, ops_manager and line managers for
--      their crews.
--    * the phone number is returned only to roles that read it on the people record
--      (workers_select: owner, admin, hr, finance, ops_manager, and a line manager for their
--      reportees); the last four digits are always returned so the screen can mask it.
--    * nothing while the company has Shifts switched off (slice 3.0).
--    * one statement: the assignments in the window by (organisation_id, starts_at), their
--      punches by the new (organisation_id, shift_assignment_id) index, the sites' last sync by
--      (organisation_id, recorded_at). No loops, no per-row lookups.
-- Times are timestamptz; the screen shows them in the company's time zone (Africa/Lagos).
-- Nothing here writes, so nothing is audited. No new table, so no new policy.

-- ---------------------------------------------------------------------------
-- 1. Index for the punches of an assignment
-- ---------------------------------------------------------------------------

create index punches_org_assignment_idx
  on public.punches (organisation_id, shift_assignment_id, recorded_at)
  where shift_assignment_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Status of one rostered worker (pure)
-- ---------------------------------------------------------------------------

create function private.attendance_status(
  p_now timestamptz,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_late_grace_minutes integer,
  p_no_show_after_minutes integer,
  p_last_punch_kind text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_last_punch_kind = 'out' then 'clocked_out'
    when p_last_punch_kind = 'in' then 'on_site'
    when p_now >= p_ends_at then 'no_show'
    when p_now > p_starts_at + make_interval(mins => coalesce(p_no_show_after_minutes, 60)) then 'no_show'
    when p_now > p_starts_at + make_interval(mins => coalesce(p_late_grace_minutes, 10)) then 'late'
    else 'starting'
  end
$$;

revoke all on function private.attendance_status(timestamptz, timestamptz, timestamptz, integer, integer, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The board
-- ---------------------------------------------------------------------------

create function private.attendance_board(p_organisation_id uuid)
returns table (
  assignment_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_id uuid,
  site_name text,
  post_id uuid,
  post_name text,
  worker_id uuid,
  worker_name text,
  staff_id text,
  phone text,
  phone_last4 text,
  published boolean,
  first_in_at timestamptz,
  last_punch_kind text,
  last_punch_at timestamptz,
  punch_flags text[],
  by_supervisor boolean,
  status text,
  late_minutes integer,
  site_last_sync_at timestamptz,
  site_late_syncs integer,
  board_at timestamptz,
  late_grace_minutes integer,
  no_show_after_minutes integer,
  time_zone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_all boolean;
  v_crew boolean;
  v_phone boolean;
  v_zone text;
  v_grace integer;
  v_no_show integer;
  v_enabled boolean;
  v_day_start timestamptz;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Your role can''t see live attendance.' using errcode = '42501';
  end if;
  v_all := private.has_role(p_organisation_id, array['owner', 'admin', 'hr', 'ops_manager']);
  v_crew := not v_all and private.has_role(p_organisation_id, array['line_manager']);
  if not (v_all or v_crew) then
    raise exception 'Your role can''t see live attendance.' using errcode = '42501';
  end if;
  -- workers_select: these roles read the phone on the people record; a line manager reads their
  -- reportees', and a line manager's rows are only their reportees.
  v_phone := v_crew or private.has_role(
    p_organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager']
  );

  select coalesce(o.timezone, 'Africa/Lagos'), o.late_grace_minutes, o.no_show_after_minutes,
    o.shifts_enabled
  into v_zone, v_grace, v_no_show, v_enabled
  from public.organisations o
  where o.id = p_organisation_id;
  if not coalesce(v_enabled, false) then
    return;
  end if;
  -- Midnight today on the company's clock.
  v_day_start := ((v_now at time zone v_zone)::date)::timestamp at time zone v_zone;

  return query
  with a as (
    select sa.id, sa.shift_date, sa.starts_at, sa.ends_at, sa.site_id, sa.worker_id, s.post_id
    from public.shift_assignments sa
    join public.shifts s on s.organisation_id = sa.organisation_id and s.id = sa.shift_id
    where sa.organisation_id = p_organisation_id
      and sa.status = 'assigned'
      and s.status = 'open'
      -- A shift is at most 24 hours long, so this bounds the index range on starts_at.
      and sa.starts_at >= v_day_start - interval '24 hours'
      and sa.starts_at <= v_now + interval '2 hours'
      and sa.ends_at > v_day_start
      and (v_all or sa.worker_id in (select private.my_reportee_ids()))
  ),
  p as (
    select pu.shift_assignment_id as assignment_id,
      min(pu.recorded_at) filter (where pu.kind = 'in') as first_in_at,
      (array_agg(pu.kind order by pu.recorded_at desc, pu.created_at desc))[1] as last_kind,
      max(pu.recorded_at) as last_at,
      coalesce(array_agg(distinct f.flag) filter (where f.flag is not null), '{}'::text[]) as flags,
      bool_or(pu.source = 'supervisor') as by_supervisor
    from public.punches pu
    left join lateral unnest(pu.flags) as f (flag) on true
    where pu.organisation_id = p_organisation_id
      and pu.shift_assignment_id in (select a.id from a)
    group by pu.shift_assignment_id
  ),
  sy as (
    select pu.site_id,
      max(pu.received_at) as last_sync_at,
      (count(*) filter (where 'late_sync' = any (pu.flags) and pu.received_at >= v_day_start))::integer
        as late_syncs
    from public.punches pu
    where pu.organisation_id = p_organisation_id
      and pu.recorded_at >= v_day_start - interval '24 hours'
      and pu.site_id in (select a.site_id from a)
      and (v_all or pu.worker_id in (select private.my_reportee_ids()))
    group by pu.site_id
  ),
  b as (
    select a.*, p.first_in_at, p.last_kind, p.last_at, p.flags, p.by_supervisor,
      private.attendance_status(v_now, a.starts_at, a.ends_at, v_grace, v_no_show, p.last_kind)
        as status
    from a
    left join p on p.assignment_id = a.id
  )
  select r.id, r.shift_date, r.starts_at, r.ends_at, r.site_id, si.name, r.post_id, po.name,
    r.worker_id, btrim(w.first_name || ' ' || w.last_name), w.staff_id,
    case when v_phone then w.phone end,
    case when w.phone is not null then right(w.phone, 4) end,
    coalesce(pub.published, false),
    r.first_in_at, r.last_kind, r.last_at, coalesce(r.flags, '{}'::text[]),
    coalesce(r.by_supervisor, false),
    r.status,
    case
      when r.status in ('late', 'no_show') and r.first_in_at is null and v_now > r.starts_at then
        floor(extract(epoch from (least(v_now, r.ends_at) - r.starts_at)) / 60)::integer
      when r.first_in_at is not null
        and r.first_in_at > r.starts_at + make_interval(mins => v_grace) then
        floor(extract(epoch from (r.first_in_at - r.starts_at)) / 60)::integer
    end,
    sy.last_sync_at, coalesce(sy.late_syncs, 0),
    v_now, v_grace, v_no_show, v_zone
  from b r
  join public.workers w on w.organisation_id = p_organisation_id and w.id = r.worker_id
  join public.sites si on si.organisation_id = p_organisation_id and si.id = r.site_id
  join public.posts po on po.organisation_id = p_organisation_id and po.id = r.post_id
  left join sy on sy.site_id = r.site_id
  left join lateral (
    select rp.snapshot @> jsonb_build_array(jsonb_build_object('a', r.id::text)) as published
    from public.roster_publications rp
    where rp.organisation_id = p_organisation_id
      and rp.site_id = r.site_id
      and rp.week_start = r.shift_date - (extract(isodow from r.shift_date)::integer - 1)
    order by rp.version desc
    limit 1
  ) pub on true
  where w.end_date is null or w.end_date >= r.shift_date
  order by
    case r.status
      when 'no_show' then 1 when 'late' then 2 when 'starting' then 3 when 'on_site' then 4
      else 5
    end,
    r.starts_at, si.name, po.name, btrim(w.first_name || ' ' || w.last_name), r.id;
end;
$$;

revoke all on function private.attendance_board(uuid) from public, anon;
grant execute on function private.attendance_board(uuid) to authenticated;

create function public.attendance_board(p_organisation_id uuid)
returns table (
  assignment_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_id uuid,
  site_name text,
  post_id uuid,
  post_name text,
  worker_id uuid,
  worker_name text,
  staff_id text,
  phone text,
  phone_last4 text,
  published boolean,
  first_in_at timestamptz,
  last_punch_kind text,
  last_punch_at timestamptz,
  punch_flags text[],
  by_supervisor boolean,
  status text,
  late_minutes integer,
  site_last_sync_at timestamptz,
  site_late_syncs integer,
  board_at timestamptz,
  late_grace_minutes integer,
  no_show_after_minutes integer,
  time_zone text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.attendance_board(p_organisation_id)
$$;

revoke all on function public.attendance_board(uuid) from public, anon;
grant execute on function public.attendance_board(uuid) to authenticated;

comment on function public.attendance_board(uuid) is
  'Live attendance (slice 3.7): one row per rostered worker on today''s board, worked out on read. Owner, admin, hr, ops_manager; a line manager for their reportees. 42501 otherwise.';
