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
--      posted (false until 5.3, so none yet), up to 400 days back, each with the number of
--      approved worked shift days in its ISO week. Slice 5.2 MUST also leave out lines already
--      recorded as a payslip source (decision 10: a source is paid once);
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
                'week_shift_days', (
                  select count(distinct l2.work_date)
                  from public.timesheet_lines l2
                  where l2.organisation_id = p_organisation_id and l2.worker_id = w.id
                    and l2.status = 'approved'
                    and l2.shift_assignment_id is not null
                    and l2.worked_minutes + l2.ot_minutes > 0
                    and date_trunc('week', l2.work_date) = date_trunc('week', l.work_date)
                )
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
