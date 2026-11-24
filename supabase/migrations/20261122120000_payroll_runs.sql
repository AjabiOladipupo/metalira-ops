-- Slice 5.2: the payroll run: draft, review, anomalies (docs/PHASE_5.md 5.2, decisions 5, 8, 10
-- and 15).
--
-- 1. Tables (organisation_id on every row, composite foreign keys, RLS in the set-helper form):
--    * payroll_runs: one per company, period and kind (regular only until 5.7). Status draft or
--      review here (approved and released come with 5.3 and 5.4). The rule set in force on the
--      pay date is snapshotted (decision 15), with the SHA-256 of the canonical inputs, the run's
--      totals in kobo (sums of its payslips, worked out here, never sent), prepared_by (who
--      created it), calculated_by (who last recalculated it) and submitted_by.
--    * payslips, payslip_lines, payslip_sources: one payslip per worker per run with every
--      amount in kobo, the snapshots of "Outputs" and the trace (storedTrace: no names or
--      personal numbers). A source (timesheet line, leave request days, pay version days,
--      adjustment) is one row per payslip, naming the lines it backs; across standing payslips a
--      source's days never overlap (exclusion constraint, decision 10: a source is paid once).
--      Inserted and deleted only while the run is a draft, never updated.
--    * payroll_adjustments: one-off and recurring earnings and deductions, with a reason and the
--      actor; changed only while the run is a draft (then the run needs recalculating).
--    * payroll_anomalies: what looks wrong, worked out by the server at each recalculation, with
--      a detail document that holds no personal numbers (checked: no run of 10 digits outside
--      ids). Warnings are acknowledged; blocking ones are fixed, never acknowledged.
--    * payroll_run_decisions: insert-only (submitted, returned with a reason; 5.3 adds approved
--      and released), for every role, the secret key and the database owner included.
--    Who reads: owner, hr and finance. Workers see no payslip here (5.5 publishes released ones).
--    Nobody writes the tables directly: the functions below do.
-- 2. Pay inputs close slice 5.1's TODO(5.2): `private.payroll_run_inputs` (and `public.payroll_run_inputs`
--    for a run, which leaves that run's own draft out; 5.1's payroll_inputs keeps its signature and
--    calls it with no run). Arrears leave out
--    a timesheet line already recorded as a source of a standing payslip of another run, the
--    off days already paid in an arrears day's ISO week come from those sources, and leave
--    whose days in the cycle another standing payslip already covers is left out.
-- 3. `private.worker_has_work_records` checks payslips of runs past draft (payslips are work
--    records; a draft is replaced at each recalculation and pays nothing).
-- 4. `private.payroll_run_touchers(org, run)`: everyone who prepared or changed the run, so 5.3's
--    approval refuses each of them (rule 10).
-- 5. Functions (private security definer behind public invoker wrappers, search_path ''):
--    create_payroll_run (hr, owner), save_payroll_results (the secret key only: the server ran
--    the engine; every invariant is checked again here), add_payroll_adjustment and
--    remove_payroll_adjustment (hr, owner; draft only), acknowledge_payroll_anomalies (hr,
--    owner; warnings only), submit_payroll_run (hr, owner; no blocking and no unacknowledged
--    anomaly) and return_payroll_run (finance, owner; back to draft with a reason).
--
-- Refusals (SQLSTATE):
--   MLPRD the run isn't in a state that allows this (not a draft, not in review, needs
--         recalculating)
--   MLPR4 anomalies stop the submission (a blocking one, or one not acknowledged)
--   MLPR6 the results break an invariant (totals, net, sources, signs, shape)
--   MLPRA a regular run for this period already exists
--   MLPRB a blocking anomaly can't be acknowledged
--   MLPRC a source is already paid by a standing payslip
--   22023 bad input; 42501 the wrong role or an untrusted session; P0002 not in the company
-- (MLPR1 to MLPR3 are Phase 1's pay-rate codes, MLPR5 is planned for 5.4 and MLPR7 to MLPR9 are 5.0's.)
-- No money maths here beyond sums and the checks: the TypeScript engine works pay out (decision 5).

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  kind text not null default 'regular'
    constraint payroll_runs_kind_value check (kind in ('regular')),
  status text not null default 'draft'
    constraint payroll_runs_status_value check (status in ('draft', 'review', 'approved', 'released')),
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  -- Decision 15: the rule set in force on the pay date, for the whole run.
  rule_set_id uuid not null,
  itf_applies boolean not null default false,
  inputs_sha256 text
    constraint payroll_runs_inputs_sha256_format check (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  -- True until the first calculation and after any adjustment changes.
  needs_recalculation boolean not null default true,
  calculated_at timestamptz,
  calculated_by uuid,
  currency text not null default 'NGN'
    constraint payroll_runs_currency check (currency = 'NGN'),
  gross_kobo bigint not null default 0 constraint payroll_runs_gross_nonneg check (gross_kobo >= 0),
  paye_kobo bigint not null default 0 constraint payroll_runs_paye_nonneg check (paye_kobo >= 0),
  pension_employee_kobo bigint not null default 0
    constraint payroll_runs_pension_employee_nonneg check (pension_employee_kobo >= 0),
  pension_employer_kobo bigint not null default 0
    constraint payroll_runs_pension_employer_nonneg check (pension_employer_kobo >= 0),
  nhf_kobo bigint not null default 0 constraint payroll_runs_nhf_nonneg check (nhf_kobo >= 0),
  other_deductions_kobo bigint not null default 0
    constraint payroll_runs_other_nonneg check (other_deductions_kobo >= 0),
  net_kobo bigint not null default 0 constraint payroll_runs_net_nonneg check (net_kobo >= 0),
  nsitf_kobo bigint not null default 0 constraint payroll_runs_nsitf_nonneg check (nsitf_kobo >= 0),
  itf_kobo bigint not null default 0 constraint payroll_runs_itf_nonneg check (itf_kobo >= 0),
  employer_cost_kobo bigint not null default 0
    constraint payroll_runs_employer_cost_nonneg check (employer_cost_kobo >= 0),
  carried_forward_kobo bigint not null default 0
    constraint payroll_runs_carried_nonneg check (carried_forward_kobo >= 0),
  worker_count integer not null default 0 constraint payroll_runs_worker_count check (worker_count >= 0),
  -- Who created the run (rule 10: never its approver; 5.3 checks in SQL).
  prepared_by uuid not null,
  submitted_at timestamptz,
  submitted_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_runs_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_runs_dates check (
    period_end >= period_start and pay_date >= period_start and pay_date <= period_end + 45
  ),
  constraint payroll_runs_net check (
    net_kobo = gross_kobo - paye_kobo - pension_employee_kobo - nhf_kobo - other_deductions_kobo
  ),
  constraint payroll_runs_employer_cost check (
    employer_cost_kobo = gross_kobo + pension_employer_kobo + nsitf_kobo + itf_kobo
  ),
  constraint payroll_runs_calculated_pair check ((calculated_at is null) = (calculated_by is null)),
  constraint payroll_runs_submitted check (
    case status
      when 'draft' then submitted_at is null and submitted_by is null
      else submitted_at is not null and submitted_by is not null
    end
  )
);

create unique index payroll_runs_one_regular on public.payroll_runs (organisation_id, period_start)
  where kind = 'regular';
create index payroll_runs_org_period_idx on public.payroll_runs (organisation_id, period_start desc);

comment on table public.payroll_runs is
  'A company''s payroll run for one pay period (slice 5.2). Totals are the sums of its payslips, worked out in SQL when the server saves the engine''s results. Changed only by the payroll functions.';

create table public.payslips (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  worker_id uuid not null,
  currency text not null default 'NGN' constraint payslips_currency check (currency = 'NGN'),
  gross_kobo bigint not null constraint payslips_gross_nonneg check (gross_kobo >= 0),
  paye_kobo bigint not null constraint payslips_paye_nonneg check (paye_kobo >= 0),
  pension_employee_kobo bigint not null
    constraint payslips_pension_employee_nonneg check (pension_employee_kobo >= 0),
  pension_employer_kobo bigint not null
    constraint payslips_pension_employer_nonneg check (pension_employer_kobo >= 0),
  nhf_kobo bigint not null constraint payslips_nhf_nonneg check (nhf_kobo >= 0),
  other_deductions_kobo bigint not null
    constraint payslips_other_nonneg check (other_deductions_kobo >= 0),
  net_kobo bigint not null constraint payslips_net_nonneg check (net_kobo >= 0),
  carried_forward_kobo bigint not null
    constraint payslips_carried_nonneg check (carried_forward_kobo >= 0),
  nsitf_kobo bigint not null constraint payslips_nsitf_nonneg check (nsitf_kobo >= 0),
  itf_kobo bigint not null constraint payslips_itf_nonneg check (itf_kobo >= 0),
  employer_cost_kobo bigint not null
    constraint payslips_employer_cost_nonneg check (employer_cost_kobo >= 0),
  -- Snapshots ("Outputs").
  rule_set_id uuid not null,
  pay_rate_ids uuid[] not null default '{}',
  employment_type text not null
    constraint payslips_employment_type check (employment_type in ('permanent', 'contract', 'casual', 'daily')),
  tax_state text constraint payslips_tax_state_text check (char_length(tax_state) between 1 and 100),
  pfa_name text constraint payslips_pfa_name_text check (char_length(pfa_name) between 1 and 200),
  cycle_days integer not null constraint payslips_cycle_days check (cycle_days between 0 and 62),
  rostered_days integer not null constraint payslips_rostered_days check (rostered_days between 0 and 62),
  employed_rostered_days integer not null
    constraint payslips_employed_days check (employed_rostered_days between 0 and 62),
  leave_deducted_days integer not null
    constraint payslips_leave_days check (leave_deducted_days between 0 and 62),
  trace jsonb not null
    constraint payslips_trace_shape check (
      jsonb_typeof(trace) = 'object'
      and jsonb_typeof(trace -> 'trace_version') = 'number'
      and jsonb_typeof(trace -> 'steps') = 'array'
      and octet_length(trace::text) <= 200000
    ),
  trace_version integer not null,
  created_at timestamptz not null default now(),
  constraint payslips_organisation_id_id_key unique (organisation_id, id),
  constraint payslips_run_worker_key unique (run_id, worker_id),
  constraint payslips_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payslips_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payslips_net check (
    net_kobo = gross_kobo - paye_kobo - pension_employee_kobo - nhf_kobo - other_deductions_kobo
  ),
  constraint payslips_employer_cost check (
    employer_cost_kobo = gross_kobo + pension_employer_kobo + nsitf_kobo + itf_kobo
  )
);

create index payslips_worker_idx on public.payslips (organisation_id, worker_id);

comment on table public.payslips is
  'One worker''s pay for one run (slice 5.2): every amount in kobo, the snapshots and the step-by-step trace (no names or personal numbers). Work records. Inserted and deleted only while the run is a draft; never updated.';

create table public.payslip_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  payslip_id uuid not null,
  run_id uuid not null,
  position integer not null constraint payslip_lines_position check (position between 1 and 500),
  code text not null
    constraint payslip_lines_code_value check (code in (
      'basic', 'housing', 'transport', 'other_allowances', 'daily_pay', 'hourly_pay', 'overtime',
      'off_day', 'public_holiday', 'leave_deduction', 'adjustment_earning', 'arrears', 'paye',
      'pension_employee', 'nhf', 'deduction', 'carried_deduction', 'pension_employer', 'nsitf',
      'itf'
    )),
  kind text not null
    constraint payslip_lines_kind_value check (kind in ('earning', 'deduction', 'statutory', 'employer')),
  label text not null
    constraint payslip_lines_label_text check (
      char_length(label) between 1 and 300 and label !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  amount_kobo bigint not null,
  currency text not null default 'NGN' constraint payslip_lines_currency check (currency = 'NGN'),
  pensionable boolean not null,
  taxable boolean not null,
  constraint payslip_lines_organisation_id_id_key unique (organisation_id, id),
  constraint payslip_lines_position_key unique (payslip_id, position),
  constraint payslip_lines_payslip_fkey foreign key (organisation_id, payslip_id)
    references public.payslips (organisation_id, id) on delete cascade,
  -- Earnings as earned (a leave deduction negative, nothing else); deductions and levies positive.
  constraint payslip_lines_sign check (
    case when code = 'leave_deduction' then amount_kobo <= 0 else amount_kobo >= 0 end
  ),
  constraint payslip_lines_kind_matches check (
    case
      when code in ('paye', 'pension_employee', 'nhf') then kind = 'statutory'
      when code in ('deduction', 'carried_deduction') then kind = 'deduction'
      when code in ('pension_employer', 'nsitf', 'itf') then kind = 'employer'
      else kind = 'earning'
    end
  )
);

create index payslip_lines_run_idx on public.payslip_lines (organisation_id, run_id);

create table public.payslip_sources (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  payslip_id uuid not null,
  run_id uuid not null,
  worker_id uuid not null,
  source_kind text not null
    constraint payslip_sources_kind_value check (
      source_kind in ('timesheet_line', 'leave_request', 'pay_rate', 'adjustment')
    ),
  source_id uuid not null,
  -- The days of the source this payslip pays (a timesheet line: its one work date; an
  -- adjustment: the run's period).
  from_date date not null,
  to_date date not null,
  -- A timesheet day paid as off-day work (the off-day rule): arrears count these per ISO week.
  off_day boolean not null default false,
  -- The payslip lines (by position) this source backs.
  line_positions integer[] not null
    constraint payslip_sources_lines check (cardinality(line_positions) between 1 and 500),
  -- False once the payslip no longer stands (a reversed run, 5.7): its sources are free again.
  stands boolean not null default true,
  created_at timestamptz not null default now(),
  constraint payslip_sources_organisation_id_id_key unique (organisation_id, id),
  constraint payslip_sources_payslip_fkey foreign key (organisation_id, payslip_id)
    references public.payslips (organisation_id, id) on delete cascade,
  constraint payslip_sources_dates check (to_date >= from_date),
  constraint payslip_sources_off_day check (not off_day or source_kind = 'timesheet_line'),
  -- One row per source per payslip.
  constraint payslip_sources_once_per_payslip unique (payslip_id, source_kind, source_id),
  -- Decision 10: across standing payslips a source's days are paid once.
  constraint payslip_sources_paid_once exclude using gist (
    organisation_id with =,
    source_kind with =,
    source_id with =,
    daterange(from_date, to_date, '[]') with &&
  ) where (stands)
);

create index payslip_sources_worker_idx on public.payslip_sources (organisation_id, worker_id, from_date);
create index payslip_sources_run_idx on public.payslip_sources (organisation_id, run_id);

comment on table public.payslip_sources is
  'What each payslip pays: a timesheet line, leave request days, pay version days or an adjustment (slice 5.2, decision 10). Across standing payslips a source''s days never overlap; one source can back several lines of one payslip.';

create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  worker_id uuid not null,
  kind text not null constraint payroll_adjustments_kind_value check (kind in ('earning', 'deduction')),
  label text not null
    constraint payroll_adjustments_label_text check (
      label = btrim(label) and char_length(label) between 1 and 80
      and label !~ '[\x01-\x1f\x7f-\x9f<>]' and label !~* '(://|www\.)'
    ),
  amount_kobo bigint not null
    constraint payroll_adjustments_amount check (amount_kobo > 0 and amount_kobo <= 100000000000),
  currency text not null default 'NGN' constraint payroll_adjustments_currency check (currency = 'NGN'),
  -- Earnings: taxable, and pensionable only when HR marks it. Deductions come off after tax.
  pensionable boolean not null default false,
  taxable boolean not null default true,
  -- Recurring: instalment n of m ("2 of 3"); one-off is 1 of 1.
  series_id uuid not null,
  instalment_number integer not null default 1,
  instalment_count integer not null default 1,
  reason text not null
    constraint payroll_adjustments_reason_text check (
      reason = btrim(reason) and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]' and reason !~* '(://|www\.)'
    ),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_adjustments_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_adjustments_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payroll_adjustments_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payroll_adjustments_instalments check (
    instalment_count between 1 and 60 and instalment_number between 1 and instalment_count
  ),
  constraint payroll_adjustments_series_key unique (series_id, instalment_number),
  constraint payroll_adjustments_deduction_flags check (
    kind = 'earning' or (not pensionable and not taxable)
  )
);

create index payroll_adjustments_run_idx on public.payroll_adjustments (organisation_id, run_id);

create table public.payroll_anomalies (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  -- Null for a run-level anomaly (open timesheet days at a site, a shared account).
  worker_id uuid,
  code text not null constraint payroll_anomalies_code_format check (code ~ '^[a-z][a-z_]{1,39}$'),
  severity text not null
    constraint payroll_anomalies_severity_value check (severity in ('blocking', 'warning')),
  -- No personal numbers: no run of 10 or more digits outside ids.
  detail jsonb not null default '{}'::jsonb
    constraint payroll_anomalies_detail_shape check (
      jsonb_typeof(detail) = 'object'
      and octet_length(detail::text) <= 4096
      and regexp_replace(
        detail::text,
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'gi'
      ) !~ '[0-9]{10}'
    ),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payroll_anomalies_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_anomalies_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payroll_anomalies_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payroll_anomalies_ack_pair check ((acknowledged_by is null) = (acknowledged_at is null)),
  constraint payroll_anomalies_blocking_unacknowledged check (
    severity = 'warning' or acknowledged_at is null
  )
);

create index payroll_anomalies_run_idx on public.payroll_anomalies (organisation_id, run_id);

create table public.payroll_run_decisions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  decision text not null
    constraint payroll_run_decisions_value check (decision in ('submitted', 'returned')),
  reason text
    constraint payroll_run_decisions_reason_text check (
      reason = btrim(reason) and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]' and reason !~* '(://|www\.)'
    ),
  actor_id uuid not null,
  -- What was submitted or returned: the run's totals and inputs hash at that moment.
  inputs_sha256 text
    constraint payroll_run_decisions_sha_format check (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  gross_kobo bigint not null,
  net_kobo bigint not null,
  worker_count integer not null,
  created_at timestamptz not null default now(),
  constraint payroll_run_decisions_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_run_decisions_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payroll_run_decisions_returned_reason check (decision <> 'returned' or reason is not null)
);

create index payroll_run_decisions_run_idx on public.payroll_run_decisions (organisation_id, run_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. Guards (every role, the secret key and the database owner included)
-- ---------------------------------------------------------------------------

-- Status of a run, locked by the caller when it matters.
create function private.payroll_run_status(p_organisation_id uuid, p_run_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.status from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = p_run_id
$$;

revoke all on function private.payroll_run_status(uuid, uuid) from public, anon, authenticated;

-- BEFORE INSERT/UPDATE/DELETE on payroll_runs:
-- * a new run is a draft with nothing calculated or submitted and zero totals;
-- * never deleted; the company, kind, period, pay date, rule set and preparer never change;
-- * the calculation (totals, inputs hash, ITF, needs_recalculation) changes only while a draft;
-- * status moves only draft -> review (submitted) and review -> draft (returned) in 5.2.
create function private.payroll_runs_guard()
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
      or new.net_kobo <> 0 or new.employer_cost_kobo <> 0 or not new.needs_recalculation then
      raise exception 'A new payroll run starts as an empty draft.' using errcode = 'MLPRD';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A payroll run is never deleted.' using errcode = 'MLPRD';
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
  ) then
    raise exception 'A payroll run moves from draft to review and back here.' using errcode = 'MLPRD';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.payroll_runs_guard() from public, anon, authenticated;

create trigger payroll_runs_guard before insert or update or delete on public.payroll_runs
  for each row execute function private.payroll_runs_guard();
create trigger payroll_runs_audit after insert or update or delete on public.payroll_runs
  for each row execute function private.audit_row_change();

-- BEFORE INSERT/UPDATE/DELETE on payslips, payslip_lines, payslip_sources and
-- payroll_adjustments: rows come and go only while their run is a draft, and never change.
create function private.payroll_draft_rows_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' then
    -- 5.7's reversal will free sources (stands) through a function-owned path of its own.
    raise exception 'Payslips, their lines, sources and adjustments never change. Recalculate the draft.'
      using errcode = 'MLPRD';
  end if;
  if tg_op = 'DELETE' then
    v_status := private.payroll_run_status(old.organisation_id, old.run_id);
  else
    v_status := private.payroll_run_status(new.organisation_id, new.run_id);
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'Only a draft run''s payslips and adjustments change.' using errcode = 'MLPRD';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_draft_rows_guard() from public, anon, authenticated;

create trigger payslips_guard before insert or update or delete on public.payslips
  for each row execute function private.payroll_draft_rows_guard();
create trigger payslip_lines_guard before insert or update or delete on public.payslip_lines
  for each row execute function private.payroll_draft_rows_guard();
create trigger payslip_sources_guard before insert or update or delete on public.payslip_sources
  for each row execute function private.payroll_draft_rows_guard();
create trigger payroll_adjustments_guard before insert or update or delete on public.payroll_adjustments
  for each row execute function private.payroll_draft_rows_guard();
create trigger payroll_adjustments_audit after insert or update or delete on public.payroll_adjustments
  for each row execute function private.audit_row_change();

-- BEFORE INSERT/UPDATE/DELETE on payroll_anomalies: rows come and go only while the run is a
-- draft; the only change is a warning's acknowledgement, once, while a draft.
create function private.payroll_anomalies_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text := private.payroll_run_status(
    coalesce(new.organisation_id, old.organisation_id), coalesce(new.run_id, old.run_id)
  );
begin
  if v_status is distinct from 'draft' then
    raise exception 'Only a draft run''s anomalies change.' using errcode = 'MLPRD';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'acknowledged_by' - 'acknowledged_at')
      is distinct from (to_jsonb(old) - 'acknowledged_by' - 'acknowledged_at')
      or old.acknowledged_at is not null or new.acknowledged_at is null then
      raise exception 'An anomaly is acknowledged once and otherwise never changes.'
        using errcode = 'MLPRD';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_anomalies_guard() from public, anon, authenticated;

create trigger payroll_anomalies_guard before insert or update or delete on public.payroll_anomalies
  for each row execute function private.payroll_anomalies_guard();

-- A version of the payroll rules a run uses is never deleted (5.0's guard already keeps versions
-- in force or past; this keeps a scheduled one a run snapshotted).
create function private.tax_rule_sets_used_by_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = old.organisation_id and r.rule_set_id = old.id
  ) then
    raise exception 'A payroll run uses this version of the rules; it is kept.' using errcode = 'MLPR8';
  end if;
  return old;
end;
$$;

revoke all on function private.tax_rule_sets_used_by_run() from public, anon, authenticated;

create trigger tax_rule_sets_used_by_run before delete on public.tax_rule_sets
  for each row execute function private.tax_rule_sets_used_by_run();

-- Decisions are insert-only for everyone.
create function private.payroll_insert_only_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Payroll decisions are kept as written.' using errcode = 'MLPRD';
end;
$$;

revoke all on function private.payroll_insert_only_guard() from public, anon, authenticated;

create trigger payroll_run_decisions_insert_only before update or delete on public.payroll_run_decisions
  for each row execute function private.payroll_insert_only_guard();
create trigger payroll_run_decisions_audit after insert on public.payroll_run_decisions
  for each row execute function private.audit_row_change();

-- TRUNCATE skips row triggers: refuse it on every payroll table.
create function private.payroll_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Payroll records are kept.' using errcode = 'MLPRD';
end;
$$;

revoke all on function private.payroll_no_truncate() from public, anon, authenticated;

create trigger payroll_runs_no_truncate before truncate on public.payroll_runs
  for each statement execute function private.payroll_no_truncate();
create trigger payslips_no_truncate before truncate on public.payslips
  for each statement execute function private.payroll_no_truncate();
create trigger payslip_lines_no_truncate before truncate on public.payslip_lines
  for each statement execute function private.payroll_no_truncate();
create trigger payslip_sources_no_truncate before truncate on public.payslip_sources
  for each statement execute function private.payroll_no_truncate();
create trigger payroll_adjustments_no_truncate before truncate on public.payroll_adjustments
  for each statement execute function private.payroll_no_truncate();
create trigger payroll_anomalies_no_truncate before truncate on public.payroll_anomalies
  for each statement execute function private.payroll_no_truncate();
create trigger payroll_run_decisions_no_truncate before truncate on public.payroll_run_decisions
  for each statement execute function private.payroll_no_truncate();

-- ---------------------------------------------------------------------------
-- 3. Row-level security and grants: owner, hr and finance read; nobody writes directly
-- ---------------------------------------------------------------------------

alter table public.payroll_runs enable row level security;
alter table public.payslips enable row level security;
alter table public.payslip_lines enable row level security;
alter table public.payslip_sources enable row level security;
alter table public.payroll_adjustments enable row level security;
alter table public.payroll_anomalies enable row level security;
alter table public.payroll_run_decisions enable row level security;

create policy payroll_runs_select on public.payroll_runs for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payslips_select on public.payslips for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payslip_lines_select on public.payslip_lines for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payslip_sources_select on public.payslip_sources for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payroll_adjustments_select on public.payroll_adjustments for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payroll_anomalies_select on public.payroll_anomalies for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payroll_run_decisions_select on public.payroll_run_decisions for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.payroll_runs, public.payslips, public.payslip_lines,
  public.payslip_sources, public.payroll_adjustments, public.payroll_anomalies,
  public.payroll_run_decisions
  from anon, authenticated, service_role;
grant select on table public.payroll_runs, public.payslips, public.payslip_lines,
  public.payslip_sources, public.payroll_adjustments, public.payroll_anomalies,
  public.payroll_run_decisions
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Pay inputs: paid sources left out (closes slice 5.1's TODO(5.2))
-- ---------------------------------------------------------------------------

-- True when another standing payslip (not of p_run_id) already pays any of these days of the
-- source. The run being recalculated is left out, so its own draft never hides what it pays.
create function private.payroll_source_paid(
  p_organisation_id uuid,
  p_kind text,
  p_source_id uuid,
  p_from date,
  p_to date,
  p_run_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.payslip_sources s
    where s.organisation_id = p_organisation_id
      and s.source_kind = p_kind
      and s.source_id = p_source_id
      and s.stands
      and daterange(s.from_date, s.to_date, '[]') && daterange(p_from, p_to, '[]')
      and (p_run_id is null or s.run_id <> p_run_id)
  )
$$;

revoke all on function private.payroll_source_paid(uuid, text, uuid, date, date, uuid)
  from public, anon, authenticated;

-- As slice 5.1's read (migration 20261122110000, section 3), plus p_run_id (the run being
-- calculated, or null; its own draft never hides what it pays) and decision 10:
-- * arrears leave out a line already recorded as a source of a standing payslip of another run
--   (one timesheet line is paid once, whatever lines of a payslip it backs);
-- * week_shift_days counts only the week's shift days before the cycle (a week running into the
--   cycle has its off day worked out by the current run's own rule, which sees the whole week);
-- * week_off_days_paid: the distinct shift days of that ISO week already paid as off-day work by
--   another standing payslip, so an arrears day owes an off day only when the week's approved
--   shift days less work_days_per_week exceed the off days already paid;
-- * leave whose days in the cycle another standing payslip already covers is left out.
create function private.payroll_run_inputs(
  p_organisation_id uuid,
  p_period_start date,
  p_worker_ids uuid[],
  p_run_id uuid
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
  if p_run_id is not null and not exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.id = p_run_id
  ) then
    raise exception 'That payroll run wasn''t found.' using errcode = '22023';
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
          and not private.payroll_source_paid(
            p_organisation_id, 'timesheet_line', l.id, l.work_date, l.work_date, p_run_id
          )
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
              ) order by r.effective_from, r.id
            )
            from public.pay_rates r
            where r.organisation_id = p_organisation_id and r.worker_id = w.id
              and r.effective_from <= v_end
              and (r.effective_to is null or r.effective_to >= v_arrears_from)
          ), '[]'::jsonb),
          'shifts', coalesce((
            select jsonb_agg(
              jsonb_build_object('date', a.shift_date, 'on_leave', a.status = 'removed')
              order by a.shift_date, a.id
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
                -- Only days before the cycle: a week that runs into the cycle has its off day paid by
                -- the current run's own off-day rule (money review M1).
                'week_shift_days', (
                  select count(distinct l2.work_date)
                  from public.timesheet_lines l2
                  where l2.organisation_id = p_organisation_id and l2.worker_id = w.id
                    and l2.status = 'approved'
                    and l2.shift_assignment_id is not null
                    and l2.worked_minutes + l2.ot_minutes > 0
                    and date_trunc('week', l2.work_date) = date_trunc('week', l.work_date)
                    and l2.work_date < v_start
                ),
                -- Shift days of this ISO week another standing payslip paid as off-day work.
                'week_off_days_paid', (
                  select count(distinct s.from_date)
                  from public.payslip_sources s
                  join public.timesheet_lines l3
                    on l3.organisation_id = s.organisation_id and l3.id = s.source_id
                  where s.organisation_id = p_organisation_id and s.worker_id = w.id
                    and s.source_kind = 'timesheet_line'
                    and s.off_day and s.stands
                    and (p_run_id is null or s.run_id <> p_run_id)
                    and l3.shift_assignment_id is not null
                    and date_trunc('week', s.from_date) = date_trunc('week', l.work_date)
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
              and not private.payroll_source_paid(
                p_organisation_id, 'timesheet_line', l.id, l.work_date, l.work_date, p_run_id
              )
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
              ) order by q.start_date, q.id
            )
            from public.leave_requests q
            join public.leave_types t
              on t.organisation_id = q.organisation_id and t.id = q.leave_type_id
            left join public.leave_request_pay p
              on p.organisation_id = q.organisation_id and p.request_id = q.id
            where q.organisation_id = p_organisation_id and q.worker_id = w.id
              and q.status = 'approved'
              and q.start_date <= v_end and q.end_date >= v_start
              and not private.payroll_source_paid(
                p_organisation_id, 'leave_request', q.id,
                greatest(q.start_date, v_start), least(q.end_date, v_end), p_run_id
              )
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

revoke all on function private.payroll_run_inputs(uuid, date, uuid[], uuid) from public, anon;
grant execute on function private.payroll_run_inputs(uuid, date, uuid[], uuid) to authenticated, service_role;

-- Slice 5.1's read keeps its signature and now leaves out what standing payslips paid.
create or replace function private.payroll_inputs(
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
  select private.payroll_run_inputs(p_organisation_id, p_period_start, p_worker_ids, null)
$$;

-- The run's own read (the server, recalculating a run): the same, leaving that run's draft out.
create function public.payroll_run_inputs(
  p_organisation_id uuid,
  p_period_start date,
  p_run_id uuid,
  p_worker_ids uuid[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.payroll_run_inputs(p_organisation_id, p_period_start, p_worker_ids, p_run_id)
$$;

revoke all on function public.payroll_run_inputs(uuid, date, uuid, uuid[]) from public, anon;
grant execute on function public.payroll_run_inputs(uuid, date, uuid, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Work records: payslips
-- ---------------------------------------------------------------------------

-- As slice 4.2's (migration 20261121120000), with the fail-closed placeholder for payslips
-- replaced by a real check: a payslip of a run past draft. A draft's payslips are replaced at
-- each recalculation and pay nothing, so they don't hold a staff ID correction back.
-- (`payroll_lines` was a name the plan never used; nothing creates it.)
create or replace function private.worker_has_work_records(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_organisation_id is null or p_worker_id is null then
    return true;
  end if;
  return exists (
      select 1 from public.punches p
      where p.organisation_id = p_organisation_id and p.worker_id = p_worker_id
    )
    or exists (
      select 1 from public.timesheet_lines l
      where l.organisation_id = p_organisation_id and l.worker_id = p_worker_id
    )
    or exists (
      select 1
      from public.payslips s
      join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
      where s.organisation_id = p_organisation_id and s.worker_id = p_worker_id
        and r.status <> 'draft'
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Shared checks
-- ---------------------------------------------------------------------------

-- The severity of an anomaly code (mirrors ANOMALY_SEVERITY in src/lib/payroll/run.ts; the RLS
-- suite compares them). Null for a code payroll doesn't know.
create function private.payroll_anomaly_severity(p_code text)
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
      'no_pension_details', 'recurring_not_carried'
    ) then 'warning'
  end
$$;

revoke all on function private.payroll_anomaly_severity(text) from public, anon, authenticated;

-- Owner or hr of the organisation, in a trusted session: prepares, recalculates and submits.
create function private.require_payroll_preparer(p_organisation_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
begin
  if v_uid is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr']) then
    raise exception 'Only an owner or HR can prepare payroll.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function private.require_payroll_preparer(uuid) from public, anon, authenticated;

-- Owner or finance of the organisation, in a trusted session: returns (and in 5.3 approves).
create function private.require_payroll_approver(p_organisation_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
begin
  if v_uid is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'finance']) then
    raise exception 'Only an owner or Finance can decide on a submitted payroll run.'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function private.require_payroll_approver(uuid) from public, anon, authenticated;

-- The run, locked, in the organisation. P0002 when it isn't there.
create function private.payroll_lock_run(p_organisation_id uuid, p_run_id uuid)
returns public.payroll_runs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype;
begin
  select r.* into v_run
  from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = p_run_id
  for update;
  if v_run.id is null then
    raise exception 'That payroll run wasn''t found.' using errcode = 'P0002';
  end if;
  return v_run;
end;
$$;

revoke all on function private.payroll_lock_run(uuid, uuid) from public, anon, authenticated;

-- Whole kobo from a results document: a string of digits (a leading minus only when p_negative).
create function private.payroll_kobo(p_value jsonb, p_negative boolean, p_what text)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    raise exception 'The results are missing %.', p_what using errcode = 'MLPR6';
  end if;
  v := p_value #>> '{}';
  if v !~ (case when p_negative then '^-?[0-9]{1,15}$' else '^[0-9]{1,15}$' end) then
    raise exception 'The results give % as something other than whole kobo.', p_what
      using errcode = 'MLPR6';
  end if;
  return v::bigint;
end;
$$;

revoke all on function private.payroll_kobo(jsonb, boolean, text) from public, anon, authenticated;

-- Everyone who prepared or changed a run, for 5.3's two-person rule (rule 10): its preparer, every
-- person who saved its results (the audit log keeps each recalculation's actor; calculated_by is
-- the latest), its submitters, anyone who added an adjustment or acknowledged an anomaly on it.
-- Each of these is taken from the session where they acted (prepared_by, submitted_by, the
-- decisions' actor, created_by, acknowledged_by), or, for a recalculation, from the actor the
-- server named after checking the signed-in user (calculated_by). No role check: definers call it.
create function private.payroll_run_touchers(p_organisation_id uuid, p_run_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct t.uid) filter (where t.uid is not null), '{}')
  from (
    select r.prepared_by as uid from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.id = p_run_id
    union all
    select r.calculated_by from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.id = p_run_id
    union all
    select r.submitted_by from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.id = p_run_id
    union all
    select d.actor_id from public.payroll_run_decisions d
    where d.organisation_id = p_organisation_id and d.run_id = p_run_id
      and d.decision = 'submitted'
    union all
    select a.created_by from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
    union all
    select a.acknowledged_by from public.payroll_anomalies a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
    union all
    select l.actor_id from public.audit_log l
    where l.organisation_id = p_organisation_id and l.entity = 'payroll_runs'
      and l.entity_id = p_run_id
      and l.action in ('payroll.results_saved', 'payroll.run_created', 'payroll.run_submitted',
        'payroll.adjustment_added', 'payroll.adjustment_removed', 'payroll.anomalies_acknowledged')
  ) t
$$;

revoke all on function private.payroll_run_touchers(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Functions
-- ---------------------------------------------------------------------------

-- Creates the regular run for the pay period starting p_period_start (owner or hr). The pay date
-- is the company's pay day unless HR sets another (from the period's start to 45 days after its
-- end). The company's rule set is copied in on first use (ensure_tax_rule_set) and the version in
-- force on the pay date (tax_rule_set_on) is snapshotted for the whole run (decision 15).
-- Recurring adjustments whose last instalment was in a posted run carry on with the next one.
-- The run starts empty: the server calculates it next. Returns the run id.
create function private.create_payroll_run(
  p_organisation_id uuid,
  p_period_start date,
  p_pay_date date default null
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
  v_carried integer;
begin
  if p_period_start is null then
    raise exception 'Choose the pay period.' using errcode = '22023';
  end if;
  select p.period_start, p.period_end, p.pay_date into v_start, v_end, v_pay
  from private.payroll_period_for(p_organisation_id, p_period_start) p;
  if v_start is null or v_start <> p_period_start then
    raise exception 'Choose a pay period by its first day.' using errcode = '22023';
  end if;
  v_pay := coalesce(p_pay_date, v_pay);
  if v_pay < v_start or v_pay > v_end + 45 then
    raise exception 'The pay date falls in the period or up to 45 days after it.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payroll_runs:' || p_organisation_id::text, 0));
  if exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.kind = 'regular' and r.period_start = v_start
  ) then
    raise exception 'A payroll run for this period already exists.' using errcode = 'MLPRA';
  end if;

  perform private.ensure_tax_rule_set(p_organisation_id);
  select t.id into v_rule_set from private.tax_rule_set_on(p_organisation_id, v_pay) t;
  if v_rule_set is null then
    raise exception 'No payroll rules are in force on the pay date.' using errcode = '22023';
  end if;

  insert into public.payroll_runs (
    organisation_id, kind, period_start, period_end, pay_date, rule_set_id, prepared_by
  )
  values (p_organisation_id, 'regular', v_start, v_end, v_pay, v_rule_set, v_uid)
  returning id into v_id;

  -- Recurring adjustments: the next instalment of each series whose latest instalment was paid
  -- in a posted run of an earlier period.
  with latest as (
    select distinct on (a.series_id) a.*
    from public.payroll_adjustments a
    join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
    where a.organisation_id = p_organisation_id
      and r.status in ('approved', 'released')
      and r.period_start < v_start
    order by a.series_id, a.instalment_number desc
  )
  insert into public.payroll_adjustments (
    organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
    series_id, instalment_number, instalment_count, reason, created_by
  )
  select l.organisation_id, v_id, l.worker_id, l.kind, l.label, l.amount_kobo, l.pensionable,
    l.taxable, l.series_id, l.instalment_number + 1, l.instalment_count, l.reason, v_uid
  from latest l
  join public.workers w on w.organisation_id = l.organisation_id and w.id = l.worker_id
  where l.instalment_number < l.instalment_count
    and (w.end_date is null or w.end_date >= v_start)
    and not exists (
      select 1 from public.payroll_adjustments x
      where x.series_id = l.series_id and x.instalment_number = l.instalment_number + 1
    );
  get diagnostics v_carried = row_count;

  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_created', 'payroll_runs', v_id, null,
    jsonb_build_object(
      'period_start', v_start, 'period_end', v_end, 'pay_date', v_pay,
      'rule_set_id', v_rule_set, 'recurring_adjustments', v_carried
    ),
    null
  );
  return v_id;
exception
  when unique_violation then
    raise exception 'A payroll run for this period already exists.' using errcode = 'MLPRA';
end;
$$;

revoke all on function private.create_payroll_run(uuid, date, date) from public, anon;
grant execute on function private.create_payroll_run(uuid, date, date) to authenticated;

create function public.create_payroll_run(
  p_organisation_id uuid,
  p_period_start date,
  p_pay_date date default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.create_payroll_run(p_organisation_id, p_period_start, p_pay_date)
$$;

revoke all on function public.create_payroll_run(uuid, date, date) from public, anon;
grant execute on function public.create_payroll_run(uuid, date, date) to authenticated;

-- Saves the engine's results for a draft run, replacing its payslips, lines, sources and
-- anomalies in one transaction. The secret key only (no signed-in user): the server gathered the
-- inputs, ran the engine and passes the actor (an owner or hr of the company, checked here).
-- Every invariant is checked again (MLPR6): amounts are whole kobo, non-negative except a leave
-- deduction line; per payslip the lines add up to gross, PAYE, pension, NHF, other deductions and
-- each levy; net = gross - PAYE - employee pension - NHF - other deductions; employer cost =
-- gross + employer pension + NSITF + ITF; every source is the worker's own approved line, approved
-- leave, pay version or an adjustment of this run, and every adjustment of the run is paid; the
-- run's totals are the sums of its payslips and must equal the totals the server sent. A source
-- already paid by another standing payslip is refused (MLPRC). Acknowledgements carry over to an
-- identical anomaly (same worker, code and detail). Returns the counts and totals.
--
-- p_results: {itf_applies, totals: {gross_kobo, ...}, payslips: [{worker_id, employment_type,
-- tax_state, pfa_name, pay_rate_ids, days: {cycle, rostered, employed_rostered, leave_deducted},
-- gross_kobo, paye_kobo, pension_employee_kobo, nhf_kobo, other_deductions_kobo, net_kobo,
-- carried_forward_kobo, pension_employer_kobo, nsitf_kobo, itf_kobo, employer_cost_kobo, trace,
-- lines: [{code, kind, label, amount_kobo, pensionable, taxable, sources: [{kind, id, from, to,
-- off_day}]}]}], anomalies: [{worker_id, code, severity, detail}]}; kobo as strings of digits.
create function private.save_payroll_results(
  p_organisation_id uuid,
  p_run_id uuid,
  p_actor uuid,
  p_results jsonb,
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
  v_slip jsonb;
  v_line jsonb;
  v_src jsonb;
  v_anomaly jsonb;
  v_slip_id uuid;
  v_worker uuid;
  v_pos integer;
  v_kind text;
  v_code text;
  v_amount bigint;
  v_from date;
  v_to date;
  v_src_id uuid;
  v_src_kind text;
  v_amounts jsonb;
  v_gross bigint; v_paye bigint; v_pee bigint; v_nhf bigint; v_other bigint; v_net bigint;
  v_carried bigint; v_per bigint; v_nsitf bigint; v_itf bigint; v_cost bigint;
  v_sum_earn bigint; v_sum_paye bigint; v_sum_pee bigint; v_sum_nhf bigint; v_sum_ded bigint;
  v_sum_per bigint; v_sum_nsitf bigint; v_sum_itf bigint;
  v_old_acks jsonb;
  v_before jsonb;
  v_totals record;
  v_anomaly_count integer := 0;
  v_ack_by uuid;
  v_ack_at timestamptz;
  v_detail jsonb;
  v_text text;
  v_slip_count integer := 0;
  v_sources jsonb;
  v_key text;
  v_severity text;
  v_adj public.payroll_adjustments%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'Only the server saves payroll results.' using errcode = '42501';
  end if;
  if p_organisation_id is null or p_run_id is null or p_actor is null then
    raise exception 'Name the company, the run and who recalculated it.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id and m.user_id = p_actor
      and m.role in ('owner', 'hr')
  ) then
    raise exception 'Only an owner or HR can recalculate payroll.' using errcode = '42501';
  end if;
  if p_inputs_sha256 is null or p_inputs_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The inputs hash isn''t a SHA-256.' using errcode = 'MLPR6';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'object'
    or jsonb_typeof(p_results -> 'payslips') <> 'array'
    or jsonb_typeof(p_results -> 'anomalies') <> 'array'
    or jsonb_typeof(p_results -> 'totals') <> 'object'
    or jsonb_typeof(p_results -> 'itf_applies') <> 'boolean' then
    raise exception 'The results aren''t in the expected shape.' using errcode = 'MLPR6';
  end if;
  if jsonb_array_length(p_results -> 'payslips') > 5000
    or jsonb_array_length(p_results -> 'anomalies') > 20000 then
    raise exception 'The results are too large.' using errcode = 'MLPR6';
  end if;

  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Only a draft run is recalculated.' using errcode = 'MLPRD';
  end if;
  perform set_config('metalira.audit_channel', 'web', true);

  v_before := jsonb_build_object(
    'gross_kobo', v_run.gross_kobo::text, 'net_kobo', v_run.net_kobo::text,
    'worker_count', v_run.worker_count, 'inputs_sha256', v_run.inputs_sha256
  );

  -- Acknowledged warnings, to carry over to identical anomalies.
  select coalesce(jsonb_agg(jsonb_build_object(
    'worker_id', a.worker_id, 'code', a.code, 'detail', a.detail,
    'by', a.acknowledged_by, 'at', a.acknowledged_at
  )), '[]'::jsonb) into v_old_acks
  from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id
    and a.acknowledged_at is not null;

  delete from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;
  delete from public.payslips s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id;

  for v_slip in select e from jsonb_array_elements(p_results -> 'payslips') e loop
    if jsonb_typeof(v_slip) <> 'object' or jsonb_typeof(v_slip -> 'lines') <> 'array'
      or jsonb_typeof(v_slip -> 'days') <> 'object'
      or jsonb_typeof(v_slip -> 'pay_rate_ids') <> 'array' then
      raise exception 'A payslip isn''t in the expected shape.' using errcode = 'MLPR6';
    end if;
    begin
      v_worker := (v_slip ->> 'worker_id')::uuid;
    exception when others then
      raise exception 'A payslip names no worker.' using errcode = 'MLPR6';
    end;
    if v_worker is null or not exists (
      select 1 from public.workers w
      where w.organisation_id = p_organisation_id and w.id = v_worker
    ) then
      raise exception 'A payslip names a worker outside the company.' using errcode = 'MLPR6';
    end if;

    v_gross := private.payroll_kobo(v_slip -> 'gross_kobo', false, 'gross pay');
    v_paye := private.payroll_kobo(v_slip -> 'paye_kobo', false, 'PAYE');
    v_pee := private.payroll_kobo(v_slip -> 'pension_employee_kobo', false, 'employee pension');
    v_nhf := private.payroll_kobo(v_slip -> 'nhf_kobo', false, 'NHF');
    v_other := private.payroll_kobo(v_slip -> 'other_deductions_kobo', false, 'other deductions');
    v_net := private.payroll_kobo(v_slip -> 'net_kobo', false, 'net pay');
    v_carried := private.payroll_kobo(v_slip -> 'carried_forward_kobo', false, 'the carried deduction');
    v_per := private.payroll_kobo(v_slip -> 'pension_employer_kobo', false, 'employer pension');
    v_nsitf := private.payroll_kobo(v_slip -> 'nsitf_kobo', false, 'NSITF');
    v_itf := private.payroll_kobo(v_slip -> 'itf_kobo', false, 'ITF');
    v_cost := private.payroll_kobo(v_slip -> 'employer_cost_kobo', false, 'employer cost');

    if v_net <> v_gross - v_paye - v_pee - v_nhf - v_other then
      raise exception 'A payslip''s net pay isn''t gross less its deductions.' using errcode = 'MLPR6';
    end if;
    if v_cost <> v_gross + v_per + v_nsitf + v_itf then
      raise exception 'A payslip''s employer cost isn''t gross plus employer pension and levies.'
        using errcode = 'MLPR6';
    end if;
    if not (v_slip ->> 'employment_type') in ('permanent', 'contract', 'casual', 'daily') then
      raise exception 'A payslip has no employment type.' using errcode = 'MLPR6';
    end if;
    begin
      if exists (
        select 1 from jsonb_array_elements_text(v_slip -> 'pay_rate_ids') x
        where not exists (
          select 1 from public.pay_rates r
          where r.organisation_id = p_organisation_id and r.worker_id = v_worker
            and r.id = x::uuid
        )
      ) then
        raise exception 'A payslip names a pay rate that isn''t this worker''s.' using errcode = 'MLPR6';
      end if;
    exception when invalid_text_representation then
      raise exception 'A payslip names a pay rate that isn''t an id.' using errcode = 'MLPR6';
    end;

    begin
      insert into public.payslips (
        organisation_id, run_id, worker_id, gross_kobo, paye_kobo, pension_employee_kobo,
        pension_employer_kobo, nhf_kobo, other_deductions_kobo, net_kobo, carried_forward_kobo,
        nsitf_kobo, itf_kobo, employer_cost_kobo, rule_set_id, pay_rate_ids, employment_type,
        tax_state, pfa_name, cycle_days, rostered_days, employed_rostered_days,
        leave_deducted_days, trace, trace_version
      )
      values (
        p_organisation_id, p_run_id, v_worker, v_gross, v_paye, v_pee, v_per, v_nhf, v_other,
        v_net, v_carried, v_nsitf, v_itf, v_cost, v_run.rule_set_id,
        (select coalesce(array_agg(x::uuid), '{}') from jsonb_array_elements_text(v_slip -> 'pay_rate_ids') x),
        v_slip ->> 'employment_type',
        nullif(btrim(v_slip ->> 'tax_state'), ''),
        nullif(btrim(v_slip ->> 'pfa_name'), ''),
        (v_slip -> 'days' ->> 'cycle')::integer,
        (v_slip -> 'days' ->> 'rostered')::integer,
        (v_slip -> 'days' ->> 'employed_rostered')::integer,
        (v_slip -> 'days' ->> 'leave_deducted')::integer,
        v_slip -> 'trace',
        (v_slip -> 'trace' ->> 'trace_version')::integer
      )
      returning id into v_slip_id;
    exception
      when unique_violation then
        raise exception 'A worker has two payslips in the results.' using errcode = 'MLPR6';
      when check_violation or not_null_violation or invalid_text_representation
        or numeric_value_out_of_range or foreign_key_violation then
        raise exception 'A payslip breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
    end;
    v_slip_count := v_slip_count + 1;

    v_sum_earn := 0; v_sum_paye := 0; v_sum_pee := 0; v_sum_nhf := 0; v_sum_ded := 0;
    v_sum_per := 0; v_sum_nsitf := 0; v_sum_itf := 0;
    v_pos := 0;
    v_sources := '{}'::jsonb;
    for v_line in select e from jsonb_array_elements(v_slip -> 'lines') e loop
      v_pos := v_pos + 1;
      v_code := v_line ->> 'code';
      v_kind := v_line ->> 'kind';
      v_amount := private.payroll_kobo(
        v_line -> 'amount_kobo', v_code = 'leave_deduction', 'a line''s amount'
      );
      if jsonb_typeof(v_line -> 'pensionable') <> 'boolean'
        or jsonb_typeof(v_line -> 'taxable') <> 'boolean'
        or jsonb_typeof(v_line -> 'sources') <> 'array' then
        raise exception 'A payslip line isn''t in the expected shape.' using errcode = 'MLPR6';
      end if;
      begin
        insert into public.payslip_lines (
          organisation_id, payslip_id, run_id, position, code, kind, label, amount_kobo,
          pensionable, taxable
        )
        values (
          p_organisation_id, v_slip_id, p_run_id, v_pos, v_code, v_kind, v_line ->> 'label',
          v_amount, (v_line ->> 'pensionable')::boolean, (v_line ->> 'taxable')::boolean
        );
      exception
        when check_violation or not_null_violation then
          raise exception 'A payslip line breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
      end;
      case
        when v_kind = 'earning' then v_sum_earn := v_sum_earn + v_amount;
        when v_code = 'paye' then v_sum_paye := v_sum_paye + v_amount;
        when v_code = 'pension_employee' then v_sum_pee := v_sum_pee + v_amount;
        when v_code = 'nhf' then v_sum_nhf := v_sum_nhf + v_amount;
        when v_kind = 'deduction' then v_sum_ded := v_sum_ded + v_amount;
        when v_code = 'pension_employer' then v_sum_per := v_sum_per + v_amount;
        when v_code = 'nsitf' then v_sum_nsitf := v_sum_nsitf + v_amount;
        when v_code = 'itf' then v_sum_itf := v_sum_itf + v_amount;
      end case;

      for v_src in select e from jsonb_array_elements(v_line -> 'sources') e loop
        v_src_kind := v_src ->> 'kind';
        begin
          v_src_id := (v_src ->> 'id')::uuid;
          v_from := (v_src ->> 'from')::date;
          v_to := (v_src ->> 'to')::date;
        exception when others then
          raise exception 'A payslip source isn''t in the expected shape.' using errcode = 'MLPR6';
        end;
        if v_src_id is null or v_from is null or v_to is null or v_to < v_from then
          raise exception 'A payslip source isn''t in the expected shape.' using errcode = 'MLPR6';
        end if;
        if not (case v_src_kind
          when 'timesheet_line' then v_from = v_to and exists (
            select 1 from public.timesheet_lines l
            where l.organisation_id = p_organisation_id and l.id = v_src_id
              and l.worker_id = v_worker and l.status = 'approved' and l.work_date = v_from
          )
          when 'leave_request' then exists (
            select 1 from public.leave_requests q
            where q.organisation_id = p_organisation_id and q.id = v_src_id
              and q.worker_id = v_worker and q.status = 'approved'
              and q.start_date <= v_from and q.end_date >= v_to
          )
          when 'pay_rate' then exists (
            select 1 from public.pay_rates r
            where r.organisation_id = p_organisation_id and r.id = v_src_id
              and r.worker_id = v_worker
              and r.effective_from <= v_from and (r.effective_to is null or r.effective_to >= v_to)
          )
          when 'adjustment' then exists (
            select 1 from public.payroll_adjustments a
            where a.organisation_id = p_organisation_id and a.id = v_src_id
              and a.run_id = p_run_id and a.worker_id = v_worker
          ) and v_from = v_run.period_start and v_to = v_run.period_end
          else false
        end) then
          raise exception 'A payslip pays a source that isn''t this worker''s to pay (%).', v_src_kind
            using errcode = 'MLPR6';
        end if;
        if v_src_kind = 'adjustment' then
          select a.* into v_adj from public.payroll_adjustments a
          where a.organisation_id = p_organisation_id and a.id = v_src_id;
          if not (
            (v_code = 'adjustment_earning' and v_adj.kind = 'earning' and v_amount = v_adj.amount_kobo)
            or (v_code = 'deduction' and v_adj.kind = 'deduction' and v_amount <= v_adj.amount_kobo)
          ) then
            raise exception 'A payslip line doesn''t pay its adjustment''s amount.' using errcode = 'MLPR6';
          end if;
        end if;
        v_key := v_src_kind || ':' || v_src_id::text;
        if v_sources ? v_key then
          if (v_sources -> v_key ->> 'from')::date <> v_from
            or (v_sources -> v_key ->> 'to')::date <> v_to then
            raise exception 'A source appears with two different ranges on one payslip.'
              using errcode = 'MLPR6';
          end if;
          v_sources := jsonb_set(
            v_sources, array[v_key],
            (v_sources -> v_key)
              || jsonb_build_object(
                'positions', (v_sources -> v_key -> 'positions') || to_jsonb(v_pos),
                'off_day', (v_sources -> v_key ->> 'off_day')::boolean
                  or coalesce((v_src ->> 'off_day')::boolean, false)
              )
          );
        else
          v_sources := v_sources || jsonb_build_object(v_key, jsonb_build_object(
            'kind', v_src_kind, 'id', v_src_id, 'from', v_from, 'to', v_to,
            'off_day', coalesce((v_src ->> 'off_day')::boolean, false),
            'positions', jsonb_build_array(v_pos)
          ));
        end if;
      end loop;
    end loop;

    -- One row per source per payslip, naming every line it backs.
    for v_src in select e.value from jsonb_each(v_sources) e loop
      begin
        insert into public.payslip_sources (
          organisation_id, payslip_id, run_id, worker_id, source_kind, source_id, from_date,
          to_date, off_day, line_positions
        )
        values (
          p_organisation_id, v_slip_id, p_run_id, v_worker, v_src ->> 'kind',
          (v_src ->> 'id')::uuid, (v_src ->> 'from')::date, (v_src ->> 'to')::date,
          (v_src ->> 'off_day')::boolean,
          (select array_agg(x::integer order by x::integer)
           from jsonb_array_elements_text(v_src -> 'positions') x)
        );
      exception
        when exclusion_violation then
          raise exception 'A source in these results is already paid by another payslip.'
            using errcode = 'MLPRC';
        when check_violation then
          raise exception 'A payslip source breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
      end;
    end loop;

    if v_sum_earn <> v_gross or v_sum_paye <> v_paye or v_sum_pee <> v_pee or v_sum_nhf <> v_nhf
      or v_sum_ded <> v_other or v_sum_per <> v_per or v_sum_nsitf <> v_nsitf
      or v_sum_itf <> v_itf then
      raise exception 'A payslip''s lines don''t add up to its totals.' using errcode = 'MLPR6';
    end if;
  end loop;

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

  v_amounts := p_results -> 'totals';
  if private.payroll_kobo(v_amounts -> 'gross_kobo', false, 'total gross') <> v_totals.gross
    or private.payroll_kobo(v_amounts -> 'paye_kobo', false, 'total PAYE') <> v_totals.paye
    or private.payroll_kobo(v_amounts -> 'pension_employee_kobo', false, 'total employee pension') <> v_totals.pee
    or private.payroll_kobo(v_amounts -> 'pension_employer_kobo', false, 'total employer pension') <> v_totals.per
    or private.payroll_kobo(v_amounts -> 'nhf_kobo', false, 'total NHF') <> v_totals.nhf
    or private.payroll_kobo(v_amounts -> 'other_deductions_kobo', false, 'total other deductions') <> v_totals.other
    or private.payroll_kobo(v_amounts -> 'net_kobo', false, 'total net') <> v_totals.net
    or private.payroll_kobo(v_amounts -> 'nsitf_kobo', false, 'total NSITF') <> v_totals.nsitf
    or private.payroll_kobo(v_amounts -> 'itf_kobo', false, 'total ITF') <> v_totals.itf
    or private.payroll_kobo(v_amounts -> 'employer_cost_kobo', false, 'total employer cost') <> v_totals.cost
    or private.payroll_kobo(v_amounts -> 'carried_forward_kobo', false, 'total carried') <> v_totals.carried
    or (v_amounts ->> 'worker_count') is distinct from v_totals.n::text then
    raise exception 'The run''s totals don''t reconcile with its payslips.' using errcode = 'MLPR6';
  end if;

  for v_anomaly in select e from jsonb_array_elements(p_results -> 'anomalies') e loop
    v_detail := coalesce(v_anomaly -> 'detail', '{}'::jsonb);
    v_worker := null;
    if v_anomaly ? 'worker_id' and jsonb_typeof(v_anomaly -> 'worker_id') = 'string' then
      begin
        v_worker := (v_anomaly ->> 'worker_id')::uuid;
      exception when others then
        raise exception 'An anomaly names no worker.' using errcode = 'MLPR6';
      end;
    end if;
    v_ack_by := null;
    v_ack_at := null;
    v_severity := private.payroll_anomaly_severity(v_anomaly ->> 'code');
    if v_severity is null then
      raise exception 'An anomaly has a code payroll doesn''t know.' using errcode = 'MLPR6';
    end if;
    if v_severity = 'warning' then
      select (o ->> 'by')::uuid, (o ->> 'at')::timestamptz into v_ack_by, v_ack_at
      from jsonb_array_elements(v_old_acks) o
      where (o ->> 'worker_id') is not distinct from v_worker::text
        and o ->> 'code' = v_anomaly ->> 'code'
        and o -> 'detail' = v_detail
      limit 1;
    end if;
    begin
      insert into public.payroll_anomalies (
        organisation_id, run_id, worker_id, code, severity, detail, acknowledged_by,
        acknowledged_at
      )
      values (
        p_organisation_id, p_run_id, v_worker, v_anomaly ->> 'code', v_severity,
        v_detail, v_ack_by, v_ack_at
      );
    exception
      when check_violation or not_null_violation or foreign_key_violation then
        raise exception 'An anomaly breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
    end;
    v_anomaly_count := v_anomaly_count + 1;
  end loop;

  -- Every adjustment of the run is paid on its worker's payslip, unless the engine refused that
  -- worker (no payslip and a blocking anomaly naming them): the run can't be submitted then.
  if exists (
    select 1 from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
      and not exists (
        select 1 from public.payslip_sources s
        where s.organisation_id = p_organisation_id and s.run_id = p_run_id
          and s.source_kind = 'adjustment' and s.source_id = a.id and s.worker_id = a.worker_id
      )
      and not (
        not exists (
          select 1 from public.payslips p
          where p.organisation_id = p_organisation_id and p.run_id = p_run_id
            and p.worker_id = a.worker_id
        )
        and exists (
          select 1 from public.payroll_anomalies x
          where x.organisation_id = p_organisation_id and x.run_id = p_run_id
            and x.worker_id = a.worker_id and x.severity = 'blocking'
        )
      )
  ) then
    raise exception 'An adjustment of this run isn''t on its worker''s payslip.' using errcode = 'MLPR6';
  end if;

  update public.payroll_runs r
  set gross_kobo = v_totals.gross, paye_kobo = v_totals.paye,
      pension_employee_kobo = v_totals.pee, pension_employer_kobo = v_totals.per,
      nhf_kobo = v_totals.nhf, other_deductions_kobo = v_totals.other, net_kobo = v_totals.net,
      nsitf_kobo = v_totals.nsitf, itf_kobo = v_totals.itf, employer_cost_kobo = v_totals.cost,
      carried_forward_kobo = v_totals.carried, worker_count = v_totals.n,
      itf_applies = (p_results ->> 'itf_applies')::boolean,
      inputs_sha256 = p_inputs_sha256,
      needs_recalculation = false,
      calculated_at = now(),
      calculated_by = p_actor
  where r.id = p_run_id;

  v_text := 'payroll.results_saved';
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, p_actor, v_text, 'payroll_runs', p_run_id, v_before,
    jsonb_build_object(
      'gross_kobo', v_totals.gross::text, 'net_kobo', v_totals.net::text,
      'paye_kobo', v_totals.paye::text, 'employer_cost_kobo', v_totals.cost::text,
      'worker_count', v_totals.n, 'anomalies', v_anomaly_count,
      'inputs_sha256', p_inputs_sha256
    )
  );

  return jsonb_build_object(
    'payslips', v_slip_count,
    'anomalies', v_anomaly_count,
    'gross_kobo', v_totals.gross::text,
    'net_kobo', v_totals.net::text
  );
end;
$$;

revoke all on function private.save_payroll_results(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function private.save_payroll_results(uuid, uuid, uuid, jsonb, text) to service_role;

create function public.save_payroll_results(
  p_organisation_id uuid,
  p_run_id uuid,
  p_actor uuid,
  p_results jsonb,
  p_inputs_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.save_payroll_results(p_organisation_id, p_run_id, p_actor, p_results, p_inputs_sha256)
$$;

revoke all on function public.save_payroll_results(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.save_payroll_results(uuid, uuid, uuid, jsonb, text) to service_role;

-- Adds a one-off or recurring earning or deduction to a draft run (owner or hr), with a reason.
-- The run then needs recalculating. A deduction is never pensionable or taxable (after tax).
-- Returns the adjustment id.
create function private.add_payroll_adjustment(
  p_organisation_id uuid,
  p_run_id uuid,
  p_worker_id uuid,
  p_kind text,
  p_label text,
  p_amount_kobo text,
  p_pensionable boolean,
  p_taxable boolean,
  p_instalments integer,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_preparer(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_label text := private.tax_clean_text(p_label, 80);
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_id uuid := gen_random_uuid();
  v_amount bigint;
begin
  -- Whole kobo as a string of digits, so no JavaScript number ever carries the amount.
  if p_amount_kobo is null or p_amount_kobo !~ '^[0-9]{1,12}$' then
    raise exception 'The amount is whole kobo, above ₦0 and at most ₦1,000,000,000.' using errcode = '22023';
  end if;
  v_amount := p_amount_kobo::bigint;
  if p_kind is null or p_kind not in ('earning', 'deduction') then
    raise exception 'Choose an earning or a deduction.' using errcode = '22023';
  end if;
  if v_label is null then
    raise exception 'Name the item in up to 80 characters, with no web addresses.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  if v_amount <= 0 or v_amount > 100000000000 then
    raise exception 'The amount is above ₦0 and at most ₦1,000,000,000.' using errcode = '22023';
  end if;
  if p_instalments is null or p_instalments not between 1 and 60 then
    raise exception 'Instalments are 1 to 60.' using errcode = '22023';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Adjustments change only while the run is a draft.' using errcode = 'MLPRD';
  end if;
  if p_worker_id is null or not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  ) then
    raise exception 'That worker wasn''t found.' using errcode = 'P0002';
  end if;
  -- Only a worker the run pays: employed on some day of the period.
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
      and w.start_date <= v_run.period_end
      and (w.end_date is null or w.end_date >= v_run.period_start)
  ) then
    raise exception 'That worker isn''t employed in this pay period.' using errcode = '22023';
  end if;

  insert into public.payroll_adjustments (
    id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
    series_id, instalment_number, instalment_count, reason, created_by
  )
  values (
    v_id, p_organisation_id, p_run_id, p_worker_id, p_kind, v_label, v_amount,
    p_kind = 'earning' and coalesce(p_pensionable, false),
    p_kind = 'earning' and coalesce(p_taxable, true),
    v_id, 1, p_instalments, v_reason, v_uid
  );
  update public.payroll_runs r set needs_recalculation = true where r.id = p_run_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.adjustment_added', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'adjustment_id', v_id, 'worker_id', p_worker_id, 'kind', p_kind, 'label', v_label,
      'amount_kobo', v_amount::text, 'instalments', p_instalments
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text
) from public, anon;
grant execute on function private.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text
) to authenticated;

create function public.add_payroll_adjustment(
  p_organisation_id uuid,
  p_run_id uuid,
  p_worker_id uuid,
  p_kind text,
  p_label text,
  p_amount_kobo text,
  p_pensionable boolean,
  p_taxable boolean,
  p_instalments integer,
  p_reason text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_payroll_adjustment(
    p_organisation_id, p_run_id, p_worker_id, p_kind, p_label, p_amount_kobo, p_pensionable,
    p_taxable, p_instalments, p_reason
  )
$$;

revoke all on function public.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text
) from public, anon;
grant execute on function public.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text
) to authenticated;

-- Removes an adjustment from a draft run (owner or hr), with a reason. The run then needs
-- recalculating.
create function private.remove_payroll_adjustment(
  p_organisation_id uuid,
  p_adjustment_id uuid,
  p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_preparer(p_organisation_id);
  v_row public.payroll_adjustments%rowtype;
  v_run public.payroll_runs%rowtype;
  v_reason text := private.tax_clean_text(p_reason, 500);
begin
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  select a.* into v_row from public.payroll_adjustments a
  where a.organisation_id = p_organisation_id and a.id = p_adjustment_id;
  if v_row.id is null then
    raise exception 'That adjustment wasn''t found.' using errcode = 'P0002';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, v_row.run_id);
  if v_run.status <> 'draft' then
    raise exception 'Adjustments change only while the run is a draft.' using errcode = 'MLPRD';
  end if;
  delete from public.payroll_adjustments a where a.id = v_row.id;
  update public.payroll_runs r set needs_recalculation = true where r.id = v_row.run_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.adjustment_removed', 'payroll_runs', v_row.run_id,
    jsonb_build_object(
      'adjustment_id', v_row.id, 'worker_id', v_row.worker_id, 'kind', v_row.kind,
      'label', v_row.label, 'amount_kobo', v_row.amount_kobo::text
    ),
    null,
    v_reason
  );
end;
$$;

revoke all on function private.remove_payroll_adjustment(uuid, uuid, text) from public, anon;
grant execute on function private.remove_payroll_adjustment(uuid, uuid, text) to authenticated;

create function public.remove_payroll_adjustment(
  p_organisation_id uuid,
  p_adjustment_id uuid,
  p_reason text
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.remove_payroll_adjustment(p_organisation_id, p_adjustment_id, p_reason)
$$;

revoke all on function public.remove_payroll_adjustment(uuid, uuid, text) from public, anon;
grant execute on function public.remove_payroll_adjustment(uuid, uuid, text) to authenticated;

-- Acknowledges warnings on a draft run (owner or hr): "pay next run" for open timesheet days,
-- "checked" for the rest. A blocking anomaly is fixed, never acknowledged (MLPRB). Returns how
-- many were newly acknowledged.
create function private.acknowledge_payroll_anomalies(
  p_organisation_id uuid,
  p_run_id uuid,
  p_anomaly_ids uuid[]
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_preparer(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_count integer;
begin
  if p_anomaly_ids is null or cardinality(p_anomaly_ids) = 0 or cardinality(p_anomaly_ids) > 5000 then
    raise exception 'Choose 1 to 5000 anomalies.' using errcode = '22023';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Anomalies are acknowledged while the run is a draft.' using errcode = 'MLPRD';
  end if;
  if (
    select count(*) from public.payroll_anomalies a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
      and a.id = any (p_anomaly_ids)
  ) <> cardinality(array(select distinct unnest(p_anomaly_ids))) then
    raise exception 'Some of those anomalies aren''t on this run. Reload the page.' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.payroll_anomalies a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
      and a.id = any (p_anomaly_ids) and a.severity = 'blocking'
  ) then
    raise exception 'A blocking anomaly is fixed, not acknowledged.' using errcode = 'MLPRB';
  end if;
  update public.payroll_anomalies a
  set acknowledged_by = v_uid, acknowledged_at = now()
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id
    and a.id = any (p_anomaly_ids) and a.acknowledged_at is null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform private.log_audit_impl(
      p_organisation_id, 'payroll.anomalies_acknowledged', 'payroll_runs', p_run_id, null,
      jsonb_build_object('count', v_count, 'anomaly_ids', to_jsonb(p_anomaly_ids)), null
    );
  end if;
  return v_count;
end;
$$;

revoke all on function private.acknowledge_payroll_anomalies(uuid, uuid, uuid[]) from public, anon;
grant execute on function private.acknowledge_payroll_anomalies(uuid, uuid, uuid[]) to authenticated;

create function public.acknowledge_payroll_anomalies(
  p_organisation_id uuid,
  p_run_id uuid,
  p_anomaly_ids uuid[]
)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.acknowledge_payroll_anomalies(p_organisation_id, p_run_id, p_anomaly_ids)
$$;

revoke all on function public.acknowledge_payroll_anomalies(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.acknowledge_payroll_anomalies(uuid, uuid, uuid[]) to authenticated;

-- Submits a draft run for approval (owner or hr). Refused (MLPRD) while it needs recalculating or
-- has no payslips, and (MLPR4) while any anomaly is blocking or any warning isn't acknowledged.
-- Records the decision and returns its id (the server emails Finance and the other owners).
create function private.submit_payroll_run(p_organisation_id uuid, p_run_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_preparer(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_blocking integer;
  v_open integer;
  v_id uuid;
begin
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Only a draft run is submitted.' using errcode = 'MLPRD';
  end if;
  if v_run.needs_recalculation or v_run.calculated_at is null then
    raise exception 'Recalculate the run before submitting it.' using errcode = 'MLPRD';
  end if;
  if v_run.worker_count = 0 then
    raise exception 'The run has no payslips.' using errcode = 'MLPRD';
  end if;
  select count(*) filter (where a.severity = 'blocking'),
         count(*) filter (where a.severity = 'warning' and a.acknowledged_at is null)
  into v_blocking, v_open
  from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;
  if v_blocking > 0 then
    raise exception '% blocking % must be fixed before submitting.', v_blocking,
      (case when v_blocking = 1 then 'anomaly' else 'anomalies' end)
      using errcode = 'MLPR4';
  end if;
  if v_open > 0 then
    raise exception 'Acknowledge % more % before submitting.', v_open,
      (case when v_open = 1 then 'anomaly' else 'anomalies' end)
      using errcode = 'MLPR4';
  end if;

  update public.payroll_runs r
  set status = 'review', submitted_at = now(), submitted_by = v_uid
  where r.id = p_run_id;
  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, actor_id, inputs_sha256, gross_kobo, net_kobo, worker_count
  )
  values (
    p_organisation_id, p_run_id, 'submitted', v_uid, v_run.inputs_sha256, v_run.gross_kobo,
    v_run.net_kobo, v_run.worker_count
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_submitted', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'decision_id', v_id, 'gross_kobo', v_run.gross_kobo::text, 'net_kobo', v_run.net_kobo::text,
      'worker_count', v_run.worker_count
    ),
    null
  );
  return v_id;
end;
$$;

revoke all on function private.submit_payroll_run(uuid, uuid) from public, anon;
grant execute on function private.submit_payroll_run(uuid, uuid) to authenticated;

create function public.submit_payroll_run(p_organisation_id uuid, p_run_id uuid)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.submit_payroll_run(p_organisation_id, p_run_id)
$$;

revoke all on function public.submit_payroll_run(uuid, uuid) from public, anon;
grant execute on function public.submit_payroll_run(uuid, uuid) to authenticated;

-- Returns a submitted run to draft (owner or finance), with a reason. Returns the decision id.
create function private.return_payroll_run(p_organisation_id uuid, p_run_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_approver(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_id uuid;
begin
  if v_reason is null then
    raise exception 'Say why, in up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'review' then
    raise exception 'Only a run waiting for approval is returned.' using errcode = 'MLPRD';
  end if;
  update public.payroll_runs r
  set status = 'draft', submitted_at = null, submitted_by = null
  where r.id = p_run_id;
  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, reason, actor_id, inputs_sha256, gross_kobo, net_kobo,
    worker_count
  )
  values (
    p_organisation_id, p_run_id, 'returned', v_reason, v_uid, v_run.inputs_sha256,
    v_run.gross_kobo, v_run.net_kobo, v_run.worker_count
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_returned', 'payroll_runs', p_run_id, null,
    jsonb_build_object('decision_id', v_id), v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.return_payroll_run(uuid, uuid, text) from public, anon;
grant execute on function private.return_payroll_run(uuid, uuid, text) to authenticated;

create function public.return_payroll_run(p_organisation_id uuid, p_run_id uuid, p_reason text)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.return_payroll_run(p_organisation_id, p_run_id, p_reason)
$$;

revoke all on function public.return_payroll_run(uuid, uuid, text) from public, anon;
grant execute on function public.return_payroll_run(uuid, uuid, text) to authenticated;
