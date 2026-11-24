-- Slice 5.1: pay inputs for the earnings stage (docs/PHASE_5.md 5.1), and pay visible to owner,
-- hr and finance only (owner decision, 23 Nov 2026).
--
-- 1. Pay access (owner decision, 23 Nov 2026). Pay amounts are personal pay data:
--    * pay_rates: read by owner, hr and finance (and the worker their own rate, as before);
--      added, changed and cancelled by owner and hr. Admin and ops_manager lose read access and
--      admin loses write access. add_pay_rate, cancel_pay_rate, create_worker and
--      commit_import_batch are security invoker, so these policies govern them too.
--    * The people import carries the template's pay columns (raw cells and the validator's
--      normalised pay rate in import_rows, the uploaded file in the `imports` bucket), so the
--      import is owner and hr only: the table and bucket policies narrow, and a guard refuses any
--      write to import_batches or import_rows from a signed-in user who is not owner or hr (the
--      import's definer functions included). The secret key (sweeps) is unaffected.
--    * The audit log: pay_rates rows carry the amounts, so admins (who read the log with the
--      owner) no longer see entity 'pay_rates' rows; owners still see everything.
--    * commit_import_batch's own role check narrows to owner and hr.
--    No definer function returns pay amounts to admin or ops_manager (checked 23 Nov 2026:
--    the workers guard reads pay_rates only to set needs_pay_details, a flag).
--
-- 2. `private.payroll_period(org, date)`: the pay cycle holding a date (start the company's
--    pay_cycle_start_day, 20 by default; end the day before it next month; pay date the company's
--    pay_day in the end's month, clamped to the month's last day). Owner, hr, finance or the
--    secret key.
--
-- 3. `private.payroll_inputs(org, period_start, worker_ids)`: everything the earnings stage
--    (src/lib/payroll/earnings.ts) needs for one cycle, as jsonb, parsed with Zod on the server
--    (src/lib/payroll/inputs.ts). Owner, hr, finance or the secret key; anyone else 42501 (an
--    untrusted session has no role: private.has_role reads private.session_uid()). It returns no
--    personal numbers: no bank details, no NIN, BVN, TIN or RSA PIN (only whether a TIN and an RSA
--    PIN are on file), no names. Amounts are strings of whole kobo. Per worker:
--    * employment: type, start and end dates, status, usual work days;
--    * statutory details: tax_state, pfa_name, nhf_opt_in, annual_rent_declared_kobo, has_tin,
--      has_rsa_pin;
--    * every pay_rates version overlapping the cycle;
--    * the rostered-day inputs: assigned shifts in the cycle (and ones approved leave removed,
--      removed_reason 'on_leave', which stay working days), and the last rostered day overall
--      (the 4.4 counter's rule);
--    * approved timesheet lines from 6 days before the cycle to its end (the days before the
--      cycle only place a day in its ISO week for the off-day rule; they are never paid here),
--      with the Work Unit's project (null until Phase 8: overtime multiplier 1.0x);
--    * arrears: approved lines from an earlier cycle that private.timesheet_period_posted says is
--      posted (false until 5.3, so none yet), up to 400 days back, each with its rank among the
--      approved worked shift dates of its ISO week up to and including its own date, the week's
--      approved shift days, and the off days already paid for that week (0 until 5.2: TODO). The
--      earnings stage owes (shift days - work_days_per_week - off days paid) off days for the
--      week, carried by its latest-ranked arrears days. Slice 5.2 MUST also leave out lines already recorded as
--      a payslip source (decision 10: a source is paid once); tests/rls/payroll-inputs.test.ts
--      has the skipped test it must un-skip;
--    * the dates of no-show and rejected days in the cycle (open question 8: flagged only), and
--      the count of pending and disputed days;
--    * approved leave overlapping the cycle, with its type's code and counting and
--      leave_request_pay (pay_percent, pay_below_service).
--    Workers: the ids given (2000 at most), or every worker employed on some day of the cycle,
--    plus workers with arrears.
--
-- Nothing here writes, so nothing is audited; the server read is a capability (payroll.inputs,
-- agent false). Refusals: 42501 not allowed, 22023 bad input.

-- ---------------------------------------------------------------------------
-- 1. Pay access: owner, hr and finance read; owner and hr write
-- ---------------------------------------------------------------------------

alter policy pay_rates_select on public.pay_rates
  using (
    organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance']))
    or worker_id in (select private.my_worker_ids())
  );

alter policy pay_rates_insert on public.pay_rates
  with check (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

alter policy pay_rates_update on public.pay_rates
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr'])))
  with check (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

alter policy pay_rates_delete on public.pay_rates
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

-- The people import carries pay: owner and hr only.
alter policy import_batches_insert on public.import_batches
  with check (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

alter policy import_batches_select on public.import_batches
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

alter policy import_batches_update on public.import_batches
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr'])))
  with check (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

alter policy import_rows_select on public.import_rows
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

alter policy imports_delete on storage.objects
  using (
    bucket_id = 'imports'
    and private.import_file_org_id(name) in (select private.role_org_ids(array['owner', 'hr']))
  );

alter policy imports_insert on storage.objects
  with check (
    bucket_id = 'imports'
    and private.import_file_org_id(name) in (select private.role_org_ids(array['owner', 'hr']))
    and exists (
      select 1
      from public.import_batches b
      where b.organisation_id = private.import_file_org_id(objects.name)
        and b.file_path = objects.name
        and b.status = 'uploaded'::public.import_batch_status
        and b.file_removed_at is null
        and b.created_by = (select auth.uid())
    )
  );

alter policy imports_select on storage.objects
  using (
    bucket_id = 'imports'
    and owner_id = ((select auth.uid()))::text
    and private.import_file_org_id(name) in (select private.role_org_ids(array['owner', 'hr']))
  );

-- Refuses an import write by a signed-in user who is not owner or hr of the row's company, on
-- every path (the import's definer functions write these tables). The secret key (no user) and
-- the database owner pass.
create function private.import_writer_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
    and not private.has_role(new.organisation_id, array['owner', 'hr']) then
    raise exception 'Only the owner or HR can import employees: the file carries pay.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.import_writer_guard() from public, anon, authenticated;

create trigger import_batches_writer_guard before insert or update on public.import_batches
  for each row execute function private.import_writer_guard();
create trigger import_rows_writer_guard before insert or update on public.import_rows
  for each row execute function private.import_writer_guard();

-- commit_import_batch (latest version: 20261119115000_bank_account_lookup.sql), unchanged except
-- its role check: owner and hr, as the policies above (security review L1).
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
  where s.organisation_id = p_organisation_id;
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

revoke all on function public.commit_import_batch(uuid, uuid, jsonb) from public, anon;
grant execute on function public.commit_import_batch(uuid, uuid, jsonb) to authenticated, service_role;

-- The audit log: pay_rates rows carry every pay amount in before and after. Owners keep the
-- whole log; admins see everything except pay_rates rows (security review H1). No other audited
-- entity carries pay amounts: import rows are not audited, import batches hold counts, and the
-- app-level import events name columns, never values.
alter policy audit_log_select on public.audit_log
  using (
    organisation_id in (select private.role_org_ids(array['owner']))
    or (
      organisation_id in (select private.role_org_ids(array['admin']))
      and entity <> 'pay_rates'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. The pay cycle
-- ---------------------------------------------------------------------------

-- Who may read pay inputs: owner, hr, finance, or the secret key (no signed-in user).
create function private.require_payroll_reader(p_organisation_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' and auth.uid() is null then
    return;
  end if;
  if p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only the owner, HR or finance can read payroll.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_payroll_reader(uuid) from public, anon, authenticated;

-- The cycle holding p_date for the company. No role check: only definers call it.
create function private.payroll_period_for(p_organisation_id uuid, p_date date)
returns table (period_start date, period_end date, pay_date date)
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select private.timesheet_period_start(p_date, o.pay_cycle_start_day) as s, o.pay_day
    from public.organisations o
    where o.id = p_organisation_id
  ),
  e as (
    select c.s, private.timesheet_period_end(c.s) as e, c.pay_day from c
  )
  select e.s, e.e,
    make_date(
      extract(year from e.e)::integer,
      extract(month from e.e)::integer,
      least(
        e.pay_day::integer,
        extract(day from (date_trunc('month', e.e) + interval '1 month - 1 day'))::integer
      )
    )
  from e
$$;

revoke all on function private.payroll_period_for(uuid, date) from public, anon, authenticated;

create function private.payroll_period(p_organisation_id uuid, p_date date)
returns table (period_start date, period_end date, pay_date date)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_payroll_reader(p_organisation_id);
  if p_date is null then
    raise exception 'Choose a day in the pay period.' using errcode = '22023';
  end if;
  return query select * from private.payroll_period_for(p_organisation_id, p_date);
end;
$$;

revoke all on function private.payroll_period(uuid, date) from public, anon;
grant execute on function private.payroll_period(uuid, date) to authenticated, service_role;

create function public.payroll_period(p_organisation_id uuid, p_date date)
returns table (period_start date, period_end date, pay_date date)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.payroll_period(p_organisation_id, p_date)
$$;

revoke all on function public.payroll_period(uuid, date) from public, anon;
grant execute on function public.payroll_period(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Pay inputs
-- ---------------------------------------------------------------------------

create function private.payroll_inputs(
  p_organisation_id uuid,
  p_period_start date,
  p_worker_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org public.organisations%rowtype;
  v_start date;
  v_end date;
  v_pay_date date;
  v_context_from date;
  v_arrears_from date;
  v_workers uuid[];
  v_result jsonb;
begin
  perform private.require_payroll_reader(p_organisation_id);
  if p_period_start is null then
    raise exception 'Choose the pay period.' using errcode = '22023';
  end if;
  if p_worker_ids is not null and cardinality(p_worker_ids) > 2000 then
    raise exception 'Ask for 2000 workers or fewer at a time.' using errcode = '22023';
  end if;

  select * into v_org from public.organisations o where o.id = p_organisation_id;
  if not found then
    raise exception 'That company wasn''t found.' using errcode = '22023';
  end if;

  select p.period_start, p.period_end, p.pay_date into v_start, v_end, v_pay_date
  from private.payroll_period_for(p_organisation_id, p_period_start) p;
  if v_start <> p_period_start then
    raise exception 'A pay period starts on day % of the month.', v_org.pay_cycle_start_day
      using errcode = '22023';
  end if;
  v_context_from := v_start - 6;
  v_arrears_from := v_start - 400;

  select coalesce(array_agg(w.id order by w.id), '{}') into v_workers
  from public.workers w
  where w.organisation_id = p_organisation_id
    and (p_worker_ids is null or w.id = any (p_worker_ids))
    and (
      p_worker_ids is not null
      or (w.start_date <= v_end and (w.end_date is null or w.end_date >= v_start))
      or exists (
        select 1
        from public.timesheet_lines l
        where l.organisation_id = p_organisation_id and l.worker_id = w.id
          and l.status = 'approved'
          and l.work_date >= v_arrears_from and l.work_date < v_start
          and private.timesheet_period_posted(p_organisation_id, l.work_date)
      )
    );
  if cardinality(v_workers) > 2000 then
    raise exception 'This company has more than 2000 workers in the period: ask for them in batches.'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
    'version', 1,
    'organisation', jsonb_build_object(
      'pay_cycle_start_day', v_org.pay_cycle_start_day,
      'pay_day', v_org.pay_day,
      'standard_shift_minutes', v_org.standard_shift_minutes,
      'hourly_rate_divisor_days', v_org.hourly_rate_divisor_days,
      'work_days_per_week', v_org.work_days_per_week,
      'default_work_days', to_jsonb(v_org.default_work_days),
      'shifts_enabled', v_org.shifts_enabled
    ),
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'pay_date', v_pay_date),
    'holidays', coalesce((
      select jsonb_agg(distinct h.holiday_date order by h.holiday_date)
      from public.public_holidays h
      where h.organisation_id = p_organisation_id and h.removed_at is null
        and h.holiday_date between v_arrears_from and v_end
    ), '[]'::jsonb),
    'workers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'worker_id', w.id,
          'employment_type', w.employment_type,
          'start_date', w.start_date,
          'end_date', w.end_date,
          'status', w.status,
          'usual_work_days', to_jsonb(w.usual_work_days),
          'statutory', jsonb_build_object(
            'tax_state', w.tax_state,
            'pfa_name', w.pfa_name,
            'nhf_opt_in', w.nhf_opt_in,
            'annual_rent_declared_kobo', w.annual_rent_declared_kobo::text,
            'has_tin', w.tin is not null,
            'has_rsa_pin', w.rsa_pin_enc is not null
          ),
          'pay_rates', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', r.id,
                'pay_type', r.pay_type,
                'currency', r.currency,
                'basic_kobo', r.basic_kobo::text,
                'housing_kobo', r.housing_kobo::text,
                'transport_kobo', r.transport_kobo::text,
                'other_allowances_kobo', r.other_allowances_kobo::text,
                'daily_rate_kobo', r.daily_rate_kobo::text,
                'hourly_rate_kobo', r.hourly_rate_kobo::text,
                'effective_from', r.effective_from,
                'effective_to', r.effective_to
              ) order by r.effective_from
            )
            from public.pay_rates r
            where r.organisation_id = p_organisation_id and r.worker_id = w.id
              and r.effective_from <= v_end
              and (r.effective_to is null or r.effective_to >= v_arrears_from)
          ), '[]'::jsonb),
          'shifts', coalesce((
            select jsonb_agg(
              jsonb_build_object('date', a.shift_date, 'on_leave', a.status = 'removed')
              order by a.shift_date
            )
            from public.shift_assignments a
            where a.organisation_id = p_organisation_id and a.worker_id = w.id
              and a.shift_date between v_start and v_end
              and (a.status = 'assigned' or a.removed_reason = 'on_leave')
          ), '[]'::jsonb),
          'last_rostered', (
            select max(a.shift_date)
            from public.shift_assignments a
            where a.organisation_id = p_organisation_id and a.worker_id = w.id
              and (a.status = 'assigned' or a.removed_reason = 'on_leave')
          ),
          'lines', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', l.id,
                'work_date', l.work_date,
                'worked_minutes', l.worked_minutes,
                'ot_minutes', l.ot_minutes,
                'has_shift', l.shift_assignment_id is not null,
                'project_id', u.project_id
              ) order by l.work_date, l.id
            )
            from public.timesheet_lines l
            left join public.work_units u
              on u.organisation_id = l.organisation_id and u.id = l.work_unit_id
            where l.organisation_id = p_organisation_id and l.worker_id = w.id
              and l.status = 'approved'
              and l.work_date between v_context_from and v_end
          ), '[]'::jsonb),
          'arrears', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', l.id,
                'work_date', l.work_date,
                'worked_minutes', l.worked_minutes,
                'ot_minutes', l.ot_minutes,
                'has_shift', l.shift_assignment_id is not null,
                'project_id', u.project_id,
                'period_start', private.timesheet_period_start(l.work_date, v_org.pay_cycle_start_day),
                'week_shift_rank', (
                  select count(distinct l2.work_date)
                  from public.timesheet_lines l2
                  where l2.organisation_id = p_organisation_id and l2.worker_id = w.id
                    and l2.status = 'approved'
                    and l2.shift_assignment_id is not null
                    and l2.worked_minutes + l2.ot_minutes > 0
                    and date_trunc('week', l2.work_date) = date_trunc('week', l.work_date)
                    and l2.work_date <= l.work_date
                ),
                'week_shift_days', (
                  select count(distinct l2.work_date)
                  from public.timesheet_lines l2
                  where l2.organisation_id = p_organisation_id and l2.worker_id = w.id
                    and l2.status = 'approved'
                    and l2.shift_assignment_id is not null
                    and l2.worked_minutes + l2.ot_minutes > 0
                    and date_trunc('week', l2.work_date) = date_trunc('week', l.work_date)
                ),
                -- TODO(5.2): the off days the original run already paid for this ISO week, from
                -- payslip_sources (off_day lines whose sources fall in the week). 0 until then.
                'week_off_days_paid', 0
              ) order by l.work_date, l.id
            )
            from public.timesheet_lines l
            left join public.work_units u
              on u.organisation_id = l.organisation_id and u.id = l.work_unit_id
            where l.organisation_id = p_organisation_id and l.worker_id = w.id
              and l.status = 'approved'
              and l.work_date >= v_arrears_from and l.work_date < v_start
              and private.timesheet_period_posted(p_organisation_id, l.work_date)
          ), '[]'::jsonb),
          'no_show_dates', coalesce((
            select jsonb_agg(distinct l.work_date order by l.work_date)
            from public.timesheet_lines l
            where l.organisation_id = p_organisation_id and l.worker_id = w.id
              and l.work_date between v_start and v_end
              and (l.status = 'rejected' or 'no_show' = any (l.exceptions))
          ), '[]'::jsonb),
          'open_line_count', (
            select count(*)
            from public.timesheet_lines l
            where l.organisation_id = p_organisation_id and l.worker_id = w.id
              and l.work_date between v_start and v_end
              and l.status in ('pending', 'disputed')
          ),
          'leave', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'request_id', q.id,
                'type_code', t.code,
                'counting', t.counting,
                'start_date', q.start_date,
                'end_date', q.end_date,
                'pay_percent', p.pay_percent,
                'pay_below_service', p.pay_below_service
              ) order by q.start_date
            )
            from public.leave_requests q
            join public.leave_types t
              on t.organisation_id = q.organisation_id and t.id = q.leave_type_id
            left join public.leave_request_pay p
              on p.organisation_id = q.organisation_id and p.request_id = q.id
            where q.organisation_id = p_organisation_id and q.worker_id = w.id
              and q.status = 'approved'
              and q.start_date <= v_end and q.end_date >= v_start
          ), '[]'::jsonb)
        ) order by w.id
      )
      from public.workers w
      where w.organisation_id = p_organisation_id and w.id = any (v_workers)
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function private.payroll_inputs(uuid, date, uuid[]) from public, anon;
grant execute on function private.payroll_inputs(uuid, date, uuid[]) to authenticated, service_role;

create function public.payroll_inputs(
  p_organisation_id uuid,
  p_period_start date,
  p_worker_ids uuid[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.payroll_inputs(p_organisation_id, p_period_start, p_worker_ids)
$$;

revoke all on function public.payroll_inputs(uuid, date, uuid[]) from public, anon;
grant execute on function public.payroll_inputs(uuid, date, uuid[]) to authenticated, service_role;
