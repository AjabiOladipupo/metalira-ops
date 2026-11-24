-- Slice 5.7b: off-cycle payroll runs (docs/PHASE_5.md 5.7, "As built in 5.7b"; decisions 7, 8, 10
-- and 15; CLAUDE.md rules 1, 4, 5 and 10).
--
-- An off-cycle run pays chosen workers outside the regular run: a leaver's final pay, a worker the
-- regular run missed, a correction, or a one-off payment. It has kind 'off_cycle', a pay period (by
-- its first day: the inputs the engine reads) and its own pay date, and goes through the same steps
-- and functions as a regular run: calculate (save_payroll_results), anomalies, submit, two-person
-- approval (approve_payroll_run), the bank file and release (5.4), payslips (5.5) and remittances
-- (5.6). Several off-cycle runs may share a period; the "one regular run per period" index
-- (5.2's payroll_runs_one_regular) already covers kind = 'regular' only.
--
-- 1. The shared contract with 5.7a and 5.7c: the kind check allows regular, off_cycle and
--    reversal, and the status check adds 'reversed' (identical SQL in each slice).
-- 2. payroll_runs gains off_cycle_reason (final_pay, missed_worker, correction, one_off) and
--    off_cycle_note (HR's reason), set only on off-cycle runs and never changed, and discarded_at,
--    discarded_by and discard_reason: an off-cycle draft nobody will pay is discarded (its draft
--    payslips, anomalies and adjustments go; the run stays, and never changes again).
--    * final_pay and missed_worker pay the worker's full pay for the period from the engine
--      (salary prorated to the end date, timesheet days, leave, arrears), plus adjustments.
--    * correction and one_off pay adjustments only (manual earning lines with a reason): no
--      salary, timesheet or leave source may be on their payslips.
-- 3. payroll_run_workers: the off-cycle run's chosen workers, written once by
--    create_off_cycle_run and never changed. Its payslips and adjustments are for these workers
--    only, and adjustments on an off-cycle run are one-off (no recurring series).
-- 4. No double payment: 5.2's exclusion constraint on payslip_sources already refuses a source
--    another standing payslip pays (MLPRC). create_off_cycle_run also refuses a full-pay worker
--    whose pay for the period a posted run already paid (MLOC3) or who is on another full-pay
--    off-cycle run for the period (MLOC4); the server leaves such workers out of the regular run.
-- 5. Paid days stay paid: a timesheet day that a posted payslip (any kind of run) pays never
--    changes or goes, even where the period isn't posted by a regular run (5.3's period lock
--    covers regular runs only, since an off-cycle run doesn't close the period for everyone).
--
-- Refusals (SQLSTATE), new here:
--   MLOC1 a worker isn't the company's or isn't employed in the period
--   MLOC2 a final pay needs the worker's last day inside the period
--   MLOC3 a posted run already paid this worker for the period (use a correction or one-off)
--   MLOC4 the worker is already on another full-pay off-cycle run for the period
--   MLOC5 an adjustment on an off-cycle run is one-off and for one of its workers
--   MLOC6 a payslip or source the off-cycle run doesn't allow
--   MLOC7 a discarded run never changes; only an off-cycle draft is discarded
--   MLOC8 an off-cycle run's workers and reason are fixed at creation
-- Reused: MLPRD (state), MLTA5 (a paid timesheet day), 42501, 22023, P0002.
-- No money maths here: the TypeScript engine works pay out (decision 5).

-- ---------------------------------------------------------------------------
-- 1. Shared contract (5.7a, 5.7b and 5.7c run the same SQL)
-- ---------------------------------------------------------------------------

alter table public.payroll_runs drop constraint if exists payroll_runs_kind_value;
alter table public.payroll_runs
  add constraint payroll_runs_kind_value check (kind in ('regular', 'off_cycle', 'reversal'));
alter table public.payroll_runs drop constraint if exists payroll_runs_status_value;
alter table public.payroll_runs
  add constraint payroll_runs_status_value
    check (status in ('draft', 'review', 'approved', 'released', 'reversed'));

-- ---------------------------------------------------------------------------
-- 2. Columns
-- ---------------------------------------------------------------------------

alter table public.payroll_runs
  add column off_cycle_reason text
    constraint payroll_runs_off_cycle_reason_value check (
      off_cycle_reason in ('final_pay', 'missed_worker', 'correction', 'one_off')
    ),
  add column off_cycle_note text
    constraint payroll_runs_off_cycle_note_text check (
      off_cycle_note = btrim(off_cycle_note) and char_length(off_cycle_note) between 1 and 500
      and off_cycle_note !~ '[\x01-\x1f\x7f-\x9f<>]' and off_cycle_note !~* '(://|www\.)'
    ),
  add column discarded_at timestamptz,
  add column discarded_by uuid,
  add column discard_reason text
    constraint payroll_runs_discard_reason_text check (
      discard_reason = btrim(discard_reason) and char_length(discard_reason) between 1 and 500
      and discard_reason !~ '[\x01-\x1f\x7f-\x9f<>]' and discard_reason !~* '(://|www\.)'
    ),
  add constraint payroll_runs_off_cycle_fields check (
    (kind = 'off_cycle') = (off_cycle_reason is not null)
    and (off_cycle_reason is null) = (off_cycle_note is null)
  ),
  add constraint payroll_runs_discarded check (
    (discarded_at is null) = (discarded_by is null)
    and (discarded_at is null) = (discard_reason is null)
    and (discarded_at is null or (kind = 'off_cycle' and status = 'draft'))
  );

comment on column public.payroll_runs.off_cycle_reason is
  'Off-cycle runs only (slice 5.7b): final_pay and missed_worker pay the full period from the engine; correction and one_off pay adjustments only.';
comment on column public.payroll_runs.discarded_at is
  'An off-cycle draft nobody will pay (slice 5.7b): its draft payslips, anomalies and adjustments are gone and it never changes again.';

create index payroll_runs_off_cycle_idx on public.payroll_runs (organisation_id, period_start)
  where kind = 'off_cycle';

-- ---------------------------------------------------------------------------
-- 3. payroll_run_workers
-- ---------------------------------------------------------------------------

create table public.payroll_run_workers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  worker_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_run_workers_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_run_workers_run_worker_key unique (run_id, worker_id),
  constraint payroll_run_workers_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payroll_run_workers_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id)
);

create index payroll_run_workers_worker_idx
  on public.payroll_run_workers (organisation_id, worker_id);

comment on table public.payroll_run_workers is
  'The workers an off-cycle payroll run pays (slice 5.7b), chosen when it is created and never changed.';

alter table public.payroll_run_workers enable row level security;

create policy payroll_run_workers_select on public.payroll_run_workers for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.payroll_run_workers from anon, authenticated, service_role;
grant select on table public.payroll_run_workers to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Guards (ENABLE ALWAYS: the secret key and the database owner included)
-- ---------------------------------------------------------------------------

-- BEFORE INSERT OR UPDATE on payroll_runs, beside the run guard (which keeps the kind, period, pay
-- date and preparer): an off-cycle run's reason and note never change; a run is discarded once,
-- only an off-cycle draft, with nothing else changing; a discarded run never changes again.
create function private.payroll_runs_off_cycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.discarded_at is not null or new.discarded_by is not null or new.discard_reason is not null then
      raise exception 'A new payroll run isn''t discarded.' using errcode = 'MLOC7';
    end if;
    return new;
  end if;
  if old.discarded_at is not null then
    raise exception 'This off-cycle run was discarded and never changes.' using errcode = 'MLOC7';
  end if;
  if (new.off_cycle_reason, new.off_cycle_note) is distinct from (old.off_cycle_reason, old.off_cycle_note) then
    raise exception 'An off-cycle run''s reason is fixed when it is created.' using errcode = 'MLOC8';
  end if;
  if new.discarded_at is not null then
    -- Discarding records who and why, zeroes the totals (its payslips are gone) and marks it for
    -- recalculation, so nothing can submit it; nothing else changes.
    if old.kind <> 'off_cycle' or old.status <> 'draft' or new.status <> 'draft'
      or new.discarded_by is null or new.discard_reason is null
      or not new.needs_recalculation or new.worker_count <> 0
      or (new.gross_kobo, new.paye_kobo, new.pension_employee_kobo, new.pension_employer_kobo,
          new.nhf_kobo, new.other_deductions_kobo, new.net_kobo, new.nsitf_kobo, new.itf_kobo,
          new.employer_cost_kobo, new.carried_forward_kobo)
        is distinct from (0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
          0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint)
      or (to_jsonb(new) - 'discarded_at' - 'discarded_by' - 'discard_reason' - 'updated_at'
          - 'needs_recalculation' - 'worker_count' - 'gross_kobo' - 'paye_kobo'
          - 'pension_employee_kobo' - 'pension_employer_kobo' - 'nhf_kobo'
          - 'other_deductions_kobo' - 'net_kobo' - 'nsitf_kobo' - 'itf_kobo'
          - 'employer_cost_kobo' - 'carried_forward_kobo')
        is distinct from (to_jsonb(old) - 'discarded_at' - 'discarded_by' - 'discard_reason'
          - 'updated_at' - 'needs_recalculation' - 'worker_count' - 'gross_kobo' - 'paye_kobo'
          - 'pension_employee_kobo' - 'pension_employer_kobo' - 'nhf_kobo'
          - 'other_deductions_kobo' - 'net_kobo' - 'nsitf_kobo' - 'itf_kobo'
          - 'employer_cost_kobo' - 'carried_forward_kobo')
    then
      raise exception 'Only an off-cycle draft is discarded, and nothing else about it changes.'
        using errcode = 'MLOC7';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_runs_off_cycle_guard() from public, anon, authenticated;

create trigger payroll_runs_off_cycle_guard before insert or update on public.payroll_runs
  for each row execute function private.payroll_runs_off_cycle_guard();
alter table public.payroll_runs enable always trigger payroll_runs_off_cycle_guard;

-- payroll_run_workers: inserted only for an off-cycle draft not worked out yet (create_off_cycle_run
-- writes them in the run's own transaction); never changed or deleted.
create function private.payroll_run_workers_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'An off-cycle run''s workers are fixed when it is created.' using errcode = 'MLOC8';
  end if;
  if not exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = new.organisation_id and r.id = new.run_id
      and r.kind = 'off_cycle' and r.status = 'draft' and r.calculated_at is null
      and r.discarded_at is null
  ) then
    raise exception 'An off-cycle run''s workers are fixed when it is created.' using errcode = 'MLOC8';
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.payroll_run_workers_guard() from public, anon, authenticated;

create trigger payroll_run_workers_guard before insert or update or delete on public.payroll_run_workers
  for each row execute function private.payroll_run_workers_guard();
alter table public.payroll_run_workers enable always trigger payroll_run_workers_guard;
create trigger payroll_run_workers_no_truncate before truncate on public.payroll_run_workers
  for each statement execute function private.payroll_no_truncate();
alter table public.payroll_run_workers enable always trigger payroll_run_workers_no_truncate;
create trigger payroll_run_workers_audit after insert on public.payroll_run_workers
  for each row execute function private.audit_row_change();

-- The off-cycle run a row belongs to (null for a regular or reversal run).
create function private.payroll_off_cycle_run(p_organisation_id uuid, p_run_id uuid)
returns public.payroll_runs
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = p_run_id and r.kind = 'off_cycle'
$$;

revoke all on function private.payroll_off_cycle_run(uuid, uuid) from public, anon, authenticated;

create function private.payroll_run_has_worker(p_organisation_id uuid, p_run_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payroll_run_workers w
    where w.organisation_id = p_organisation_id and w.run_id = p_run_id and w.worker_id = p_worker_id
  )
$$;

revoke all on function private.payroll_run_has_worker(uuid, uuid, uuid) from public, anon, authenticated;

-- BEFORE INSERT on payroll_adjustments: on an off-cycle run, one-off items for its own workers.
create function private.payroll_adjustments_off_cycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype := private.payroll_off_cycle_run(new.organisation_id, new.run_id);
begin
  if v_run.id is null then
    return new;
  end if;
  if v_run.discarded_at is not null then
    raise exception 'This off-cycle run was discarded and never changes.' using errcode = 'MLOC7';
  end if;
  if not private.payroll_run_has_worker(new.organisation_id, new.run_id, new.worker_id) then
    raise exception 'That worker isn''t on this off-cycle run.' using errcode = 'MLOC5';
  end if;
  if new.instalment_count <> 1 then
    raise exception 'An off-cycle run takes one-off items only. Add recurring items to the regular run.'
      using errcode = 'MLOC5';
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_adjustments_off_cycle_guard() from public, anon, authenticated;

create trigger payroll_adjustments_off_cycle before insert on public.payroll_adjustments
  for each row execute function private.payroll_adjustments_off_cycle_guard();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_off_cycle;

-- BEFORE INSERT on payslips: an off-cycle run pays its own workers only, and nothing once discarded.
create function private.payslips_off_cycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype := private.payroll_off_cycle_run(new.organisation_id, new.run_id);
begin
  if v_run.id is null then
    return new;
  end if;
  if v_run.discarded_at is not null then
    raise exception 'This off-cycle run was discarded and never changes.' using errcode = 'MLOC7';
  end if;
  if not private.payroll_run_has_worker(new.organisation_id, new.run_id, new.worker_id) then
    raise exception 'An off-cycle run pays only the workers chosen for it.' using errcode = 'MLOC6';
  end if;
  return new;
end;
$$;

revoke all on function private.payslips_off_cycle_guard() from public, anon, authenticated;

create trigger payslips_off_cycle before insert on public.payslips
  for each row execute function private.payslips_off_cycle_guard();
alter table public.payslips enable always trigger payslips_off_cycle;

-- BEFORE INSERT on payslip_sources: a correction or one-off run pays adjustments only, never a
-- salary, timesheet day or leave (those belong to the regular run or a full-pay off-cycle run).
create function private.payslip_sources_off_cycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype := private.payroll_off_cycle_run(new.organisation_id, new.run_id);
begin
  if v_run.id is not null and v_run.off_cycle_reason in ('correction', 'one_off')
    and new.source_kind <> 'adjustment' then
    raise exception 'A correction or one-off run pays its adjustments only.' using errcode = 'MLOC6';
  end if;
  return new;
end;
$$;

revoke all on function private.payslip_sources_off_cycle_guard() from public, anon, authenticated;

create trigger payslip_sources_off_cycle before insert on public.payslip_sources
  for each row execute function private.payslip_sources_off_cycle_guard();
alter table public.payslip_sources enable always trigger payslip_sources_off_cycle;

-- BEFORE UPDATE OR DELETE on timesheet_lines: an approved day a posted payslip pays (a standing
-- source of an approved or released run of any kind) never changes, but its timestamps and 4.2's
-- one allowance (adding late_punch_after_decision), and is never deleted. 5.3's period lock already
-- holds days in a period a regular run posted; this also holds days an off-cycle run paid. A
-- reversal (5.7a) clears `stands`, which frees the day again.
create function private.timesheet_lines_freeze_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'approved'
    and (
      tg_op = 'DELETE'
      or (to_jsonb(new) - 'updated_at' - 'decided_at' - 'exceptions')
        is distinct from (to_jsonb(old) - 'updated_at' - 'decided_at' - 'exceptions')
      or (
        new.exceptions is distinct from old.exceptions
        and not (
          new.exceptions @> old.exceptions
          and new.exceptions <@ (old.exceptions || 'late_punch_after_decision'::text)
        )
      )
    )
    and exists (
      select 1
      from public.payslip_sources s
      join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
      where s.organisation_id = old.organisation_id
        and s.source_kind = 'timesheet_line' and s.source_id = old.id
        and s.stands
        and r.status in ('approved', 'released')
    ) then
    raise exception 'A posted payslip pays this day, so it can''t be reopened. Correct it in a later run.'
      using errcode = 'MLTA5';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.timesheet_lines_freeze_paid() from public, anon, authenticated;

create trigger timesheet_lines_freeze_paid before update or delete on public.timesheet_lines
  for each row execute function private.timesheet_lines_freeze_paid();
alter table public.timesheet_lines enable always trigger timesheet_lines_freeze_paid;

-- ---------------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------------

-- Creates an off-cycle run (owner or hr, trusted session) for the pay period starting
-- p_period_start, paid on p_pay_date (from the period's start to 45 days after its end), for the
-- chosen workers, with a reason code and HR's note. The rule set in force on the pay date is
-- snapshotted for the whole run (decision 15). Full-pay runs (final_pay, missed_worker) refuse a
-- worker a posted run already paid for the period (MLOC3) or who is on another full-pay off-cycle
-- run for it (MLOC4); a final pay needs the worker's end date inside the period (MLOC2). Returns the
-- run id; the server calculates it next.
create function private.create_off_cycle_run(
  p_organisation_id uuid,
  p_period_start date,
  p_pay_date date,
  p_reason text,
  p_note text,
  p_worker_ids uuid[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_preparer(p_organisation_id);
  v_start date;
  v_end date;
  v_pay date;
  v_rule_set uuid;
  v_id uuid;
  v_note text := private.tax_clean_text(p_note, 500);
  v_workers uuid[];
  v_full boolean;
  v_worker uuid;
begin
  if p_period_start is null then
    raise exception 'Choose the pay period.' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('final_pay', 'missed_worker', 'correction', 'one_off') then
    raise exception 'Choose why this run is off-cycle.' using errcode = '22023';
  end if;
  if v_note is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_workers
  from unnest(coalesce(p_worker_ids, '{}'::uuid[])) x
  where x is not null;
  if cardinality(v_workers) = 0 or cardinality(v_workers) > 200 then
    raise exception 'Choose 1 to 200 workers.' using errcode = '22023';
  end if;

  select p.period_start, p.period_end into v_start, v_end
  from private.payroll_period_for(p_organisation_id, p_period_start) p;
  if v_start is null or v_start <> p_period_start then
    raise exception 'Choose a pay period by its first day.' using errcode = '22023';
  end if;
  v_pay := p_pay_date;
  if v_pay is null or v_pay < v_start or v_pay > v_end + 45 then
    raise exception 'The pay date falls in the period or up to 45 days after it.' using errcode = '22023';
  end if;

  if (
    select count(*) from public.workers w
    where w.organisation_id = p_organisation_id and w.id = any (v_workers)
  ) <> cardinality(v_workers) then
    raise exception 'Some of those workers aren''t in this company.' using errcode = 'MLOC1';
  end if;
  if exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = any (v_workers)
      and not (w.start_date <= v_end and (w.end_date is null or w.end_date >= v_start))
  ) then
    raise exception 'Every worker on the run must be employed on some day of the period.'
      using errcode = 'MLOC1';
  end if;
  if p_reason = 'final_pay' and exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = any (v_workers)
      and (w.end_date is null or w.end_date not between v_start and v_end)
  ) then
    raise exception 'A final pay needs each worker''s last day inside the period. Set the end date on their page first.'
      using errcode = 'MLOC2';
  end if;

  -- One creation at a time per company (as create_payroll_run), so two full-pay runs for the same
  -- worker can't both pass the checks below.
  perform pg_advisory_xact_lock(hashtextextended('payroll_runs:' || p_organisation_id::text, 0));

  v_full := p_reason in ('final_pay', 'missed_worker');
  if v_full then
    foreach v_worker in array v_workers loop
      if exists (
        select 1
        from public.payslip_sources s
        join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
        where s.organisation_id = p_organisation_id and s.worker_id = v_worker
          and s.stands and s.source_kind in ('pay_rate', 'timesheet_line', 'leave_request')
          and daterange(s.from_date, s.to_date, '[]') && daterange(v_start, v_end, '[]')
          and r.status in ('approved', 'released')
      ) then
        raise exception 'A posted run already paid a worker on this run for the period. Use a correction or a one-off payment instead.'
          using errcode = 'MLOC3';
      end if;
      if exists (
        select 1
        from public.payroll_run_workers x
        join public.payroll_runs r on r.organisation_id = x.organisation_id and r.id = x.run_id
        where x.organisation_id = p_organisation_id and x.worker_id = v_worker
          and r.kind = 'off_cycle' and r.off_cycle_reason in ('final_pay', 'missed_worker')
          and r.period_start = v_start and r.discarded_at is null and r.status <> 'reversed'
      ) then
        raise exception 'A worker on this run is already on another final-pay or missed-worker run for the period.'
          using errcode = 'MLOC4';
      end if;
    end loop;
  end if;

  perform private.ensure_tax_rule_set(p_organisation_id);
  select t.id into v_rule_set from private.tax_rule_set_on(p_organisation_id, v_pay) t;
  if v_rule_set is null then
    raise exception 'No payroll rules are in force on the pay date.' using errcode = '22023';
  end if;

  insert into public.payroll_runs (
    organisation_id, kind, period_start, period_end, pay_date, rule_set_id, prepared_by,
    off_cycle_reason, off_cycle_note
  )
  values (
    p_organisation_id, 'off_cycle', v_start, v_end, v_pay, v_rule_set, v_uid, p_reason, v_note
  )
  returning id into v_id;

  insert into public.payroll_run_workers (organisation_id, run_id, worker_id, created_by)
  select p_organisation_id, v_id, x, v_uid from unnest(v_workers) x;

  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_created', 'payroll_runs', v_id, null,
    jsonb_build_object(
      'kind', 'off_cycle', 'off_cycle_reason', p_reason, 'period_start', v_start,
      'period_end', v_end, 'pay_date', v_pay, 'rule_set_id', v_rule_set,
      'worker_ids', to_jsonb(v_workers)
    ),
    v_note
  );
  return v_id;
end;
$$;

revoke all on function private.create_off_cycle_run(uuid, date, date, text, text, uuid[]) from public, anon;
grant execute on function private.create_off_cycle_run(uuid, date, date, text, text, uuid[]) to authenticated;

create function public.create_off_cycle_run(
  p_organisation_id uuid,
  p_period_start date,
  p_pay_date date,
  p_reason text,
  p_note text,
  p_worker_ids uuid[]
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.create_off_cycle_run(
    p_organisation_id, p_period_start, p_pay_date, p_reason, p_note, p_worker_ids
  )
$$;

revoke all on function public.create_off_cycle_run(uuid, date, date, text, text, uuid[]) from public, anon;
grant execute on function public.create_off_cycle_run(uuid, date, date, text, text, uuid[]) to authenticated;

-- Discards an off-cycle draft (owner or hr, trusted session), with a reason: its draft payslips
-- (with their lines and sources), anomalies and adjustments are deleted, so nothing of it is paid
-- or holds a source; its totals go to zero (the audit row keeps what it would have paid), and the
-- run never changes again. A regular run is never discarded.
create function private.discard_off_cycle_run(p_organisation_id uuid, p_run_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_preparer(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_slips integer;
  v_adjustments integer;
begin
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.kind <> 'off_cycle' then
    raise exception 'Only an off-cycle run is discarded.' using errcode = 'MLOC7';
  end if;
  if v_run.discarded_at is not null then
    raise exception 'This off-cycle run is already discarded.' using errcode = 'MLOC7';
  end if;
  if v_run.status <> 'draft' then
    raise exception 'Only a draft is discarded. Ask Finance to return it first.' using errcode = 'MLPRD';
  end if;
  perform set_config('metalira.audit_channel', 'web', true);

  delete from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;
  delete from public.payslips s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id;
  get diagnostics v_slips = row_count;
  delete from public.payroll_adjustments a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;
  get diagnostics v_adjustments = row_count;

  update public.payroll_runs r
  set discarded_at = now(), discarded_by = v_uid, discard_reason = v_reason,
      needs_recalculation = true, worker_count = 0, gross_kobo = 0, paye_kobo = 0,
      pension_employee_kobo = 0, pension_employer_kobo = 0, nhf_kobo = 0,
      other_deductions_kobo = 0, net_kobo = 0, nsitf_kobo = 0, itf_kobo = 0,
      employer_cost_kobo = 0, carried_forward_kobo = 0
  where r.id = p_run_id;

  perform private.log_audit_impl(
    p_organisation_id, 'payroll.off_cycle_discarded', 'payroll_runs', p_run_id,
    jsonb_build_object(
      'payslips', v_slips, 'adjustments', v_adjustments,
      'gross_kobo', v_run.gross_kobo::text, 'net_kobo', v_run.net_kobo::text
    ),
    null,
    v_reason
  );
end;
$$;

revoke all on function private.discard_off_cycle_run(uuid, uuid, text) from public, anon;
grant execute on function private.discard_off_cycle_run(uuid, uuid, text) to authenticated;

create function public.discard_off_cycle_run(p_organisation_id uuid, p_run_id uuid, p_reason text)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.discard_off_cycle_run(p_organisation_id, p_run_id, p_reason)
$$;

revoke all on function public.discard_off_cycle_run(uuid, uuid, text) from public, anon;
grant execute on function public.discard_off_cycle_run(uuid, uuid, text) to authenticated;
