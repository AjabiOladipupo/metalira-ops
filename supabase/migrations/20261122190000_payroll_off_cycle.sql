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
--   MLOC9 a line a correction or one-off run doesn't allow, or an earning line with no source
--   MLOCA the period's regular run is waiting for approval with an item for a worker on this run
-- Reused: MLPRD (state), MLTA5 (a paid timesheet day or leave), 42501, 22023, P0002.
--
-- Review fixes (security review of PR #81): free text on the run and on adjustments refuses
-- personal numbers (private.has_personal_number, mirrored by src/lib/personal-number.ts); a
-- correction or one-off run's lines are adjustment, statutory and employer lines only, and every
-- earning line of any run names a source (checked at commit); approved leave a posted payslip pays
-- never changes (MLTA5); the creation takes the company's lock first and reads workers FOR SHARE;
-- a discard's audit keeps the deleted adjustments; a worker on an off-cycle run not yet approved is
-- a visible warning on the regular run (`on_off_cycle_run`).
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

-- True when free text holds a personal number (rule 9: NIN, BVN, account numbers, RSA PIN): 10 or
-- more digits in a row once spaces and dashes are ignored, or PEN followed by 12 digits. Used by
-- column checks beside tax_clean_text; src/lib/personal-number.ts applies the same rule in Zod.
create function private.has_personal_number(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    regexp_replace(p_text, '[[:space:]-]', '', 'g') ~ '[0-9]{10}'
    or regexp_replace(p_text, '[[:space:]-]', '', 'g') ~* 'PEN[0-9]{12}',
    false
  )
$$;

revoke all on function private.has_personal_number(text) from public, anon;
-- The column checks call it as whoever inserts.
grant execute on function private.has_personal_number(text) to authenticated, service_role;

-- Adjustment labels and reasons (slice 5.2's columns) refuse personal numbers too. NOT VALID:
-- rows written before this check aren't rescanned; every new row is checked.
alter table public.payroll_adjustments
  add constraint payroll_adjustments_label_no_personal_number
    check (not private.has_personal_number(label)) not valid,
  add constraint payroll_adjustments_reason_no_personal_number
    check (not private.has_personal_number(reason)) not valid;

alter table public.payroll_runs
  add column off_cycle_reason text
    constraint payroll_runs_off_cycle_reason_value check (
      off_cycle_reason in ('final_pay', 'missed_worker', 'correction', 'one_off')
    ),
  add column off_cycle_note text
    constraint payroll_runs_off_cycle_note_text check (
      off_cycle_note = btrim(off_cycle_note) and char_length(off_cycle_note) between 1 and 500
      and off_cycle_note !~ '[\x01-\x1f\x7f-\x9f<>]' and off_cycle_note !~* '(://|www\.)'
      and not private.has_personal_number(off_cycle_note)
    ),
  add column discarded_at timestamptz,
  add column discarded_by uuid,
  add column discard_reason text
    constraint payroll_runs_discard_reason_text check (
      discard_reason = btrim(discard_reason) and char_length(discard_reason) between 1 and 500
      and discard_reason !~ '[\x01-\x1f\x7f-\x9f<>]' and discard_reason !~* '(://|www\.)'
      and not private.has_personal_number(discard_reason)
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
  -- One-off items only, except that a final pay continues a recurring series already started in
  -- an earlier run (money review M1: a leaver's last instalment), keeping its series.
  if new.instalment_count <> 1 and not (
    v_run.off_cycle_reason = 'final_pay'
    and new.instalment_number > 1
    and exists (
      select 1 from public.payroll_adjustments a
      where a.organisation_id = new.organisation_id and a.series_id = new.series_id
        and a.instalment_number < new.instalment_number
    )
  ) then
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
  -- A one-off run pays its adjustments only. A correction run may also pay timesheet days and
  -- leave that no standing payslip has paid (money review M2; the exclusion constraint still
  -- refuses one already paid), but never a pay version's days (salary).
  if v_run.id is not null and (
    (v_run.off_cycle_reason = 'one_off' and new.source_kind <> 'adjustment')
    or (v_run.off_cycle_reason = 'correction'
        and new.source_kind not in ('adjustment', 'timesheet_line', 'leave_request'))
  ) then
    raise exception 'A correction pays one-off items and unpaid days only; a one-off run pays its items only.'
      using errcode = 'MLOC6';
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
  v_moved jsonb;
  v_regular text;
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
  if private.has_personal_number(v_note) then
    raise exception 'Leave personal numbers out of the reason (10 or more digits, or an RSA PIN).'
      using errcode = '22023';
  end if;
  -- One creation at a time per company (as create_payroll_run), taken before anything is read, so
  -- two full-pay runs for the same worker can't both pass the checks below.
  perform pg_advisory_xact_lock(hashtextextended('payroll_runs:' || p_organisation_id::text, 0));
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
  -- A correction or one-off payment for a former worker may be paid any time after the period
  -- (money review L3); the other runs pay in the period or up to 45 days after it.
  if v_pay is null or v_pay < v_start
    or (v_pay > v_end + 45 and p_reason not in ('correction', 'one_off')) then
    raise exception 'The pay date falls in the period or up to 45 days after it (any later date for a correction or one-off payment).'
      using errcode = '22023';
  end if;

  -- The workers' start and end dates hold until the run is created.
  perform 1 from public.workers w
  where w.organisation_id = p_organisation_id and w.id = any (v_workers)
  order by w.id
  for share;
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

  if v_full and exists (
    select 1
    from public.payroll_adjustments a
    join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
    where a.organisation_id = p_organisation_id and a.worker_id = any (v_workers)
      and r.kind = 'regular' and r.period_start = v_start and r.status = 'review'
  ) then
    raise exception 'The regular run for this period is waiting for approval with an item for a worker on this run. Ask Finance to return it first.'
      using errcode = 'MLOCA';
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

  -- Money review M1: a full-pay run takes over its workers' items from the period's regular draft
  -- (one-off items, and a recurring series' next instalment, which keeps its series), so they
  -- don't block the regular run that now leaves these workers out. A series started in the
  -- regular draft itself (instalment 1 of several) stays there and shows as blocking, for HR.
  if v_full then
    select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at, a.id), '[]'::jsonb), max(r.id::text)
    into v_moved, v_regular
    from public.payroll_adjustments a
    join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
    where a.organisation_id = p_organisation_id and a.worker_id = any (v_workers)
      and r.kind = 'regular' and r.period_start = v_start and r.status = 'draft'
      and (a.instalment_count = 1 or (p_reason = 'final_pay' and a.instalment_number > 1));
    if jsonb_array_length(v_moved) > 0 then
      delete from public.payroll_adjustments a
      where a.organisation_id = p_organisation_id
        and a.id in (select (e ->> 'id')::uuid from jsonb_array_elements(v_moved) e);
      insert into public.payroll_adjustments (
        id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
        series_id, instalment_number, instalment_count, reason, created_by
      )
      select (e ->> 'id')::uuid, p_organisation_id, v_id, (e ->> 'worker_id')::uuid, e ->> 'kind',
        e ->> 'label', (e ->> 'amount_kobo')::bigint, (e ->> 'pensionable')::boolean,
        (e ->> 'taxable')::boolean, (e ->> 'series_id')::uuid,
        (e ->> 'instalment_number')::integer, (e ->> 'instalment_count')::integer, e ->> 'reason',
        (e ->> 'created_by')::uuid
      from jsonb_array_elements(v_moved) e;
      update public.payroll_runs r set needs_recalculation = true
      where r.organisation_id = p_organisation_id and r.id = v_regular::uuid;
      perform private.log_audit_impl(
        p_organisation_id, 'payroll.adjustments_moved', 'payroll_runs', v_id, null,
        jsonb_build_object(
          'from_run_id', v_regular,
          'adjustments', (
            select jsonb_agg(jsonb_build_object(
              'id', e ->> 'id', 'worker_id', e ->> 'worker_id', 'amount_kobo', e ->> 'amount_kobo'
            )) from jsonb_array_elements(v_moved) e
          )
        ),
        null
      );
    end if;
  end if;

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
  v_deleted jsonb;
begin
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  if private.has_personal_number(v_reason) then
    raise exception 'Leave personal numbers out of the reason (10 or more digits, or an RSA PIN).'
      using errcode = '22023';
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

  -- What the audit keeps of the adjustments that go: ids, workers and amounts.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'worker_id', a.worker_id, 'kind', a.kind, 'amount_kobo', a.amount_kobo::text
  ) order by a.created_at, a.id), '[]'::jsonb) into v_deleted
  from public.payroll_adjustments a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;

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
      'payslips', v_slips, 'adjustments', v_adjustments, 'deleted_adjustments', v_deleted,
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

-- ---------------------------------------------------------------------------
-- 6. Review fixes: lines, leave, the regular run's warning
-- ---------------------------------------------------------------------------

-- BEFORE INSERT on payslip_lines (security review M2): a one-off run carries only its adjustments
-- and what they owe: adjustment earnings, deductions, and the statutory and employer lines. A
-- correction may also carry lines for unpaid timesheet days and leave. Neither carries salary
-- components or a carried deduction.
create function private.payslip_lines_off_cycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype := private.payroll_off_cycle_run(new.organisation_id, new.run_id);
begin
  if v_run.id is not null and (
    (v_run.off_cycle_reason = 'one_off' and new.code not in (
      'adjustment_earning', 'deduction', 'paye', 'pension_employee', 'nhf', 'pension_employer',
      'nsitf', 'itf'
    ))
    -- A correction may also pay unpaid timesheet days and leave (money review M2), never salary
    -- components or a carried deduction.
    or (v_run.off_cycle_reason = 'correction' and new.code not in (
      'adjustment_earning', 'deduction', 'paye', 'pension_employee', 'nhf', 'pension_employer',
      'nsitf', 'itf', 'daily_pay', 'hourly_pay', 'overtime', 'off_day', 'public_holiday',
      'arrears', 'leave_deduction'
    ))
  ) then
    raise exception 'A correction pays one-off items and unpaid days only; a one-off run pays its items only.'
      using errcode = 'MLOC9';
  end if;
  return new;
end;
$$;

revoke all on function private.payslip_lines_off_cycle_guard() from public, anon, authenticated;

create trigger payslip_lines_off_cycle before insert on public.payslip_lines
  for each row execute function private.payslip_lines_off_cycle_guard();
alter table public.payslip_lines enable always trigger payslip_lines_off_cycle;

-- At commit, on every run (security review M2): an earning line names at least one source (the
-- pay version, timesheet day, leave or adjustment it pays), so nothing is paid that decision 10
-- can't hold to once. save_payroll_results writes lines before their sources, so the check is a
-- deferred constraint trigger rather than a change to that function.
create function private.payslip_lines_need_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'earning'
    and exists (
      select 1 from public.payslip_lines l
      where l.organisation_id = new.organisation_id and l.id = new.id
    )
    and not exists (
      select 1 from public.payslip_sources s
      where s.organisation_id = new.organisation_id and s.payslip_id = new.payslip_id
        and new.position = any (s.line_positions)
    ) then
    raise exception 'An earning line on a payslip names no source.' using errcode = 'MLOC9';
  end if;
  return null;
end;
$$;

revoke all on function private.payslip_lines_need_source() from public, anon, authenticated;

create constraint trigger payslip_lines_need_source after insert on public.payslip_lines
  deferrable initially deferred
  for each row execute function private.payslip_lines_need_source();
alter table public.payslip_lines enable always trigger payslip_lines_need_source;

-- BEFORE UPDATE OR DELETE on leave_requests (security review M3): approved leave that a posted
-- payslip of any run pays (a standing leave_request source of an approved or released run) keeps
-- its status, dates, type and worker, as 5.3's lock does for regular periods. 5.7c replaces the
-- leave lock with arrears and refunds.
create function private.leave_requests_freeze_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'approved'
    and (
      tg_op = 'DELETE'
      or (new.status, new.start_date, new.end_date, new.leave_type_id, new.worker_id)
        is distinct from (old.status, old.start_date, old.end_date, old.leave_type_id, old.worker_id)
    )
    and exists (
      select 1
      from public.payslip_sources s
      join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
      where s.organisation_id = old.organisation_id
        and s.source_kind = 'leave_request' and s.source_id = old.id
        and s.stands
        and r.status in ('approved', 'released')
    ) then
    raise exception 'Part of this leave is in a posted pay period. Ask payroll to correct it in the next run.'
      using errcode = 'MLTA5';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.leave_requests_freeze_paid() from public, anon, authenticated;

create trigger leave_requests_freeze_paid before update or delete on public.leave_requests
  for each row execute function private.leave_requests_freeze_paid();
alter table public.leave_requests enable always trigger leave_requests_freeze_paid;

-- The anomaly codes (5.2's list, mirrored by ANOMALY_SEVERITY in src/lib/payroll/run.ts) gain
-- `on_off_cycle_run` (money review L4): a worker the regular run leaves out because a final-pay or
-- missed-worker run of the period pays them, while that run isn't approved yet. A warning, so HR
-- acknowledges it knowingly.
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
      'no_pension_details', 'recurring_not_carried', 'on_off_cycle_run'
    ) then 'warning'
  end
$$;

revoke all on function private.payroll_anomaly_severity(text) from public, anon, authenticated;

-- Money review L3: a correction or one-off payment may be paid any time after its period (a
-- former worker); the other runs keep 5.2's window (the period to 45 days after it).
alter table public.payroll_runs drop constraint payroll_runs_dates;
alter table public.payroll_runs
  add constraint payroll_runs_dates check (
    period_end >= period_start and pay_date >= period_start
    and (pay_date <= period_end + 45 or off_cycle_reason in ('correction', 'one_off'))
  );

-- BEFORE INSERT on payroll_adjustments, after the draft guard (money review M1): an item added to
-- a regular draft for a worker a final-pay or missed-worker draft of the same period pays goes to
-- that off-cycle draft instead (create_payroll_run's carried instalments included), which is
-- marked for recalculation. When that off-cycle run is already posted, a carried instalment of a
-- recurring series isn't added (the leaver's period is paid; it would only block the regular run)
-- and the audit log says so; anything else stays and shows as blocking on the regular run.
create function private.payroll_adjustments_to_off_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.payroll_runs%rowtype;
  v_regular public.payroll_runs%rowtype;
begin
  select r.* into v_regular from public.payroll_runs r
  where r.organisation_id = new.organisation_id and r.id = new.run_id and r.kind = 'regular';
  if v_regular.id is null then
    return new;
  end if;
  select r.* into v_target
  from public.payroll_run_workers x
  join public.payroll_runs r on r.organisation_id = x.organisation_id and r.id = x.run_id
  where x.organisation_id = new.organisation_id and x.worker_id = new.worker_id
    and r.kind = 'off_cycle' and r.off_cycle_reason in ('final_pay', 'missed_worker')
    and r.period_start = v_regular.period_start and r.discarded_at is null
    and r.status <> 'reversed'
  order by r.created_at desc
  limit 1;
  if v_target.id is null then
    return new;
  end if;
  if v_target.status = 'draft'
    and (new.instalment_count = 1
      or (v_target.off_cycle_reason = 'final_pay' and new.instalment_number > 1)) then
    new.run_id := v_target.id;
    update public.payroll_runs r set needs_recalculation = true
    where r.organisation_id = v_target.organisation_id and r.id = v_target.id;
    -- Written directly (as save_payroll_results does): the insert may come from the secret key.
    insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
    values (
      new.organisation_id, coalesce(auth.uid(), new.created_by), 'payroll.adjustments_moved',
      'payroll_runs', v_target.id,
      jsonb_build_object(
        'from_run_id', v_regular.id,
        'adjustments', jsonb_build_array(jsonb_build_object(
          'id', new.id, 'worker_id', new.worker_id, 'amount_kobo', new.amount_kobo::text
        ))
      )
    );
    return new;
  end if;
  if v_target.status in ('approved', 'released') and new.instalment_number > 1 then
    insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
    values (
      new.organisation_id, coalesce(auth.uid(), new.created_by), 'payroll.instalment_not_carried',
      'payroll_runs', v_regular.id,
      jsonb_build_object(
        'series_id', new.series_id, 'worker_id', new.worker_id,
        'instalment', new.instalment_number, 'of', new.instalment_count,
        'amount_kobo', new.amount_kobo::text, 'paid_by_run_id', v_target.id
      )
    );
    return null;
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_adjustments_to_off_cycle() from public, anon, authenticated;

-- Named to fire after payroll_adjustments_guard (the regular draft's own check) and before
-- payroll_adjustments_off_cycle (which then checks the off-cycle run it lands on).
create trigger payroll_adjustments_moved_to_off_cycle before insert on public.payroll_adjustments
  for each row execute function private.payroll_adjustments_to_off_cycle();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_moved_to_off_cycle;
