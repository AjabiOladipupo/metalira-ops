-- Slice 4.5: approved leave opens shifts (docs/PHASE_4.md 4.5, owner decisions 8 and 13).
--
-- 1. HR's final approval (`decide_leave_hr`, approved) takes the worker off their assigned shifts
--    in the leave range, in the same transaction: status removed, removed_reason 'on_leave',
--    removed_by the approver. Only shifts that haven't started: a day before today, or a shift
--    today that has already started, is left as it is. The dry run (the confirm step's preview)
--    lists each shift it would open. The shifts go back to uncovered; a published week shows them
--    as changed since publish (slice 3.3 reads that live).
-- 2. `shift_assignments_guard` refuses a new assignment for a worker on approved leave that day
--    (MLRSL, "On approved leave 4 to 6 Nov."). Every path goes through it: assign_worker_to_shift,
--    copy_last_week, the secret key, and slice 4.7's line-manager assign. `copy_last_week` lists
--    those as skipped instead of stopping.
-- 3. `roster_leave` (owner, admin, ops_manager): approved and pending leave overlapping some
--    days, worker ids and dates only, for the Uncovered tray's suggestions (skip approved, mark
--    pending). `roster_leave_removals`: the assignments at a site that approved leave opened, for
--    the grid's "On leave" chips.
-- 4. Decision 13 (the 3.3 low): `private.roster_affected_workers` leaves out workers whose
--    employment ended (status ended, or an end date before the week). Publishing and "Send
--    notices again" both read it, so neither tells a leaver, even one who left after the publish.
--
-- Locks: the guard takes the worker's leave lock shared ('leave_requests:<worker>', the key the
-- leave functions take exclusively), so an assignment and HR's approval for the same worker take
-- turns: either the assignment lands first and the approval opens it, or the approval lands first
-- and the assignment is refused. No site locks are taken here, so no lock cycle with publish.
--
-- Refusals (SQLSTATE): MLRSL the worker is on approved leave that day (new); the rest as in 3.2,
-- 3.3 and 4.4. Nothing here stores money.

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------

-- "4 Nov", "4 to 6 Nov", "28 Oct to 3 Nov" (src/lib/leave/requests.ts formatLeaveRange without
-- the year; a leave request lies inside one year).
create function private.leave_short_range(p_start date, p_end date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_start = p_end then to_char(p_start, 'FMDD Mon')
    when date_trunc('month', p_start) = date_trunc('month', p_end)
      then to_char(p_start, 'FMDD') || ' to ' || to_char(p_end, 'FMDD Mon')
    else to_char(p_start, 'FMDD Mon') || ' to ' || to_char(p_end, 'FMDD Mon')
  end
$$;

revoke all on function private.leave_short_range(date, date) from public, anon, authenticated;

-- The worker's assigned shifts between two days that approved leave would open: still assigned,
-- on or after the company's today, and not started yet. No role check: only definers call it.
create function private.leave_shifts_to_open(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_from date,
  p_to date
)
returns table (
  assignment_id uuid,
  shift_id uuid,
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
security definer
set search_path = ''
as $$
  select a.id, a.shift_id, a.shift_date, a.starts_at, a.ends_at, a.site_id, si.name, s.post_id, p.name
  from public.shift_assignments a
  join public.shifts s on s.organisation_id = a.organisation_id and s.id = a.shift_id
  join public.posts p on p.organisation_id = a.organisation_id and p.id = s.post_id
  join public.sites si on si.organisation_id = a.organisation_id and si.id = a.site_id
  where a.organisation_id = p_organisation_id
    and a.worker_id = p_worker_id
    and a.status = 'assigned'
    and a.shift_date between p_from and p_to
    and a.shift_date >= private.org_today(p_organisation_id)
    and a.starts_at > now()
  order by a.starts_at, a.id
$$;

revoke all on function private.leave_shifts_to_open(uuid, uuid, date, date)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The assignment guard refuses approved leave
-- ---------------------------------------------------------------------------

-- Slice 3.2's guard, unchanged except the leave check after the employment checks (and its lock).
create or replace function private.shift_assignments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_req record;
  v_post public.posts%rowtype;
  v_site_status text;
  v_worker public.workers%rowtype;
  v_name text;
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
  v_assigned integer;
  v_clash record;
  v_zone text;
  v_leave record;
begin
  if tg_op = 'DELETE' then
    raise exception 'Assignments are never deleted. Remove the worker from the shift instead.'
      using errcode = 'MLRS8';
  end if;

  if tg_op = 'UPDATE' then
    if (
      new.id, new.organisation_id, new.shift_id, new.site_id, new.shift_date, new.worker_id,
      new.starts_at, new.ends_at, new.assigned_by, new.assigned_at, new.created_at
    ) is distinct from (
      old.id, old.organisation_id, old.shift_id, old.site_id, old.shift_date, old.worker_id,
      old.starts_at, old.ends_at, old.assigned_by, old.assigned_at, old.created_at
    ) then
      raise exception 'An assignment never changes. Remove it and assign again.'
        using errcode = 'MLRS8';
    end if;
    if old.status = 'removed' then
      raise exception 'This assignment was already removed.' using errcode = 'MLRS8';
    end if;
    if new.status = 'removed' then
      if old.shift_date < v_today then
        raise exception 'This day has passed and its roster can''t change.' using errcode = 'MLRS6';
      end if;
      new.removed_at := coalesce(new.removed_at, now());
      new.removed_by := coalesce(new.removed_by, private.session_uid(), auth.uid());
    end if;
    return new;
  end if;

  -- INSERT
  if new.status is distinct from 'assigned' or new.removed_at is not null
    or new.removed_by is not null or new.removed_reason is not null then
    raise exception 'A new assignment is assigned.' using errcode = 'MLRS8';
  end if;

  select * into v_shift
  from public.shifts s
  where s.id = new.shift_id and s.organisation_id = new.organisation_id
  for update;
  if not found then
    raise exception 'That shift wasn''t found.' using errcode = 'P0002';
  end if;
  select * into v_post from public.posts p where p.id = v_shift.post_id;
  if v_shift.status = 'cancelled' then
    raise exception '% on % was cancelled.', v_post.name, to_char(v_shift.shift_date, 'FMDy FMDD Mon')
      using errcode = 'MLRS9';
  end if;
  if v_shift.shift_date < v_today then
    raise exception 'This day has passed and its roster can''t change.' using errcode = 'MLRS6';
  end if;

  if v_post.closed_on is not null and v_shift.shift_date > v_post.closed_on then
    raise exception '% closed after %.', v_post.name, to_char(v_post.closed_on, 'FMDD Mon YYYY')
      using errcode = 'MLRS1';
  end if;
  select * into v_req
  from private.post_day_requirement(new.organisation_id, v_shift.post_id, v_shift.shift_date);
  if not found then
    raise exception '% isn''t staffed on %.', v_post.name, to_char(v_shift.shift_date, 'FMDy FMDD Mon')
      using errcode = 'MLRS1';
  end if;

  select s.status into v_site_status from public.sites s where s.id = v_shift.site_id;
  if v_site_status = 'archived' then
    raise exception 'This site is archived. Rosters are for sites in use.' using errcode = 'MLRS3';
  end if;

  select * into v_worker
  from public.workers w
  where w.id = new.worker_id and w.organisation_id = new.organisation_id;
  if not found then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  v_name := v_worker.first_name || ' ' || v_worker.last_name;
  if v_worker.status = 'ended' and (v_worker.end_date is null or v_worker.end_date < v_shift.shift_date) then
    raise exception '% has left the company.', v_name using errcode = 'MLRS2';
  end if;
  if v_worker.end_date is not null and v_worker.end_date < v_shift.shift_date then
    raise exception '% leaves on %.', v_name, to_char(v_worker.end_date, 'FMDD Mon YYYY')
      using errcode = 'MLRS2';
  end if;
  if v_worker.start_date > v_shift.shift_date then
    raise exception '% starts on %.', v_name, to_char(v_worker.start_date, 'FMDD Mon YYYY')
      using errcode = 'MLRS2';
  end if;

  -- Slice 4.5: never onto a day of approved leave. The worker's leave lock (shared here, taken
  -- exclusively by the leave functions) makes an approval and an assignment take turns; the
  -- query after it sees an approval committed while we waited.
  perform pg_advisory_xact_lock_shared(hashtextextended('leave_requests:' || new.worker_id::text, 0));
  select r.start_date, r.end_date into v_leave
  from public.leave_requests r
  where r.organisation_id = new.organisation_id
    and r.worker_id = new.worker_id
    and r.status = 'approved'
    and v_shift.shift_date between r.start_date and r.end_date
  order by r.start_date
  limit 1;
  if v_leave.start_date is not null then
    raise exception 'On approved leave %.', private.leave_short_range(v_leave.start_date, v_leave.end_date)
      using errcode = 'MLRSL';
  end if;

  if exists (
    select 1 from public.shift_assignments a
    where a.shift_id = v_shift.id and a.worker_id = new.worker_id and a.status = 'assigned'
  ) then
    raise exception '% is already on this shift.', v_name using errcode = 'MLRS7';
  end if;

  select count(*) into v_assigned
  from public.shift_assignments a
  where a.shift_id = v_shift.id and a.status = 'assigned';
  if v_assigned >= v_req.required_count then
    raise exception '% on % already has the % % it needs.', v_post.name,
      to_char(v_shift.shift_date, 'FMDy FMDD Mon'), v_req.required_count,
      case when v_req.required_count = 1 then 'person' else 'people' end
      using errcode = 'MLRS4';
  end if;

  new.site_id := v_shift.site_id;
  new.shift_date := v_shift.shift_date;
  new.starts_at := v_req.starts_at;
  new.ends_at := v_req.ends_at;
  new.assigned_at := now();
  new.assigned_by := coalesce(new.assigned_by, private.session_uid(), auth.uid());

  select a.starts_at, a.ends_at, p.name into v_clash
  from public.shift_assignments a
  join public.shifts s on s.id = a.shift_id
  join public.posts p on p.id = s.post_id
  where a.worker_id = new.worker_id
    and a.status = 'assigned'
    and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
  order by a.starts_at
  limit 1;
  if found then
    select coalesce(o.timezone, 'Africa/Lagos') into v_zone
    from public.organisations o where o.id = new.organisation_id;
    raise exception '% is already on % %–% then.', v_name, v_clash.name,
      to_char(v_clash.starts_at at time zone v_zone, 'FMDy HH24:MI'),
      to_char(v_clash.ends_at at time zone v_zone, 'HH24:MI')
      using errcode = 'MLRS5';
  end if;

  return new;
end;
$$;

revoke all on function private.shift_assignments_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. copy_last_week skips workers on approved leave
-- ---------------------------------------------------------------------------

-- Slice 3.2's copy, unchanged except: a worker on approved leave on the target day is skipped
-- with MLRSL (checked first in plain SQL, and caught from the guard as the backstop).
create or replace function private.copy_last_week(
  p_organisation_id uuid,
  p_site_id uuid,
  p_week_start date,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source record;
  v_target date;
  v_shift_id uuid;
  v_copied integer := 0;
  v_already integer := 0;
  v_total integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_code text;
  v_message text;
  v_result jsonb;
  v_existing uuid;
  v_required integer;
  v_leave record;
begin
  perform private.require_roster_role(p_organisation_id);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'A roster week starts on a Monday.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.sites s where s.id = p_site_id and s.organisation_id = p_organisation_id
  ) then
    raise exception 'That site wasn''t found.' using errcode = 'P0002';
  end if;
  -- One copy per site at a time.
  perform pg_advisory_xact_lock(hashtextextended('roster_copy:' || p_site_id::text, 0));

  begin
    for v_source in
      select a.worker_id, s.post_id, s.shift_date, p.name as post_name,
        w.first_name || ' ' || w.last_name as worker_name
      from public.shift_assignments a
      join public.shifts s on s.id = a.shift_id
      join public.posts p on p.id = s.post_id
      join public.workers w on w.id = a.worker_id
      where a.organisation_id = p_organisation_id
        and a.site_id = p_site_id
        and a.status = 'assigned'
        and a.shift_date between p_week_start - 7 and p_week_start - 1
      order by a.shift_date, a.starts_at, p.name, w.last_name, w.first_name, a.id
      limit 1000
    loop
      v_total := v_total + 1;
      v_target := v_source.shift_date + 7;

      -- Slice 4.5: approved leave on the target day.
      v_leave := null;
      select r.start_date, r.end_date into v_leave
      from public.leave_requests r
      where r.organisation_id = p_organisation_id
        and r.worker_id = v_source.worker_id
        and r.status = 'approved'
        and v_target between r.start_date and r.end_date
      limit 1;
      if v_leave.start_date is not null then
        v_skipped := v_skipped || jsonb_build_object(
          'post_id', v_source.post_id,
          'post_name', v_source.post_name,
          'shift_date', v_target,
          'worker_id', v_source.worker_id,
          'worker_name', v_source.worker_name,
          'code', 'MLRSL',
          'reason', 'On approved leave ' || private.leave_short_range(v_leave.start_date, v_leave.end_date) || '.'
        );
        continue;
      end if;

      -- The cheap refusals in plain SQL first (no subtransaction): already on the shift, or the
      -- shift already full by the requirement in force. The block below stays as the backstop.
      select s.id into v_existing
      from public.shifts s
      where s.post_id = v_source.post_id and s.shift_date = v_target
        and s.organisation_id = p_organisation_id;
      if v_existing is not null then
        if exists (
          select 1 from public.shift_assignments a
          where a.shift_id = v_existing and a.worker_id = v_source.worker_id
            and a.status = 'assigned'
        ) then
          v_already := v_already + 1;
          continue;
        end if;
        select r.required_count into v_required
        from private.post_day_requirement(p_organisation_id, v_source.post_id, v_target) r;
        if v_required is not null and (
          select count(*) from public.shift_assignments a
          where a.shift_id = v_existing and a.status = 'assigned'
        ) >= v_required then
          v_skipped := v_skipped || jsonb_build_object(
            'post_id', v_source.post_id,
            'post_name', v_source.post_name,
            'shift_date', v_target,
            'worker_id', v_source.worker_id,
            'worker_name', v_source.worker_name,
            'code', 'MLRS4',
            'reason', format('%s on %s already has the %s %s it needs.', v_source.post_name,
              to_char(v_target, 'FMDy FMDD Mon'), v_required,
              case when v_required = 1 then 'person' else 'people' end)
          );
          continue;
        end if;
      end if;

      begin
        v_shift_id := private.materialise_shift(p_organisation_id, v_source.post_id, v_target);
        insert into public.shift_assignments (
          organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at
        )
        values (
          p_organisation_id, v_shift_id, p_site_id, v_target, v_source.worker_id,
          now(), now() + interval '1 minute'
        );
        v_copied := v_copied + 1;
      exception
        when sqlstate 'MLRS7' then
          v_already := v_already + 1;
        when sqlstate 'MLRS1' or sqlstate 'MLRS2' or sqlstate 'MLRS3' or sqlstate 'MLRS4'
          or sqlstate 'MLRS5' or sqlstate 'MLRS6' or sqlstate 'MLRS9' or sqlstate 'MLRSL'
          or sqlstate '23P01' or sqlstate '23505' then
          get stacked diagnostics v_code = returned_sqlstate, v_message = message_text;
          if v_code = '23P01' then
            v_code := 'MLRS5';
            v_message := v_source.worker_name || ' is already on an overlapping shift.';
          elsif v_code = '23505' then
            v_code := 'MLRS7';
            v_message := v_source.worker_name || ' is already on this shift.';
          end if;
          v_skipped := v_skipped || jsonb_build_object(
            'post_id', v_source.post_id,
            'post_name', v_source.post_name,
            'shift_date', v_target,
            'worker_id', v_source.worker_id,
            'worker_name', v_source.worker_name,
            'code', v_code,
            'reason', v_message
          );
      end;
    end loop;

    v_result := jsonb_build_object(
      'week_start', p_week_start,
      'source', v_total,
      'copied', v_copied,
      'already', v_already,
      'skipped', v_skipped,
      'dry_run', coalesce(p_dry_run, false)
    );

    if coalesce(p_dry_run, false) then
      -- Undo everything above; v_result survives (variables aren't transactional).
      raise exception 'dry run' using errcode = 'MLRSD';
    end if;
  exception
    when sqlstate 'MLRSD' then
      return v_result;
  end;

  if v_copied > 0 then
    perform private.log_audit_impl(
      p_organisation_id, 'roster.week_copied', 'sites', p_site_id, null,
      jsonb_build_object(
        'week_start', p_week_start, 'copied', v_copied, 'already', v_already,
        'skipped', jsonb_array_length(v_skipped)
      ),
      null
    );
  end if;
  return v_result;
end;
$$;

revoke all on function private.copy_last_week(uuid, uuid, date, boolean) from public, anon;
grant execute on function private.copy_last_week(uuid, uuid, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Decision 13: publishing never tells a leaver
-- ---------------------------------------------------------------------------

-- Slice 3.3's list, unchanged except it leaves out workers whose employment ended: status ended,
-- or an end date before the week (the week of the snapshots' days; one site-week each). Read at
-- the time it runs, so "Send notices again" skips someone who left after the publish.
create or replace function private.roster_affected_workers(
  p_organisation_id uuid,
  p_old jsonb,
  p_new jsonb,
  p_unnotified_for uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with d as (
    select * from private.roster_snapshot_diff(p_old, p_new)
  ),
  wk as (
    select min(x.day) - (extract(isodow from min(x.day))::integer - 1) as week_start
    from (
      select (e ->> 'd')::date as day from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) e
      union all
      select (e ->> 'd')::date from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) e
    ) x
  ),
  per_worker as (
    select d.worker_id,
      case
        when bool_and(d.kind = 'added') then 'added'
        when bool_and(d.kind = 'removed') then 'removed'
        else 'changed'
      end as kind
    from d
    group by d.worker_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'worker_id', pw.worker_id,
      'worker_name', w.first_name || ' ' || w.last_name,
      'kind', pw.kind,
      'shifts', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'shift_date', e ->> 'd',
            'starts_at', e ->> 'from',
            'ends_at', e ->> 'to',
            'post_name', p.name
          )
          order by e ->> 'from'
        ), '[]'::jsonb)
        from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) e
        join public.posts p on p.id = (e ->> 'p')::uuid
        where (e ->> 'w')::uuid = pw.worker_id
      )
    )
    order by w.last_name, w.first_name, pw.worker_id
  ), '[]'::jsonb)
  from per_worker pw
  cross join wk
  join public.workers w on w.id = pw.worker_id and w.organisation_id = p_organisation_id
  where w.status <> 'ended'
    and (w.end_date is null or wk.week_start is null or w.end_date >= wk.week_start)
    and (
      p_unnotified_for is null
      or not exists (
        select 1 from public.inbox_items i
        where i.roster_publication_id = p_unnotified_for and i.worker_id = pw.worker_id
      )
    )
$$;

revoke all on function private.roster_affected_workers(uuid, jsonb, jsonb, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Roster reads: leave for suggestions, removals for the grid
-- ---------------------------------------------------------------------------

-- Approved and pending leave overlapping p_from to p_to (62 days at most): worker ids, dates and
-- 'approved' or 'pending'. No type, reason or note. Owner, admin and ops_manager (the roster
-- builders); anyone else 42501.
create function private.roster_leave(p_organisation_id uuid, p_from date, p_to date)
returns table (worker_id uuid, start_date date, end_date date, status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_roster_role(p_organisation_id);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    raise exception 'Ask for 62 days or fewer at a time.' using errcode = '22023';
  end if;
  return query
  select r.worker_id, r.start_date, r.end_date,
    case when r.status = 'approved' then 'approved' else 'pending' end
  from public.leave_requests r
  where r.organisation_id = p_organisation_id
    and r.status in ('pending_line_manager', 'pending_hr', 'approved')
    and r.start_date <= p_to and r.end_date >= p_from
  order by r.start_date, r.worker_id
  limit 2000;
end;
$$;

revoke all on function private.roster_leave(uuid, date, date) from public, anon;
grant execute on function private.roster_leave(uuid, date, date) to authenticated;

create function public.roster_leave(p_organisation_id uuid, p_from date, p_to date)
returns table (worker_id uuid, start_date date, end_date date, status text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.roster_leave(p_organisation_id, p_from, p_to)
$$;

revoke all on function public.roster_leave(uuid, date, date) from public, anon;
grant execute on function public.roster_leave(uuid, date, date) to authenticated;

-- The assignments at a site between two days (62 at most) that approved leave opened and whose
-- worker is still on approved leave that day: the grid's "On leave" chips. Owner, admin and
-- ops_manager.
create function private.roster_leave_removals(
  p_organisation_id uuid,
  p_site_id uuid,
  p_from date,
  p_to date
)
returns table (assignment_id uuid, post_id uuid, shift_date date, worker_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_roster_role(p_organisation_id);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    raise exception 'Ask for 62 days or fewer at a time.' using errcode = '22023';
  end if;
  return query
  select a.id, s.post_id, a.shift_date, a.worker_id
  from public.shift_assignments a
  join public.shifts s on s.organisation_id = a.organisation_id and s.id = a.shift_id
  where a.organisation_id = p_organisation_id
    and a.site_id = p_site_id
    and a.shift_date between p_from and p_to
    and a.status = 'removed'
    and a.removed_reason = 'on_leave'
    and exists (
      select 1 from public.leave_requests r
      where r.organisation_id = a.organisation_id
        and r.worker_id = a.worker_id
        and r.status = 'approved'
        and a.shift_date between r.start_date and r.end_date
    )
    -- Not back on the same shift since.
    and not exists (
      select 1 from public.shift_assignments b
      where b.shift_id = a.shift_id and b.worker_id = a.worker_id and b.status = 'assigned'
    )
  order by a.shift_date, a.id;
end;
$$;

revoke all on function private.roster_leave_removals(uuid, uuid, date, date) from public, anon;
grant execute on function private.roster_leave_removals(uuid, uuid, date, date) to authenticated;

create function public.roster_leave_removals(
  p_organisation_id uuid,
  p_site_id uuid,
  p_from date,
  p_to date
)
returns table (assignment_id uuid, post_id uuid, shift_date date, worker_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.roster_leave_removals(p_organisation_id, p_site_id, p_from, p_to)
$$;

revoke all on function public.roster_leave_removals(uuid, uuid, date, date) from public, anon;
grant execute on function public.roster_leave_removals(uuid, uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. HR's final approval opens the worker's shifts
-- ---------------------------------------------------------------------------
-- 4.4's function (migration 20261121180000, latest version) copied exactly, plus: the worker's
-- leave lock (when 4.4 doesn't take it already), the list of shifts the approval opens
-- (`open_shifts`, in the dry run and the result) and, on approval, the update that takes the
-- worker off them with removed_reason 'on_leave' and removed_by the approver, audited as
-- roster.opened_by_leave. The public wrapper is unchanged.
create or replace function private.decide_leave_hr(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Slice 4.5: the shifts the approval opens, and how many it took the worker off.
  v_open jsonb := '[]'::jsonb;
  v_opened integer := 0;
  v_request public.leave_requests%rowtype;
  v_type public.leave_types%rowtype;
  v_version public.leave_entitlements%rowtype;
  v_note text := private.leave_clean_text(p_note, 500);
  v_count record;
  v_start date;
  v_available integer;
  v_status text;
  v_certificate boolean;
  v_below boolean;
  v_pay integer;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to decide leave.' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'Approve or decline.' using errcode = '22023';
  end if;
  if p_note is not null and btrim(p_note) <> '' and v_note is null then
    raise exception 'Keep the note to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;
  if p_decision = 'declined' and v_note is null then
    raise exception 'Say why, so the worker knows.' using errcode = '22023';
  end if;

  select r.* into v_request
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'That leave request wasn''t found.' using errcode = 'P0002';
  end if;
  if v_request.worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t decide your own leave.' using errcode = 'MLLQ6';
  end if;
  if not private.leave_can_decide_step2(p_organisation_id, v_request.worker_id) then
    raise exception 'Only HR, an admin or the owner decides this step.' using errcode = '42501';
  end if;
  if v_request.status <> 'pending_hr' then
    raise exception 'This request isn''t waiting for HR.' using errcode = 'MLLQ4';
  end if;

  -- Slice 4.5: the worker's leave lock (the roster guard takes it shared), so an assignment
  -- for this worker and this approval take turns.
  perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_request.worker_id::text, 0));

  select t.* into v_type from public.leave_types t where t.id = v_request.leave_type_id;
  select w.start_date into v_start from public.workers w where w.id = v_request.worker_id;
  v_certificate := v_request.certificate_seen
    or (coalesce(p_certificate_seen, false) and v_type.needs_certificate);
  select c.* into v_count
  from private.leave_count_days(
    p_organisation_id, v_request.worker_id, v_type.counting, v_request.start_date,
    v_request.end_date
  ) c;
  v_version := private.leave_version_on(v_type.id, v_request.start_date);
  v_below := coalesce(
    v_version.pay_min_service_months is not null
      and private.leave_service_months(v_start, v_request.start_date) < v_version.pay_min_service_months,
    false
  );
  v_pay := case when v_type.paid then coalesce(v_version.pay_percent, v_request.pay_percent) else 0 end;

  perform private.leave_ensure_year_core(p_organisation_id, v_request.leave_year, array[v_request.worker_id]);
  v_available := private.leave_balance(
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year
    ) - private.leave_pending_days(
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year, v_request.id
    );

  if p_decision = 'approved' then
    if coalesce(v_count.days, 0) = 0 then
      raise exception 'Those dates no longer have working days for the worker. Decline it instead.'
        using errcode = 'MLLQ7';
    end if;
    if v_type.needs_certificate and not v_certificate then
      raise exception 'Tick Certificate seen before approving % leave.', lower(v_type.name)
        using errcode = '22023';
    end if;
    if coalesce(v_version.days_per_year, 0) > 0 and v_available < v_count.days then
      raise exception 'The worker has % % left, fewer than the % asked for.',
        greatest(v_available, 0), case when greatest(v_available, 0) = 1 then 'day' else 'days' end,
        v_count.days
        using errcode = 'MLLQ2';
    end if;
    v_status := 'approved';
  else
    v_status := 'declined';
  end if;

  -- Slice 4.5: the worker's assigned shifts in the range that haven't started.
  if v_status = 'approved' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'assignment_id', o.assignment_id, 'shift_date', o.shift_date,
        'starts_at', o.starts_at, 'ends_at', o.ends_at,
        'site_id', o.site_id, 'site_name', o.site_name,
        'post_id', o.post_id, 'post_name', o.post_name
      ) order by o.starts_at, o.assignment_id), '[]'::jsonb)
    into v_open
    from private.leave_shifts_to_open(
      p_organisation_id, v_request.worker_id, v_request.start_date, v_request.end_date
    ) o;
  end if;

  if coalesce(p_dry_run, false) then
    return jsonb_build_object(
      'id', v_request.id, 'status', v_status, 'days', coalesce(v_count.days, v_request.days),
      'worker_id', v_request.worker_id, 'dry_run', true,
      'balance_before', v_available,
      'balance_after', case when v_status = 'approved' then v_available - v_count.days else v_available end,
      'shifts', coalesce(v_count.shifts, 0), 'site_names', to_jsonb(coalesce(v_count.site_names, '{}'::text[])),
      'pay_below_service', v_below,
      'open_shifts', v_open
    );
  end if;

  insert into public.leave_decisions (
    organisation_id, request_id, worker_id, step, decision, note, certificate_seen, days, actor
  )
  values (
    p_organisation_id, v_request.id, v_request.worker_id, 'hr', p_decision, v_note,
    coalesce(p_certificate_seen, false) and v_type.needs_certificate,
    coalesce(v_count.days, 0), private.session_uid()
  );

  update public.leave_requests r
  set status = v_status,
      days = case when v_status = 'approved' then v_count.days else r.days end,
      certificate_seen = v_certificate,
      pay_percent = case when v_status = 'approved' then v_pay else r.pay_percent end,
      pay_below_service = case when v_status = 'approved' then v_below else r.pay_below_service end,
      decided_at = now()
  where r.id = v_request.id;

  if v_status = 'approved' then
    insert into public.leave_ledger (
      organisation_id, worker_id, leave_type_id, leave_year, kind, days, request_id, actor
    )
    values (
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year, 'taken',
      -v_count.days, v_request.id, private.session_uid()
    );

    -- Slice 4.5 (decision 8): take the worker off the shifts in the range that haven't started,
    -- in this transaction. The guard checks each row (never a past day) and the audit trigger
    -- records each one.
    update public.shift_assignments a
    set status = 'removed',
        removed_at = now(),
        removed_by = private.session_uid(),
        removed_reason = 'on_leave'
    where a.organisation_id = p_organisation_id
      and a.worker_id = v_request.worker_id
      and a.status = 'assigned'
      and a.id in (select (e ->> 'assignment_id')::uuid from jsonb_array_elements(v_open) e);
    get diagnostics v_opened = row_count;
    if v_opened > 0 then
      perform private.log_audit_impl(
        p_organisation_id, 'roster.opened_by_leave', 'leave_requests', v_request.id, null,
        jsonb_build_object(
          'worker_id', v_request.worker_id,
          'opened', v_opened,
          'assignment_ids', (select coalesce(jsonb_agg(e -> 'assignment_id'), '[]'::jsonb)
                             from jsonb_array_elements(v_open) e)
        ),
        null
      );
    end if;
  end if;

  perform private.log_audit_impl(
    p_organisation_id, 'leave.decided_hr', 'leave_requests', v_request.id,
    jsonb_build_object('status', v_request.status, 'days', v_request.days),
    jsonb_build_object(
      'status', v_status, 'days', coalesce(v_count.days, v_request.days), 'decision', p_decision,
      'pay_below_service', v_below
    ),
    v_note
  );

  return jsonb_build_object(
    'id', v_request.id, 'status', v_status, 'days', coalesce(v_count.days, v_request.days),
    'worker_id', v_request.worker_id, 'dry_run', false,
    'balance_before', v_available,
    'balance_after', case when v_status = 'approved' then v_available - v_count.days else v_available end,
    'shifts', coalesce(v_count.shifts, 0), 'site_names', to_jsonb(coalesce(v_count.site_names, '{}'::text[])),
    'pay_below_service', v_below,
    'open_shifts', v_open
  );
end;
$$;

revoke all on function private.decide_leave_hr(uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function private.decide_leave_hr(uuid, uuid, text, text, boolean, boolean) to authenticated;
