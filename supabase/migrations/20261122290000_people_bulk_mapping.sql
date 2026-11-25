-- Slice U.3: bulk mapping on the People list (owner-requested, 25 Nov 2026).
--
-- public.bulk_map_workers(org, worker_ids, site, project_ids, mode, dry_run) maps up to 200
-- selected people to one site and, optionally, projects of that site's client, through the single
-- mapping save itself (public.save_worker_mapping, slice 1.6, its only definition), called once
-- per person inside this one transaction. So every person passes exactly the single save's rules:
-- the effective date (the next shift: tomorrow, or the start date of someone who hasn't started),
-- rows that stop applying closed the day before (or removed when they never applied), leavers
-- refused (MLAS2), the site and projects in this company (MLAS4, MLAS5), a site or project of
-- another client than the row's (MLAS1), archived sites and clients (MLAS6, MLAS7), and no
-- overlapping rows (23P01). The single save doesn't touch the roster or posts, so neither does
-- this.
--
-- Each person keeps their department and line manager: they are passed back to the single save
-- unchanged (U.1 has its own bulk actions for those), so it never updates the workers row.
--
-- Modes:
-- * replace: the chosen site and projects only. Every other site and project row closes from the
--   next shift (the single save's own comparison).
-- * add: the person's current projects are kept and the chosen ones added. The single save keeps
--   one site per person, so someone already at another site is refused with the reason (Replace
--   moves them); someone with no site, or already at this one, gets or keeps it.
--
-- All or nothing: if anyone is refused, nothing changes and the refusal (MLBM2) lists each person
-- and why, as JSON in its DETAIL. p_dry_run works everything out through the same calls and then
-- rolls it all back (MLBMP never leaves the function), so the preview and the confirm agree.
--
-- Audit: one `people.mapping_saved` row per person whose mapping changed, with the single save's
-- before and after shape ({department, lineManager, sites, projects}, after adding
-- assignmentsFrom, plus bulk: true), and one `people.bulk_mapping_saved` row for the batch. The
-- row audit triggers log every assignment row as well.
--
-- Roles: owner, admin and hr (private.people_bulk_assert_editor, the single save's roles). A
-- trusted session only, else 42501. The organisation is the caller's active one, passed by the
-- server from the verified session, and only its rows are touched: another company's worker,
-- site or project ids are refused as not found.
--
-- Refusals: 42501 role or untrusted session; MLBU1 nobody selected, or more than 200 (U.1's
-- helper); MLBM1 the mode or a missing site; MLBM2 someone selected can't be mapped (DETAIL:
-- [{worker_id, reason}], no names; the dry run returns names in its result instead); MLBM3 the
-- site or a project isn't this company's, or a project isn't of the site's client. MLBMP is the
-- dry run's internal rollback.
--
-- No table, trigger or policy is added.

create function private.bulk_map_workers(
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

  select s.id, s.client_id, s.name into v_site
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

revoke all on function private.bulk_map_workers(uuid, uuid[], uuid, uuid[], text, boolean)
  from public, anon;
grant execute on function private.bulk_map_workers(uuid, uuid[], uuid, uuid[], text, boolean)
  to authenticated;

create function public.bulk_map_workers(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_site_id uuid,
  p_project_ids uuid[] default '{}',
  p_mode text default 'replace',
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bulk_map_workers(
    p_organisation_id, p_worker_ids, p_site_id, p_project_ids, p_mode, p_dry_run
  )
$$;

revoke all on function public.bulk_map_workers(uuid, uuid[], uuid, uuid[], text, boolean)
  from public, anon;
grant execute on function public.bulk_map_workers(uuid, uuid[], uuid, uuid[], text, boolean)
  to authenticated;
