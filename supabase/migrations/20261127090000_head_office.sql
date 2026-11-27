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
-- null-safely), and only owner, admin and ops_manager add an office (42501). The role check is
-- for statements a signed-in user runs; a definer function (the new company's Head office) or
-- the secret key is trusted, as for every other table.
create function private.sites_kind_guard()
returns trigger
language plpgsql
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
    and current_user = 'authenticated'
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
-- is never refused. Definer so the overlap check sees every row of the person.
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
    and not (
      old.effective_to is not null
      and (new.effective_to is null or new.effective_to > old.effective_to)
    ) then
    return new;
  end if;

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

-- public.save_worker_mapping: slice 1.6's definition (its only one), with one check added after
-- the site and projects are found: an office takes no projects (MLHO5). Everything else is
-- unchanged. Security invoker, so RLS, the column grants and the worker and assignment triggers
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
        'after', v_result -> 'after'
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
