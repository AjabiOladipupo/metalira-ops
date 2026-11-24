-- Slice 5.3: two-person approval, posting and the period lock (docs/PHASE_5.md 5.3, decisions 7,
-- 8, 9 and 10; CLAUDE.md rules 1, 4, 5 and 10; Phase 1 decision 17).
--
-- 1. Approval (rule 10, decision 7):
--    * payroll_runs gains approved_at and approved_by, with checks that the approver is never the
--      preparer, the submitter or the last recalculator (`approved_by <> prepared_by` in SQL).
--    * payroll_approval_checks (insert-only): the server's re-gathering of a submitted run's
--      inputs. The server reads the inputs as the approver (payroll_run_inputs checks the role),
--      runs the engine's canonical hash (src/server/payroll/run.ts) and records the hash it got
--      with the secret key (`record_payroll_approval_check`, service role only, naming the actor
--      the server checked). A signed-in user can't write one, so no approver can skip the check.
--    * approve_payroll_run(org, run): owner or finance, trusted session; never anyone in
--      private.payroll_run_touchers (the preparer, every recalculator, every submitter, adjustment
--      creators and anomaly acknowledgers, the owner included) (MLPRE); needs the approver's own
--      check made in the last 10 minutes after the latest submission, with the hash the run was
--      submitted with (MLPRF); re-checks the anomalies (MLPR4) and that the totals are the sums of
--      the payslips (MLPR6); review -> approved; records the decision; audited.
-- 2. Posting (rule 5, decision 9): once approved, the run, its payslips, lines, sources,
--    adjustments, anomalies and decisions can't change or go for any role, the secret key or the
--    database owner. The guards are ENABLE ALWAYS triggers, so even session_replication_role =
--    replica doesn't skip them, and no guard reads a session setting: there is no bypass. (5.7
--    adds a function-owned reversal path; 5.4 lets approved move to released.)
-- 3. The period lock: private.timesheet_period_posted (4.3's placeholder) is true for a day in the
--    period of an approved or released regular run (5.7's reversed status won't count). 4.3's
--    reopen and dispute then refuse with MLTA5, and a trigger refuses any status change of an
--    approved or rejected timesheet day in a posted period for everyone (the database owner and
--    the secret key included). Days approved after posting are arrears in the next run (5.1 and
--    5.2's payroll_run_inputs read this hook).
-- 4. private.tax_rule_set_in_posted_run (5.0's placeholder) checks posted runs, and a version a
--    posted run used may still close, but never before that run's pay date and period end.
-- 5. Backdated pay rates (Phase 1 decision 17): once a company has posted payroll, a new pay
--    version may start as far back as the first day after the latest posted period (the earliest
--    period not posted); until then 1.3's "today or later" stays. No version's days in a posted
--    period change, and a version used by a posted payslip can't change or be cancelled (MLPRG).
--    public.pay_rate_earliest_start(org) gives the date for the screen.
--
-- Refusals (SQLSTATE), new here:
--   MLPRE the approver prepared or changed the run (two-person rule)
--   MLPRF the inputs weren't re-checked, or changed since the run was worked out
--   MLPRG posted payroll used this pay rate, or the change reaches into a posted period
-- Reused: MLPRD (state), MLPR4 (anomalies), MLPR6 (totals), MLPR2 (a pay rate too far back),
-- MLPR8 (5.0's rule-set code), MLTA5 (4.3's posted period), 42501, 22023, P0002.
-- (MLPR1 to MLPR3 are Phase 1's pay-rate codes, MLPR5 is planned for 5.4, MLPR7 to MLPR9 are
-- 5.0's, MLPR4, MLPR6 and MLPRA to MLPRD are 5.2's.)
-- No money maths here beyond the sums 5.2 already checks.

-- ---------------------------------------------------------------------------
-- 1. Columns and the approval checks table
-- ---------------------------------------------------------------------------

alter table public.payroll_runs
  add column approved_at timestamptz,
  add column approved_by uuid,
  add constraint payroll_runs_approved_pair check ((approved_at is null) = (approved_by is null)),
  add constraint payroll_runs_approved_state check (
    case
      when status in ('approved', 'released') then approved_at is not null
      else approved_at is null
    end
  ),
  -- Rule 10, in SQL: the approver is never the preparer, the submitter or the last recalculator.
  -- (approve_payroll_run also refuses adjusters, acknowledgers and every earlier recalculator.)
  add constraint payroll_runs_two_people check (
    approved_by is null or (
      approved_by <> prepared_by
      and approved_by is distinct from submitted_by
      and approved_by is distinct from calculated_by
    )
  );

comment on column public.payroll_runs.approved_by is
  'Who approved the run (rule 10): never its preparer, submitter or anyone who changed it.';

alter table public.payroll_run_decisions
  drop constraint payroll_run_decisions_value,
  add constraint payroll_run_decisions_value check (
    decision in ('submitted', 'returned', 'approved', 'released')
  );

-- Who posted payroll used a pay version: payslips name their pay_rate_ids.
create index payslips_pay_rate_ids_idx on public.payslips using gin (pay_rate_ids);
create index payroll_runs_posted_idx on public.payroll_runs (organisation_id, period_end)
  where status in ('approved', 'released');

create table public.payroll_approval_checks (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  -- The approver the server checked (an owner or finance member of the company).
  actor_id uuid not null,
  -- The canonical inputs hash the server got by re-gathering the inputs now.
  inputs_sha256 text not null
    constraint payroll_approval_checks_sha_format check (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  -- Whether it equals the hash the run was worked out (and submitted) with.
  matches boolean not null,
  created_at timestamptz not null default now(),
  constraint payroll_approval_checks_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_approval_checks_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id)
);

create index payroll_approval_checks_run_idx
  on public.payroll_approval_checks (organisation_id, run_id, actor_id, created_at desc);

comment on table public.payroll_approval_checks is
  'The server''s re-gathering of a submitted run''s inputs before approval (slice 5.3, decision 7): the hash it got and whether it matched. Written only by record_payroll_approval_check with the secret key; insert-only.';

alter table public.payroll_approval_checks enable row level security;

create policy payroll_approval_checks_select on public.payroll_approval_checks
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.payroll_approval_checks from anon, authenticated, service_role;
grant select on table public.payroll_approval_checks to authenticated, service_role;

-- Insert-only, and an insert is stamped now.
create function private.payroll_approval_checks_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Approval checks are kept as written.' using errcode = 'MLPRD';
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.payroll_approval_checks_guard() from public, anon, authenticated;

create trigger payroll_approval_checks_guard
  before insert or update or delete on public.payroll_approval_checks
  for each row execute function private.payroll_approval_checks_guard();
create trigger payroll_approval_checks_no_truncate before truncate on public.payroll_approval_checks
  for each statement execute function private.payroll_no_truncate();
create trigger payroll_approval_checks_audit after insert on public.payroll_approval_checks
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 2. Posting: the run's guard, and every payroll guard fires always
-- ---------------------------------------------------------------------------

-- As 5.2's guard (migration 20261122120000, section 2), plus:
-- * approved_at and approved_by are set only by the move review -> approved, which changes
--   nothing else;
-- * once approved or released, a run never changes (5.4 adds approved -> released; 5.7 adds its
--   reversal through its own function).
create or replace function private.payroll_runs_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- No foreign key to tax_rule_sets (5.0's truncate guard must stay first): checked here.
    if not exists (
      select 1 from public.tax_rule_sets t
      where t.organisation_id = new.organisation_id and t.id = new.rule_set_id
    ) then
      raise exception 'The run''s rule set isn''t one of the company''s.' using errcode = 'MLPRD';
    end if;
    if new.status <> 'draft' or new.calculated_at is not null or new.submitted_at is not null
      or new.inputs_sha256 is not null or new.worker_count <> 0 or new.gross_kobo <> 0
      or new.net_kobo <> 0 or new.employer_cost_kobo <> 0 or not new.needs_recalculation
      or new.approved_at is not null or new.approved_by is not null then
      raise exception 'A new payroll run starts as an empty draft.' using errcode = 'MLPRD';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A payroll run is never deleted.' using errcode = 'MLPRD';
  end if;
  -- Posted is final (rule 5): nothing about an approved or released run changes.
  if old.status in ('approved', 'released') then
    raise exception 'This payroll run is posted and never changes. Corrections go in a later run.'
      using errcode = 'MLPRD';
  end if;
  if (
    new.id, new.organisation_id, new.kind, new.period_start, new.period_end, new.pay_date,
    new.rule_set_id, new.prepared_by, new.currency, new.created_at
  ) is distinct from (
    old.id, old.organisation_id, old.kind, old.period_start, old.period_end, old.pay_date,
    old.rule_set_id, old.prepared_by, old.currency, old.created_at
  ) then
    raise exception 'A payroll run''s period, pay date, rule set and preparer never change.'
      using errcode = 'MLPRD';
  end if;
  if (
    new.itf_applies, new.inputs_sha256, new.needs_recalculation, new.calculated_at,
    new.calculated_by, new.gross_kobo, new.paye_kobo, new.pension_employee_kobo,
    new.pension_employer_kobo, new.nhf_kobo, new.other_deductions_kobo, new.net_kobo,
    new.nsitf_kobo, new.itf_kobo, new.employer_cost_kobo, new.carried_forward_kobo,
    new.worker_count
  ) is distinct from (
    old.itf_applies, old.inputs_sha256, old.needs_recalculation, old.calculated_at,
    old.calculated_by, old.gross_kobo, old.paye_kobo, old.pension_employee_kobo,
    old.pension_employer_kobo, old.nhf_kobo, old.other_deductions_kobo, old.net_kobo,
    old.nsitf_kobo, old.itf_kobo, old.employer_cost_kobo, old.carried_forward_kobo,
    old.worker_count
  ) and not (old.status = 'draft' and new.status = 'draft') then
    raise exception 'Only a draft run is recalculated.' using errcode = 'MLPRD';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status = 'review')
    or (old.status = 'review' and new.status = 'draft')
    or (old.status = 'review' and new.status = 'approved')
  ) then
    raise exception 'A payroll run moves from draft to review, back to draft, or on to approved.'
      using errcode = 'MLPRD';
  end if;
  if new.status = 'approved' then
    if new.approved_at is null or new.approved_by is null
      or (new.submitted_at, new.submitted_by) is distinct from (old.submitted_at, old.submitted_by) then
      raise exception 'An approval records who approved and when, and changes nothing else.'
        using errcode = 'MLPRD';
    end if;
  elsif new.approved_at is not null or new.approved_by is not null then
    raise exception 'Only an approval records an approver.' using errcode = 'MLPRD';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ENABLE ALWAYS: these guards fire whatever session_replication_role says, so the database
-- owner can't skip them either. (Row guards on payslips, lines and sources refuse any update and
-- any insert or delete unless the run is a draft; see 5.2's private.payroll_draft_rows_guard.)
alter table public.payroll_runs enable always trigger payroll_runs_guard;
alter table public.payslips enable always trigger payslips_guard;
alter table public.payslip_lines enable always trigger payslip_lines_guard;
alter table public.payslip_sources enable always trigger payslip_sources_guard;
alter table public.payroll_adjustments enable always trigger payroll_adjustments_guard;
alter table public.payroll_anomalies enable always trigger payroll_anomalies_guard;
alter table public.payroll_run_decisions enable always trigger payroll_run_decisions_insert_only;
alter table public.payroll_approval_checks enable always trigger payroll_approval_checks_guard;
alter table public.payroll_runs enable always trigger payroll_runs_no_truncate;
alter table public.payslips enable always trigger payslips_no_truncate;
alter table public.payslip_lines enable always trigger payslip_lines_no_truncate;
alter table public.payslip_sources enable always trigger payslip_sources_no_truncate;
alter table public.payroll_adjustments enable always trigger payroll_adjustments_no_truncate;
alter table public.payroll_anomalies enable always trigger payroll_anomalies_no_truncate;
alter table public.payroll_run_decisions enable always trigger payroll_run_decisions_no_truncate;
alter table public.payroll_approval_checks enable always trigger payroll_approval_checks_no_truncate;

-- ---------------------------------------------------------------------------
-- 3. The period lock
-- ---------------------------------------------------------------------------

-- 4.3's hook (migration 20261121170000), now real: true when the day falls in the period of an
-- approved or released regular run of the company. 5.7's reversed runs have another status, so a
-- reversal unlocks the period. Called by definer functions (reopen, dispute, the pay inputs).
create or replace function private.timesheet_period_posted(p_organisation_id uuid, p_work_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_organisation_id is not null and p_work_date is not null and exists (
    select 1
    from public.payroll_runs r
    where r.organisation_id = p_organisation_id
      and r.kind = 'regular'
      and r.status in ('approved', 'released')
      and p_work_date between r.period_start and r.period_end
  ), false)
$$;

revoke all on function private.timesheet_period_posted(uuid, date) from public, anon, authenticated;

-- BEFORE UPDATE on timesheet_lines: an approved or rejected day in a posted period keeps its
-- status, for every role, the secret key and the database owner (reopen and dispute refuse first
-- with the same code). A pending day there may still be approved or rejected: an approval is paid
-- in the next run as arrears (decision 10).
create function private.timesheet_lines_period_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('approved', 'rejected') and new.status is distinct from old.status
    and private.timesheet_period_posted(old.organisation_id, old.work_date) then
    raise exception 'Payroll for this period is posted. This day can''t be reopened.'
      using errcode = 'MLTA5';
  end if;
  return new;
end;
$$;

revoke all on function private.timesheet_lines_period_lock() from public, anon, authenticated;

create trigger timesheet_lines_period_lock before update on public.timesheet_lines
  for each row execute function private.timesheet_lines_period_lock();

-- ---------------------------------------------------------------------------
-- 4. Rule sets used by posted runs (5.0's hook)
-- ---------------------------------------------------------------------------

create or replace function private.tax_rule_set_in_posted_run(p_rule_set_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_rule_set_id is not null and exists (
    select 1 from public.payroll_runs r
    where r.rule_set_id = p_rule_set_id and r.status in ('approved', 'released')
  ), false)
$$;

revoke all on function private.tax_rule_set_in_posted_run(uuid) from public, anon, authenticated;

-- The last day a posted run relies on a version: the later of its pay date and period end.
create function private.tax_rule_set_posted_until(p_rule_set_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select max(greatest(r.pay_date, r.period_end))
  from public.payroll_runs r
  where r.rule_set_id = p_rule_set_id and r.status in ('approved', 'released')
$$;

revoke all on function private.tax_rule_set_posted_until(uuid) from public, anon, authenticated;

-- As 5.0's guard (migration 20261122100000, section 2) except one rule: a version a posted run
-- used may still close when a new version is added (otherwise the company could never change its
-- rules after its first payroll), but never before the posted runs' pay dates and period ends, so
-- what they used stays the version in force for them.
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
    -- its successor from the next day, so the rules never have a gap. The function sets this
    -- transaction-local flag; nothing a signed-in user can call sets it.
    if coalesce(current_setting('metalira.tax_rule_set_closing', true), '') <> 'on' then
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

-- ---------------------------------------------------------------------------
-- 5. Backdated pay rates (Phase 1 decision 17)
-- ---------------------------------------------------------------------------

-- The last day of the latest posted pay period of the company (any posted run), or null when
-- nothing is posted. Readable for the company's owner, hr and finance, and for callers with no
-- signed-in user (the secret key, the database owner); null for anyone else, so it tells another
-- company's users nothing. Called by the pay-rate guard and add_pay_rate as the caller.
create function private.payroll_posted_through(p_organisation_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select max(r.period_end)
  from public.payroll_runs r
  where r.organisation_id = p_organisation_id
    and r.status in ('approved', 'released')
    and (auth.uid() is null or private.has_role(p_organisation_id, array['owner', 'hr', 'finance']))
$$;

revoke all on function private.payroll_posted_through(uuid) from public, anon;
grant execute on function private.payroll_posted_through(uuid) to authenticated, service_role;

-- True when a payslip of a posted run used this pay version. Same audience as above.
create function private.pay_rate_in_posted_payslip(p_organisation_id uuid, p_pay_rate_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.payslips s
    join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
    where s.organisation_id = p_organisation_id
      and s.pay_rate_ids @> array[p_pay_rate_id]
      and r.status in ('approved', 'released')
  ), false)
  and (auth.uid() is null or private.has_role(p_organisation_id, array['owner', 'hr', 'finance']))
$$;

revoke all on function private.pay_rate_in_posted_payslip(uuid, uuid) from public, anon;
grant execute on function private.pay_rate_in_posted_payslip(uuid, uuid) to authenticated, service_role;

-- The first day a new pay version may start for a worker who already has one: the day after the
-- latest posted pay period once the company has posted payroll (the earliest period not posted),
-- else today (1.3's rule until payroll posts).
create function private.pay_rate_floor(p_organisation_id uuid)
returns date
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    private.payroll_posted_through(p_organisation_id) + 1,
    private.org_today(p_organisation_id)
  )
$$;

revoke all on function private.pay_rate_floor(uuid) from public, anon;
grant execute on function private.pay_rate_floor(uuid) to authenticated, service_role;

-- For the Pay section's date picker (owner, hr, finance): the earliest start a new version may
-- have for a worker who already has one.
create function private.pay_rate_earliest_start(p_organisation_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only an owner, HR or Finance can read this.' using errcode = '42501';
  end if;
  return private.pay_rate_floor(p_organisation_id);
end;
$$;

revoke all on function private.pay_rate_earliest_start(uuid) from public, anon;
grant execute on function private.pay_rate_earliest_start(uuid) to authenticated;

create function public.pay_rate_earliest_start(p_organisation_id uuid)
returns date
language sql
stable
security invoker
set search_path = ''
as $$
  select private.pay_rate_earliest_start(p_organisation_id)
$$;

revoke all on function public.pay_rate_earliest_start(uuid) from public, anon;
grant execute on function public.pay_rate_earliest_start(uuid) to authenticated;

-- As Phase 1's guard (migration 20261116103000, section 7), with decision 17:
-- * a new version for a worker who has one starts on private.pay_rate_floor or later (today
--   until payroll posts; then back to the first day after the latest posted period) (MLPR2);
-- * a version used by a posted payslip never changes except to close after the posted days, and
--   is never cancelled (MLPRG);
-- * no version's end moves into a posted period, and a version that ended inside one never
--   changes (MLPRG);
-- * a version in force closes from the day before the floor at the earliest (yesterday until
--   payroll posts, as before).
create or replace function private.pay_rates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organisation_id, old.organisation_id);
  v_today date := private.org_today(v_org);
  v_posted date := private.payroll_posted_through(v_org);
  v_floor date := coalesce(v_posted + 1, v_today);
  v_start date;
begin
  if tg_op = 'INSERT' then
    -- Read as the caller: a worker of another organisation is invisible here and the insert
    -- is then refused by RLS, so nothing leaks.
    select w.start_date into v_start from public.workers w where w.id = new.worker_id;
    if new.effective_from < v_start then
      raise exception 'A pay rate can''t start before the employee''s start date.' using errcode = '22023';
    end if;
    if new.effective_from < v_floor
      and exists (select 1 from public.pay_rates p where p.worker_id = new.worker_id) then
      if v_posted is null then
        raise exception 'A new pay rate can''t start in the past once the worker has one. Start it today or later.'
          using errcode = 'MLPR2';
      end if;
      raise exception 'A new pay rate can start on % at the earliest: payroll up to % is posted.',
        to_char(v_floor, 'FMDD Mon YYYY'), to_char(v_posted, 'FMDD Mon YYYY')
        using errcode = 'MLPR2';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if private.pay_rate_in_posted_payslip(old.organisation_id, old.id) then
      raise exception 'Posted payroll used this pay rate, so it is kept.' using errcode = 'MLPRG';
    end if;
    if old.effective_from <= v_today then
      raise exception 'This pay rate is already in force and can''t be removed.' using errcode = 'MLPR1';
    end if;
    if exists (
      select 1 from public.pay_rates p
      where p.worker_id = old.worker_id and p.effective_from > old.effective_from
    ) then
      raise exception 'A later pay rate is scheduled after this one. Cancel that one first.'
        using errcode = 'MLPR1';
    end if;
    return old;
  end if;

  if new.worker_id is distinct from old.worker_id
    or new.organisation_id is distinct from old.organisation_id then
    raise exception 'A pay rate can''t move to another worker.' using errcode = 'MLPR1';
  end if;

  -- Posted payroll (decision 17): what posted payslips used stays as it was.
  if (
    new.pay_type, new.basic_kobo, new.housing_kobo, new.transport_kobo,
    new.other_allowances_kobo, new.daily_rate_kobo, new.hourly_rate_kobo, new.currency,
    new.effective_from
  ) is distinct from (
    old.pay_type, old.basic_kobo, old.housing_kobo, old.transport_kobo,
    old.other_allowances_kobo, old.daily_rate_kobo, old.hourly_rate_kobo, old.currency,
    old.effective_from
  ) and private.pay_rate_in_posted_payslip(old.organisation_id, old.id) then
    raise exception 'Posted payroll used this pay rate, so it can''t change. Add a new version instead.'
      using errcode = 'MLPRG';
  end if;
  if v_posted is not null and new.effective_to is distinct from old.effective_to then
    if old.effective_to is not null and old.effective_to <= v_posted then
      raise exception 'This pay rate ended in a posted pay period and can''t change.'
        using errcode = 'MLPRG';
    end if;
    if new.effective_to is not null and new.effective_to < v_posted then
      raise exception 'Payroll up to % is posted: this pay rate can end on that day at the earliest.',
        to_char(v_posted, 'FMDD Mon YYYY')
        using errcode = 'MLPRG';
    end if;
  end if;

  -- The end of a version followed by another is pinned to the day before the next one starts.
  if new.effective_to is distinct from old.effective_to
    and exists (
      select 1 from public.pay_rates p
      where p.worker_id = old.worker_id and p.effective_from > old.effective_from
    ) then
    raise exception 'A later pay rate follows this one, so its end date can''t change. Cancel the later one first.'
      using errcode = 'MLPR1';
  end if;

  if old.effective_from <= v_today then
    if (
      new.pay_type, new.basic_kobo, new.housing_kobo, new.transport_kobo,
      new.other_allowances_kobo, new.daily_rate_kobo, new.hourly_rate_kobo, new.currency,
      new.effective_from
    ) is distinct from (
      old.pay_type, old.basic_kobo, old.housing_kobo, old.transport_kobo,
      old.other_allowances_kobo, old.daily_rate_kobo, old.hourly_rate_kobo, old.currency,
      old.effective_from
    ) then
      raise exception 'This pay rate is already in force and can''t be changed. Add a new version instead.'
        using errcode = 'MLPR1';
    end if;
    if new.effective_to is distinct from old.effective_to then
      if old.effective_to is not null and old.effective_to < v_floor then
        raise exception 'This pay rate has ended and can''t be changed.' using errcode = 'MLPR1';
      end if;
      if new.effective_to is not null and new.effective_to < v_floor - 1 then
        if v_posted is null then
          raise exception 'A pay rate in force can be closed from yesterday at the earliest.'
            using errcode = 'MLPR1';
        end if;
        raise exception 'A pay rate in force can be closed from % at the earliest.',
          to_char(v_floor - 1, 'FMDD Mon YYYY')
          using errcode = 'MLPR1';
      end if;
    end if;
  elsif new.effective_from is distinct from old.effective_from then
    -- Moving a scheduled version would open a gap after the version before it (or overlap
    -- it). Signed-in users have no grant on effective_from; this holds for server code too.
    if exists (select 1 from public.pay_rates p where p.worker_id = old.worker_id and p.id <> old.id) then
      raise exception 'A scheduled pay rate can''t move. Cancel it and add it again from the new date.'
        using errcode = 'MLPR1';
    end if;
    if new.effective_from < v_today then
      raise exception 'A scheduled pay rate can''t be moved into the past.' using errcode = 'MLPR2';
    end if;
    select w.start_date into v_start from public.workers w where w.id = new.worker_id;
    if new.effective_from < v_start then
      raise exception 'A pay rate can''t start before the employee''s start date.' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.pay_rates_guard() from public, anon, authenticated;

-- As Phase 1's add_pay_rate, with decision 17's floor in place of "today" for a worker who
-- already has a version (the guard checks the same on the insert).
create or replace function public.add_pay_rate(p_organisation_id uuid, p_worker_id uuid, p_rate jsonb)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_from date := (p_rate ->> 'effective_from')::date;
  v_posted date;
  v_floor date;
  v_id uuid;
begin
  if v_from is null then
    raise exception 'Choose the date the pay rate starts.' using errcode = '22023';
  end if;

  -- Locks the worker row: pay changes for one worker happen one at a time.
  perform 1
  from public.workers w
  where w.id = p_worker_id
    and w.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.pay_rates p where p.worker_id = p_worker_id and p.effective_from >= v_from
  ) then
    raise exception 'A pay rate from this date or later already exists. Cancel that version first, or change its amounts.'
      using errcode = 'MLPR3';
  end if;
  v_posted := private.payroll_posted_through(p_organisation_id);
  v_floor := coalesce(v_posted + 1, private.org_today(p_organisation_id));
  if v_from < v_floor
    and exists (select 1 from public.pay_rates p where p.worker_id = p_worker_id) then
    if v_posted is null then
      raise exception 'A new pay rate can''t start in the past once the worker has one. Start it today or later.'
        using errcode = 'MLPR2';
    end if;
    raise exception 'A new pay rate can start on % at the earliest: payroll up to % is posted.',
      to_char(v_floor, 'FMDD Mon YYYY'), to_char(v_posted, 'FMDD Mon YYYY')
      using errcode = 'MLPR2';
  end if;

  update public.pay_rates p
  set effective_to = v_from - 1
  where p.worker_id = p_worker_id
    and (p.effective_to is null or p.effective_to >= v_from);

  insert into public.pay_rates (
    organisation_id, worker_id, pay_type, basic_kobo, housing_kobo, transport_kobo,
    other_allowances_kobo, daily_rate_kobo, hourly_rate_kobo, effective_from
  )
  values (
    p_organisation_id,
    p_worker_id,
    (p_rate ->> 'pay_type')::public.pay_type,
    (p_rate ->> 'basic_kobo')::bigint,
    (p_rate ->> 'housing_kobo')::bigint,
    (p_rate ->> 'transport_kobo')::bigint,
    (p_rate ->> 'other_allowances_kobo')::bigint,
    (p_rate ->> 'daily_rate_kobo')::bigint,
    (p_rate ->> 'hourly_rate_kobo')::bigint,
    v_from
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Functions: the server's input check and the approval
-- ---------------------------------------------------------------------------

-- Records the server's re-gathering of a submitted run's inputs (decision 7). The secret key only
-- (no signed-in user): the server read the inputs as the approver, hashed them with the engine's
-- canonical form and names that approver, who must be an owner or finance member of the company.
-- Returns {check_id, matches}.
create function private.record_payroll_approval_check(
  p_organisation_id uuid,
  p_run_id uuid,
  p_actor uuid,
  p_inputs_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype;
  v_id uuid;
  v_matches boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'Only the server checks a run''s inputs.' using errcode = '42501';
  end if;
  if p_organisation_id is null or p_run_id is null or p_actor is null then
    raise exception 'Name the company, the run and who is approving.' using errcode = '22023';
  end if;
  if p_inputs_sha256 is null or p_inputs_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The inputs hash isn''t a SHA-256.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id and m.user_id = p_actor
      and m.role in ('owner', 'finance')
  ) then
    raise exception 'Only an owner or Finance can approve payroll.' using errcode = '42501';
  end if;
  select r.* into v_run
  from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = p_run_id;
  if v_run.id is null then
    raise exception 'That payroll run wasn''t found.' using errcode = 'P0002';
  end if;
  if v_run.status <> 'review' then
    raise exception 'Only a run waiting for approval is checked.' using errcode = 'MLPRD';
  end if;
  v_matches := v_run.inputs_sha256 is not null and v_run.inputs_sha256 = p_inputs_sha256;
  perform set_config('metalira.audit_channel', 'web', true);
  insert into public.payroll_approval_checks (
    organisation_id, run_id, actor_id, inputs_sha256, matches
  )
  values (p_organisation_id, p_run_id, p_actor, p_inputs_sha256, v_matches)
  returning id into v_id;
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, p_actor, 'payroll.inputs_checked', 'payroll_runs', p_run_id, null,
    jsonb_build_object('check_id', v_id, 'matches', v_matches, 'inputs_sha256', p_inputs_sha256)
  );
  return jsonb_build_object('check_id', v_id, 'matches', v_matches);
end;
$$;

revoke all on function private.record_payroll_approval_check(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function private.record_payroll_approval_check(uuid, uuid, uuid, text) to service_role;

create function public.record_payroll_approval_check(
  p_organisation_id uuid,
  p_run_id uuid,
  p_actor uuid,
  p_inputs_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_payroll_approval_check(p_organisation_id, p_run_id, p_actor, p_inputs_sha256)
$$;

revoke all on function public.record_payroll_approval_check(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_payroll_approval_check(uuid, uuid, uuid, text) to service_role;

-- Approves a submitted run (owner or finance, trusted session), posting it: its payslips become
-- final and its pay period is locked. Refused (MLPRE) to anyone who prepared or changed the run,
-- owner included; (MLPRF) without the approver's own fresh input check, or when that check found
-- the inputs changed; (MLPR4) if an anomaly blocks or isn't acknowledged; (MLPR6) if the totals
-- aren't the sums of the payslips. Records the decision and returns its id.
create function private.approve_payroll_run(p_organisation_id uuid, p_run_id uuid)
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

  -- Decision 7: the approver's own server check, after the latest submission, in the last 10
  -- minutes, must have found the inputs the run was worked out from.
  select c.* into v_check
  from public.payroll_approval_checks c
  where c.organisation_id = p_organisation_id and c.run_id = p_run_id and c.actor_id = v_uid
    and c.created_at >= v_run.submitted_at
  order by c.created_at desc, c.id desc
  limit 1;
  if v_check.id is null or v_check.created_at < now() - interval '10 minutes' then
    raise exception 'The run''s inputs must be checked again just before approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  if not v_check.matches or v_check.inputs_sha256 <> v_run.inputs_sha256 then
    raise exception 'Something this run was worked out from has changed since (a timesheet day, a pay rate, leave or bank details). Return it to HR to recalculate.'
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

create function public.approve_payroll_run(p_organisation_id uuid, p_run_id uuid)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.approve_payroll_run(p_organisation_id, p_run_id)
$$;

revoke all on function public.approve_payroll_run(uuid, uuid) from public, anon;
grant execute on function public.approve_payroll_run(uuid, uuid) to authenticated;
