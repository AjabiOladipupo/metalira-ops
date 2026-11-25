-- Slice U.1: People bulk actions (owner-requested UX work, 24 Nov 2026).
--
-- 1. public.bulk_end_employment_preview(org, worker_ids, end_date): for each selected person, the
--    shifts after the last working day that will be left uncovered, their pending and approved
--    leave after it, and why they can't be ended (already ended, a date before their start date,
--    not in this company). Reads only; definer, because HR doesn't read the roster.
-- 2. public.bulk_end_employment(org, worker_ids, end_date, reason): ends everyone selected through
--    public.end_employment (the single rule: status ended, end date set, open assignments closed
--    on the last working day), in this one transaction. If any one person can't be ended, nothing
--    changes and the refusal (MLBU2) lists each person and why, as JSON in its DETAIL. One
--    `people.employment_ended` audit row per person (with the reason) and one
--    `people.bulk_employment_ended` row for the batch. Payroll is not touched: people on a posted
--    payroll still end, and final pay is prorated by the next run.
-- 3. public.bulk_set_line_manager(org, worker_ids, lm_worker, lm_membership) and
--    public.bulk_set_department(org, worker_ids, department): the line manager or department of
--    everyone selected, all or nothing, with the single mapping's rules (active employees only,
--    MLAS2's rule; the workers trigger checks the line manager: a manager in this company who is
--    not on the worker list, never oneself, no loops). One audit row per person changed and one
--    for the batch.
--
-- Roles: owner, admin and hr, as the single end_employment and save_worker_mapping (the People
-- editors). Trusted sessions only (private.session_uid()). The organisation is the caller's
-- active one, passed by the server from the verified session; every function checks the caller
-- holds one of those roles in it and touches only its rows, so another company's worker ids are
-- refused as not found.
--
-- Refusals: 42501 role or untrusted session; MLBU1 nobody selected, or too many (200 to end, 1000
-- to reassign); MLBU2 someone selected can't be changed (DETAIL: [{worker_id, name, staff_id,
-- reason}]); MLBU3 the reason; MLBU4 the last working day; MLBU5 the line manager or department.
--
-- No new table, so no new policy. Every row change is also logged by the row audit triggers.

-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------

-- The caller may run a bulk People change in this company: a trusted session with owner, admin
-- or hr there.
create function private.people_bulk_assert_editor(p_organisation_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Only an owner, an admin or HR can change employee records.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.people_bulk_assert_editor(uuid) from public, anon, authenticated;

-- The distinct, non-null ids of a selection, refused when empty or above p_max.
create function private.people_bulk_ids(p_worker_ids uuid[], p_max integer)
returns uuid[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(distinct x.id order by x.id), '{}')
  into v_ids
  from unnest(coalesce(p_worker_ids, '{}')) as x (id)
  where x.id is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'Select at least one employee.' using errcode = 'MLBU1';
  end if;
  if cardinality(v_ids) > p_max then
    raise exception 'Select % people or fewer at a time.', p_max using errcode = 'MLBU1';
  end if;
  return v_ids;
end;
$$;

revoke all on function private.people_bulk_ids(uuid[], integer) from public, anon, authenticated;

-- Per person: what ending employment on p_end_date leaves behind, and the refusal, if any. Ids
-- that aren't workers of this company come back with no name and "Not found in this company".
create function private.people_bulk_end_check(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_end_date date
)
returns table (
  worker_id uuid,
  name text,
  staff_id text,
  start_date date,
  future_shifts integer,
  leave_pending integer,
  leave_approved integer,
  refusal text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    x.id,
    case when w.id is null then null else w.first_name || ' ' || w.last_name end,
    w.staff_id,
    w.start_date,
    coalesce((
      select count(*)::integer
      from public.shift_assignments a
      where a.organisation_id = p_organisation_id
        and a.worker_id = x.id
        and a.status = 'assigned'
        and a.shift_date > p_end_date
    ), 0),
    coalesce((
      select count(*)::integer
      from public.leave_requests l
      where l.organisation_id = p_organisation_id
        and l.worker_id = x.id
        and l.status in ('pending_line_manager', 'pending_hr')
        and l.end_date > p_end_date
    ), 0),
    coalesce((
      select count(*)::integer
      from public.leave_requests l
      where l.organisation_id = p_organisation_id
        and l.worker_id = x.id
        and l.status = 'approved'
        and l.end_date > p_end_date
    ), 0),
    case
      when w.id is null then 'Not found in this company.'
      when w.status <> 'active' then
        'Already ended on ' || coalesce(to_char(w.end_date, 'FMDD Mon YYYY'), 'an earlier date') || '.'
      when p_end_date < w.start_date then
        'The last working day is before their start date, ' || to_char(w.start_date, 'FMDD Mon YYYY') || '.'
      else null
    end
  from unnest(p_worker_ids) as x (id)
  left join public.workers w
    on w.id = x.id
   and w.organisation_id = p_organisation_id
  order by w.last_name nulls last, w.first_name, w.staff_id, x.id
$$;

revoke all on function private.people_bulk_end_check(uuid, uuid[], date) from public, anon, authenticated;

-- The checks of a reason typed for the audit log: 3 to 500 characters of plain text, no web
-- addresses (the same text rule as remove_assignment's reason).
create function private.people_bulk_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Give a reason for ending their employment.' using errcode = 'MLBU3';
  end if;
  if char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]' or v_reason ~* '(://|www\.)' then
    raise exception 'Keep the reason to 500 characters of plain text, without web addresses.'
      using errcode = 'MLBU3';
  end if;
  return v_reason;
end;
$$;

revoke all on function private.people_bulk_reason(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Preview: end employment
-- ---------------------------------------------------------------------------

create function private.bulk_end_employment_preview(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_people jsonb;
begin
  perform private.people_bulk_assert_editor(p_organisation_id);
  if p_end_date is null then
    raise exception 'Choose the last working day.' using errcode = 'MLBU4';
  end if;
  v_ids := private.people_bulk_ids(p_worker_ids, 200);

  select coalesce(jsonb_agg(jsonb_build_object(
    'worker_id', c.worker_id,
    'name', c.name,
    'staff_id', c.staff_id,
    'start_date', c.start_date,
    'future_shifts', c.future_shifts,
    'leave_pending', c.leave_pending,
    'leave_approved', c.leave_approved,
    'refusal', c.refusal
  )), '[]'::jsonb)
  into v_people
  from private.people_bulk_end_check(p_organisation_id, v_ids, p_end_date) c;

  return jsonb_build_object('end_date', p_end_date, 'people', v_people);
end;
$$;

revoke all on function private.bulk_end_employment_preview(uuid, uuid[], date) from public, anon;
grant execute on function private.bulk_end_employment_preview(uuid, uuid[], date) to authenticated;

create function public.bulk_end_employment_preview(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_end_date date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.bulk_end_employment_preview(p_organisation_id, p_worker_ids, p_end_date) $$;

revoke all on function public.bulk_end_employment_preview(uuid, uuid[], date) from public, anon;
grant execute on function public.bulk_end_employment_preview(uuid, uuid[], date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. End employment for everyone selected, all or nothing
-- ---------------------------------------------------------------------------

create function private.bulk_end_employment(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_end_date date,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_reason text;
  v_refusals jsonb;
  v_row record;
  v_count integer := 0;
begin
  perform private.people_bulk_assert_editor(p_organisation_id);
  if p_end_date is null then
    raise exception 'Choose the last working day.' using errcode = 'MLBU4';
  end if;
  v_reason := private.people_bulk_reason(p_reason);
  v_ids := private.people_bulk_ids(p_worker_ids, 200);

  -- Lock everyone selected, in one order, so two batches never interleave on the same people.
  perform 1
  from public.workers w
  where w.organisation_id = p_organisation_id
    and w.id = any (v_ids)
  order by w.id
  for update;

  select coalesce(jsonb_agg(jsonb_build_object(
    'worker_id', c.worker_id,
    'name', c.name,
    'staff_id', c.staff_id,
    'reason', c.refusal
  )), '[]'::jsonb)
  into v_refusals
  from private.people_bulk_end_check(p_organisation_id, v_ids, p_end_date) c
  where c.refusal is not null;

  if jsonb_array_length(v_refusals) > 0 then
    raise exception 'Nobody was ended: % of the people selected can''t be.',
      jsonb_array_length(v_refusals)
      using errcode = 'MLBU2', detail = v_refusals::text;
  end if;

  for v_row in
    select w.id, w.status, w.end_date
    from public.workers w
    where w.organisation_id = p_organisation_id
      and w.id = any (v_ids)
    order by w.id
  loop
    -- The single rule, unchanged: the row triggers audit the worker and assignment changes.
    perform public.end_employment(p_organisation_id, v_row.id, p_end_date);
    perform private.log_audit_impl(
      p_organisation_id,
      'people.employment_ended',
      'workers',
      v_row.id,
      jsonb_build_object('status', v_row.status, 'end_date', v_row.end_date),
      jsonb_build_object('status', 'ended', 'end_date', p_end_date, 'bulk', true),
      v_reason
    );
    v_count := v_count + 1;
  end loop;

  perform private.log_audit_impl(
    p_organisation_id,
    'people.bulk_employment_ended',
    'workers',
    null,
    null,
    jsonb_build_object('count', v_count, 'end_date', p_end_date, 'worker_ids', to_jsonb(v_ids)),
    v_reason
  );

  return jsonb_build_object('ended', v_count, 'end_date', p_end_date);
end;
$$;

revoke all on function private.bulk_end_employment(uuid, uuid[], date, text) from public, anon;
grant execute on function private.bulk_end_employment(uuid, uuid[], date, text) to authenticated;

create function public.bulk_end_employment(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_end_date date,
  p_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.bulk_end_employment(p_organisation_id, p_worker_ids, p_end_date, p_reason) $$;

revoke all on function public.bulk_end_employment(uuid, uuid[], date, text) from public, anon;
grant execute on function public.bulk_end_employment(uuid, uuid[], date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Line manager and department for everyone selected, all or nothing
-- ---------------------------------------------------------------------------

-- Refusals for people who aren't active employees of this company, as MLBU2's DETAIL.
create function private.people_bulk_inactive(p_organisation_id uuid, p_worker_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'worker_id', x.id,
    'name', case when w.id is null then null else w.first_name || ' ' || w.last_name end,
    'staff_id', w.staff_id,
    'reason', case
      when w.id is null then 'Not found in this company.'
      else 'This employee has left, so their mapping can''t change.'
    end
  ) order by w.last_name nulls last, w.first_name, x.id), '[]'::jsonb)
  from unnest(p_worker_ids) as x (id)
  left join public.workers w
    on w.id = x.id
   and w.organisation_id = p_organisation_id
  where w.id is null or w.status <> 'active'
$$;

revoke all on function private.people_bulk_inactive(uuid, uuid[]) from public, anon, authenticated;

create function private.bulk_set_line_manager(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_line_manager_worker_id uuid default null,
  p_line_manager_membership_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_refusals jsonb;
  v_row record;
  v_changed integer := 0;
begin
  perform private.people_bulk_assert_editor(p_organisation_id);
  if num_nonnulls(p_line_manager_worker_id, p_line_manager_membership_id) <> 1 then
    raise exception 'Choose one line manager.' using errcode = 'MLBU5';
  end if;
  v_ids := private.people_bulk_ids(p_worker_ids, 1000);

  if p_line_manager_worker_id is not null and not exists (
    select 1 from public.workers w
    where w.id = p_line_manager_worker_id
      and w.organisation_id = p_organisation_id
      and w.status = 'active'
  ) then
    raise exception 'That line manager wasn''t found or has left.' using errcode = 'MLBU5';
  end if;
  if p_line_manager_membership_id is not null and not exists (
    select 1 from public.memberships m
    where m.id = p_line_manager_membership_id
      and m.organisation_id = p_organisation_id
      and m.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
      and m.worker_id is null
  ) then
    raise exception 'The line manager must be a manager in this company who is not on the worker list.'
      using errcode = 'MLBU5';
  end if;

  perform 1
  from public.workers w
  where w.organisation_id = p_organisation_id
    and w.id = any (v_ids)
  order by w.id
  for update;

  v_refusals := private.people_bulk_inactive(p_organisation_id, v_ids);
  if jsonb_array_length(v_refusals) > 0 then
    raise exception 'Nothing was changed: % of the people selected can''t be.',
      jsonb_array_length(v_refusals)
      using errcode = 'MLBU2', detail = v_refusals::text;
  end if;

  -- One person at a time, so the workers trigger checks each change against the ones before it
  -- (a loop closed by two of the selected people is refused).
  for v_row in
    select w.id, w.first_name, w.last_name, w.staff_id,
           w.line_manager_worker_id, w.line_manager_membership_id
    from public.workers w
    where w.organisation_id = p_organisation_id
      and w.id = any (v_ids)
    order by w.id
  loop
    if (v_row.line_manager_worker_id, v_row.line_manager_membership_id)
      is not distinct from (p_line_manager_worker_id, p_line_manager_membership_id) then
      continue;
    end if;
    begin
      update public.workers w
      set line_manager_worker_id = p_line_manager_worker_id,
          line_manager_membership_id = p_line_manager_membership_id
      where w.id = v_row.id
        and w.organisation_id = p_organisation_id;
    exception
      when sqlstate 'MLLM1' or sqlstate 'MLLM2' or check_violation then
        v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
          'worker_id', v_row.id,
          'name', v_row.first_name || ' ' || v_row.last_name,
          'staff_id', v_row.staff_id,
          'reason', case
            when sqlstate = '23514' then 'A worker can''t be their own line manager.'
            else sqlerrm
          end
        ));
        continue;
    end;
    perform private.log_audit_impl(
      p_organisation_id,
      'people.line_manager_changed',
      'workers',
      v_row.id,
      jsonb_build_object(
        'line_manager_worker_id', v_row.line_manager_worker_id,
        'line_manager_membership_id', v_row.line_manager_membership_id
      ),
      jsonb_build_object(
        'line_manager_worker_id', p_line_manager_worker_id,
        'line_manager_membership_id', p_line_manager_membership_id,
        'bulk', true
      ),
      null
    );
    v_changed := v_changed + 1;
  end loop;

  if jsonb_array_length(v_refusals) > 0 then
    raise exception 'Nothing was changed: % of the people selected can''t be.',
      jsonb_array_length(v_refusals)
      using errcode = 'MLBU2', detail = v_refusals::text;
  end if;

  perform private.log_audit_impl(
    p_organisation_id,
    'people.bulk_line_manager_changed',
    'workers',
    null,
    null,
    jsonb_build_object(
      'count', cardinality(v_ids),
      'changed', v_changed,
      'line_manager_worker_id', p_line_manager_worker_id,
      'line_manager_membership_id', p_line_manager_membership_id,
      'worker_ids', to_jsonb(v_ids)
    ),
    null
  );

  return jsonb_build_object('selected', cardinality(v_ids), 'changed', v_changed);
end;
$$;

revoke all on function private.bulk_set_line_manager(uuid, uuid[], uuid, uuid) from public, anon;
grant execute on function private.bulk_set_line_manager(uuid, uuid[], uuid, uuid) to authenticated;

create function public.bulk_set_line_manager(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_line_manager_worker_id uuid default null,
  p_line_manager_membership_id uuid default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bulk_set_line_manager(
    p_organisation_id, p_worker_ids, p_line_manager_worker_id, p_line_manager_membership_id
  )
$$;

revoke all on function public.bulk_set_line_manager(uuid, uuid[], uuid, uuid) from public, anon;
grant execute on function public.bulk_set_line_manager(uuid, uuid[], uuid, uuid) to authenticated;

create function private.bulk_set_department(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_department_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_refusals jsonb;
  v_row record;
  v_changed integer := 0;
begin
  perform private.people_bulk_assert_editor(p_organisation_id);
  if p_department_id is null or not exists (
    select 1 from public.departments d
    where d.id = p_department_id and d.organisation_id = p_organisation_id
  ) then
    raise exception 'That department wasn''t found.' using errcode = 'MLBU5';
  end if;
  v_ids := private.people_bulk_ids(p_worker_ids, 1000);

  perform 1
  from public.workers w
  where w.organisation_id = p_organisation_id
    and w.id = any (v_ids)
  order by w.id
  for update;

  v_refusals := private.people_bulk_inactive(p_organisation_id, v_ids);
  if jsonb_array_length(v_refusals) > 0 then
    raise exception 'Nothing was changed: % of the people selected can''t be.',
      jsonb_array_length(v_refusals)
      using errcode = 'MLBU2', detail = v_refusals::text;
  end if;

  for v_row in
    select w.id, w.department_id
    from public.workers w
    where w.organisation_id = p_organisation_id
      and w.id = any (v_ids)
      and w.department_id is distinct from p_department_id
    order by w.id
  loop
    update public.workers w
    set department_id = p_department_id
    where w.id = v_row.id
      and w.organisation_id = p_organisation_id;
    perform private.log_audit_impl(
      p_organisation_id,
      'people.department_changed',
      'workers',
      v_row.id,
      jsonb_build_object('department_id', v_row.department_id),
      jsonb_build_object('department_id', p_department_id, 'bulk', true),
      null
    );
    v_changed := v_changed + 1;
  end loop;

  perform private.log_audit_impl(
    p_organisation_id,
    'people.bulk_department_changed',
    'workers',
    null,
    null,
    jsonb_build_object(
      'count', cardinality(v_ids),
      'changed', v_changed,
      'department_id', p_department_id,
      'worker_ids', to_jsonb(v_ids)
    ),
    null
  );

  return jsonb_build_object('selected', cardinality(v_ids), 'changed', v_changed);
end;
$$;

revoke all on function private.bulk_set_department(uuid, uuid[], uuid) from public, anon;
grant execute on function private.bulk_set_department(uuid, uuid[], uuid) to authenticated;

create function public.bulk_set_department(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_department_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.bulk_set_department(p_organisation_id, p_worker_ids, p_department_id) $$;

revoke all on function public.bulk_set_department(uuid, uuid[], uuid) from public, anon;
grant execute on function public.bulk_set_department(uuid, uuid[], uuid) to authenticated;
