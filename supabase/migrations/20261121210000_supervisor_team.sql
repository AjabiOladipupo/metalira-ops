-- Slice 4.7b: My team for worker-supervisors (/m/team, the SupHome Approvals tile).
--
-- Owner decision (21 Nov 2026): a worker-supervisor (a `worker` login whose worker record is the
-- line manager of a crew, workers.line_manager_worker_id, as slice 3.6 defines crews) gets a My
-- team view in the worker app. Line-manager logins who use the worker app may use it too.
--
-- 1. private.my_supervised_crew_ids(): the crews of the caller's worker logins, while the
--    supervisor's own worker record is employed (status active, no end date passed). Never the
--    caller. A set, computed once per statement; trusted sessions only (private.session_uid()).
--    Slice 3.6's private.my_crew_ids() also holds a line manager's reportees and doesn't check
--    the supervisor's employment, so the decisions below use this narrower set.
-- 2. Timesheet days (slice 4.3's functions, replaced from their 20261121170000 versions):
--    private.timesheet_can_decide admits a worker-supervisor for their crew while the company has
--    Shifts on; approve_timesheet_line and reject_timesheet_line admit `worker` to the role gate
--    (timesheet_assert_decider then checks the crew). Every 4.3 rule stays: never their own day
--    (MLTA1), the day refreshed first under the worker's lock, a running shift refused (MLTA3),
--    the MLTA7 changed-since-opened guard. Bulk approval, reopen and corrections stay with
--    managers (their own role gates are unchanged).
--    refresh_timesheet_lines (slice 4.2's version): a worker login refreshes its crew's days (while
--    Shifts is on) as well as its own, still 35 days at most, and at most 200 people (so a worker login never
--    takes the company-wide refresh lock).
-- 3. Leave step 1 (slice 4.4's helpers, replaced): private.leave_has_line_manager counts a
--    worker-supervisor (a worker login on the worker's line_manager_worker_id, still employed)
--    as the worker's line manager, so step 1 is theirs; private.leave_can_decide_step1 lets them
--    decide it. decide_leave_line_manager keeps every 4.4 check (nobody decides their own leave,
--    MLLQ6; step 1 before HR, MLLQ4; the request row locked for update; the days counted again),
--    now takes the worker's leave lock first like the other leave decisions, and writes its audit
--    row directly (log_audit_impl admits manager roles only). An ended supervisor stops counting, and step 1 falls back to an owner, admin or
--    ops_manager as for a worker with no line manager.
-- 4. Reads for /m/team, each a definer for `worker` and `line_manager` logins only, narrowed to
--    the caller's crew (worker-supervisor) or reportees (line manager), never the caller:
--    crew_timesheet_days (pending or disputed days the caller may decide, the last 35 days) and
--    crew_leave_requests (step 1 waiting for the caller: dates, type, reason, the balance of that
--    type and the shifts approval would open, 4.5's private.leave_shifts_to_open), plus
--    crew_team_size (a count, for the Approvals tile). Safe columns only: no bank, tax, pay, NIN,
--    phone or location.
--
-- Queries are out of scope (owner, 21 Nov 2026): worker-supervisors read no staff_queries or
-- replies, and no 4.6 policy or function changes here.
--
-- No new tables, so no new policies.

-- ---------------------------------------------------------------------------
-- 1. The caller's supervised crew, as a set
-- ---------------------------------------------------------------------------

create function private.my_supervised_crew_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id
  from public.memberships m
  join public.workers sup
    on sup.organisation_id = m.organisation_id and sup.id = m.worker_id
  join public.workers w
    on w.organisation_id = m.organisation_id and w.line_manager_worker_id = m.worker_id
  where m.user_id = (select private.session_uid())
    and m.role = 'worker'
    and m.worker_id is not null
    and w.id <> m.worker_id
    and sup.status = 'active'
    and (sup.end_date is null or sup.end_date >= private.org_today(m.organisation_id))
$$;

revoke all on function private.my_supervised_crew_ids() from public, anon;
grant execute on function private.my_supervised_crew_ids() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Timesheet days
-- ---------------------------------------------------------------------------

-- May the caller decide this worker's days (owner decision 6)? Owner, admin and ops_manager for
-- any worker of the company; a line manager for their reportees; a worker-supervisor for their
-- crew while Shifts is on (slice 4.7b); never anyone for their own worker record. Trusted
-- sessions only.
create or replace function private.timesheet_can_decide(p_organisation_id uuid, p_worker_id uuid)
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
      or (
        private.has_role(p_organisation_id, array['worker'])
        and private.org_shifts_enabled(p_organisation_id)
        and p_worker_id in (select private.my_supervised_crew_ids())
      )
    )
$$;

revoke all on function private.timesheet_can_decide(uuid, uuid) from public, anon, authenticated;

create or replace function private.approve_timesheet_line(
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
  if not private.has_role(
    p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager', 'worker']
  ) then
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

-- 4.3's rejection, with `worker` admitted to the role gate (the crew check follows).
create or replace function private.reject_timesheet_line(
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
  if not private.has_role(
    p_organisation_id, array['owner', 'admin', 'ops_manager', 'line_manager', 'worker']
  ) then
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
  if private.timesheet_line_running(p_organisation_id, v_line.id) then
    raise exception 'This shift hasn''t finished yet. Decide it once it ends.' using errcode = 'MLTA3';
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


revoke all on function private.approve_timesheet_line(uuid, uuid, text) from public, anon;
revoke all on function private.reject_timesheet_line(uuid, uuid, text) from public, anon;
grant execute on function private.approve_timesheet_line(uuid, uuid, text) to authenticated;
grant execute on function private.reject_timesheet_line(uuid, uuid, text) to authenticated;

-- 4.2's refresh: owner, admin, hr and ops_manager any workers of the company (null: all); a line
-- manager their reportees and themselves; a worker themselves and, as a worker-supervisor, their
-- crew (slice 4.7b), 35 days and 200 people at most. 62 days at most for everyone. The secret
-- key may call it for any company.
create or replace function private.refresh_timesheet_lines(
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
    if not exists (
      select 1 from public.memberships m
      where m.organisation_id = p_organisation_id and m.user_id = v_uid and m.role = 'worker'
    ) then
      raise exception 'Your role can''t see timesheets.' using errcode = '42501';
    end if;
    -- A worker refreshes at most 35 days (security review L3).
    if p_to - p_from > 35 then
      raise exception 'Choose a range of 35 days or fewer.' using errcode = '22023';
    end if;
    select coalesce(array_agg(w.id), '{}'::uuid[]) into v_workers
    from public.workers w
    where w.organisation_id = p_organisation_id
      and (
        w.id in (
          select m.worker_id from public.memberships m
          where m.organisation_id = p_organisation_id and m.user_id = v_uid
            and m.role = 'worker' and m.worker_id is not null
        )
        -- The crew only while Shifts is on, as for the decisions (security review L3).
        or (
          private.org_shifts_enabled(p_organisation_id)
          and w.id in (select private.my_supervised_crew_ids())
        )
      )
      and (p_worker_ids is null or w.id = any (p_worker_ids));
    -- Never the company-wide lock for a worker login (private.timesheet_lock takes it past 200).
    if cardinality(v_workers) > 200 then
      raise exception 'At most 200 people at a time.' using errcode = '22023';
    end if;
  end if;
  return private.timesheet_refresh(p_organisation_id, p_from, p_to, v_workers);
end;
$$;

revoke all on function private.refresh_timesheet_lines(uuid, date, date, uuid[]) from public, anon;
grant execute on function private.refresh_timesheet_lines(uuid, date, date, uuid[])
  to authenticated, service_role;

-- /m/team's timesheet section: the pending or disputed days, over the last 35 days (the worker
-- refresh's limit), that the caller may decide: a worker-supervisor their crew's (Shifts on), a
-- line manager their reportees'. Never the caller's own. Names, the site and post, the shift,
-- minutes, exceptions and the worker's dispute reason; never a location, a phone or money.
-- 42501 for every other role.
create function private.crew_timesheet_days(p_organisation_id uuid)
returns table (
  line_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  work_date date,
  status text,
  site_name text,
  post_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  scheduled_minutes integer,
  worked_minutes integer,
  late_minutes integer,
  early_minutes integer,
  ot_minutes integer,
  exceptions text[],
  needs_review boolean,
  running boolean,
  dispute_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['worker', 'line_manager']) then
    raise exception 'Your role can''t see your team''s timesheets.' using errcode = '42501';
  end if;
  v_today := private.org_today(p_organisation_id);

  return query
    select l.id, l.worker_id,
      nullif(btrim(concat_ws(' ', w.first_name, w.last_name)), ''),
      w.staff_id, l.work_date, l.status, si.name, po.name, sa.starts_at, sa.ends_at,
      l.scheduled_minutes, l.worked_minutes, l.late_minutes, l.early_minutes, l.ot_minutes,
      l.exceptions, l.needs_review,
      private.timesheet_line_running(p_organisation_id, l.id),
      case when l.status = 'disputed' then d.reason end
    from public.timesheet_lines l
    join public.workers w on w.organisation_id = l.organisation_id and w.id = l.worker_id
    left join public.sites si on si.organisation_id = l.organisation_id and si.id = l.site_id
    left join public.posts po on po.organisation_id = l.organisation_id and po.id = l.post_id
    left join public.shift_assignments sa
      on sa.organisation_id = l.organisation_id and sa.id = l.shift_assignment_id
    left join lateral (
      select dd.reason
      from public.timesheet_decisions dd
      where dd.organisation_id = l.organisation_id and dd.line_id = l.id
      order by dd.seq desc
      limit 1
    ) d on true
    where l.organisation_id = p_organisation_id
      and l.work_date between v_today - 34 and v_today
      and l.status in ('pending', 'disputed')
      and (
        l.worker_id in (select private.my_supervised_crew_ids())
        or l.worker_id in (select private.my_reportee_ids())
      )
      and private.timesheet_can_decide(p_organisation_id, l.worker_id)
    order by case when l.status = 'disputed' then 0 else 1 end, l.work_date, 3, l.id
    limit 500;
end;
$$;

revoke all on function private.crew_timesheet_days(uuid) from public, anon;
grant execute on function private.crew_timesheet_days(uuid) to authenticated;

create function public.crew_timesheet_days(p_organisation_id uuid)
returns table (
  line_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  work_date date,
  status text,
  site_name text,
  post_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  scheduled_minutes integer,
  worked_minutes integer,
  late_minutes integer,
  early_minutes integer,
  ot_minutes integer,
  exceptions text[],
  needs_review boolean,
  running boolean,
  dispute_reason text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.crew_timesheet_days(p_organisation_id)
$$;

revoke all on function public.crew_timesheet_days(uuid) from public, anon;
grant execute on function public.crew_timesheet_days(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Leave step 1
-- ---------------------------------------------------------------------------

-- Does the worker have a line manager who can sign in? A line_manager login whose membership or
-- worker record is on the worker (slice 4.4), or a worker-supervisor: a worker login on the
-- worker's line_manager_worker_id whose worker record is still employed (slice 4.7b). Otherwise
-- step 1 falls to an owner, admin or ops_manager.
create or replace function private.leave_has_line_manager(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workers w
    join public.memberships m
      on m.organisation_id = w.organisation_id and m.role = 'line_manager'
     and (
       m.id = w.line_manager_membership_id
       or (m.worker_id is not null and m.worker_id = w.line_manager_worker_id)
     )
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  )
  or exists (
    select 1
    from public.workers w
    join public.memberships m
      on m.organisation_id = w.organisation_id and m.role = 'worker'
     and m.worker_id = w.line_manager_worker_id
    join public.workers sup
      on sup.organisation_id = w.organisation_id and sup.id = w.line_manager_worker_id
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
      and w.line_manager_worker_id <> w.id
      and sup.status = 'active'
      and (sup.end_date is null or sup.end_date >= private.org_today(p_organisation_id))
  )
$$;

revoke all on function private.leave_has_line_manager(uuid, uuid) from public, anon, authenticated;

-- May the caller decide step 1 for this worker? Their line manager: a line_manager login (4.4) or
-- a worker-supervisor for their crew (4.7b). With none, an owner, admin or ops_manager. Never the
-- worker themselves.
create or replace function private.leave_can_decide_step1(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_uid() is not null
    and p_worker_id not in (select private.my_worker_ids())
    and case
      when private.leave_has_line_manager(p_organisation_id, p_worker_id)
        then private.leave_is_my_reportee(p_organisation_id, p_worker_id)
          or (
            private.has_role(p_organisation_id, array['worker'])
            and p_worker_id in (select private.my_supervised_crew_ids())
          )
      else private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager'])
    end
$$;

revoke all on function private.leave_can_decide_step1(uuid, uuid) from public, anon, authenticated;

-- 4.4's step 1 (from 20261121180000), unchanged except: the worker's leave lock is taken first,
-- like the other leave decisions, and the audit row is written directly, because
-- private.log_audit_impl admits manager roles only and a worker-supervisor now decides step 1.
-- The checks are 4.4's: nobody decides their own leave (MLLQ6), only the step-1 decider
-- (private.leave_can_decide_step1, extended above), only while waiting for step 1 (MLLQ4), and
-- the days counted again on approval.
create or replace function private.decide_leave_line_manager(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests%rowtype;
  v_type public.leave_types%rowtype;
  v_note text := private.leave_clean_text(p_note, 500);
  v_days integer;
  v_status text;
  v_lock_worker uuid;
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

  -- The worker's leave lock first (as decide_leave_hr, request_leave and adjust_leave_balance
  -- take it), so a step-1 decision and a cancellation or a second decision can't interleave.
  select r.worker_id into v_lock_worker
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id;
  if v_lock_worker is not null then
    perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_lock_worker::text, 0));
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
  if not private.leave_can_decide_step1(p_organisation_id, v_request.worker_id) then
    raise exception 'Only the worker''s line manager decides this step.' using errcode = '42501';
  end if;
  if v_request.status <> 'pending_line_manager' then
    raise exception 'This request isn''t waiting for the line manager.' using errcode = 'MLLQ4';
  end if;

  select t.* into v_type from public.leave_types t where t.id = v_request.leave_type_id;
  v_days := v_request.days;
  if p_decision = 'approved' then
    select c.days into v_days
    from private.leave_count_days(
      p_organisation_id, v_request.worker_id, v_type.counting, v_request.start_date,
      v_request.end_date
    ) c;
    if coalesce(v_days, 0) = 0 then
      raise exception 'Those dates no longer have working days for the worker. Decline it instead.'
        using errcode = 'MLLQ7';
    end if;
    v_status := 'pending_hr';
  else
    v_status := 'declined';
  end if;

  insert into public.leave_decisions (
    organisation_id, request_id, worker_id, step, decision, note, certificate_seen, days, actor
  )
  values (
    p_organisation_id, v_request.id, v_request.worker_id, 'line_manager', p_decision, v_note,
    coalesce(p_certificate_seen, false) and v_type.needs_certificate, v_days, private.session_uid()
  );

  update public.leave_requests r
  set status = v_status,
      days = v_days,
      certificate_seen = r.certificate_seen
        or (coalesce(p_certificate_seen, false) and v_type.needs_certificate),
      decided_at = case when v_status = 'declined' then now() else r.decided_at end
  where r.id = v_request.id;

  -- Written directly: log_audit_impl admits manager roles only, and a worker-supervisor (role
  -- worker) decides step 1 too. The caller was checked above.
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after, reason)
  values (
    p_organisation_id, private.session_uid(), 'leave.decided_line_manager', 'leave_requests',
    v_request.id,
    jsonb_build_object('status', v_request.status, 'days', v_request.days),
    jsonb_build_object('status', v_status, 'days', v_days, 'decision', p_decision),
    v_note
  );

  return jsonb_build_object(
    'id', v_request.id, 'status', v_status, 'days', v_days, 'worker_id', v_request.worker_id
  );
end;
$$;

revoke all on function private.decide_leave_line_manager(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function private.decide_leave_line_manager(uuid, uuid, text, text, boolean) to authenticated;

-- /m/team's leave section: requests waiting at step 1 that the caller decides (a worker-supervisor
-- their crew's, a line manager their reportees'), with the type, dates, days and reason, the
-- worker's balance of that type for the request's year (the ledger sum) and the days their other
-- pending requests hold, and the shifts approval would open (4.5's leave_shifts_to_open:
-- date, times, site and post). No pay figures. Empty while the company has People off.
-- 42501 for every other role.
create function private.crew_leave_requests(p_organisation_id uuid)
returns table (
  id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  leave_type_name text,
  counting text,
  needs_certificate boolean,
  start_date date,
  end_date date,
  days integer,
  reason text,
  created_at timestamptz,
  balance integer,
  other_pending integer,
  open_shifts jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['worker', 'line_manager']) then
    raise exception 'Your role can''t see your team''s leave.' using errcode = '42501';
  end if;

  return query
    select r.id, r.worker_id,
      nullif(btrim(concat_ws(' ', w.first_name, w.last_name)), ''),
      w.staff_id, t.name, t.counting, t.needs_certificate, r.start_date, r.end_date, r.days,
      r.reason, r.created_at,
      coalesce((
        select sum(lg.days)
        from public.leave_ledger lg
        where lg.organisation_id = r.organisation_id and lg.worker_id = r.worker_id
          and lg.leave_type_id = r.leave_type_id and lg.leave_year = r.leave_year
      ), 0)::integer,
      private.leave_pending_days(
        r.organisation_id, r.worker_id, r.leave_type_id, r.leave_year, r.id
      ),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'date', s.shift_date, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'site_name', s.site_name, 'post_name', s.post_name
        ) order by s.starts_at)
        from private.leave_shifts_to_open(
          r.organisation_id, r.worker_id, r.start_date, r.end_date
        ) s
      ), '[]'::jsonb)
    from public.leave_requests r
    join public.workers w on w.organisation_id = r.organisation_id and w.id = r.worker_id
    join public.leave_types t on t.organisation_id = r.organisation_id and t.id = r.leave_type_id
    join public.organisations o on o.id = r.organisation_id
    where r.organisation_id = p_organisation_id
      and o.people_enabled
      and r.status = 'pending_line_manager'
      and (
        r.worker_id in (select private.my_supervised_crew_ids())
        or r.worker_id in (select private.my_reportee_ids())
      )
      and private.leave_can_decide_step1(p_organisation_id, r.worker_id)
    order by r.start_date, r.created_at, r.id
    limit 200;
end;
$$;

revoke all on function private.crew_leave_requests(uuid) from public, anon;
grant execute on function private.crew_leave_requests(uuid) to authenticated;

create function public.crew_leave_requests(p_organisation_id uuid)
returns table (
  id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  leave_type_name text,
  counting text,
  needs_certificate boolean,
  start_date date,
  end_date date,
  days integer,
  reason text,
  created_at timestamptz,
  balance integer,
  other_pending integer,
  open_shifts jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.crew_leave_requests(p_organisation_id)
$$;

revoke all on function public.crew_leave_requests(uuid) from public, anon;
grant execute on function public.crew_leave_requests(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Who sees the Approvals tile
-- ---------------------------------------------------------------------------

-- How many people the caller supervises in this company (a worker-supervisor's crew, a line
-- manager's reportees; employed only, never the caller): the worker home shows the Approvals
-- tile when it is above 0. A count only; 0 for every other role and untrusted sessions.
create function private.crew_team_size(p_organisation_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.workers w
  where private.session_uid() is not null
    and w.organisation_id = p_organisation_id
    and w.status = 'active'
    and w.id not in (select private.my_worker_ids())
    and (
      w.id in (select private.my_supervised_crew_ids())
      or w.id in (select private.my_reportee_ids())
    )
$$;

revoke all on function private.crew_team_size(uuid) from public, anon;
grant execute on function private.crew_team_size(uuid) to authenticated;

create function public.crew_team_size(p_organisation_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select private.crew_team_size(p_organisation_id)
$$;

revoke all on function public.crew_team_size(uuid) from public, anon;
grant execute on function public.crew_team_size(uuid) to authenticated;
