-- Slice 6.11: a Head office site for non-service staff (owner request, 27 Nov 2026).
--
-- Staff who don't work at a client's site (HR, finance, the operations manager, admin) are mapped
-- to the company's own office. Until now every site belonged to a client.
--
-- 1. `sites.kind`: 'client' (the default, every existing site) or 'office'. An office has no
--    client and a client's site always has one (sites_kind_client). Office names are unique per
--    company (sites_office_name_key). A site never changes kind or client
--    (private.sites_kind_guard, ENABLE ALWAYS, so the secret key and the database owner are
--    refused too; this also closes sites_before_write's MLST5 check, which a null client slipped
--    past). Only owner, admin and ops_manager add an office (RLS for hr, the guard for anyone
--    signed in); hr keeps adding name-only client sites (the people import).
-- 2. Every company has one office named "Head office": backfilled here for existing companies,
--    and made with each new company by private.organisations_add_head_office (an AFTER INSERT
--    trigger, so every path that creates a company gets one). More offices (branches) are added
--    the same way as a client's site, from Settings > Company.
-- 3. An office is never a client's site. private.refuse_office_site (ENABLE ALWAYS) refuses an
--    office on a contract or a contract change (MLHO2), in headcount (MLHO3), and on a post, its
--    roster requirements, its shifts and its Work Units (MLHO4). With no posts there, no Work
--    Unit is ever made at an office, so nothing at an office is billable.
--    Hook for Phase 6: 6.1's unbilled queue and 6.2's invoices read Work Units (never made at an
--    office, see above) and must still read sites through their client (an inner join on
--    clients, or `kind = 'client'`), so an office never reaches an invoice.
-- 4. Mapping: an office takes no client and no projects. private.worker_assignments_office_guard
--    (ENABLE ALWAYS) refuses an office row naming a client or a project, and a project row that
--    overlaps the person's office row, or the other way round (MLHO5). public.save_worker_mapping
--    (its latest definition, slice 1.6) refuses an office with projects up front (MLHO5), and
--    private.bulk_map_workers (its latest definition, slice U.3) refuses projects for an office
--    before anyone moves (MLBM3) and reports MLHO5 per person in Add mode.
-- 5. Payroll: nothing new is stored. A person whose site of record is an office is overhead,
--    not a client site's labour cost; Phase 7's overhead allocation reads `sites.kind` through
--    their worker_assignments.
--
-- Attendance needs no change: the no-shift clock-in already accepts any site the person is
-- mapped to and checks its geofence (slice 3.5).
--
-- Refusals: MLHO1 a site changed between client and office; MLHO2 an office on a contract;
-- MLHO3 headcount at an office; MLHO4 a post, roster requirement, shift or Work Unit at an
-- office; MLHO5 an office mapping with a client or projects; 42501 a role that can't add offices.

-- ---------------------------------------------------------------------------
-- 1. sites.kind
-- ---------------------------------------------------------------------------

alter table public.sites
  add column kind text not null default 'client'
    constraint sites_kind_value check (kind in ('client', 'office'));

alter table public.sites alter column client_id drop not null;

alter table public.sites
  add constraint sites_kind_client check ((kind = 'client') = (client_id is not null));

create unique index sites_office_name_key on public.sites (organisation_id, lower(name))
  where kind = 'office';

comment on table public.sites is
  'A place people work: a client''s site (kind client, with its client) or one of the company''s own offices (kind office, no client; every company has "Head office"). Archived, never deleted.';
comment on column public.sites.kind is
  'client: a client''s site. office: the company''s own office (Head office or a branch). An office is never on a contract, post, roster or invoice, and people mapped to it are overhead. Never changes.';

-- Owner, admin and ops_manager name the kind when they add a site (an office). Update is not
-- granted: a site never changes kind.
grant insert (kind) on table public.sites to authenticated;

-- hr adds name-only client sites (the people import), never an office.
alter policy sites_insert on public.sites
  with check (
    organisation_id in (select private.role_org_ids(array['owner', 'admin', 'ops_manager']))
    or (
      organisation_id in (select private.role_org_ids(array['hr']))
      and kind = 'client'
      and address is null and state is null and landmark is null
      and centre is null and boundary is null
    )
  );

-- BEFORE INSERT/UPDATE on sites: a site never changes kind (MLHO1) or client (MLST5, compared
-- null-safely), and only owner, admin and ops_manager add an office (42501). The role check runs
-- for every signed-in session (private.session_uid(), whatever role runs the statement, so a
-- definer function is checked too). Two cases pass without it: the secret key (no session), and
-- a company with no members yet, which is the new company's own Head office being made by
-- private.organisations_add_head_office before its owner's membership is inserted.
create function private.sites_kind_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.kind is distinct from old.kind then
      raise exception 'A client''s site can''t become an office, or an office a client''s site.'
        using errcode = 'MLHO1';
    end if;
    if new.client_id is distinct from old.client_id
      or new.organisation_id is distinct from old.organisation_id then
      raise exception 'A site can''t move to another client.' using errcode = 'MLST5';
    end if;
    return new;
  end if;

  if new.kind = 'office'
    and private.session_uid() is not null
    and exists (select 1 from public.memberships m where m.organisation_id = new.organisation_id)
    and not private.has_role(new.organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t add offices.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.sites_kind_guard() from public, anon, authenticated;

create trigger sites_kind_guard before insert or update on public.sites
  for each row execute function private.sites_kind_guard();
alter table public.sites enable always trigger sites_kind_guard;

-- ---------------------------------------------------------------------------
-- 2. Head office for every company
-- ---------------------------------------------------------------------------

insert into public.sites (organisation_id, kind, name)
select o.id, 'office', 'Head office'
from public.organisations o
where not exists (
  select 1 from public.sites s where s.organisation_id = o.id and s.kind = 'office'
);

-- AFTER INSERT on organisations: the new company's Head office. Definer, so it runs whichever
-- path made the company (sign-up, a test's secret key). The sites row audit logs it.
create function private.organisations_add_head_office()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.sites (organisation_id, kind, name)
  values (new.id, 'office', 'Head office');
  return null;
end;
$$;

revoke all on function private.organisations_add_head_office() from public, anon, authenticated;

create trigger organisations_add_head_office after insert on public.organisations
  for each row execute function private.organisations_add_head_office();

-- ---------------------------------------------------------------------------
-- 3. An office is never a client's site
-- ---------------------------------------------------------------------------

-- BEFORE INSERT/UPDATE OF site_id: refuses a row at an office. TG_ARGV[0] is the SQLSTATE and
-- TG_ARGV[1] the message. Definer so the check sees the site whatever the caller may read.
create function private.refuse_office_site()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.site_id is not null and exists (
    select 1 from public.sites s
    where s.organisation_id = new.organisation_id and s.id = new.site_id and s.kind = 'office'
  ) then
    raise exception '%', tg_argv[1] using errcode = tg_argv[0];
  end if;
  return new;
end;
$$;

revoke all on function private.refuse_office_site() from public, anon, authenticated;

create trigger contract_sites_refuse_office before insert or update of site_id
  on public.contract_sites for each row
  execute function private.refuse_office_site(
    'MLHO2', 'An office isn''t a client''s site, so it can''t be on a contract.'
  );
create trigger contract_changes_refuse_office before insert or update of site_id
  on public.contract_changes for each row
  execute function private.refuse_office_site(
    'MLHO2', 'An office isn''t a client''s site, so it can''t be on a contract.'
  );
create trigger headcount_requirements_refuse_office before insert or update of site_id
  on public.headcount_requirements for each row
  execute function private.refuse_office_site(
    'MLHO3', 'An office isn''t a client''s site, so it has no contract headcount.'
  );
create trigger posts_refuse_office before insert or update of site_id
  on public.posts for each row
  execute function private.refuse_office_site(
    'MLHO4', 'An office isn''t a client''s site, so it has no posts.'
  );
create trigger roster_requirements_refuse_office before insert or update of site_id
  on public.roster_requirements for each row
  execute function private.refuse_office_site(
    'MLHO4', 'An office isn''t a client''s site, so it has no posts.'
  );
create trigger shifts_refuse_office before insert or update of site_id
  on public.shifts for each row
  execute function private.refuse_office_site(
    'MLHO4', 'An office isn''t a client''s site, so it has no posts.'
  );
create trigger work_units_refuse_office before insert or update of site_id
  on public.work_units for each row
  execute function private.refuse_office_site(
    'MLHO4', 'An office isn''t a client''s site, so it has no posts.'
  );

alter table public.contract_sites enable always trigger contract_sites_refuse_office;
alter table public.contract_changes enable always trigger contract_changes_refuse_office;
alter table public.headcount_requirements enable always trigger headcount_requirements_refuse_office;
alter table public.posts enable always trigger posts_refuse_office;
alter table public.roster_requirements enable always trigger roster_requirements_refuse_office;
alter table public.shifts enable always trigger shifts_refuse_office;
alter table public.work_units enable always trigger work_units_refuse_office;

-- ---------------------------------------------------------------------------
-- 4. Mapping to an office
-- ---------------------------------------------------------------------------

-- BEFORE INSERT/UPDATE on worker_assignments (after worker_assignments_before_write, by name):
-- an office row names no client and no project, and a person at an office works on no project
-- at the same time (MLHO5). Like worker_assignments_target_active, an update is checked only
-- when it changes the site, project or client, or moves a closed row's end later; closing a row
-- is never refused. Definer so the overlap check sees every row of the person. One writer per
-- person at a time (a transaction lock on the worker), so two concurrent saves can't each miss
-- the other's row (security review L2); a changed start date is checked again.
create function private.worker_assignments_office_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_office boolean := false;
begin
  if tg_op = 'UPDATE'
    and new.site_id is not distinct from old.site_id
    and new.project_id is not distinct from old.project_id
    and new.client_id is not distinct from old.client_id
    and new.effective_from is not distinct from old.effective_from
    and not (
      old.effective_to is not null
      and (new.effective_to is null or new.effective_to > old.effective_to)
    ) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('worker_assignments_office:' || new.worker_id::text, 0));

  if new.site_id is not null then
    select coalesce(s.kind = 'office', false) into v_office
    from public.sites s
    where s.organisation_id = new.organisation_id and s.id = new.site_id;
    v_office := coalesce(v_office, false);
  end if;

  if v_office then
    if new.client_id is not null or new.project_id is not null then
      raise exception 'An office has no client or projects. Map the person to the office alone.'
        using errcode = 'MLHO5';
    end if;
    if exists (
      select 1 from public.worker_assignments a
      where a.organisation_id = new.organisation_id
        and a.worker_id = new.worker_id
        and a.id <> new.id
        and a.project_id is not null
        and daterange(a.effective_from, a.effective_to, '[]')
          && daterange(new.effective_from, new.effective_to, '[]')
    ) then
      raise exception 'People at an office work on no projects. Take them off their projects first.'
        using errcode = 'MLHO5';
    end if;
  elsif new.project_id is not null and exists (
    select 1
    from public.worker_assignments a
    join public.sites s on s.organisation_id = a.organisation_id and s.id = a.site_id
    where a.organisation_id = new.organisation_id
      and a.worker_id = new.worker_id
      and a.id <> new.id
      and s.kind = 'office'
      and daterange(a.effective_from, a.effective_to, '[]')
        && daterange(new.effective_from, new.effective_to, '[]')
  ) then
    raise exception 'People at an office work on no projects. Map them to a client''s site first.'
      using errcode = 'MLHO5';
  end if;
  return new;
end;
$$;

revoke all on function private.worker_assignments_office_guard() from public, anon, authenticated;

create trigger worker_assignments_office_guard before insert or update on public.worker_assignments
  for each row execute function private.worker_assignments_office_guard();
alter table public.worker_assignments enable always trigger worker_assignments_office_guard;

-- Slice 6.11 (money review M1): someone mapped to an office comes off their shifts at clients'
-- sites from the day the mapping applies, in the same transaction, so a leftover shift can't
-- pick up their office clock-ins and become a Work Unit. Each assignment is marked removed with
-- the reason (the row audit logs it) and one `roster.office_mapping_released` row lists them.
-- Owner, admin and hr (the mapping roles) in a trusted session only; called by
-- save_worker_mapping, which bulk_map_workers runs per person. Returns the removed assignments.
create function private.release_shifts_for_office(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_from date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_released jsonb;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Only an owner, an admin or HR can change employee records.'
      using errcode = '42501';
  end if;

  with released as (
    update public.shift_assignments a
    set status = 'removed',
      removed_reason = 'Mapped to an office from ' || to_char(p_from, 'FMDD Mon YYYY') || '.'
    where a.organisation_id = p_organisation_id
      and a.worker_id = p_worker_id
      and a.status = 'assigned'
      and a.shift_date >= greatest(p_from, private.org_today(p_organisation_id))
    returning a.id, a.shift_date, a.site_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'assignment_id', r.id, 'shift_date', r.shift_date, 'site_id', r.site_id,
      'site_name', s.name
    ) order by r.shift_date, r.id),
    '[]'::jsonb
  )
  into v_released
  from released r
  left join public.sites s on s.organisation_id = p_organisation_id and s.id = r.site_id;

  if jsonb_array_length(v_released) > 0 then
    perform private.log_audit_impl(
      p_organisation_id, 'roster.office_mapping_released', 'workers', p_worker_id, null,
      jsonb_build_object(
        'from', p_from,
        'count', jsonb_array_length(v_released),
        'assignment_ids', (select jsonb_agg(x -> 'assignment_id') from jsonb_array_elements(v_released) x)
      ),
      null
    );
  end if;
  return v_released;
end;
$$;

revoke all on function private.release_shifts_for_office(uuid, uuid, date) from public, anon;
grant execute on function private.release_shifts_for_office(uuid, uuid, date) to authenticated;

-- public.save_worker_mapping: slice 1.6's definition (its only one), with two additions: an
-- office takes no projects (MLHO5), and mapping someone to an office takes them off their shifts
-- at clients' sites from the day it applies (private.release_shifts_for_office), reported as
-- `released_shifts`. Everything else is unchanged. Security invoker, so RLS, the column grants and the worker and assignment triggers
-- still apply to the caller (owner, admin and hr; a trusted session, through RLS's set helpers).
create or replace function public.save_worker_mapping(
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
  v_released jsonb := '[]'::jsonb;
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
  -- Slice 6.11: an office has no client, so no projects.
  if p_site_id is not null and cardinality(v_projects) > 0 and exists (
    select 1 from public.sites s
    where s.id = p_site_id and s.organisation_id = p_organisation_id and s.kind = 'office'
  ) then
    raise exception 'An office has no projects. Choose the office alone, or a client''s site for project work.'
      using errcode = 'MLHO5';
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

  -- Slice 6.11: at an office from v_from, so off clients' shifts from then.
  if p_site_id is not null and exists (
    select 1 from public.sites s
    where s.id = p_site_id and s.organisation_id = p_organisation_id and s.kind = 'office'
  ) then
    v_released := private.release_shifts_for_office(p_organisation_id, p_worker_id, v_from);
    if jsonb_array_length(v_released) > 0 then
      v_assignments_changed := true;
    end if;
  end if;

  return jsonb_build_object(
    'released_shifts', v_released,
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

-- private.bulk_map_workers: slice U.3's definition (its only one), with the office rules added:
-- projects for an office are refused before anyone moves (MLBM3), and in Add mode someone who
-- works on projects is refused with the reason (MLHO5 from the single save). Everything else is
-- unchanged: owner, admin and hr in a trusted session (private.people_bulk_assert_editor, 42501
-- otherwise), the organisation the server passes from the verified session, all or nothing, the
-- dry run rolled back, one audit row per person changed and one for the batch.
create or replace function private.bulk_map_workers(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_site_id uuid,
  p_project_ids uuid[] default '{}',
  p_mode text default 'replace',
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_today date;
  v_site record;
  v_projects uuid[];
  v_refusals jsonb;
  v_people jsonb := '[]'::jsonb;
  v_row record;
  v_current_projects uuid[];
  v_other_sites text;
  v_save_projects uuid[];
  v_result jsonb;
  v_state text;
  v_message text;
  v_changed integer := 0;
  v_out jsonb;
begin
  perform private.people_bulk_assert_editor(p_organisation_id);
  if p_mode is null or p_mode not in ('replace', 'add') then
    raise exception 'Choose Replace or Add.' using errcode = 'MLBM1';
  end if;
  if p_site_id is null then
    raise exception 'Choose a site.' using errcode = 'MLBM1';
  end if;
  v_ids := private.people_bulk_ids(p_worker_ids, 200);
  v_today := private.org_today(p_organisation_id);

  select s.id, s.client_id, s.name, s.kind into v_site
  from public.sites s
  where s.id = p_site_id and s.organisation_id = p_organisation_id;
  if not found then
    raise exception 'That site wasn''t found.' using errcode = 'MLBM3';
  end if;

  select coalesce(array_agg(distinct x.id order by x.id), '{}')
  into v_projects
  from unnest(coalesce(p_project_ids, '{}')) as x (id)
  where x.id is not null;
  if cardinality(v_projects) > 50 then
    raise exception 'Choose 50 projects or fewer.' using errcode = 'MLBM3';
  end if;
  -- Slice 6.11: an office has no client, so no projects.
  if v_site.kind = 'office' and cardinality(v_projects) > 0 then
    raise exception 'An office has no projects. Map people to it without projects.'
      using errcode = 'MLBM3';
  end if;
  -- The projects offered are the site's client's; anything else is refused before anyone moves.
  if exists (
    select 1
    from unnest(v_projects) as x (id)
    where not exists (
      select 1 from public.projects p
      where p.id = x.id
        and p.organisation_id = p_organisation_id
        and p.client_id = v_site.client_id
    )
  ) then
    raise exception 'That project isn''t one of this site''s client''s projects.' using errcode = 'MLBM3';
  end if;

  -- Lock everyone selected, in one order, so two batches never interleave on the same people.
  perform 1
  from public.workers w
  where w.organisation_id = p_organisation_id
    and w.id = any (v_ids)
  order by w.id
  for update;

  -- Not in this company, or left: the single save's own words (P0002, MLAS2).
  v_refusals := private.people_bulk_inactive(p_organisation_id, v_ids);

  begin
    for v_row in
      select w.id, w.first_name || ' ' || w.last_name as name, w.staff_id, w.department_id,
             w.line_manager_worker_id, w.line_manager_membership_id
      from public.workers w
      where w.organisation_id = p_organisation_id
        and w.id = any (v_ids)
        and w.status = 'active'
      order by w.last_name, w.first_name, w.staff_id, w.id
    loop
      -- What the single save reads as the mapping now: rows not ended by the end of today.
      select coalesce(array_agg(distinct a.project_id order by a.project_id)
                        filter (where a.project_id is not null), '{}'),
             string_agg(distinct s.name, ', ' order by s.name)
               filter (where a.site_id is not null and a.site_id <> p_site_id)
      into v_current_projects, v_other_sites
      from public.worker_assignments a
      left join public.sites s on s.id = a.site_id and s.organisation_id = a.organisation_id
      where a.worker_id = v_row.id
        and a.organisation_id = p_organisation_id
        and (a.effective_to is null or a.effective_to > v_today);

      if p_mode = 'add' then
        if v_other_sites is not null then
          v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
            'worker_id', v_row.id,
            'name', v_row.name,
            'staff_id', v_row.staff_id,
            'reason', 'Works at ' || v_other_sites
              || '. A person works at one site, so choose Replace to move them.'
          ));
          continue;
        end if;
        select coalesce(array_agg(distinct x.id order by x.id), '{}')
        into v_save_projects
        from unnest(v_current_projects || v_projects) as x (id);
      else
        v_save_projects := v_projects;
      end if;

      begin
        -- The single save, unchanged; department and line manager passed back as they are.
        v_result := public.save_worker_mapping(
          p_organisation_id,
          v_row.id,
          v_row.department_id,
          v_row.line_manager_worker_id,
          v_row.line_manager_membership_id,
          p_site_id,
          v_save_projects
        );
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        v_refusals := v_refusals || jsonb_build_array(jsonb_build_object(
          'worker_id', v_row.id,
          'name', v_row.name,
          'staff_id', v_row.staff_id,
          'reason', case
            when v_state = '23P01'
              then 'This employee is already on that site or project for these dates.'
            when v_state = 'MLHO5'
              then 'Works on projects, and an office has none. Choose Replace to take them off their projects.'
            when v_state in ('MLAS1', 'MLAS2', 'MLAS4', 'MLAS5', 'MLAS6', 'MLAS7', 'P0002')
              then v_message
            else 'Their mapping couldn''t be changed here. Open their page to map them.'
          end
        ));
        continue;
      end;

      if (v_result ->> 'changed')::boolean then
        v_changed := v_changed + 1;
        if not coalesce(p_dry_run, false) then
          perform private.log_audit_impl(
            p_organisation_id,
            'people.mapping_saved',
            'workers',
            v_row.id,
            jsonb_build_object(
              'department', v_result -> 'before' -> 'department',
              'lineManager', v_result -> 'before' -> 'line_manager',
              'sites', v_result -> 'before' -> 'sites',
              'projects', v_result -> 'before' -> 'projects'
            ),
            jsonb_build_object(
              'department', v_result -> 'after' -> 'department',
              'lineManager', v_result -> 'after' -> 'line_manager',
              'sites', v_result -> 'after' -> 'sites',
              'projects', v_result -> 'after' -> 'projects',
              'assignmentsFrom', case
                when (v_result ->> 'assignments_changed')::boolean then v_result -> 'effective_from'
                else 'null'::jsonb
              end,
              'bulk', true
            ),
            null
          );
        end if;
      end if;

      v_people := v_people || jsonb_build_array(jsonb_build_object(
        'worker_id', v_row.id,
        'name', v_row.name,
        'staff_id', v_row.staff_id,
        'changed', (v_result ->> 'changed')::boolean,
        'assignments_changed', (v_result ->> 'assignments_changed')::boolean,
        'effective_from', v_result -> 'effective_from',
        'before', v_result -> 'before',
        'after', v_result -> 'after',
        'released_shifts', coalesce(v_result -> 'released_shifts', '[]'::jsonb)
      ));
    end loop;

    if not coalesce(p_dry_run, false) then
      if jsonb_array_length(v_refusals) > 0 then
        -- Ids and reasons only: no names or staff IDs in an error (security review L1). The
        -- server names them from its own read, as the dry run's list already did.
        raise exception 'Nobody was mapped: % of the people selected can''t be.',
          jsonb_array_length(v_refusals)
          using errcode = 'MLBM2',
                detail = (
                  select jsonb_agg(jsonb_build_object('worker_id', r -> 'worker_id', 'reason', r -> 'reason'))
                  from jsonb_array_elements(v_refusals) r
                )::text;
      end if;
      perform private.log_audit_impl(
        p_organisation_id,
        'people.bulk_mapping_saved',
        'workers',
        null,
        null,
        jsonb_build_object(
          'count', cardinality(v_ids),
          'changed', v_changed,
          'mode', p_mode,
          'site_id', p_site_id,
          'project_ids', to_jsonb(v_projects),
          'worker_ids', to_jsonb(v_ids)
        ),
        null
      );
    end if;

    v_out := jsonb_build_object(
      'dry_run', coalesce(p_dry_run, false),
      'mode', p_mode,
      'selected', cardinality(v_ids),
      'changed', v_changed,
      'people', v_people,
      'refusals', v_refusals
    );
    if coalesce(p_dry_run, false) then
      -- The preview: undo every write in this block (variables keep their values).
      raise exception 'preview' using errcode = 'MLBMP';
    end if;
  exception when sqlstate 'MLBMP' then
    null;
  end;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The people import (security review H1)
-- ---------------------------------------------------------------------------
-- public.commit_import_batch: its latest definition (20261122110000_pay_inputs.sql), unchanged
-- except that the site lookup reads clients' sites only. It keyed every site on
-- 'id:' || client_id || ':' || id, and an office's null client made a null key, which
-- jsonb_object_agg refuses ("field name must not be null"): every import would have failed once
-- Head office existed. Import rows name a client and its site, so an office never matches anyway.
create or replace function public.commit_import_batch(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  v_status public.import_batch_status;
  v_sent integer;
  v_found integer;
  v_done integer;
  v_held integer;
  v_item jsonb;
  v_worker jsonb;
  v_worker_id uuid;
  v_departments jsonb;
  v_clients jsonb;
  v_sites jsonb;
  v_projects jsonb;
  v_department uuid;
  v_client uuid;
  v_site uuid;
  v_project uuid;
  v_created integer := 0;
  v_new_departments integer := 0;
  v_new_clients integer := 0;
  v_new_sites integer := 0;
  v_new_projects integer := 0;
  v_single_approver boolean := false;
  v_bank public.workers;
  v_bank_saved integer := 0;
begin
  if not private.has_role(p_organisation_id, array['owner', 'hr']) then
    raise exception 'Your role can''t import employees.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Nothing to import.' using errcode = '22023';
  end if;

  -- One commit per batch at a time.
  select b.status into v_status
  from public.import_batches b
  where b.id = p_batch_id and b.organisation_id = p_organisation_id
  for update;
  if v_status is null then
    raise exception 'That import wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status = 'cancelled' then
    raise exception 'This import was cancelled. Upload the file again.' using errcode = 'MLIM2';
  end if;
  if v_status = 'uploaded' then
    raise exception 'Check the file before importing it.' using errcode = 'MLIM2';
  end if;

  -- The rows named (kept still by the batch lock above).
  select count(*)::integer into v_sent from jsonb_array_elements(p_rows);
  select count(*)::integer,
         count(*) filter (where r.status = 'imported')::integer,
         count(*) filter (where r.status = 'held')::integer
  into v_found, v_done, v_held
  from public.import_rows r
  where r.batch_id = p_batch_id
    and r.organisation_id = p_organisation_id
    and r.id in (select (e.item ->> 'row_id')::uuid from jsonb_array_elements(p_rows) as e (item));

  if v_found <> v_sent then
    raise exception 'A row of this import wasn''t found.' using errcode = 'P0002';
  end if;
  if v_sent = 0 then
    return jsonb_build_object('created', 0, 'already_imported', 0, 'departments', 0,
      'clients', 0, 'sites', 0, 'projects', 0);
  end if;
  if v_done = v_sent then
    return jsonb_build_object('created', 0, 'already_imported', v_done, 'departments', 0,
      'clients', 0, 'sites', 0, 'projects', 0);
  end if;
  if v_done > 0 then
    raise exception 'Some of these rows were imported a moment ago. Check the file again.'
      using errcode = 'MLIM1';
  end if;
  if v_held > 0 then
    raise exception 'Rows that need fixing can''t be imported yet. Check the file again.'
      using errcode = 'MLIM1';
  end if;

  -- Decision 20: the owner's import before setup is finished saves bank details directly.
  v_single_approver := private.import_single_approver(p_organisation_id, p_batch_id);

  -- New names, once each. The server sends a name only when it found no match.
  insert into public.departments (organisation_id, name)
  select distinct on (lower(n.name)) p_organisation_id, n.name
  from (
    select btrim(e.item -> 'department' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where (e.item -> 'department') ? 'name'
  ) as n
  where n.name <> ''
  on conflict (organisation_id, lower(name)) do nothing;
  get diagnostics v_new_departments = row_count;

  insert into public.clients (organisation_id, name)
  select distinct on (lower(n.name)) p_organisation_id, n.name
  from (
    select btrim(e.item -> 'client' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where jsonb_typeof(e.item -> 'client') = 'object' and (e.item -> 'client') ? 'name'
  ) as n
  where n.name <> ''
  on conflict (organisation_id, lower(name)) do nothing;
  get diagnostics v_new_clients = row_count;

  -- Lookups by id and by lower-case name, for this organisation only.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_departments
  from public.departments d
  cross join lateral (values ('id:' || d.id::text, d.id), ('name:' || lower(d.name), d.id)) as m (k, v)
  where d.organisation_id = p_organisation_id;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_clients
  from public.clients c
  cross join lateral (values ('id:' || c.id::text, c.id), ('name:' || lower(c.name), c.id)) as m (k, v)
  where c.organisation_id = p_organisation_id;

  -- Sites and projects belong to a client: new ones once each per client.
  insert into public.sites (organisation_id, client_id, name)
  select distinct on (n.client_id, lower(n.name)) p_organisation_id, n.client_id, n.name
  from (
    select (v_clients ->> case
              when (e.item -> 'client') ? 'id' then 'id:' || (e.item -> 'client' ->> 'id')
              else 'name:' || lower(btrim(e.item -> 'client' ->> 'name'))
            end)::uuid as client_id,
           btrim(e.item -> 'site' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where jsonb_typeof(e.item -> 'client') = 'object'
      and jsonb_typeof(e.item -> 'site') = 'object'
      and (e.item -> 'site') ? 'name'
  ) as n
  where n.client_id is not null and n.name <> ''
  on conflict (organisation_id, client_id, lower(name)) do nothing;
  get diagnostics v_new_sites = row_count;

  insert into public.projects (organisation_id, client_id, name)
  select distinct on (n.client_id, lower(n.name)) p_organisation_id, n.client_id, n.name
  from (
    select (v_clients ->> case
              when (e.item -> 'client') ? 'id' then 'id:' || (e.item -> 'client' ->> 'id')
              else 'name:' || lower(btrim(e.item -> 'client' ->> 'name'))
            end)::uuid as client_id,
           btrim(e.item -> 'project' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where jsonb_typeof(e.item -> 'client') = 'object'
      and jsonb_typeof(e.item -> 'project') = 'object'
      and (e.item -> 'project') ? 'name'
  ) as n
  where n.client_id is not null and n.name <> ''
  on conflict (organisation_id, client_id, lower(name)) do nothing;
  get diagnostics v_new_projects = row_count;

  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_sites
  from public.sites s
  cross join lateral (
    values ('id:' || s.client_id::text || ':' || s.id::text, s.id),
           ('name:' || s.client_id::text || ':' || lower(s.name), s.id)
  ) as m (k, v)
  where s.organisation_id = p_organisation_id
    -- Slice 6.11: an office has no client, so its keys would be null. Rows name clients' sites.
    and s.kind = 'client';
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_projects
  from public.projects p
  cross join lateral (
    values ('id:' || p.client_id::text || ':' || p.id::text, p.id),
           ('name:' || p.client_id::text || ':' || lower(p.name), p.id)
  ) as m (k, v)
  where p.organisation_id = p_organisation_id;

  for v_item in
    select e.item from jsonb_array_elements(p_rows) with ordinality as e (item, n) order by e.n
  loop
    v_department := (v_departments ->> case
      when (v_item -> 'department') ? 'id' then 'id:' || (v_item -> 'department' ->> 'id')
      else 'name:' || lower(btrim(v_item -> 'department' ->> 'name'))
    end)::uuid;
    if v_department is null then
      raise exception 'An employee in this import has no department.' using errcode = '22023';
    end if;

    v_client := null;
    v_site := null;
    v_project := null;
    if jsonb_typeof(v_item -> 'client') = 'object' then
      v_client := (v_clients ->> case
        when (v_item -> 'client') ? 'id' then 'id:' || (v_item -> 'client' ->> 'id')
        else 'name:' || lower(btrim(v_item -> 'client' ->> 'name'))
      end)::uuid;
      if v_client is null then
        raise exception 'A client in this import wasn''t found.' using errcode = 'P0002';
      end if;
      if jsonb_typeof(v_item -> 'site') = 'object' then
        v_site := (v_sites ->> case
          when (v_item -> 'site') ? 'id' then 'id:' || v_client::text || ':' || (v_item -> 'site' ->> 'id')
          else 'name:' || v_client::text || ':' || lower(btrim(v_item -> 'site' ->> 'name'))
        end)::uuid;
        if v_site is null then
          raise exception 'A site in this import wasn''t found.' using errcode = 'P0002';
        end if;
      end if;
      if jsonb_typeof(v_item -> 'project') = 'object' then
        v_project := (v_projects ->> case
          when (v_item -> 'project') ? 'id' then 'id:' || v_client::text || ':' || (v_item -> 'project' ->> 'id')
          else 'name:' || v_client::text || ':' || lower(btrim(v_item -> 'project' ->> 'name'))
        end)::uuid;
        if v_project is null then
          raise exception 'A project in this import wasn''t found.' using errcode = 'P0002';
        end if;
      end if;
    end if;

    -- The worker, always in this organisation, with the department and line manager resolved
    -- here. create_worker runs as the caller: RLS, grants and the workers triggers apply
    -- (line-manager checks, needs_pay_details, audit).
    v_worker := coalesce(v_item -> 'worker', '{}'::jsonb)
      || jsonb_build_object(
        'organisation_id', p_organisation_id,
        'department_id', v_department,
        'line_manager_worker_id', v_item -> 'line_manager' ->> 'worker_id',
        'line_manager_membership_id', v_item -> 'line_manager' ->> 'membership_id'
      );
    v_bank := jsonb_populate_record(null::public.workers, v_worker);
    if v_single_approver
      and num_nulls(v_bank.bank_name, v_bank.account_name, v_bank.bank_account_enc, v_bank.bank_account_last4) = 0 then
      v_worker_id := public.create_worker(
        v_worker - 'bank_name' - 'account_name' - 'bank_account_enc' - 'bank_account_last4',
        null
      );
      perform private.import_bank_details_single_approver(
        p_organisation_id, p_batch_id, v_worker_id, v_bank.bank_name, v_bank.account_name,
        v_bank.bank_account_enc, v_bank.bank_account_last4
      );
      v_bank_saved := v_bank_saved + 1;
    else
      -- Slice 2.3b: create_worker no longer takes unchecked bank details from a signed-in
      -- caller, so they go in as a `not_checked` request through the definer function.
      v_worker_id := public.create_worker(
        v_worker - 'bank_name' - 'account_name' - 'bank_account_enc' - 'bank_account_last4'
          - 'bank_code' - 'bank_lookup_id' - 'bank_account_digest' - 'name_check'
          - 'name_check_reason',
        null
      );
      if num_nulls(v_bank.bank_name, v_bank.account_name, v_bank.bank_account_enc,
          v_bank.bank_account_last4) = 0 then
        perform private.import_bank_change(
          p_organisation_id, p_batch_id, v_worker_id, v_bank.bank_name, v_bank.account_name,
          v_bank.bank_account_enc, v_bank.bank_account_last4, v_bank.bank_code
        );
      end if;
    end if;

    -- The first pay version from the start date. The worker is new, so there is nothing to
    -- close; private.pay_rates_guard still checks the start date.
    if jsonb_typeof(v_item -> 'pay_rate') = 'object' then
      insert into public.pay_rates (
        organisation_id, worker_id, pay_type, basic_kobo, housing_kobo, transport_kobo,
        other_allowances_kobo, daily_rate_kobo, hourly_rate_kobo, effective_from
      )
      values (
        p_organisation_id,
        v_worker_id,
        (v_item -> 'pay_rate' ->> 'pay_type')::public.pay_type,
        (v_item -> 'pay_rate' ->> 'basic_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'housing_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'transport_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'other_allowances_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'daily_rate_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'hourly_rate_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'effective_from')::date
      );
    end if;

    if v_client is not null then
      insert into public.worker_assignments (
        organisation_id, worker_id, client_id, site_id, project_id, effective_from
      )
      values (
        p_organisation_id, v_worker_id, v_client, v_site, v_project,
        (v_worker ->> 'start_date')::date
      );
    end if;

    v_created := v_created + 1;
  end loop;

  perform private.mark_import_rows_imported(p_organisation_id, p_batch_id, p_rows);

  update public.import_batches b
  set status = 'committed',
      committed_at = coalesce(b.committed_at, now()),
      committed_by = coalesce(b.committed_by, (select auth.uid())),
      rows_ready = counts.ready,
      rows_held = counts.held,
      rows_imported = counts.imported
  from (
    select
      count(*) filter (where r.status in ('ready', 'fixed'))::integer as ready,
      count(*) filter (where r.status = 'held')::integer as held,
      count(*) filter (where r.status = 'imported')::integer as imported
    from public.import_rows r
    where r.batch_id = p_batch_id
  ) as counts
  where b.id = p_batch_id and b.organisation_id = p_organisation_id;

  perform public.log_audit(
    p_organisation_id,
    'people.import_committed',
    'import_batches',
    p_batch_id,
    null,
    jsonb_build_object(
      'created', v_created,
      'departments', v_new_departments,
      'clients', v_new_clients,
      'sites', v_new_sites,
      'projects', v_new_projects,
      'bank_details_saved', v_bank_saved
    ),
    null
  );

  return jsonb_build_object(
    'created', v_created,
    'already_imported', 0,
    'departments', v_new_departments,
    'clients', v_new_clients,
    'sites', v_new_sites,
    'projects', v_new_projects,
    'bank_details_saved', v_bank_saved
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Clock-ins at an office (security review M1, money review M1)
-- ---------------------------------------------------------------------------
-- `no_geofence`: a punch at an office that has no geofence yet. Recorded, never refused; the
-- flag shows the location went unchecked. The list is checkpoint scans' (20261120220000) plus it.
create or replace function private.punch_flag_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'outside', 'near', 'no_location', 'no_shift', 'late', 'early_out', 'no_selfie',
    'clock_drift', 'delayed', 'late_sync', 'time_unverified', 'double_in', 'out_without_in',
    'queued_offline', 'no_geofence'
  ]
$$;

-- private.record_punch: its latest definition (20261120220000_checkpoint_scans.sql), with two
-- changes. A punch naming an office the worker is mapped to matches no shift (a leftover shift
-- at a client's site never claims it), and a punch at an office with no geofence is flagged
-- `no_geofence`. Everything else is unchanged: the worker and organisation from the caller's own
-- worker membership (the phone's values only compared), a trusted session, the site checks
-- (MLPU7 for a site the worker isn't mapped or rostered to, another company's office included).
create or replace function private.record_punch(
  p_expected_organisation_id uuid,
  p_expected_worker_id uuid,
  p_client_event_id uuid,
  p_kind text,
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_site_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_outside_reason text,
  p_outside_note text,
  p_has_selfie boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_org uuid;
  v_worker uuid;
  v_status public.worker_status;
  v_existing public.punches;
  v_hash text;
  v_note text := nullif(btrim(p_outside_note), '');
  v_received timestamptz := now();
  v_recorded timestamptz;
  v_time_source text;
  v_drift integer;
  v_has_point boolean;
  v_point extensions.geography;
  v_accuracy integer;
  v_prev public.punches;
  v_asg_id uuid;
  v_asg_shift uuid;
  v_asg_site uuid;
  v_asg_start timestamptz;
  v_asg_end timestamptz;
  v_site uuid;
  v_result text := 'unknown';
  v_distance integer;
  v_selfie boolean := false;
  v_grace integer;
  v_flags text[];
  v_reason text;
  v_today date;
  v_row public.punches;
  v_at_office boolean := false;
begin
  if v_uid is null then
    raise exception 'Sign in to the worker app to clock in.' using errcode = '42501';
  end if;

  -- The caller's own worker login, in the company the phone's queue belongs to.
  select m.organisation_id, m.worker_id, w.status into v_org, v_worker, v_status
  from public.memberships m
  join public.workers w on w.organisation_id = m.organisation_id and w.id = m.worker_id
  where m.user_id = v_uid
    and m.role = 'worker'
    and m.worker_id is not null
    and m.organisation_id = p_expected_organisation_id
    and m.worker_id = p_expected_worker_id;
  if v_worker is null then
    if exists (
      select 1 from public.memberships m
      where m.user_id = v_uid and m.role = 'worker' and m.worker_id is not null
    ) then
      raise exception 'This punch was saved by someone else on this phone.' using errcode = 'MLPU9';
    end if;
    raise exception 'Only a worker can clock in, signed in to the worker app.' using errcode = 'MLPU1';
  end if;

  if p_client_event_id is null or p_kind is null or p_kind not in ('in', 'out')
    or p_device_time is null
    or p_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00'
    or (p_sent_device_time is not null
      and p_sent_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00')
    or (p_elapsed_ms is not null and abs(p_elapsed_ms) > 1000000000000) then
    raise exception 'This punch is incomplete.' using errcode = 'MLPU5';
  end if;

  perform set_config('metalira.audit_channel', 'worker_app', true);
  -- One punch at a time per worker: sequencing, the rate limit and idempotency see each other.
  perform pg_advisory_xact_lock(hashtextextended('punches:' || v_worker::text, 0));

  v_hash := md5(concat_ws('|',
    p_kind,
    (extract(epoch from p_device_time) * 1000)::bigint,
    coalesce(p_site_id::text, '-'),
    coalesce(round(p_latitude::numeric, 6)::text, '-'),
    coalesce(round(p_longitude::numeric, 6)::text, '-'),
    coalesce(round(p_accuracy_m::numeric)::text, '-'),
    coalesce(p_outside_reason, '-'),
    coalesce(v_note, '-'),
    coalesce(p_has_selfie, false)::text
  ));

  -- Idempotency: the same event sent again gets the row it made.
  select p.* into v_existing
  from public.punches p
  where p.organisation_id = v_org and p.worker_id = v_worker
    and p.client_event_id = p_client_event_id;
  if found then
    if v_existing.payload_hash <> v_hash then
      raise exception 'A different punch was already sent under this id.' using errcode = 'MLPU2';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'duplicate', true,
      'kind', v_existing.kind,
      'recorded_at', v_existing.recorded_at,
      'geofence_result', v_existing.geofence_result,
      'distance_m', v_existing.distance_m,
      'flags', to_jsonb(v_existing.flags),
      'selfie_wanted', v_existing.selfie_expected and v_existing.selfie_path is null
        and v_existing.selfie_deleted_at is null
    );
  end if;

  if v_status = 'ended' then
    raise exception 'You have left this company, so you can''t clock in.' using errcode = 'MLPU3';
  end if;
  if not private.org_shifts_enabled(v_org) then
    raise exception 'Clock-in is switched off for your company.' using errcode = 'MLPU4';
  end if;

  -- Values.
  v_has_point := p_latitude is not null and p_longitude is not null;
  if (p_latitude is null) <> (p_longitude is null)
    or (v_has_point and (
      p_latitude not between -90 and 90 or p_longitude not between -180 and 180
      or p_latitude = 'NaN'::double precision or p_longitude = 'NaN'::double precision
    ))
    or (p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m = 'NaN'::double precision))
    or (p_outside_reason is not null
      and p_outside_reason not in ('gate_locked', 'errand', 'location_wrong', 'other'))
    or (v_note is not null and not private.punch_note_ok(v_note))
    or (v_note is not null and p_outside_reason is null) then
    raise exception 'This punch has values that aren''t valid.' using errcode = 'MLPU5';
  end if;

  if not private.worker_has_consent(v_org, v_worker, 'location') then
    raise exception 'Agree to share your location first, or ask your supervisor to clock you in.'
      using errcode = 'MLPU6';
  end if;

  -- At most 20 punches an hour per worker.
  if (
    select count(*) from public.punches p
    where p.worker_id = v_worker and p.received_at > v_received - interval '1 hour'
      and p.kind in ('in', 'out')
  ) >= 20 then
    raise exception 'Too many punches in the last hour. Try again later.' using errcode = 'MLPU8';
  end if;

  -- Time.
  select t.recorded_at, t.time_source into v_recorded, v_time_source
  from private.punch_corrected_time(p_device_time, p_sent_device_time, p_elapsed_ms, v_received) t;
  v_drift := round(extract(epoch from (p_device_time - v_recorded)))::integer;

  -- The punch before this one, by the time it happened.
  select p.* into v_prev
  from public.punches p
  where p.worker_id = v_worker and p.organisation_id = v_org and p.recorded_at <= v_recorded
    and p.kind in ('in', 'out')
  order by p.recorded_at desc, p.created_at desc
  limit 1;

  -- The shift. A clock-out belongs to its open clock-in's shift when it has one.
  if p_kind = 'out' and v_prev.kind = 'in' and v_prev.shift_assignment_id is not null
    and v_prev.recorded_at > v_recorded - interval '20 hours' then
    select a.id, a.shift_id, a.site_id, a.starts_at, a.ends_at
    into v_asg_id, v_asg_shift, v_asg_site, v_asg_start, v_asg_end
    from public.shift_assignments a
    where a.organisation_id = v_org and a.id = v_prev.shift_assignment_id;
  end if;
  -- Slice 6.11 (money review M1): a clock-in at an office the worker is mapped to is office
  -- work. It never matches a shift at another site (a leftover client shift), so it can't
  -- become a Work Unit there.
  if p_site_id is not null then
    v_at_office := exists (
      select 1
      from public.sites s
      join public.worker_assignments wa
        on wa.organisation_id = s.organisation_id and wa.site_id = s.id
      where s.organisation_id = v_org and s.id = p_site_id and s.kind = 'office'
        and wa.worker_id = v_worker
        and wa.effective_from <= private.org_today(v_org) + 1
        and (wa.effective_to is null or wa.effective_to >= private.org_today(v_org) - 1)
    );
  end if;
  if v_asg_id is null and not v_at_office then
    select a.id, a.shift_id, a.site_id, a.starts_at, a.ends_at
    into v_asg_id, v_asg_shift, v_asg_site, v_asg_start, v_asg_end
    from public.shift_assignments a
    where a.organisation_id = v_org
      and a.worker_id = v_worker
      and a.status = 'assigned'
      and v_recorded >= a.starts_at - interval '2 hours'
      and v_recorded <= a.ends_at + interval '4 hours'
    -- A published assignment (slice 3.3) before an unpublished one, then the nearest start.
    order by exists (
        select 1 from public.roster_publications rp
        where rp.organisation_id = a.organisation_id
          and rp.site_id = a.site_id
          and rp.week_start = a.shift_date - (extract(isodow from a.shift_date)::integer - 1)
          and rp.snapshot @> jsonb_build_array(jsonb_build_object('a', a.id::text))
      ) desc,
      abs(extract(epoch from (v_recorded - a.starts_at))), a.starts_at
    limit 1;
  end if;

  -- The site: the shift's; else one the worker is mapped to or rostered at (never another
  -- company's); else, for a clock-out, the clock-in's.
  v_today := private.org_today(v_org);
  if v_asg_id is not null then
    v_site := v_asg_site;
  elsif p_site_id is not null then
    if not exists (
      select 1 from public.worker_assignments wa
      where wa.organisation_id = v_org and wa.worker_id = v_worker and wa.site_id = p_site_id
        and wa.effective_from <= v_today + 1
        and (wa.effective_to is null or wa.effective_to >= v_today - 1)
    ) and not exists (
      select 1 from public.shift_assignments a
      where a.organisation_id = v_org and a.worker_id = v_worker and a.site_id = p_site_id
        and a.shift_date between v_today - 2 and v_today + 1
    ) then
      raise exception 'You aren''t working at that site.' using errcode = 'MLPU7';
    end if;
    v_site := p_site_id;
  elsif p_kind = 'out' and v_prev.kind = 'in' then
    v_site := v_prev.site_id;
  end if;

  -- Where.
  if v_has_point then
    v_point := extensions.st_setsrid(
      extensions.st_makepoint(p_longitude, p_latitude), 4326
    )::extensions.geography;
    v_accuracy := least(round(coalesce(p_accuracy_m, 0)), 100000)::integer;
    if v_site is not null then
      v_result := coalesce(private.site_geofence_check(v_org, v_site, v_point, v_accuracy), 'unknown');
      select round(extensions.st_distance(coalesce(s.centre, s.geofence), v_point))::integer
      into v_distance
      from public.sites s
      where s.organisation_id = v_org and s.id = v_site
        and coalesce(s.centre, s.geofence) is not null;
    end if;
  end if;
  if v_result in ('outside', 'near') then
    v_reason := p_outside_reason;
  else
    v_reason := null;
    v_note := null;
  end if;

  -- The selfie: clock-ins only, and only with the worker's consent.
  v_selfie := p_kind = 'in' and coalesce(p_has_selfie, false)
    and private.worker_has_consent(v_org, v_worker, 'selfie');

  select o.late_grace_minutes into v_grace from public.organisations o where o.id = v_org;
  v_flags := private.punch_flags(
    p_kind, v_result, v_has_point, v_selfie, v_asg_start, v_asg_end, v_grace,
    v_recorded, v_received, v_drift, v_time_source, v_prev.kind, v_prev.recorded_at
  );
  -- Slice 6.11 (security review M1): a clock-in at an office with no geofence yet is recorded
  -- (never refused) and flagged, so the unchecked location is seen.
  if v_site is not null and exists (
    select 1 from public.sites s
    where s.organisation_id = v_org and s.id = v_site and s.kind = 'office' and s.geofence is null
  ) then
    v_flags := v_flags || 'no_geofence'::text;
  end if;

  insert into public.punches (
    organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
    shift_assignment_id, shift_id, site_id, device_time, received_at, recorded_at, time_source,
    clock_drift_seconds, location, accuracy_m, distance_m, geofence_result, outside_reason,
    outside_note, selfie_expected, flags, payload_hash
  ) values (
    v_org, v_worker, p_kind, 'self', v_uid, p_client_event_id,
    v_asg_id, v_asg_shift, v_site, p_device_time, v_received, v_recorded, v_time_source,
    v_drift, v_point, case when v_has_point then v_accuracy end, v_distance, v_result, v_reason,
    v_note, v_selfie, v_flags, v_hash
  )
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'duplicate', false,
    'kind', v_row.kind,
    'recorded_at', v_row.recorded_at,
    'geofence_result', v_row.geofence_result,
    'distance_m', v_row.distance_m,
    'flags', to_jsonb(v_row.flags),
    'selfie_wanted', v_row.selfie_expected
  );
end;
$$;
