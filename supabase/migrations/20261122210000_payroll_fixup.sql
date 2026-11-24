-- Slice 5.8: Phase 5 review fix-up (phase-level money and security reviews, 24 Nov 2026).
--
-- 1. The audit log hides pay from everyone but the owner (security, high). Owner decision: only
--    owner, hr and finance see pay. hr and finance have never read the audit log (unchanged), so
--    the owner keeps the whole log and admins (the only other role with audit access) see no
--    row of a Phase 5 payroll or statutory entity (tax_rule_sets, pay_rates, payroll_*,
--    payslip*, payout_*, statutory_*) and no payroll.* or statutory.* event, whatever entity it
--    names. Patterns, not a list, so a later payroll table is hidden too. Set-helper form kept.
-- 2. A reversal waits for later runs that depend on the reversed run (money, high): MLFX1,
--    "Reverse the later run first: <run>", for both the request and the approval, by a trigger
--    on payroll_runs (ENABLE ALWAYS), so 5.7a's functions stay as they are.
-- 3. Approval and month-aggregate PAYE (money): approve_payroll_run (5.3's, its only version)
--    takes a lock per (company, worker, pay-date month) and refuses a month that changed.
-- 4. Guards ENABLE ALWAYS (security): tax_rule_sets_guard, tax_rule_sets_no_truncate,
--    tax_rule_sets_used_by_run and pay_rates_guard. tax_rule_sets_guard no longer reads the
--    session setting metalira.tax_rule_set_closing: add_tax_rule_set_version records the closing
--    in a private table for its transaction and the guard reads that row.
-- 5. Two warnings (private.payroll_anomaly_severity, 5.7c's version with two codes added):
--    carry_settled_later (a full-pay off-cycle run for a period earlier than a posted run that
--    already settled the worker's carried deduction takes none) and refund_uncollected_carry (a
--    leave refund pays back arrears part of which is still in the carried balance).
--
-- Refusal codes: MLFX1 (a later run depends on the run being reversed), MLFX2 (pay rates can't be
-- truncated).

-- ---------------------------------------------------------------------------
-- 1. The audit log: no pay for anyone but the owner
-- ---------------------------------------------------------------------------

alter policy audit_log_select on public.audit_log
  using (
    organisation_id in (select private.role_org_ids(array['owner']))
    or (
      organisation_id in (select private.role_org_ids(array['admin']))
      and entity not in ('pay_rates', 'tax_rule_sets')
      and entity not like 'payroll\_%'
      and entity not like 'payslip%'
      and entity not like 'payout\_%'
      and entity not like 'statutory\_%'
      and action not like 'payroll.%'
      and action not like 'statutory.%'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Reverse the later run first
-- ---------------------------------------------------------------------------

-- The latest run past draft (review, approved or released; not a reversal, not reversed) that
-- depends on p_run_id, by its title ("October 2026", "November 2026 off-cycle: A correction"),
-- or null. Depending means any of:
--   (a) a later-period run holding a standing source dated inside the run's period (arrears or a
--       refund paid later);
--   (b) a later-period run with a payslip for one of the run's workers, approved after this run
--       or not approved yet (its history could have read this run: the carried deduction, first
--       pay, instalments; a run approved before this one was re-checked without it). Conservative
--       on purpose;
--   (c) a run with a payslip for one of the run's workers and a pay date in the same calendar
--       month, approved after this run or not approved yet (month-aggregate PAYE, 5.7b, counted
--       this run's payslip);
--   (d) an earlier-period final-pay or missed-worker run with a payslip for one of the run's
--       workers, approved after this run or not approved yet (money review H1: it took no carried
--       deduction because this run had settled it; with this run reversed, the period's new run
--       would carry on from that payslip and the carry would be lost).
-- No role check: the trigger and the checked read below call it.
create function private.payroll_reversal_blocker(p_organisation_id uuid, p_run_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with o as (
    select r.id, r.period_start, r.period_end, r.pay_date, r.approved_at
    from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.id = p_run_id
  ),
  w as (
    select distinct s.worker_id
    from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
  )
  select
    to_char(x.period_end, 'FMMonth YYYY')
      || case
        when x.kind = 'off_cycle' then ' off-cycle' || case x.off_cycle_reason
          when 'final_pay' then ': Final pay for a leaver'
          when 'missed_worker' then ': A worker the regular run missed'
          when 'correction' then ': A correction'
          when 'one_off' then ': A one-off payment'
          else ''
        end
        else ''
      end
  from public.payroll_runs x
  cross join o
  where x.organisation_id = p_organisation_id
    and x.id <> o.id
    and x.kind <> 'reversal'
    and x.status in ('review', 'approved', 'released')
    and (
      (
        x.period_start > o.period_start
        and exists (
          select 1 from public.payslip_sources s
          where s.organisation_id = x.organisation_id and s.run_id = x.id and s.stands
            and s.from_date <= o.period_end and s.to_date >= o.period_start
        )
      )
      or (
        x.period_start > o.period_start
        and (x.approved_at is null or o.approved_at is null or x.approved_at > o.approved_at)
        and exists (
          select 1 from public.payslips s
          where s.organisation_id = x.organisation_id and s.run_id = x.id
            and s.worker_id in (select w.worker_id from w)
        )
      )
      or (
        x.period_start < o.period_start
        and x.kind = 'off_cycle' and x.off_cycle_reason in ('final_pay', 'missed_worker')
        and (x.approved_at is null or o.approved_at is null or x.approved_at > o.approved_at)
        and exists (
          select 1 from public.payslips s
          where s.organisation_id = x.organisation_id and s.run_id = x.id
            and s.worker_id in (select w.worker_id from w)
        )
      )
      or (
        date_trunc('month', x.pay_date) = date_trunc('month', o.pay_date)
        and (x.approved_at is null or o.approved_at is null or x.approved_at > o.approved_at)
        and exists (
          select 1 from public.payslips s
          where s.organisation_id = x.organisation_id and s.run_id = x.id
            and s.worker_id in (select w.worker_id from w)
        )
      )
    )
  order by x.period_start desc, x.approved_at desc nulls first, x.created_at desc, x.id
  limit 1
$$;

revoke all on function private.payroll_reversal_blocker(uuid, uuid) from public, anon, authenticated;

-- Refuses a reversal request (a reversal run inserted) and a reversal approval (the original
-- moving approved -> reversed) while a later run depends on the original. ENABLE ALWAYS, so
-- replica mode doesn't skip it. Reads database state only.
create function private.payroll_runs_reversal_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_label text;
begin
  if tg_op = 'INSERT' then
    if new.kind is distinct from 'reversal' or new.reverses_run_id is null then
      return new;
    end if;
    v_run := new.reverses_run_id;
  else
    if not (old.status = 'approved' and new.status = 'reversed') then
      return new;
    end if;
    v_run := old.id;
  end if;
  v_label := private.payroll_reversal_blocker(new.organisation_id, v_run);
  if v_label is not null then
    raise exception 'Reverse the later run first: %', v_label using errcode = 'MLFX1';
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_runs_reversal_order() from public, anon, authenticated;

create trigger payroll_runs_reversal_order
  before insert or update of status on public.payroll_runs
  for each row execute function private.payroll_runs_reversal_order();
alter table public.payroll_runs enable always trigger payroll_runs_reversal_order;

-- The reversal previews' read (owner, hr, finance; the secret key): the run that must be reversed
-- first, or null.
create function private.payroll_reversal_blocker_read(p_organisation_id uuid, p_run_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_payroll_reader(p_organisation_id);
  return private.payroll_reversal_blocker(p_organisation_id, p_run_id);
end;
$$;

revoke all on function private.payroll_reversal_blocker_read(uuid, uuid) from public, anon;
grant execute on function private.payroll_reversal_blocker_read(uuid, uuid)
  to authenticated, service_role;

create function public.payroll_reversal_blocker(p_organisation_id uuid, p_run_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select private.payroll_reversal_blocker_read(p_organisation_id, p_run_id)
$$;

revoke all on function public.payroll_reversal_blocker(uuid, uuid) from public, anon;
grant execute on function public.payroll_reversal_blocker(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Approval: month-aggregate PAYE under a lock (5.3's approve_payroll_run, its only version,
--    with only the block marked "Slice 5.8 (fix 4)" added)
-- ---------------------------------------------------------------------------

create or replace function private.approve_payroll_run(p_organisation_id uuid, p_run_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_approver(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_check public.payroll_approval_checks%rowtype;
  v_blocking integer;
  v_open integer;
  v_acked integer;
  v_totals record;
  v_id uuid;
  v_worker uuid;
  v_month_start date;
  v_month_end date;
begin
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'review' then
    raise exception 'Only a run waiting for approval is approved.' using errcode = 'MLPRD';
  end if;
  if v_uid = any (private.payroll_run_touchers(p_organisation_id, p_run_id)) then
    raise exception 'You prepared or changed this run, so a different person must approve it.'
      using errcode = 'MLPRE';
  end if;
  if v_run.needs_recalculation or v_run.calculated_at is null or v_run.inputs_sha256 is null then
    raise exception 'The run needs recalculating. Return it to HR.' using errcode = 'MLPRD';
  end if;

  -- Decision 7: the approver's own server check, after the latest submission, read in the last
  -- 2 minutes, must have found the inputs the run was worked out from.
  select c.* into v_check
  from public.payroll_approval_checks c
  where c.organisation_id = p_organisation_id and c.run_id = p_run_id and c.actor_id = v_uid
    and c.created_at >= v_run.submitted_at
  order by c.created_at desc, c.id desc
  limit 1;
  if v_check.id is null or v_check.read_started_at < now() - interval '2 minutes' then
    raise exception 'The run''s inputs must be checked again just before approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  if not v_check.matches or v_check.inputs_sha256 <> v_run.inputs_sha256 then
    raise exception 'Something this run was worked out from has changed since (a timesheet day, a pay rate, leave or bank details). Return it to HR to recalculate.'
      using errcode = 'MLPRF';
  end if;

  -- Money review M1: the server's read and this approval are separate transactions, so hold what
  -- the run pays still (the workers' leave locks, as 4.4 takes them, in a fixed order; FOR SHARE on
  -- the paid timesheet days, leave and pay versions, so a reopen, dispute, cancellation or pay
  -- change waits for this transaction), refuse if a paid source isn't approved or there any more,
  -- and refuse if anything in the run's scope was written after the read began.
  for v_worker in
    select distinct s.worker_id from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    order by s.worker_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_worker::text, 0));
  end loop;

  -- Slice 5.8 (fix 4): month-aggregate PAYE (5.7b) reads every standing payslip of the worker
  -- with a pay date in the same calendar month. Approvals take one lock per (company, worker,
  -- pay-date month), in worker order, so two such approvals run one after the other. Then this
  -- one is refused if another run's payslip for one of its workers in the month was approved
  -- after the read began, or if the month's standing payslips aren't the ones each payslip's
  -- PAYE counted (its trace's month_to_date step): that also covers an approval whose
  -- transaction began before the read and committed after it.
  v_month_start := date_trunc('month', v_run.pay_date)::date;
  v_month_end := (v_month_start + interval '1 month')::date;
  for v_worker in
    select distinct s.worker_id from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    order by s.worker_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'payroll_month:' || p_organisation_id::text || ':' || v_worker::text || ':'
        || to_char(v_month_start, 'YYYY-MM'),
      0
    ));
  end loop;
  if exists (
    select 1
    from public.payslips o
    join public.payroll_runs x on x.organisation_id = o.organisation_id and x.id = o.run_id
    where o.organisation_id = p_organisation_id and o.run_id <> p_run_id
      and o.worker_id in (
        select s.worker_id from public.payslips s
        where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      )
      and x.kind <> 'reversal' and x.status in ('approved', 'released')
      and x.pay_date >= v_month_start and x.pay_date < v_month_end
      and x.approved_at > v_check.read_started_at
  ) or exists (
    with mine as (
      select s.worker_id, s.trace from public.payslips s
      where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    ),
    month_slips as (
      select o.worker_id, count(*)::integer as n, bool_or(x.kind = 'off_cycle') as any_off_cycle
      from public.payslips o
      join public.payroll_runs x on x.organisation_id = o.organisation_id and x.id = o.run_id
      where o.organisation_id = p_organisation_id and o.run_id <> p_run_id
        and o.worker_id in (select m.worker_id from mine m)
        and x.kind <> 'reversal' and x.status in ('approved', 'released')
        and x.pay_date >= v_month_start and x.pay_date < v_month_end
      group by o.worker_id
    )
    select 1
    from mine m
    left join month_slips ms on ms.worker_id = m.worker_id
    -- Only payslips the PAYE bands ran on (a daily worker's exemption skips them).
    where jsonb_typeof(m.trace -> 'steps') = 'array'
      and jsonb_path_exists(m.trace -> 'steps', '$[*] ? (@.step == "annual_gross")')
      and coalesce((
        select case when (st -> 'inputs' ->> 'payslips') ~ '^[0-9]{1,4}$'
          then (st -> 'inputs' ->> 'payslips')::integer end
        from jsonb_array_elements(m.trace -> 'steps') st
        where st ->> 'step' = 'month_to_date'
        limit 1
      ), 0) <> case
        -- As the server's monthOf: an off-cycle payslip always counts the month's others; a
        -- regular one only when an off-cycle payslip of the month is among them.
        when v_run.kind = 'off_cycle' or coalesce(ms.any_off_cycle, false)
          then coalesce(ms.n, 0)
        else 0
      end
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  perform 1
  from public.pay_rates r
  join public.payslip_sources s
    on s.organisation_id = r.organisation_id and s.source_id = r.id
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    and s.source_kind = 'pay_rate'
  for share of r;
  perform 1
  from public.timesheet_lines l
  join public.payslip_sources s
    on s.organisation_id = l.organisation_id and s.source_id = l.id
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    and s.source_kind = 'timesheet_line'
  for share of l;
  perform 1
  from public.leave_requests q
  join public.payslip_sources s
    on s.organisation_id = q.organisation_id and s.source_id = q.id
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    and s.source_kind = 'leave_request'
  for share of q;
  if exists (
    select 1
    from public.payslip_sources s
    left join public.timesheet_lines l
      on s.source_kind = 'timesheet_line' and l.organisation_id = s.organisation_id
        and l.id = s.source_id
    left join public.leave_requests q
      on s.source_kind = 'leave_request' and q.organisation_id = s.organisation_id
        and q.id = s.source_id
    left join public.pay_rates r
      on s.source_kind = 'pay_rate' and r.organisation_id = s.organisation_id
        and r.id = s.source_id
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      and (
        (s.source_kind = 'timesheet_line' and l.status is distinct from 'approved')
        or (s.source_kind = 'leave_request' and q.status is distinct from 'approved')
        or (s.source_kind = 'pay_rate' and (
          r.id is null or r.worker_id <> s.worker_id
          or r.effective_from > s.from_date
          or (r.effective_to is not null and r.effective_to < s.to_date)
          or greatest(r.created_at, r.updated_at) > v_check.read_started_at
        ))
      )
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  if exists (
    with scope as (
      select s.worker_id from public.payslips s
      where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      union
      select a.worker_id from public.payroll_adjustments a
      where a.organisation_id = p_organisation_id and a.run_id = p_run_id
    )
    select 1
    from public.timesheet_decisions d
    join public.timesheet_lines l
      on l.organisation_id = d.organisation_id and l.id = d.line_id
    where d.organisation_id = p_organisation_id
      and d.worker_id in (select worker_id from scope)
      and l.work_date between v_run.period_start - 400 and v_run.period_end
      and d.created_at > v_check.read_started_at
    union all
    select 1
    from public.leave_decisions d
    join public.leave_requests q on q.organisation_id = d.organisation_id and q.id = d.request_id
    where d.organisation_id = p_organisation_id
      and d.worker_id in (select worker_id from scope)
      and q.start_date <= v_run.period_end and q.end_date >= v_run.period_start
      and d.created_at > v_check.read_started_at
    union all
    select 1
    from public.pay_rates r
    where r.organisation_id = p_organisation_id
      and r.worker_id in (select worker_id from scope)
      and greatest(r.created_at, r.updated_at) > v_check.read_started_at
    union all
    select 1
    from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
      and a.created_at > v_check.read_started_at
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;

  select count(*) filter (where a.severity = 'blocking'),
         count(*) filter (where a.severity = 'warning' and a.acknowledged_at is null),
         count(*) filter (where a.acknowledged_at is not null)
  into v_blocking, v_open, v_acked
  from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;
  if v_blocking > 0 or v_open > 0 then
    raise exception 'Anomalies on this run block it or aren''t acknowledged. Return it to HR.'
      using errcode = 'MLPR4';
  end if;

  select
    coalesce(sum(s.gross_kobo), 0) as gross, coalesce(sum(s.paye_kobo), 0) as paye,
    coalesce(sum(s.pension_employee_kobo), 0) as pee, coalesce(sum(s.pension_employer_kobo), 0) as per,
    coalesce(sum(s.nhf_kobo), 0) as nhf, coalesce(sum(s.other_deductions_kobo), 0) as other,
    coalesce(sum(s.net_kobo), 0) as net, coalesce(sum(s.nsitf_kobo), 0) as nsitf,
    coalesce(sum(s.itf_kobo), 0) as itf, coalesce(sum(s.employer_cost_kobo), 0) as cost,
    coalesce(sum(s.carried_forward_kobo), 0) as carried, count(*)::integer as n
  into v_totals
  from public.payslips s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id;
  if v_totals.n = 0
    or (v_totals.gross, v_totals.paye, v_totals.pee, v_totals.per, v_totals.nhf, v_totals.other,
        v_totals.net, v_totals.nsitf, v_totals.itf, v_totals.cost, v_totals.carried, v_totals.n)
    is distinct from
       (v_run.gross_kobo, v_run.paye_kobo, v_run.pension_employee_kobo, v_run.pension_employer_kobo,
        v_run.nhf_kobo, v_run.other_deductions_kobo, v_run.net_kobo, v_run.nsitf_kobo,
        v_run.itf_kobo, v_run.employer_cost_kobo, v_run.carried_forward_kobo, v_run.worker_count) then
    raise exception 'The run''s totals don''t reconcile with its payslips.' using errcode = 'MLPR6';
  end if;

  update public.payroll_runs r
  set status = 'approved', approved_at = now(), approved_by = v_uid
  where r.id = p_run_id;
  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, actor_id, inputs_sha256, gross_kobo, net_kobo, worker_count
  )
  values (
    p_organisation_id, p_run_id, 'approved', v_uid, v_run.inputs_sha256, v_run.gross_kobo,
    v_run.net_kobo, v_run.worker_count
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_approved', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'decision_id', v_id, 'check_id', v_check.id, 'inputs_sha256', v_run.inputs_sha256,
      'gross_kobo', v_run.gross_kobo::text, 'net_kobo', v_run.net_kobo::text,
      'worker_count', v_run.worker_count, 'anomalies_acknowledged', v_acked,
      'period_start', v_run.period_start, 'period_end', v_run.period_end
    ),
    null
  );
  return v_id;
end;
$$;

revoke all on function private.approve_payroll_run(uuid, uuid) from public, anon;
grant execute on function private.approve_payroll_run(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Guards that replica mode doesn't skip, and no session setting
-- ---------------------------------------------------------------------------

-- A closing of a tax rule set version, recorded by add_tax_rule_set_version for its own
-- transaction. No grants: only definer functions (owned by the migration's role) write or read
-- it. Rows are kept (one per version closed).
create table private.tax_rule_set_closings (
  id bigint generated always as identity primary key,
  rule_set_id uuid not null,
  effective_to date not null,
  xact_id xid8 not null default pg_current_xact_id(),
  created_at timestamptz not null default now()
);

create index tax_rule_set_closings_lookup_idx
  on private.tax_rule_set_closings (rule_set_id, xact_id);

revoke all on table private.tax_rule_set_closings from public, anon, authenticated, service_role;

-- 5.3's tax_rule_sets_guard (migration 20261122130000, its latest version), with only the
-- closing check changed: it reads private.tax_rule_set_closings instead of the session setting.
create or replace function private.tax_rule_sets_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
  v_posted_until date;
begin
  if tg_op = 'INSERT' then
    if new.adviser_confirmed_at is not null or new.adviser_confirmed_by is not null
      or new.adviser_note is not null then
      raise exception 'A new version starts unconfirmed. Record the adviser''s confirmation after.'
        using errcode = 'MLPR8';
    end if;
    if new.effective_to is not null then
      raise exception 'A new version runs on until a later one starts.' using errcode = 'MLPR8';
    end if;
    if new.effective_from <= v_today and exists (
      select 1 from public.tax_rule_sets t where t.organisation_id = new.organisation_id
    ) then
      raise exception 'A new version of the payroll rules starts tomorrow or later.'
        using errcode = 'MLPR7';
    end if;
    new.created_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.effective_from <= v_today or private.tax_rule_set_in_posted_run(old.id) then
      raise exception 'This version is in force, past or used by posted payroll, and is kept.'
        using errcode = 'MLPR8';
    end if;
    return old;
  end if;

  if (
    new.id, new.organisation_id, new.name, new.effective_from, new.rules, new.policy,
    new.currency, new.source_label, new.reason, new.created_at, new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.name, old.effective_from, old.rules, old.policy,
    old.currency, old.source_label, old.reason, old.created_at, old.created_by
  ) then
    raise exception 'A version of the payroll rules never changes. Add a new version instead.'
      using errcode = 'MLPR8';
  end if;

  if (new.adviser_confirmed_at, new.adviser_confirmed_by, new.adviser_note)
    is distinct from (old.adviser_confirmed_at, old.adviser_confirmed_by, old.adviser_note) then
    if old.adviser_confirmed_at is not null then
      raise exception 'The adviser''s confirmation is recorded once and kept.' using errcode = 'MLPR9';
    end if;
    if new.adviser_confirmed_at is null or new.adviser_confirmed_by is null then
      raise exception 'Record who confirmed and when.' using errcode = '22023';
    end if;
  end if;

  if new.effective_to is distinct from old.effective_to then
    -- A version is closed only by add_tax_rule_set_version, in the same transaction that adds
    -- its successor from the next day, so the rules never have a gap. Slice 5.8: the function
    -- records the closing in private.tax_rule_set_closings for this transaction (no role but the
    -- definer functions' owner can write it), and this guard reads that row instead of a session
    -- setting.
    if new.effective_to is null or not exists (
      select 1 from private.tax_rule_set_closings c
      where c.rule_set_id = old.id and c.effective_to = new.effective_to
        and c.xact_id = pg_current_xact_id()
    ) then
      raise exception 'A version closes only when a new version is added from the next day.'
        using errcode = 'MLPR8';
    end if;
    v_posted_until := private.tax_rule_set_posted_until(old.id);
    if v_posted_until is not null
      and (new.effective_to is null or new.effective_to < v_posted_until) then
      raise exception 'Posted payroll used this version up to %; it can close only after that.',
        to_char(v_posted_until, 'FMDD Mon YYYY')
        using errcode = 'MLPR8';
    end if;
    if old.effective_to is not null and old.effective_to < v_today then
      raise exception 'This version has ended and can''t change.' using errcode = 'MLPR8';
    end if;
    if old.effective_from <= v_today then
      if new.effective_to is null
        or (old.effective_to is not null and new.effective_to > old.effective_to) then
        raise exception 'A version in force can only close earlier. Add a new version instead.'
          using errcode = 'MLPR8';
      end if;
      if new.effective_to < v_today then
        raise exception 'A version in force closes today at the earliest.' using errcode = 'MLPR8';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.tax_rule_sets_guard() from public, anon, authenticated;

-- 5.0's add_tax_rule_set_version (migration 20261122100000, its only version), with only the
-- set_config calls replaced by the closing row the guard reads.
create or replace function private.add_tax_rule_set_version(
  p_organisation_id uuid,
  p_name text,
  p_rules jsonb,
  p_policy jsonb,
  p_effective_from date,
  p_reason text,
  p_source_label text default null,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_dry boolean := coalesce(p_dry_run, false);
  v_name text := private.tax_clean_text(p_name, 60);
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_source text := private.tax_clean_text(p_source_label, 200);
  v_today date;
  v_before public.tax_rule_sets%rowtype;
  v_before_doc jsonb;
  v_replaces jsonb;
  v_unchanged boolean;
  v_id uuid;
begin
  perform private.require_payroll_rules_writer(p_organisation_id);
  if v_name is null then
    raise exception 'Give the version a name of up to 60 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  if p_source_label is not null and btrim(p_source_label) <> '' and v_source is null then
    raise exception 'The source is up to 200 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  if not private.tax_rules_valid(p_rules) then
    raise exception 'The tax figures aren''t complete or aren''t in range.' using errcode = '22023';
  end if;
  if not private.tax_policy_valid(p_policy) then
    raise exception 'The pay-policy figures aren''t complete or aren''t in range.' using errcode = '22023';
  end if;
  v_today := private.org_today(p_organisation_id);
  if p_effective_from is null or p_effective_from <= v_today
    or p_effective_from > '2100-12-31' then
    raise exception 'A new version of the payroll rules starts tomorrow or later.'
      using errcode = 'MLPR7';
  end if;

  if not v_dry then
    perform private.ensure_tax_rule_set_core(p_organisation_id);
  end if;

  select t.* into v_before
  from public.tax_rule_sets t
  where t.organisation_id = p_organisation_id and t.effective_from < p_effective_from
  order by t.effective_from desc
  limit 1;

  if v_before.id is not null then
    v_before_doc := jsonb_build_object(
      'id', v_before.id, 'name', v_before.name, 'effective_from', v_before.effective_from,
      'rules', v_before.rules, 'policy', v_before.policy
    );
  elsif not exists (select 1 from public.tax_rule_sets t where t.organisation_id = p_organisation_id) then
    -- A dry run before the company has any version: compare with the template it would get.
    select jsonb_build_object(
      'id', null, 'name', tpl.name, 'effective_from', tpl.effective_from,
      'rules', tpl.rules, 'policy', tpl.policy
    ) into v_before_doc
    from private.tax_rule_set_template() tpl;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object('id', t.id, 'name', t.name, 'effective_from', t.effective_from)
    order by t.effective_from
  ), '[]'::jsonb)
  into v_replaces
  from public.tax_rule_sets t
  where t.organisation_id = p_organisation_id and t.effective_from >= p_effective_from;

  v_unchanged := v_before_doc is not null
    and v_before_doc -> 'rules' = p_rules
    and v_before_doc -> 'policy' = p_policy
    and jsonb_array_length(v_replaces) = 0;

  if not v_dry and not v_unchanged then
    delete from public.tax_rule_sets t
    where t.organisation_id = p_organisation_id and t.effective_from >= p_effective_from;
    if v_before.id is not null and (
      v_before.effective_to is null or v_before.effective_to >= p_effective_from
    ) then
      -- Slice 5.8: the closing is recorded as database state the guard reads (a row only
      -- definer functions can write, for this transaction), not a session setting.
      insert into private.tax_rule_set_closings (rule_set_id, effective_to)
      values (v_before.id, p_effective_from - 1);
      update public.tax_rule_sets t
      set effective_to = p_effective_from - 1
      where t.id = v_before.id;
    end if;
    insert into public.tax_rule_sets (
      organisation_id, name, effective_from, rules, policy, source_label, reason
    )
    values (
      p_organisation_id, v_name, p_effective_from, p_rules, p_policy, v_source, v_reason
    )
    returning id into v_id;
    perform private.log_audit_impl(
      p_organisation_id, 'payroll.rule_set_version_added', 'tax_rule_sets', v_id,
      v_before_doc,
      jsonb_build_object(
        'name', v_name, 'effective_from', p_effective_from, 'rules', p_rules, 'policy', p_policy,
        'replaces', jsonb_array_length(v_replaces)
      ),
      v_reason
    );
  end if;

  return jsonb_build_object(
    'id', v_id,
    'name', v_name,
    'effective_from', p_effective_from,
    'dry_run', v_dry,
    'unchanged', v_unchanged,
    'before', v_before_doc,
    'after', jsonb_build_object('rules', p_rules, 'policy', p_policy),
    'replaces', v_replaces
  );
end;
$$;

revoke all on function private.add_tax_rule_set_version(
  uuid, text, jsonb, jsonb, date, text, text, boolean
) from public, anon;
grant execute on function private.add_tax_rule_set_version(
  uuid, text, jsonb, jsonb, date, text, text, boolean
) to authenticated;

alter table public.tax_rule_sets enable always trigger tax_rule_sets_guard;
alter table public.tax_rule_sets enable always trigger tax_rule_sets_no_truncate;
alter table public.tax_rule_sets enable always trigger tax_rule_sets_used_by_run;
alter table public.pay_rates enable always trigger pay_rates_guard;

-- Security review L4 (defence in depth): pay rates can't be truncated, and the Phase 4 pay-input
-- truncate and insert-only guards fire in replica mode too. timesheet_lines_guard and
-- leave_requests_guard stay ordinary triggers on purpose (5.3): the test suites seed decided days
-- and leave with triggers off, and what payroll relies on is held by the ENABLE ALWAYS freezes
-- (timesheet_lines_freeze_posted, timesheet_lines_freeze_paid, leave_requests_freeze_paid).
create function private.pay_rates_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Pay rates are kept as dated versions.' using errcode = 'MLFX2';
end;
$$;

revoke all on function private.pay_rates_no_truncate() from public, anon, authenticated;

create trigger pay_rates_no_truncate before truncate on public.pay_rates
  for each statement execute function private.pay_rates_no_truncate();
alter table public.pay_rates enable always trigger pay_rates_no_truncate;
alter table public.timesheets enable always trigger timesheets_no_truncate;
alter table public.timesheet_lines enable always trigger timesheet_lines_no_truncate;
alter table public.leave_requests enable always trigger leave_requests_no_truncate;
alter table public.leave_request_pay enable always trigger leave_request_pay_insert_only;
alter table public.leave_request_pay enable always trigger leave_request_pay_no_truncate;

-- ---------------------------------------------------------------------------
-- 5. Two warnings
-- ---------------------------------------------------------------------------

-- 5.7c's private.payroll_anomaly_severity (migration 20261122200000, its latest version), with
-- two warnings added: carry_settled_later and refund_uncollected_carry.
create or replace function private.payroll_anomaly_severity(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_code in (
      'no_pay_rate', 'no_rostered_days', 'no_tax_state', 'calculation_failed',
      'previous_not_posted'
    ) then 'blocking'
    when p_code in (
      'roster_pattern_unknown', 'leave_pay_missing', 'open_timesheet_days', 'no_show_days',
      'bank_missing', 'bank_in_hold', 'bank_not_checked', 'bank_unreadable', 'bank_shared',
      'bank_shared_unchecked', 'first_pay', 'final_pay', 'net_change', 'deduction_cut',
      'no_pension_details', 'recurring_not_carried', 'on_off_cycle_run',
      'leave_correction_pending', 'carry_settled_later', 'refund_uncollected_carry'
    ) then 'warning'
  end
$$;
