-- Slice 4.0: close the line-manager column gap (Phase 4 owner decision 11, carried from Phase 1
-- slice 1.11).
--
-- Until now workers_select let a line manager select whole rows of their reportees from
-- public.workers, bank, tax, NIN, RSA and rent columns included. The app never asked for them
-- (people-data.ts read a short column list for line managers), but the Data API would hand them
-- over to anyone holding a line manager's session. RLS filters rows, not columns, so the fix is:
--
-- 1. workers_select loses its two line-manager branches. Owner, admin, hr, finance and
--    ops_manager keep reading the company's workers, and every login keeps reading its own
--    worker row (private.my_worker_ids). A line manager now reads no reportee row from
--    public.workers at all.
-- 2. public.my_reportees(p_organisation_id) (the "team_members" read of docs/PHASE_4.md; that
--    name is taken by Settings > Team's manager list): a security-definer read (behind a security-invoker
--    wrapper, search_path '') that returns the caller's reportees with safe columns only: who
--    they are, how to reach them, their job and employment dates, their line manager, the
--    supervisor clock-in flag and the sites they are mapped to. Never an _enc or _last4 column,
--    bank name, account name, bank code or check, TIN, tax state, PFA, NHF, rent, pay or next of
--    kin. tests/rls/my-reportees.test.ts snapshots the column list, so adding a column here
--    fails CI until the snapshot is changed on purpose.
--
-- Who the reportees are is private.my_line_manager_keys() (the caller's trusted session and
-- line_manager memberships), the same rule workers_select used, so the set of people a line
-- manager sees doesn't change; only the columns do. The organisation argument only narrows that
-- set: a company where the caller is not a line manager, another company, a worker login, an
-- untrusted session (private.session_uid() null) or an anonymous caller all get no rows.
--
-- Definer functions that already join workers (attendance_board, my_clock_context,
-- worker_sign_in_status, my_line_manager and the rest) keep working: they don't pass through
-- workers_select. No policy reads public.workers in a subquery, and the security-invoker
-- functions that read it (create_worker, save_worker_mapping, add_pay_rate, ...) are for
-- owner, admin and hr, whose access is unchanged.
--
-- usual_work_days: Phase 4 slice 4.1 adds workers.usual_work_days. Until then this read returns
-- null in that column, so its shape is fixed now; 4.1 replaces the function body to read the
-- column (tests/rls/my-reportees.test.ts fails once the column exists and is not returned).
--
-- Nothing here writes, so nothing is audited. No new table, so no new isolation entry.

-- ---------------------------------------------------------------------------
-- 1. workers_select without the line-manager branches
-- ---------------------------------------------------------------------------

alter policy workers_select on public.workers
  using (
    organisation_id in (
      select private.role_org_ids(array['owner', 'admin', 'hr', 'finance', 'ops_manager'])
    )
    or id in (select private.my_worker_ids())
  );

comment on policy workers_select on public.workers is
  'Owner, admin, hr, finance and ops_manager read the company''s workers; a login reads its own worker row. Line managers read their reportees through public.my_reportees (safe columns only; slice 4.0).';

-- ---------------------------------------------------------------------------
-- 2. my_reportees: the caller's reportees, safe columns only
-- ---------------------------------------------------------------------------

create function private.my_reportees(p_organisation_id uuid)
returns table (
  id uuid,
  staff_id text,
  first_name text,
  last_name text,
  phone text,
  email text,
  job_title text,
  department_id uuid,
  department_name text,
  employment_type public.employment_type,
  status public.worker_status,
  start_date date,
  end_date date,
  line_manager_worker_id uuid,
  line_manager_membership_id uuid,
  line_manager_name text,
  usual_work_days smallint[],
  supervisor_clock_in boolean,
  site_ids uuid[],
  site_names text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with keys as (
    -- The caller's line_manager membership in this company (trusted session only; at most
    -- one, as a login holds one role per company).
    select k.organisation_id, k.membership_id, k.worker_id
    from private.my_line_manager_keys() k
    where p_organisation_id is not null
      and k.organisation_id = p_organisation_id
  ),
  reportees as (
    select w.*
    from keys k
    join public.workers w
      on w.organisation_id = k.organisation_id
     and (
       w.line_manager_membership_id = k.membership_id
       or (k.worker_id is not null and w.line_manager_worker_id = k.worker_id)
     )
  )
  select
    r.id,
    r.staff_id,
    r.first_name,
    r.last_name,
    r.phone,
    r.email,
    r.job_title,
    r.department_id,
    d.name,
    r.employment_type,
    r.status,
    r.start_date,
    r.end_date,
    r.line_manager_worker_id,
    r.line_manager_membership_id,
    coalesce(
      nullif(btrim(lmw.first_name || ' ' || lmw.last_name), ''),
      nullif(btrim(p.full_name), '')
    ),
    null::smallint[],
    r.supervisor_clock_in,
    coalesce(mapped.site_ids, '{}'::uuid[]),
    coalesce(mapped.site_names, '{}'::text[])
  from reportees r
  left join public.departments d
    on d.organisation_id = r.organisation_id and d.id = r.department_id
  left join public.workers lmw
    on lmw.organisation_id = r.organisation_id and lmw.id = r.line_manager_worker_id
  left join public.memberships lmm
    on lmm.organisation_id = r.organisation_id and lmm.id = r.line_manager_membership_id
  left join public.profiles p on p.user_id = lmm.user_id
  -- The sites the reportee is mapped to now or from the next shift, as the People screens
  -- count them (an assignment ending today is already replaced).
  left join lateral (
    select
      array_agg(s.id order by s.name, s.id) as site_ids,
      array_agg(s.name order by s.name, s.id) as site_names
    from (
      select distinct si.id, si.name
      from public.worker_assignments a
      join public.sites si on si.organisation_id = a.organisation_id and si.id = a.site_id
      where a.organisation_id = r.organisation_id
        and a.worker_id = r.id
        and a.site_id is not null
        and (a.effective_to is null or a.effective_to > private.org_today(r.organisation_id))
    ) s
  ) mapped on true
  order by r.last_name, r.first_name, r.id
$$;

revoke all on function private.my_reportees(uuid) from public, anon;
grant execute on function private.my_reportees(uuid) to authenticated;

create function public.my_reportees(p_organisation_id uuid)
returns table (
  id uuid,
  staff_id text,
  first_name text,
  last_name text,
  phone text,
  email text,
  job_title text,
  department_id uuid,
  department_name text,
  employment_type public.employment_type,
  status public.worker_status,
  start_date date,
  end_date date,
  line_manager_worker_id uuid,
  line_manager_membership_id uuid,
  line_manager_name text,
  usual_work_days smallint[],
  supervisor_clock_in boolean,
  site_ids uuid[],
  site_names text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.my_reportees(p_organisation_id)
$$;

revoke all on function public.my_reportees(uuid) from public, anon;
grant execute on function public.my_reportees(uuid) to authenticated;

comment on function public.my_reportees(uuid) is
  'The caller''s reportees in this company (line_manager role, trusted session), safe columns only: no bank, tax, NIN, RSA, pension, NHF, rent, pay or next-of-kin columns (slice 4.0). No rows for anyone else.';
