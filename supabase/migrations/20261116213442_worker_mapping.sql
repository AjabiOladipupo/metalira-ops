-- Slice 1.6: mapping.
--
-- A worker's mapping is their department and line manager (columns on workers) plus the site
-- and projects they work on (dated rows in worker_assignments). public.save_worker_mapping
-- changes all of it in one transaction from the mapping panel on /app/people.
--
-- Rules (docs/PHASE_1.md 1.6):
-- * Site and project changes apply from the next shift: rows that stop applying are closed the
--   day before the new ones start, and new rows start tomorrow (or on the start date of a worker
--   who has not started yet). History is kept: a row that was ever in force is closed, never
--   changed or removed. A row that has not started yet (saved earlier today for tomorrow) may be
--   removed, since it never applied; the row audit trigger still records it.
-- * Department and line manager are not dated: they change at once (the workers row audit
--   trigger keeps the before and after).
-- * The mapping as it stands is every assignment that has not ended by the end of today, so a
--   change saved today shows straight away in the People list and its Mapped/Incomplete status.
-- * A worker is never on the same site, or the same project, twice on one day (exclusion
--   constraints below).

-- ---------------------------------------------------------------------------
-- 1. No overlapping assignment to the same site or project
-- ---------------------------------------------------------------------------

alter table public.worker_assignments
  add constraint worker_assignments_no_site_overlap exclude using gist (
    worker_id with =,
    site_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (site_id is not null),
  add constraint worker_assignments_no_project_overlap exclude using gist (
    worker_id with =,
    project_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (project_id is not null);

-- ---------------------------------------------------------------------------
-- 2. Removing an assignment that never applied
-- ---------------------------------------------------------------------------
-- An assignment in force today or earlier is history: it is closed (effective_to), never
-- removed. One that starts later may be removed by owner, admin or hr (save_worker_mapping does
-- this when a mapping saved earlier today is changed again).

create function private.worker_assignments_guard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.effective_from <= private.org_today(old.organisation_id) then
    raise exception 'This assignment is already in force and can''t be removed. Close it instead.'
      using errcode = 'MLAS3';
  end if;
  return old;
end;
$$;

create trigger worker_assignments_guard_delete before delete on public.worker_assignments
  for each row execute function private.worker_assignments_guard_delete();

create policy worker_assignments_delete on public.worker_assignments for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

grant delete on table public.worker_assignments to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The mapping as it stands, for the audit trail
-- ---------------------------------------------------------------------------
-- Department, line manager, sites and projects of one worker, by id and name, counting every
-- assignment that has not ended by the end of p_today. Runs as the caller, so it sees only what
-- RLS lets them read.

create function private.worker_mapping_snapshot(p_worker_id uuid, p_today date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'department', (
      select jsonb_build_object('id', d.id, 'name', d.name)
      from public.departments d
      where d.id = w.department_id
    ),
    'line_manager', case
      when w.line_manager_worker_id is not null then (
        select jsonb_build_object(
          'kind', 'worker', 'id', m.id, 'name', m.first_name || ' ' || m.last_name
        )
        from public.workers m
        where m.id = w.line_manager_worker_id
      )
      when w.line_manager_membership_id is not null then jsonb_build_object(
        'kind', 'membership',
        'id', w.line_manager_membership_id,
        'name', (
          select p.full_name
          from public.memberships ms
          join public.profiles p on p.user_id = ms.user_id
          where ms.id = w.line_manager_membership_id
        )
      )
    end,
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name, s.id)
      from public.sites s
      where s.id in (
        select a.site_id
        from public.worker_assignments a
        where a.worker_id = w.id and (a.effective_to is null or a.effective_to > p_today)
      )
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name, p.id)
      from public.projects p
      where p.id in (
        select a.project_id
        from public.worker_assignments a
        where a.worker_id = w.id and (a.effective_to is null or a.effective_to > p_today)
      )
    ), '[]'::jsonb)
  )
  from public.workers w
  where w.id = p_worker_id
$$;

-- ---------------------------------------------------------------------------
-- 4. save_worker_mapping
-- ---------------------------------------------------------------------------
-- Sets one worker's department, line manager (a worker or a manager-app user, never both:
-- owner decision 3), site (one, or none) and projects (any number). Security invoker: RLS,
-- column grants and the triggers on workers and worker_assignments apply to the caller, so
-- only owner, admin and hr can use it, and a line manager loop or a site of another client is
-- refused as anywhere else.
--
-- Assignments that have not ended by the end of today are compared with the choice:
-- * a row whose site and project are both still chosen is kept as it is;
-- * any other row (with a site or a project) is closed the day before the new rows start, or
--   removed when it has not started by then (it never applied);
-- * a chosen site or project not covered by a kept row gets a new row from the next shift.
-- Rows naming only a client are left alone: the panel does not manage clients.
--
-- Returns what changed and the mapping before and after, by id and name, for the server's
-- audit event and the email to the line manager.
create function public.save_worker_mapping(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_department_id uuid default null,
  p_line_manager_worker_id uuid default null,
  p_line_manager_membership_id uuid default null,
  p_site_id uuid default null,
  p_project_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_today date := private.org_today(p_organisation_id);
  v_worker record;
  v_from date;
  v_projects uuid[];
  v_before jsonb;
  v_row record;
  v_kept_sites uuid[] := '{}';
  v_kept_projects uuid[] := '{}';
  v_department_changed boolean;
  v_line_manager_changed boolean;
  v_assignments_changed boolean := false;
  v_inserted integer;
begin
  if p_line_manager_worker_id is not null and p_line_manager_membership_id is not null then
    raise exception 'Choose one line manager.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct x.id), '{}')
  into v_projects
  from unnest(coalesce(p_project_ids, '{}')) as x (id)
  where x.id is not null;

  -- Locks the worker row: one mapping change for a worker at a time. A caller who can't
  -- update workers (no role, or another organisation) finds nothing.
  select w.id, w.status, w.start_date, w.department_id, w.line_manager_worker_id,
         w.line_manager_membership_id
  into v_worker
  from public.workers w
  where w.id = p_worker_id
    and w.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  if v_worker.status <> 'active' then
    raise exception 'This employee has left, so their mapping can''t change.' using errcode = 'MLAS2';
  end if;

  if p_site_id is not null and not exists (
    select 1 from public.sites s where s.id = p_site_id and s.organisation_id = p_organisation_id
  ) then
    raise exception 'That site wasn''t found.' using errcode = 'MLAS4';
  end if;
  if exists (
    select 1
    from unnest(v_projects) as x (id)
    where not exists (
      select 1 from public.projects p where p.id = x.id and p.organisation_id = p_organisation_id
    )
  ) then
    raise exception 'That project wasn''t found.' using errcode = 'MLAS5';
  end if;

  v_before := private.worker_mapping_snapshot(p_worker_id, v_today);

  -- Department and line manager: at once. The workers triggers check the line manager (a
  -- manager in this company, no loops) and the row audit keeps the before and after.
  v_department_changed := v_worker.department_id is distinct from p_department_id;
  v_line_manager_changed :=
    (v_worker.line_manager_worker_id, v_worker.line_manager_membership_id)
    is distinct from (p_line_manager_worker_id, p_line_manager_membership_id);
  if v_department_changed or v_line_manager_changed then
    update public.workers w
    set department_id = p_department_id,
        line_manager_worker_id = p_line_manager_worker_id,
        line_manager_membership_id = p_line_manager_membership_id
    where w.id = p_worker_id
      and w.organisation_id = p_organisation_id;
  end if;

  -- Site and projects: from the next shift, and not before the worker starts.
  v_from := greatest(v_today + 1, v_worker.start_date);

  for v_row in
    select a.id, a.site_id, a.project_id, a.effective_from
    from public.worker_assignments a
    where a.worker_id = p_worker_id
      and a.organisation_id = p_organisation_id
      and (a.effective_to is null or a.effective_to > v_today)
      and (a.site_id is not null or a.project_id is not null)
    order by a.effective_from, a.id
    for update
  loop
    if (v_row.site_id is null or v_row.site_id = p_site_id)
      and (v_row.project_id is null or v_row.project_id = any (v_projects)) then
      if v_row.site_id is not null then
        v_kept_sites := v_kept_sites || v_row.site_id;
      end if;
      if v_row.project_id is not null then
        v_kept_projects := v_kept_projects || v_row.project_id;
      end if;
    else
      v_assignments_changed := true;
      if v_row.effective_from <= v_from - 1 then
        update public.worker_assignments a
        set effective_to = v_from - 1
        where a.id = v_row.id;
      else
        delete from public.worker_assignments a where a.id = v_row.id;
      end if;
    end if;
  end loop;

  if p_site_id is not null and not (p_site_id = any (v_kept_sites)) then
    insert into public.worker_assignments (organisation_id, worker_id, site_id, effective_from)
    values (p_organisation_id, p_worker_id, p_site_id, v_from);
    v_assignments_changed := true;
  end if;

  insert into public.worker_assignments (organisation_id, worker_id, project_id, effective_from)
  select p_organisation_id, p_worker_id, x.id, v_from
  from unnest(v_projects) as x (id)
  where not (x.id = any (v_kept_projects))
  order by x.id;
  get diagnostics v_inserted = row_count;
  if v_inserted > 0 then
    v_assignments_changed := true;
  end if;

  return jsonb_build_object(
    'changed', v_department_changed or v_line_manager_changed or v_assignments_changed,
    'department_changed', v_department_changed,
    'line_manager_changed', v_line_manager_changed,
    'assignments_changed', v_assignments_changed,
    'effective_from', v_from,
    'before', v_before,
    'after', private.worker_mapping_snapshot(p_worker_id, v_today)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Who to tell: the line manager's address
-- ---------------------------------------------------------------------------
-- After a mapping change the server emails the worker's line manager (docs/PHASE_1.md 1.6),
-- when they have an address: a worker line manager's own email on their worker record, or a
-- manager-app user's confirmed sign-in address. Only owner, admin and hr of the organisation
-- (the people who change mappings) get an answer, and only for a worker of that organisation.
-- The private definer reads auth.users (a manager-app user's address lives there); the public
-- invoker wrapper is what signed-in users call. `user_id` is the manager-app user's id, so the
-- server can skip telling people about their own change.

create function private.worker_line_manager_contact(p_organisation_id uuid, p_worker_id uuid)
returns table (email text, name text, user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      when lm.id is not null then lm.email
      else u.email::text
    end,
    case
      when lm.id is not null then lm.first_name || ' ' || lm.last_name
      else p.full_name
    end,
    ms.user_id
  from public.workers w
  left join public.workers lm
    on lm.id = w.line_manager_worker_id
    and lm.organisation_id = w.organisation_id
    and lm.status = 'active'
  left join public.memberships ms
    on ms.id = w.line_manager_membership_id
    and ms.organisation_id = w.organisation_id
  left join auth.users u on u.id = ms.user_id and u.email_confirmed_at is not null
  left join public.profiles p on p.user_id = ms.user_id
  where w.id = p_worker_id
    and w.organisation_id = p_organisation_id
    and (lm.id is not null or ms.id is not null)
    and private.has_role(p_organisation_id, array['owner', 'admin', 'hr'])
$$;

create function public.worker_line_manager_contact(p_organisation_id uuid, p_worker_id uuid)
returns table (email text, name text, user_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.email, c.name, c.user_id
  from private.worker_line_manager_contact(p_organisation_id, p_worker_id) as c
$$;

-- ---------------------------------------------------------------------------
-- 6. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.worker_assignments_guard_delete() from public, anon, authenticated;
revoke all on function private.worker_mapping_snapshot(uuid, date) from public, anon;
grant execute on function private.worker_mapping_snapshot(uuid, date) to authenticated, service_role;

revoke all on function public.save_worker_mapping(uuid, uuid, uuid, uuid, uuid, uuid, uuid[])
  from public, anon;
grant execute on function public.save_worker_mapping(uuid, uuid, uuid, uuid, uuid, uuid, uuid[])
  to authenticated, service_role;

revoke all on function private.worker_line_manager_contact(uuid, uuid) from public, anon;
grant execute on function private.worker_line_manager_contact(uuid, uuid)
  to authenticated, service_role;
revoke all on function public.worker_line_manager_contact(uuid, uuid) from public, anon;
grant execute on function public.worker_line_manager_contact(uuid, uuid)
  to authenticated, service_role;
