-- Slice 5.7a: payroll reversal and corrections (docs/PHASE_5.md 5.7; CLAUDE.md rules 1, 4, 5, 9
-- and 10). The reversal model 5.7b (off-cycle runs) and 5.7c (arrears, refunds, offsets) build on.
--
-- 1. payroll_runs (the shared 5.7 contract, identical in 5.7a, 5.7b and 5.7c):
--    * the kind check is kind in ('regular', 'off_cycle', 'reversal') and the status check gains
--      'reversed' (drop if exists, then add, under the existing names);
--    * reverses_run_id uuid null references payroll_runs (id): set only on a reversal run.
--    Here also: approved_at stays set on a reversed run (payroll_runs_approved_state), one live
--    regular run per period means one that isn't reversed (payroll_runs_one_regular), and one
--    reversal waiting or approved per run (payroll_runs_one_reversal).
-- 2. The sign convention. Payslip, line and run amounts are checked non-negative (5.2's
--    *_nonneg checks), so a reversal's copies keep the original's amounts as written and carry an
--    explicit sign: payslips.sign and payslip_lines.sign are 1, or -1 on a reversal run's copies
--    (payslips.reverses_payslip_id names the payslip copied). A reversal run's totals are the
--    original's; the run's kind says they count negatively. Signed value = sign x amount, so the
--    copies sum to minus the original to the kobo. A copy's pay_rate_ids are empty, so a pay rate
--    the reversed run used can be corrected again (5.3's MLPRG counts posted payslips).
-- 3. reverse_payroll_run(org, run, reason, not_uploaded): owner or finance, trusted session. Only
--    an approved run, never a released one (the money has gone: correct it in a later run). Makes
--    the reversal run (kind reversal, reverses_run_id) with a copy of every payslip and line, sign
--    -1, its totals and inputs hash the original's, prepared and submitted by the requester, now
--    waiting for a second person. A bank file someone downloaded needs the requester's statement
--    that it wasn't uploaded (MLRV5). While it waits, the original can't be released (MLRV9).
-- 4. approve_payroll_reversal(org, reversal, not_uploaded): owner or finance, trusted session,
--    never anyone in private.payroll_run_touchers of the reversal run (MLRV4). In one
--    transaction: the copies are checked against the original (MLRV7), the original's active bank
--    file is voided ("Run reversed", 5.4's void), the original becomes 'reversed', its payslip
--    sources stop standing (so its timesheet days, leave and adjustments are payable again), its
--    statutory remittances are voided (private.void_run_remittances), and the reversal is
--    approved. timesheet_period_posted, leave_in_posted_period and the pay-rate floor count only
--    approved and released runs, so the period reopens. A reversal is declined with 5.2's
--    return_payroll_run (back to draft, with a reason); a declined reversal is never submitted
--    again: request a new one.
-- 5. Function-owned paths without a bypass. No guard reads a session setting; each allows a move
--    only when the database's own state shows the reversal:
--    * payroll_runs: approved -> reversed only while a reversal of it is waiting and no bank file
--      of it is active, changing nothing else; a reversal run's review -> approved only once its
--      original is reversed; a reversed run never changes.
--    * payslip_sources: the one update is stands true -> false on a reversed run's payslip.
--    * statutory_remittance_voids (new, insert-only): a void row per remittance, only for a
--      reversed run. A remittance with a standing payment is voided too; the payment stays as
--      evidence (5.7c refunds or offsets it).
--    * payout_batches: a reversal run never gets a bank file; statutory_remittances: never for a
--      reversal run (the remittances trigger skips it).
-- 6. Corrections after release: payroll_adjustments.corrects_payslip_id names a released payslip
--    of the same worker and company that a later run's adjustment corrects (MLRV8);
--    add_payroll_correction(org, run, payslip, kind, label, amount, pensionable, reason) adds one
--    to a draft run (owner or hr).
-- 7. RSA PIN snapshot (5.6 follow-up, security review L4): payslips.rsa_pin_enc is the worker's
--    encrypted RSA PIN as it was when the results were saved (the worker row's ciphertext, still
--    under its workers.rsa_pin_enc context), set by a trigger on insert, never from the caller;
--    rsa_pin_snapshot says the payslip has one (payslips saved before this slice don't). 5.6's
--    pension schedule reads the snapshot first.
-- 8. create_payroll_run (5.2's, unchanged but this) lets a new regular run start for a period
--    whose run was reversed, and carries a recurring instalment that only a reversed run paid.
-- 9. Review fixes (section 10): the schedule check, payout_file_download FOR SHARE, no payment
--    entry on a voided remittance, the correction check on update, and series instalments unique
--    only among runs that aren't reversed (carry_payroll_instalment ignores reversed runs).
--
-- Refusals (SQLSTATE), new here:
--   MLRV1 a released run can't be reversed (the money has gone)
--   MLRV2 only an approved run is reversed (not a draft, a run in review, a reversal or a run
--         already reversed)
--   MLRV3 a reversal of this run is already waiting or approved
--   MLRV4 the approver requested the reversal (two-person rule)
--   MLRV5 the bank file was downloaded: confirm it wasn't uploaded to the bank
--   MLRV6 the reversal isn't in a state that allows this (not waiting, declined, original not
--         reversed)
--   MLRV7 the reversal's copies don't match the original, or a reversal's rows can't change
--   MLRV8 a correction must name a released payslip of the same worker
--   MLRV9 the run has a reversal waiting: decide it before releasing
--   MLRVA remittance voids are kept as written, and only a reversed run's remittances are voided
--   MLRVB a voided remittance has no schedule and takes no payment entry (security review M1, L2)
--   MLRVC a payslip corrected twice in one run, or again elsewhere without confirming (money M4a)
-- Reused: MLPRD (state), 42501, 22023, P0002.
-- No money maths beyond copies, equality checks and sums.

-- ---------------------------------------------------------------------------
-- 1. payroll_runs: the shared 5.7 contract, then this slice's columns and indexes
-- ---------------------------------------------------------------------------

alter table public.payroll_runs drop constraint if exists payroll_runs_kind_value;
alter table public.payroll_runs
  add constraint payroll_runs_kind_value check (kind in ('regular', 'off_cycle', 'reversal'));
alter table public.payroll_runs drop constraint if exists payroll_runs_status_value;
alter table public.payroll_runs
  add constraint payroll_runs_status_value
  check (status in ('draft', 'review', 'approved', 'released', 'reversed'));

alter table public.payroll_runs
  add column if not exists reverses_run_id uuid references public.payroll_runs (id);

alter table public.payroll_runs
  add constraint payroll_runs_reverses_fkey foreign key (organisation_id, reverses_run_id)
    references public.payroll_runs (organisation_id, id),
  add constraint payroll_runs_reverses_kind check ((kind = 'reversal') = (reverses_run_id is not null)),
  add constraint payroll_runs_reverses_other check (reverses_run_id is distinct from id);

comment on column public.payroll_runs.reverses_run_id is
  'The run a reversal run reverses (slice 5.7a). Set only on kind = reversal; its payslips are copies with sign -1.';

-- 5.3's check, with reversed: a reversed run was approved, and keeps who approved it.
alter table public.payroll_runs drop constraint payroll_runs_approved_state;
alter table public.payroll_runs
  add constraint payroll_runs_approved_state check (
    case
      when status in ('approved', 'released', 'reversed') then approved_at is not null
      else approved_at is null
    end
  );

-- One live regular run per period: a reversed run's period may be run again.
drop index public.payroll_runs_one_regular;
create unique index payroll_runs_one_regular on public.payroll_runs (organisation_id, period_start)
  where kind = 'regular' and status <> 'reversed';

-- One reversal waiting or approved per run (a declined one, back in draft, doesn't count).
create unique index payroll_runs_one_reversal on public.payroll_runs (organisation_id, reverses_run_id)
  where kind = 'reversal' and status in ('review', 'approved');

alter table public.payroll_run_decisions drop constraint payroll_run_decisions_value;
alter table public.payroll_run_decisions
  add constraint payroll_run_decisions_value check (
    decision in ('submitted', 'returned', 'approved', 'released', 'reversed')
  );

-- ---------------------------------------------------------------------------
-- 2. Payslips and lines: the sign, the copy, the RSA PIN snapshot
-- ---------------------------------------------------------------------------

alter table public.payslips
  add column sign smallint not null default 1
    constraint payslips_sign_value check (sign in (1, -1)),
  add column reverses_payslip_id uuid,
  -- The worker's encrypted RSA PIN when the results were saved: workers.rsa_pin_enc's ciphertext,
  -- decrypted under that column's context (organisation, workers, rsa_pin_enc, worker id).
  add column rsa_pin_enc bytea,
  add column rsa_pin_snapshot boolean not null default false,
  add constraint payslips_reverses_fkey foreign key (organisation_id, reverses_payslip_id)
    references public.payslips (organisation_id, id),
  add constraint payslips_sign_reverses check ((sign = -1) = (reverses_payslip_id is not null)),
  add constraint payslips_rsa_pin_snapshot check (rsa_pin_snapshot or rsa_pin_enc is null);

create unique index payslips_reverses_key on public.payslips (run_id, reverses_payslip_id)
  where reverses_payslip_id is not null;

comment on column public.payslips.sign is
  'Slice 5.7a: 1, or -1 on a reversal run''s copy. Amounts stay as written (non-negative); the signed value is sign x amount.';
comment on column public.payslips.rsa_pin_enc is
  'Slice 5.7a (security review L4): the worker''s encrypted RSA PIN as saved with the results; the ciphertext of workers.rsa_pin_enc, under that column''s context. Read by the pension schedule.';

alter table public.payslip_lines
  add column sign smallint not null default 1
    constraint payslip_lines_sign_value check (sign in (1, -1)),
  -- Money review L1: a reversal's line names the one line it copies, once.
  add column copies_line_id uuid,
  add constraint payslip_lines_copies_fkey foreign key (organisation_id, copies_line_id)
    references public.payslip_lines (organisation_id, id),
  add constraint payslip_lines_sign_copies check ((sign = -1) = (copies_line_id is not null));

create unique index payslip_lines_copies_key on public.payslip_lines (copies_line_id)
  where copies_line_id is not null;

-- BEFORE INSERT OR DELETE on payslips (ENABLE ALWAYS): a reversal run's payslips are copies of
-- its original's (same worker, every amount and snapshot, sign -1) and never go; other runs'
-- payslips have sign 1 and copy nothing.
create function private.payslips_reversal_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype;
  v_orig public.payslips%rowtype;
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.payroll_runs r
      where r.organisation_id = old.organisation_id and r.id = old.run_id and r.kind = 'reversal'
    ) then
      raise exception 'A reversal''s payslips are kept.' using errcode = 'MLRV7';
    end if;
    return old;
  end if;
  select r.* into v_run
  from public.payroll_runs r
  where r.organisation_id = new.organisation_id and r.id = new.run_id;
  if v_run.kind is distinct from 'reversal' then
    if new.reverses_payslip_id is not null or new.sign <> 1 then
      raise exception 'Only a reversal run''s payslips are copies.' using errcode = 'MLRV7';
    end if;
    return new;
  end if;
  select s.* into v_orig
  from public.payslips s
  where s.organisation_id = new.organisation_id and s.id = new.reverses_payslip_id;
  if new.sign <> -1 or v_orig.id is null or v_orig.run_id <> v_run.reverses_run_id
    or (
      new.worker_id, new.currency, new.gross_kobo, new.paye_kobo, new.pension_employee_kobo,
      new.pension_employer_kobo, new.nhf_kobo, new.other_deductions_kobo, new.net_kobo,
      new.carried_forward_kobo, new.nsitf_kobo, new.itf_kobo, new.employer_cost_kobo,
      new.rule_set_id, new.employment_type, new.tax_state, new.pfa_name, new.cycle_days,
      new.rostered_days, new.employed_rostered_days, new.leave_deducted_days, new.trace_version
    ) is distinct from (
      v_orig.worker_id, v_orig.currency, v_orig.gross_kobo, v_orig.paye_kobo,
      v_orig.pension_employee_kobo, v_orig.pension_employer_kobo, v_orig.nhf_kobo,
      v_orig.other_deductions_kobo, v_orig.net_kobo, v_orig.carried_forward_kobo,
      v_orig.nsitf_kobo, v_orig.itf_kobo, v_orig.employer_cost_kobo, v_orig.rule_set_id,
      v_orig.employment_type, v_orig.tax_state, v_orig.pfa_name, v_orig.cycle_days,
      v_orig.rostered_days, v_orig.employed_rostered_days, v_orig.leave_deducted_days,
      v_orig.trace_version
    )
    or new.trace is distinct from v_orig.trace
    or cardinality(new.pay_rate_ids) <> 0 then
    raise exception 'A reversal''s payslip copies its original exactly, with sign -1.'
      using errcode = 'MLRV7';
  end if;
  return new;
end;
$$;

revoke all on function private.payslips_reversal_guard() from public, anon, authenticated;

create trigger payslips_reversal_guard before insert or delete on public.payslips
  for each row execute function private.payslips_reversal_guard();
alter table public.payslips enable always trigger payslips_reversal_guard;

-- BEFORE INSERT on payslips (ENABLE ALWAYS): the RSA PIN snapshot, never from the caller. A
-- reversal's copy takes its original's; any other payslip the worker's ciphertext now.
create function private.payslips_rsa_pin_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reverses_payslip_id is not null then
    select s.rsa_pin_enc, s.rsa_pin_snapshot into new.rsa_pin_enc, new.rsa_pin_snapshot
    from public.payslips s
    where s.organisation_id = new.organisation_id and s.id = new.reverses_payslip_id;
    new.rsa_pin_snapshot := coalesce(new.rsa_pin_snapshot, false);
    return new;
  end if;
  select w.rsa_pin_enc into new.rsa_pin_enc
  from public.workers w
  where w.organisation_id = new.organisation_id and w.id = new.worker_id;
  new.rsa_pin_snapshot := true;
  return new;
end;
$$;

revoke all on function private.payslips_rsa_pin_snapshot() from public, anon, authenticated;

create trigger payslips_rsa_pin_snapshot before insert on public.payslips
  for each row execute function private.payslips_rsa_pin_snapshot();
alter table public.payslips enable always trigger payslips_rsa_pin_snapshot;

-- BEFORE INSERT OR DELETE on payslip_lines (ENABLE ALWAYS): a line's sign is its payslip's; a
-- reversal copy's line repeats a line of the original (position, code, kind, label, amount,
-- flags); a reversal's lines never go.
create function private.payslip_lines_reversal_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slip public.payslips%rowtype;
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.payroll_runs r
      where r.organisation_id = old.organisation_id and r.id = old.run_id and r.kind = 'reversal'
    ) then
      raise exception 'A reversal''s payslip lines are kept.' using errcode = 'MLRV7';
    end if;
    return old;
  end if;
  select s.* into v_slip
  from public.payslips s
  where s.organisation_id = new.organisation_id and s.id = new.payslip_id;
  if v_slip.id is null or v_slip.run_id <> new.run_id or new.sign <> v_slip.sign then
    raise exception 'A payslip line carries its payslip''s run and sign.' using errcode = 'MLRV7';
  end if;
  if v_slip.sign = -1 and not exists (
    select 1 from public.payslip_lines l
    where l.organisation_id = new.organisation_id and l.id = new.copies_line_id
      and l.payslip_id = v_slip.reverses_payslip_id
      and l.position = new.position and l.code = new.code and l.kind = new.kind
      and l.label = new.label and l.amount_kobo = new.amount_kobo and l.currency = new.currency
      and l.pensionable = new.pensionable and l.taxable = new.taxable and l.sign = 1
  ) then
    raise exception 'A reversal''s payslip line copies a line of the original.' using errcode = 'MLRV7';
  end if;
  return new;
end;
$$;

revoke all on function private.payslip_lines_reversal_guard() from public, anon, authenticated;

create trigger payslip_lines_reversal_guard before insert or delete on public.payslip_lines
  for each row execute function private.payslip_lines_reversal_guard();
alter table public.payslip_lines enable always trigger payslip_lines_reversal_guard;

-- ---------------------------------------------------------------------------
-- 3. payslip_sources: freed only on a reversed run
-- ---------------------------------------------------------------------------

-- As 5.2's payroll_draft_rows_guard for this table (rows come and go only while their run is a
-- draft), plus the one update: stands true -> false, nothing else, on a payslip of a reversed run
-- (approve_payroll_reversal frees them after the run is reversed in the same transaction).
create function private.payslip_sources_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' then
    if old.stands and not new.stands
      and (to_jsonb(new) - 'stands') = (to_jsonb(old) - 'stands')
      and private.payroll_run_status(old.organisation_id, old.run_id) = 'reversed' then
      return new;
    end if;
    raise exception 'Payslip sources never change, except a reversed run''s being freed.'
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

revoke all on function private.payslip_sources_guard() from public, anon, authenticated;

drop trigger payslip_sources_guard on public.payslip_sources;
create trigger payslip_sources_guard before insert or update or delete on public.payslip_sources
  for each row execute function private.payslip_sources_guard();
alter table public.payslip_sources enable always trigger payslip_sources_guard;

-- ---------------------------------------------------------------------------
-- 4. payroll_runs' guard: reversal moves
-- ---------------------------------------------------------------------------

-- A reversal of the run waiting for its second person (status review).
create function private.payroll_reversal_waiting(p_organisation_id uuid, p_run_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.reverses_run_id = p_run_id
    and r.kind = 'reversal' and r.status = 'review'
  limit 1
$$;

revoke all on function private.payroll_reversal_waiting(uuid, uuid) from public, anon, authenticated;

-- 5.4's guard (migration 20261122170000), plus:
-- * a new reversal run names an approved run (not a reversal) and has its period, pay date, rule
--   set and ITF choice; no other run names one;
-- * reverses_run_id never changes;
-- * approved -> reversed while a reversal of the run waits and no bank file of it is active,
--   changing nothing but status and updated_at; a reversed run never changes;
-- * approved -> released is refused while a reversal waits (MLRV9);
-- * a reversal run's draft -> review only before it was ever returned (declined), and its
--   review -> approved only once its original is reversed.
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
      or new.approved_at is not null or new.approved_by is not null
      or new.released_at is not null or new.released_by is not null then
      raise exception 'A new payroll run starts as an empty draft.' using errcode = 'MLPRD';
    end if;
    if new.kind = 'reversal' then
      if new.reverses_run_id is null or not exists (
        select 1 from public.payroll_runs o
        where o.organisation_id = new.organisation_id and o.id = new.reverses_run_id
          and o.kind <> 'reversal' and o.status = 'approved'
          and o.period_start = new.period_start and o.period_end = new.period_end
          and o.pay_date = new.pay_date and o.rule_set_id = new.rule_set_id
          and o.itf_applies = new.itf_applies
      ) then
        raise exception 'A reversal names an approved run and keeps its period, pay date and rules.'
          using errcode = 'MLRV2';
      end if;
    elsif new.reverses_run_id is not null then
      raise exception 'Only a reversal run names a run it reverses.' using errcode = 'MLRV2';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A payroll run is never deleted.' using errcode = 'MLPRD';
  end if;
  if new.reverses_run_id is distinct from old.reverses_run_id then
    raise exception 'The run a reversal reverses never changes.' using errcode = 'MLPRD';
  end if;
  if old.status = 'reversed' then
    raise exception 'This payroll run was reversed and never changes.' using errcode = 'MLPRD';
  end if;
  -- Reversal (slice 5.7a): the original, once its reversal is being approved. Its bank file was
  -- voided first; nothing else about the run changes.
  if old.status = 'approved' and new.status = 'reversed' then
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'Reversing a run changes nothing but its status.' using errcode = 'MLPRD';
    end if;
    if private.payroll_reversal_waiting(old.organisation_id, old.id) is null then
      raise exception 'A run is reversed only when a second person approves its reversal.'
        using errcode = 'MLRV6';
    end if;
    if exists (
      select 1 from public.payout_batches b
      where b.organisation_id = old.organisation_id and b.run_id = old.id and b.status = 'active'
    ) then
      raise exception 'Void the run''s bank file before reversing it.' using errcode = 'MLRV6';
    end if;
    new.updated_at := now();
    return new;
  end if;
  -- Release (slice 5.4): the bank file went to the bank. Nothing else about the run changes.
  if old.status = 'approved' and new.status = 'released' then
    if private.payroll_reversal_waiting(old.organisation_id, old.id) is not null then
      raise exception 'A reversal of this run is waiting for approval. Decide it before releasing.'
        using errcode = 'MLRV9';
    end if;
    if new.released_at is null or new.released_by is null
      or (to_jsonb(new) - 'status' - 'released_at' - 'released_by' - 'updated_at')
        is distinct from (to_jsonb(old) - 'status' - 'released_at' - 'released_by' - 'updated_at')
    then
      raise exception 'A release records who released the run and when, and changes nothing else.'
        using errcode = 'MLPRD';
    end if;
    new.updated_at := now();
    return new;
  end if;
  -- Posted is final (rule 5): nothing else about an approved or released run changes.
  if old.status in ('approved', 'released') then
    raise exception 'This payroll run is posted and never changes. Corrections go in a later run.'
      using errcode = 'MLPRD';
  end if;
  if new.released_at is not null or new.released_by is not null then
    raise exception 'Only a release records who released the run.' using errcode = 'MLPRD';
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
  if old.kind = 'reversal' and old.status = 'draft' and new.status = 'review' and exists (
    select 1 from public.payroll_run_decisions d
    where d.organisation_id = old.organisation_id and d.run_id = old.id and d.decision = 'returned'
  ) then
    raise exception 'This reversal was declined. Ask for a new one.' using errcode = 'MLRV6';
  end if;
  if old.kind = 'reversal' and new.status = 'approved' and not exists (
    select 1 from public.payroll_runs o
    where o.organisation_id = old.organisation_id and o.id = old.reverses_run_id
      and o.status = 'reversed'
  ) then
    raise exception 'A reversal is approved only with approve_payroll_reversal.' using errcode = 'MLRV6';
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

-- ---------------------------------------------------------------------------
-- 5. Bank files and remittances: never for a reversal run
-- ---------------------------------------------------------------------------

create function private.payroll_not_for_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = new.organisation_id and r.id = new.run_id and r.kind = 'reversal'
  ) then
    raise exception 'A reversal run pays nothing and owes nothing: it has no bank file, remittances or adjustments.'
      using errcode = 'MLRV7';
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_not_for_reversal() from public, anon, authenticated;

-- Money review M3: no new bank file while a reversal of the run waits for approval.
create function private.payout_batches_no_waiting_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.payroll_reversal_waiting(new.organisation_id, new.run_id) is not null then
    raise exception 'A reversal of this run is waiting for approval. Decide it before making a bank file.'
      using errcode = 'MLRV9';
  end if;
  return new;
end;
$$;

revoke all on function private.payout_batches_no_waiting_reversal() from public, anon, authenticated;

create trigger payout_batches_no_waiting_reversal before insert on public.payout_batches
  for each row execute function private.payout_batches_no_waiting_reversal();
alter table public.payout_batches enable always trigger payout_batches_no_waiting_reversal;

create trigger payout_batches_not_for_reversal before insert on public.payout_batches
  for each row execute function private.payroll_not_for_reversal();
alter table public.payout_batches enable always trigger payout_batches_not_for_reversal;
create trigger statutory_remittances_not_for_reversal before insert on public.statutory_remittances
  for each row execute function private.payroll_not_for_reversal();
alter table public.statutory_remittances enable always trigger statutory_remittances_not_for_reversal;

-- 5.6's trigger, skipping a reversal run's approval (its original's remittances are voided).
drop trigger payroll_runs_make_remittances on public.payroll_runs;
create trigger payroll_runs_make_remittances
  after update of status on public.payroll_runs
  for each row
  when (old.status = 'review' and new.status = 'approved' and new.kind <> 'reversal')
  execute function private.payroll_runs_make_remittances();
alter table public.payroll_runs enable always trigger payroll_runs_make_remittances;

-- ---------------------------------------------------------------------------
-- 6. Statutory remittance voids (insert-only)
-- ---------------------------------------------------------------------------

create table public.statutory_remittance_voids (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  remittance_id uuid not null,
  run_id uuid not null,
  reason text not null
    constraint statutory_remittance_voids_reason_text check (
      reason = btrim(reason) and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  voided_by uuid not null,
  created_at timestamptz not null default now(),
  constraint statutory_remittance_voids_organisation_id_id_key unique (organisation_id, id),
  -- A remittance is voided once.
  constraint statutory_remittance_voids_remittance_key unique (remittance_id),
  constraint statutory_remittance_voids_remittance_fkey foreign key (organisation_id, remittance_id)
    references public.statutory_remittances (organisation_id, id),
  constraint statutory_remittance_voids_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id)
);

create index statutory_remittance_voids_run_idx
  on public.statutory_remittance_voids (organisation_id, run_id);

comment on table public.statutory_remittance_voids is
  'A reversed run''s remittances, voided (slice 5.7a): one row per remittance with the reason and who. Insert-only; a payment already recorded stays as evidence (5.7c refunds or offsets it).';

-- Insert-only; an insert names a remittance of the row's run, which is reversed; stamped now.
create function private.statutory_remittance_voids_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Remittance voids are kept as written.' using errcode = 'MLRVA';
  end if;
  if not exists (
    select 1
    from public.statutory_remittances m
    join public.payroll_runs r on r.organisation_id = m.organisation_id and r.id = m.run_id
    where m.organisation_id = new.organisation_id and m.id = new.remittance_id
      and m.run_id = new.run_id and r.status = 'reversed'
  ) then
    raise exception 'Only a reversed run''s remittances are voided.' using errcode = 'MLRVA';
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.statutory_remittance_voids_guard() from public, anon, authenticated;

create trigger statutory_remittance_voids_guard
  before insert or update or delete on public.statutory_remittance_voids
  for each row execute function private.statutory_remittance_voids_guard();
create trigger statutory_remittance_voids_no_truncate
  before truncate on public.statutory_remittance_voids
  for each statement execute function private.statutory_no_truncate();
create trigger statutory_remittance_voids_audit after insert on public.statutory_remittance_voids
  for each row execute function private.audit_row_change();
alter table public.statutory_remittance_voids enable always trigger statutory_remittance_voids_guard;
alter table public.statutory_remittance_voids enable always trigger statutory_remittance_voids_no_truncate;

alter table public.statutory_remittance_voids enable row level security;

create policy statutory_remittance_voids_select on public.statutory_remittance_voids
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.statutory_remittance_voids from anon, authenticated, service_role;
grant select on table public.statutory_remittance_voids to authenticated, service_role;

-- The shared 5.7 void path: voids every remittance of a reversed run not voided yet, as p_actor
-- with p_reason, and audits it. Never deletes; a standing payment stays (5.7c's refunds and
-- offsets build on it). Called only by definer functions (approve_payroll_reversal); the guard
-- refuses a run that isn't reversed. Returns how many it voided.
create function private.void_run_remittances(
  p_organisation_id uuid,
  p_run_id uuid,
  p_reason text,
  p_actor uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_count integer;
  v_paid integer;
begin
  if p_organisation_id is null or p_run_id is null or p_actor is null then
    raise exception 'Name the run and who voids its remittances.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  insert into public.statutory_remittance_voids (organisation_id, remittance_id, run_id, reason, voided_by)
  select m.organisation_id, m.id, m.run_id, v_reason, p_actor
  from public.statutory_remittances m
  where m.organisation_id = p_organisation_id and m.run_id = p_run_id
    and not exists (select 1 from public.statutory_remittance_voids v where v.remittance_id = m.id)
  order by m.kind, m.authority_key nulls first;
  get diagnostics v_count = row_count;
  -- Remittances with a standing payment (recorded and not voided): evidence 5.7c settles.
  select count(*)::integer into v_paid
  from public.statutory_remittances m
  where m.organisation_id = p_organisation_id and m.run_id = p_run_id
    and exists (
      select 1 from public.statutory_payments p
      where p.organisation_id = m.organisation_id and p.remittance_id = m.id
        and p.entry = 'payment'
        and not exists (
          select 1 from public.statutory_payments v
          where v.organisation_id = p.organisation_id and v.voids_payment_id = p.id
        )
    );
  if v_count > 0 then
    perform private.log_audit_impl(
      p_organisation_id, 'payroll.remittances_voided', 'payroll_runs', p_run_id, null,
      jsonb_build_object('voided', v_count, 'with_payment', v_paid),
      v_reason
    );
  end if;
  return v_count;
end;
$$;

revoke all on function private.void_run_remittances(uuid, uuid, text, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Corrections after release
-- ---------------------------------------------------------------------------

alter table public.payroll_adjustments
  add column corrects_payslip_id uuid,
  add constraint payroll_adjustments_corrects_fkey foreign key (organisation_id, corrects_payslip_id)
    references public.payslips (organisation_id, id),
  add constraint payroll_adjustments_corrects_once check (
    corrects_payslip_id is null or instalment_count = 1
  );

comment on column public.payroll_adjustments.corrects_payslip_id is
  'Slice 5.7a: the released payslip (same worker and company) this adjustment in a later run corrects.';

-- BEFORE INSERT on payroll_adjustments (ENABLE ALWAYS): never on a reversal run; a correction
-- names a payslip of a released run (not a reversal) other than this run, of the same worker.
create function private.payroll_adjustments_correction_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = new.organisation_id and r.id = new.run_id and r.kind = 'reversal'
  ) then
    raise exception 'A reversal run takes no adjustments.' using errcode = 'MLRV7';
  end if;
  if new.corrects_payslip_id is null then
    return new;
  end if;
  -- A released payslip of the same worker, of a run that isn't a reversal, from an earlier period
  -- than the correcting run (money review M4b; an off-cycle run may correct its own period).
  if not exists (
    select 1
    from public.payslips s
    join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
    join public.payroll_runs c on c.organisation_id = new.organisation_id and c.id = new.run_id
    where s.organisation_id = new.organisation_id and s.id = new.corrects_payslip_id
      and s.worker_id = new.worker_id and r.status = 'released' and r.kind <> 'reversal'
      and r.id <> new.run_id
      and (c.period_start > r.period_start
        or (c.kind = 'off_cycle' and c.period_start >= r.period_start))
  ) then
    raise exception 'A correction names a released payslip of the same worker from an earlier period.'
      using errcode = 'MLRV8';
  end if;
  -- Money review M4a: one correction of a payslip per run.
  if exists (
    select 1 from public.payroll_adjustments a
    where a.organisation_id = new.organisation_id and a.run_id = new.run_id
      and a.corrects_payslip_id = new.corrects_payslip_id and a.id <> new.id
  ) then
    raise exception 'This run already corrects that payslip. Remove that correction to change it.'
      using errcode = 'MLRVC';
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_adjustments_correction_check() from public, anon, authenticated;

create trigger payroll_adjustments_correction_check before insert on public.payroll_adjustments
  for each row execute function private.payroll_adjustments_correction_check();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_correction_check;

-- Adds a one-off correction to a draft run (owner or hr): an earning or deduction for the worker
-- of p_payslip_id, a payslip of a released run, naming it. As add_payroll_adjustment otherwise
-- (the worker employed in the period; the run then needs recalculating). Returns the id.
create function private.add_payroll_correction(
  p_organisation_id uuid,
  p_run_id uuid,
  p_payslip_id uuid,
  p_kind text,
  p_label text,
  p_amount_kobo text,
  p_pensionable boolean,
  p_reason text,
  p_repeat boolean default false
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
  v_worker uuid;
begin
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
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Adjustments change only while the run is a draft.' using errcode = 'MLPRD';
  end if;
  select s.worker_id into v_worker
  from public.payslips s
  where s.organisation_id = p_organisation_id and s.id = p_payslip_id;
  if v_worker is null then
    raise exception 'That payslip wasn''t found.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = v_worker
      and w.start_date <= v_run.period_end
      and (w.end_date is null or w.end_date >= v_run.period_start)
  ) then
    raise exception 'That worker isn''t employed in this pay period.' using errcode = '22023';
  end if;
  -- Money review M4a: a payslip already corrected in another run that stands needs the explicit
  -- statement that this is a further correction, not the same one twice.
  if not coalesce(p_repeat, false) and exists (
    select 1
    from public.payroll_adjustments a
    join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
    where a.organisation_id = p_organisation_id and a.corrects_payslip_id = p_payslip_id
      and a.run_id <> p_run_id and r.status <> 'reversed'
  ) then
    raise exception 'That payslip was already corrected in another run. Confirm this is a further correction.'
      using errcode = 'MLRVC';
  end if;

  insert into public.payroll_adjustments (
    id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
    series_id, instalment_number, instalment_count, reason, created_by, corrects_payslip_id
  )
  values (
    v_id, p_organisation_id, p_run_id, v_worker, p_kind, v_label, v_amount,
    p_kind = 'earning' and coalesce(p_pensionable, false), p_kind = 'earning',
    v_id, 1, 1, v_reason, v_uid, p_payslip_id
  );
  update public.payroll_runs r set needs_recalculation = true where r.id = p_run_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.correction_added', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'adjustment_id', v_id, 'worker_id', v_worker, 'kind', p_kind, 'label', v_label,
      'amount_kobo', v_amount::text, 'corrects_payslip_id', p_payslip_id,
      'further_correction', coalesce(p_repeat, false)
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.add_payroll_correction(uuid, uuid, uuid, text, text, text, boolean, text, boolean)
  from public, anon;
grant execute on function private.add_payroll_correction(uuid, uuid, uuid, text, text, text, boolean, text, boolean)
  to authenticated;

create function public.add_payroll_correction(
  p_organisation_id uuid,
  p_run_id uuid,
  p_payslip_id uuid,
  p_kind text,
  p_label text,
  p_amount_kobo text,
  p_pensionable boolean,
  p_reason text,
  p_repeat boolean default false
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_payroll_correction(
    p_organisation_id, p_run_id, p_payslip_id, p_kind, p_label, p_amount_kobo, p_pensionable,
    p_reason, p_repeat
  )
$$;

revoke all on function public.add_payroll_correction(uuid, uuid, uuid, text, text, text, boolean, text, boolean)
  from public, anon;
grant execute on function public.add_payroll_correction(uuid, uuid, uuid, text, text, text, boolean, text, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 8. A reversed period may be run again
-- ---------------------------------------------------------------------------

-- 5.2's create_payroll_run (migration 20261122120000), unchanged but that a reversed regular run
-- no longer holds the period.
create or replace function private.create_payroll_run(
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
  v_from_reversed integer;
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
      and r.status <> 'reversed'
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

  -- Money review H1 (slice 5.7a): the period's latest reversed regular run's adjustments come
  -- across as they were (one-offs, recurring instalments with the same series and number, and
  -- corrections naming the same payslip), for workers employed in the period. The reversed run's
  -- rows no longer hold their instalment numbers (payroll_adjustments_series_once).
  with reversed as (
    select r.id from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.kind = 'regular'
      and r.period_start = v_start and r.status = 'reversed'
    order by r.created_at desc
    limit 1
  )
  insert into public.payroll_adjustments (
    organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
    series_id, instalment_number, instalment_count, reason, created_by, corrects_payslip_id
  )
  select a.organisation_id, v_id, a.worker_id, a.kind, a.label, a.amount_kobo, a.pensionable,
    a.taxable, a.series_id, a.instalment_number, a.instalment_count, a.reason, v_uid,
    a.corrects_payslip_id
  from public.payroll_adjustments a
  join reversed x on x.id = a.run_id
  join public.workers w on w.organisation_id = a.organisation_id and w.id = a.worker_id
  where a.organisation_id = p_organisation_id
    and w.start_date <= v_end and (w.end_date is null or w.end_date >= v_start)
  order by a.created_at, a.id;
  get diagnostics v_from_reversed = row_count;

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
      select 1
      from public.payroll_adjustments x
      join public.payroll_runs xr on xr.organisation_id = x.organisation_id and xr.id = x.run_id
      where x.series_id = l.series_id and x.instalment_number = l.instalment_number + 1
        and xr.status <> 'reversed'
    );
  get diagnostics v_carried = row_count;

  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_created', 'payroll_runs', v_id, null,
    jsonb_build_object(
      'period_start', v_start, 'period_end', v_end, 'pay_date', v_pay,
      'rule_set_id', v_rule_set, 'recurring_adjustments', v_carried,
      'from_reversed_run', v_from_reversed
    ),
    null
  );
  return v_id;
exception
  when unique_violation then
    raise exception 'A payroll run for this period already exists.' using errcode = 'MLPRA';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Requesting and approving a reversal
-- ---------------------------------------------------------------------------

-- When the run's active bank file was downloaded (5.4's audited download), or null.
create function private.payroll_active_file_downloaded(p_organisation_id uuid, p_run_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(l.at)
  from public.payout_batches b
  join public.audit_log l
    on l.organisation_id = b.organisation_id and l.entity = 'payout_batches' and l.entity_id = b.id
  where b.organisation_id = p_organisation_id and b.run_id = p_run_id and b.status = 'active'
    and l.action = 'payroll.bank_file_downloaded'
$$;

revoke all on function private.payroll_active_file_downloaded(uuid, uuid) from public, anon, authenticated;

-- Asks for an approved run to be reversed (owner or finance, trusted session), with a reason.
-- Refused for a released run (MLRV1: the money has gone), any run not approved or a reversal
-- (MLRV2), a run with a reversal waiting or approved (MLRV3), and a downloaded bank file without
-- p_not_uploaded (MLRV5). Makes the reversal run: every payslip and line copied with sign -1,
-- the original's totals and inputs hash, prepared, worked out and submitted by the requester, so
-- a second person approves it. Returns the reversal run's id.
create function private.reverse_payroll_run(
  p_organisation_id uuid,
  p_run_id uuid,
  p_reason text,
  p_not_uploaded boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_approver(p_organisation_id);
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_orig public.payroll_runs%rowtype;
  v_id uuid;
  v_downloaded timestamptz;
  v_slips integer;
  v_lines integer;
  v_decision uuid;
begin
  if v_reason is null then
    raise exception 'Say why the run is reversed, in up to 500 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('payroll_runs:' || p_organisation_id::text, 0));
  v_orig := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_orig.status = 'released' then
    raise exception 'This run is released: the money has gone. Correct it in a later run instead.'
      using errcode = 'MLRV1';
  end if;
  if v_orig.kind = 'reversal' or v_orig.status <> 'approved' then
    raise exception 'Only an approved run that isn''t released is reversed.' using errcode = 'MLRV2';
  end if;
  if exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.reverses_run_id = p_run_id
      and r.kind = 'reversal' and r.status in ('review', 'approved')
  ) then
    raise exception 'A reversal of this run is already waiting for approval.' using errcode = 'MLRV3';
  end if;
  v_downloaded := private.payroll_active_file_downloaded(p_organisation_id, p_run_id);
  if v_downloaded is not null and not coalesce(p_not_uploaded, false) then
    raise exception 'The bank file was downloaded. Confirm it wasn''t uploaded to the bank before reversing, or the money may be paid.'
      using errcode = 'MLRV5';
  end if;

  insert into public.payroll_runs (
    organisation_id, kind, reverses_run_id, period_start, period_end, pay_date, rule_set_id,
    itf_applies, prepared_by
  )
  values (
    p_organisation_id, 'reversal', p_run_id, v_orig.period_start, v_orig.period_end,
    v_orig.pay_date, v_orig.rule_set_id, v_orig.itf_applies, v_uid
  )
  returning id into v_id;

  insert into public.payslips (
    organisation_id, run_id, worker_id, currency, gross_kobo, paye_kobo, pension_employee_kobo,
    pension_employer_kobo, nhf_kobo, other_deductions_kobo, net_kobo, carried_forward_kobo,
    nsitf_kobo, itf_kobo, employer_cost_kobo, rule_set_id, pay_rate_ids, employment_type,
    tax_state, pfa_name, cycle_days, rostered_days, employed_rostered_days, leave_deducted_days,
    trace, trace_version, sign, reverses_payslip_id
  )
  select s.organisation_id, v_id, s.worker_id, s.currency, s.gross_kobo, s.paye_kobo,
    s.pension_employee_kobo, s.pension_employer_kobo, s.nhf_kobo, s.other_deductions_kobo,
    s.net_kobo, s.carried_forward_kobo, s.nsitf_kobo, s.itf_kobo, s.employer_cost_kobo,
    s.rule_set_id, '{}'::uuid[], s.employment_type, s.tax_state, s.pfa_name, s.cycle_days,
    s.rostered_days, s.employed_rostered_days, s.leave_deducted_days, s.trace, s.trace_version,
    -1, s.id
  from public.payslips s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
  order by s.worker_id;
  get diagnostics v_slips = row_count;

  insert into public.payslip_lines (
    organisation_id, payslip_id, run_id, position, code, kind, label, amount_kobo, currency,
    pensionable, taxable, sign, copies_line_id
  )
  select l.organisation_id, c.id, v_id, l.position, l.code, l.kind, l.label, l.amount_kobo,
    l.currency, l.pensionable, l.taxable, -1, l.id
  from public.payslip_lines l
  join public.payslips c
    on c.organisation_id = l.organisation_id and c.run_id = v_id and c.reverses_payslip_id = l.payslip_id
  where l.organisation_id = p_organisation_id and l.run_id = p_run_id
  order by c.id, l.position;
  get diagnostics v_lines = row_count;

  -- The reversal's totals are the original's (counted negatively by kind), worked out now by the
  -- requester; the inputs hash names what the original was worked out from.
  update public.payroll_runs r
  set gross_kobo = v_orig.gross_kobo, paye_kobo = v_orig.paye_kobo,
      pension_employee_kobo = v_orig.pension_employee_kobo,
      pension_employer_kobo = v_orig.pension_employer_kobo, nhf_kobo = v_orig.nhf_kobo,
      other_deductions_kobo = v_orig.other_deductions_kobo, net_kobo = v_orig.net_kobo,
      nsitf_kobo = v_orig.nsitf_kobo, itf_kobo = v_orig.itf_kobo,
      employer_cost_kobo = v_orig.employer_cost_kobo,
      carried_forward_kobo = v_orig.carried_forward_kobo, worker_count = v_orig.worker_count,
      inputs_sha256 = v_orig.inputs_sha256, needs_recalculation = false,
      calculated_at = now(), calculated_by = v_uid
  where r.id = v_id;
  if v_slips <> v_orig.worker_count then
    raise exception 'The reversal doesn''t copy every payslip of the run.' using errcode = 'MLRV7';
  end if;

  update public.payroll_runs r
  set status = 'review', submitted_at = now(), submitted_by = v_uid
  where r.id = v_id;
  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, reason, actor_id, inputs_sha256, gross_kobo, net_kobo,
    worker_count
  )
  values (
    p_organisation_id, v_id, 'submitted', v_reason, v_uid, v_orig.inputs_sha256,
    v_orig.gross_kobo, v_orig.net_kobo, v_orig.worker_count
  )
  returning id into v_decision;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.reversal_requested', 'payroll_runs', v_id, null,
    jsonb_build_object(
      'reverses_run_id', p_run_id, 'decision_id', v_decision, 'payslips', v_slips,
      'lines', v_lines, 'gross_kobo', (-v_orig.gross_kobo)::text,
      'net_kobo', (-v_orig.net_kobo)::text, 'worker_count', v_orig.worker_count,
      'bank_file_downloaded', v_downloaded is not null,
      'confirmed_not_uploaded', v_downloaded is not null and coalesce(p_not_uploaded, false)
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.reverse_payroll_run(uuid, uuid, text, boolean) from public, anon;
grant execute on function private.reverse_payroll_run(uuid, uuid, text, boolean) to authenticated;

create function public.reverse_payroll_run(
  p_organisation_id uuid,
  p_run_id uuid,
  p_reason text,
  p_not_uploaded boolean default false
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.reverse_payroll_run(p_organisation_id, p_run_id, p_reason, p_not_uploaded)
$$;

revoke all on function public.reverse_payroll_run(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.reverse_payroll_run(uuid, uuid, text, boolean) to authenticated;

-- Approves a waiting reversal (owner or finance, trusted session), never anyone who requested or
-- changed it (MLRV4). In this one transaction: checks the copies against the original (MLRV7),
-- voids the original's active bank file ("Run reversed"; a downloaded one needs p_not_uploaded,
-- MLRV5), reverses the original, frees its sources, voids its remittances and approves the
-- reversal; records both decisions; audited. Returns the reversal's approval decision id.
create function private.approve_payroll_reversal(
  p_organisation_id uuid,
  p_run_id uuid,
  p_not_uploaded boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_approver(p_organisation_id);
  v_rev public.payroll_runs%rowtype;
  v_orig public.payroll_runs%rowtype;
  v_reason text;
  v_batch public.payout_batches%rowtype;
  v_downloaded timestamptz;
  v_freed integer;
  v_voided integer;
  v_totals record;
  v_id uuid;
begin
  v_rev := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_rev.kind <> 'reversal' then
    raise exception 'That run isn''t a reversal.' using errcode = 'MLRV6';
  end if;
  if v_rev.status <> 'review' then
    raise exception 'Only a reversal waiting for approval is approved.' using errcode = 'MLRV6';
  end if;
  if v_uid = any (private.payroll_run_touchers(p_organisation_id, p_run_id)) then
    raise exception 'You asked for this reversal, so a different person must approve it.'
      using errcode = 'MLRV4';
  end if;
  v_orig := private.payroll_lock_run(p_organisation_id, v_rev.reverses_run_id);
  if v_orig.status = 'released' then
    raise exception 'The run was released: the money has gone. Correct it in a later run instead.'
      using errcode = 'MLRV1';
  end if;
  if v_orig.status <> 'approved' then
    raise exception 'Only an approved run that isn''t released is reversed.' using errcode = 'MLRV2';
  end if;

  -- The copies: one per payslip of the original, each with as many lines, and totals equal to
  -- the original's and to the sums of the copies.
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
  if (v_totals.gross, v_totals.paye, v_totals.pee, v_totals.per, v_totals.nhf, v_totals.other,
      v_totals.net, v_totals.nsitf, v_totals.itf, v_totals.cost, v_totals.carried, v_totals.n)
    is distinct from
     (v_orig.gross_kobo, v_orig.paye_kobo, v_orig.pension_employee_kobo, v_orig.pension_employer_kobo,
      v_orig.nhf_kobo, v_orig.other_deductions_kobo, v_orig.net_kobo, v_orig.nsitf_kobo,
      v_orig.itf_kobo, v_orig.employer_cost_kobo, v_orig.carried_forward_kobo, v_orig.worker_count)
    or (v_rev.gross_kobo, v_rev.paye_kobo, v_rev.pension_employee_kobo, v_rev.pension_employer_kobo,
        v_rev.nhf_kobo, v_rev.other_deductions_kobo, v_rev.net_kobo, v_rev.nsitf_kobo,
        v_rev.itf_kobo, v_rev.employer_cost_kobo, v_rev.carried_forward_kobo, v_rev.worker_count)
    is distinct from
     (v_orig.gross_kobo, v_orig.paye_kobo, v_orig.pension_employee_kobo, v_orig.pension_employer_kobo,
      v_orig.nhf_kobo, v_orig.other_deductions_kobo, v_orig.net_kobo, v_orig.nsitf_kobo,
      v_orig.itf_kobo, v_orig.employer_cost_kobo, v_orig.carried_forward_kobo, v_orig.worker_count)
    or exists (
      select 1 from public.payslips o
      where o.organisation_id = p_organisation_id and o.run_id = v_orig.id
        and not exists (
          select 1 from public.payslips c
          where c.organisation_id = o.organisation_id and c.run_id = p_run_id
            and c.reverses_payslip_id = o.id
        )
    )
    or exists (
      select 1 from public.payslips c
      where c.organisation_id = p_organisation_id and c.run_id = p_run_id
        and (
          select count(*) from public.payslip_lines l
          where l.organisation_id = c.organisation_id and l.payslip_id = c.id
        ) <> (
          select count(*) from public.payslip_lines l
          where l.organisation_id = c.organisation_id and l.payslip_id = c.reverses_payslip_id
        )
    ) then
    raise exception 'The reversal doesn''t mirror the run it reverses. Ask for a new reversal.'
      using errcode = 'MLRV7';
  end if;

  select d.reason into v_reason
  from public.payroll_run_decisions d
  where d.organisation_id = p_organisation_id and d.run_id = p_run_id and d.decision = 'submitted'
  order by d.created_at desc
  limit 1;
  v_reason := coalesce(v_reason, 'Run reversed');

  -- 5.4's void path: the original's active bank file, its pending items with it.
  select b.* into v_batch
  from public.payout_batches b
  where b.organisation_id = p_organisation_id and b.run_id = v_orig.id and b.status = 'active'
  for update;
  if v_batch.id is not null then
    v_downloaded := private.payroll_active_file_downloaded(p_organisation_id, v_orig.id);
    if v_downloaded is not null and not coalesce(p_not_uploaded, false) then
      raise exception 'The bank file was downloaded. Confirm it wasn''t uploaded to the bank before approving the reversal, or the money may be paid.'
        using errcode = 'MLRV5';
    end if;
    update public.payout_batches b
    set status = 'voided', voided_by = v_uid, voided_at = now(),
        void_reason = case
          when v_downloaded is not null
            then 'Run reversed (confirmed the file was not uploaded to the bank)'
          else 'Run reversed'
        end
    where b.id = v_batch.id;
    update public.payout_items i
    set status = 'voided'
    where i.organisation_id = p_organisation_id and i.batch_id = v_batch.id
      and i.status = 'pending';
  end if;

  update public.payroll_runs r set status = 'reversed' where r.id = v_orig.id;

  update public.payslip_sources s
  set stands = false
  where s.organisation_id = p_organisation_id and s.run_id = v_orig.id and s.stands;
  get diagnostics v_freed = row_count;

  v_voided := private.void_run_remittances(p_organisation_id, v_orig.id, v_reason, v_uid);

  update public.payroll_runs r
  set status = 'approved', approved_at = now(), approved_by = v_uid
  where r.id = p_run_id;

  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, actor_id, inputs_sha256, gross_kobo, net_kobo, worker_count
  )
  values (
    p_organisation_id, p_run_id, 'approved', v_uid, v_rev.inputs_sha256, v_rev.gross_kobo,
    v_rev.net_kobo, v_rev.worker_count
  )
  returning id into v_id;
  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, reason, actor_id, inputs_sha256, gross_kobo, net_kobo,
    worker_count
  )
  values (
    p_organisation_id, v_orig.id, 'reversed', v_reason, v_uid, v_orig.inputs_sha256,
    v_orig.gross_kobo, v_orig.net_kobo, v_orig.worker_count
  );
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.reversal_approved', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'decision_id', v_id, 'reverses_run_id', v_orig.id,
      'gross_kobo', (-v_rev.gross_kobo)::text, 'net_kobo', (-v_rev.net_kobo)::text,
      'worker_count', v_rev.worker_count
    ),
    null
  );
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_reversed', 'payroll_runs', v_orig.id,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object(
      'status', 'reversed', 'reversal_run_id', p_run_id, 'sources_freed', v_freed,
      'remittances_voided', v_voided, 'bank_file_voided', v_batch.id,
      'confirmed_not_uploaded', v_downloaded is not null
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.approve_payroll_reversal(uuid, uuid, boolean) from public, anon;
grant execute on function private.approve_payroll_reversal(uuid, uuid, boolean) to authenticated;

create function public.approve_payroll_reversal(
  p_organisation_id uuid,
  p_run_id uuid,
  p_not_uploaded boolean default false
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.approve_payroll_reversal(p_organisation_id, p_run_id, p_not_uploaded)
$$;

revoke all on function public.approve_payroll_reversal(uuid, uuid, boolean) from public, anon;
grant execute on function public.approve_payroll_reversal(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Security and money review fixes (24 Nov 2026)
-- ---------------------------------------------------------------------------

-- M1: a pension schedule (RSA PINs) opens only for a posted run's remittance that isn't voided.
-- The server calls this as the signed-in user before it decrypts anything (owner, hr, finance).
create function private.statutory_schedule_check(p_organisation_id uuid, p_remittance_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if private.session_uid() is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only an owner, HR or Finance downloads a schedule.' using errcode = '42501';
  end if;
  select r.status into v_status
  from public.statutory_remittances m
  join public.payroll_runs r on r.organisation_id = m.organisation_id and r.id = m.run_id
  where m.organisation_id = p_organisation_id and m.id = p_remittance_id;
  if v_status is null then
    raise exception 'That remittance wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status not in ('approved', 'released') or exists (
    select 1 from public.statutory_remittance_voids v
    where v.organisation_id = p_organisation_id and v.remittance_id = p_remittance_id
  ) then
    raise exception 'This remittance was voided because its run was reversed, so it has no schedule.'
      using errcode = 'MLRVB';
  end if;
  return true;
end;
$$;

revoke all on function private.statutory_schedule_check(uuid, uuid) from public, anon;
grant execute on function private.statutory_schedule_check(uuid, uuid) to authenticated;

create function public.statutory_schedule_check(p_organisation_id uuid, p_remittance_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.statutory_schedule_check(p_organisation_id, p_remittance_id)
$$;

revoke all on function public.statutory_schedule_check(uuid, uuid) from public, anon;
grant execute on function public.statutory_schedule_check(uuid, uuid) to authenticated;

-- L1: 5.4's payout_file_download, unchanged but that it reads the batch FOR SHARE, so a download
-- waits behind approve_payroll_reversal (which voids the batch FOR UPDATE) and then sees it voided.
create or replace function private.payout_file_download(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_reason text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payout_maker(p_organisation_id);
  v_batch public.payout_batches%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select b.* into v_batch
  from public.payout_batches b
  where b.organisation_id = p_organisation_id and b.id = p_batch_id
  for share;
  if v_batch.id is null then
    raise exception 'That bank file wasn''t found.' using errcode = 'P0002';
  end if;
  if v_batch.status <> 'active' then
    raise exception 'This file was replaced. Download the current one.' using errcode = 'MLBF5';
  end if;
  -- Money review M3: a file a waiting reversal will void isn't handed out.
  if private.payroll_reversal_waiting(p_organisation_id, v_batch.run_id) is not null then
    raise exception 'A reversal of this run is waiting for approval. Decide it before downloading the bank file.'
      using errcode = 'MLRV9';
  end if;
  if v_reason is not null and (
    char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v_reason ~* '(://|www\.)' or regexp_replace(v_reason, '[^0-9]', '', 'g') ~ '[0-9]{10}'
  ) then
    raise exception 'Say why in up to 500 characters, with no web addresses or account numbers.'
      using errcode = '22023';
  end if;
  if private.payroll_run_status(p_organisation_id, v_batch.run_id) = 'released' and v_reason is null then
    raise exception 'This file is already paid. Say why you need it again; never upload it to the bank again.'
      using errcode = 'MLBFE';
  end if;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.bank_file_downloaded', 'payout_batches', v_batch.id, null,
    jsonb_build_object('batch_id', v_batch.id), v_reason
  );
  return v_batch.file_path;
end;
$$;

-- L2: no payment entry (a payment or a void) on a voided remittance or a reversed run's: the
-- payment already recorded stays as evidence, and slice 5.7c refunds or offsets it.
create function private.statutory_payments_not_voided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.statutory_remittance_voids v
    where v.organisation_id = new.organisation_id and v.remittance_id = new.remittance_id
  ) or exists (
    select 1
    from public.statutory_remittances m
    join public.payroll_runs r on r.organisation_id = m.organisation_id and r.id = m.run_id
    where m.organisation_id = new.organisation_id and m.id = new.remittance_id
      and r.status = 'reversed'
  ) then
    raise exception 'This remittance was voided because its run was reversed; its payment record stays as it is.'
      using errcode = 'MLRVB';
  end if;
  return new;
end;
$$;

revoke all on function private.statutory_payments_not_voided() from public, anon, authenticated;

create trigger statutory_payments_not_voided before insert on public.statutory_payments
  for each row execute function private.statutory_payments_not_voided();
alter table public.statutory_payments enable always trigger statutory_payments_not_voided;

-- L3: the correction check also fires on a change of the worker, the payslip or the run (5.2's
-- guard refuses every update anyway; this keeps the check whole on its own).
drop trigger payroll_adjustments_correction_check on public.payroll_adjustments;
create trigger payroll_adjustments_correction_check
  before insert or update of worker_id, corrects_payslip_id, run_id on public.payroll_adjustments
  for each row execute function private.payroll_adjustments_correction_check();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_correction_check;

-- L4: a recurring instalment paid in a reversed run doesn't hold its number. The series' unique key
-- becomes per run, and a trigger keeps one instalment n per series among runs that aren't reversed
-- (under the series' advisory lock, as carry_payroll_instalment takes it).
alter table public.payroll_adjustments drop constraint payroll_adjustments_series_key;
alter table public.payroll_adjustments
  add constraint payroll_adjustments_series_key unique (series_id, instalment_number, run_id);

create function private.payroll_adjustments_series_once()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('payroll_series:' || new.series_id::text, 0));
  if exists (
    select 1
    from public.payroll_adjustments a
    join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
    where a.series_id = new.series_id and a.instalment_number = new.instalment_number
      and r.status <> 'reversed'
  ) then
    raise exception 'That instalment is already on a run.' using errcode = 'MLPRD';
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_adjustments_series_once() from public, anon, authenticated;

create trigger payroll_adjustments_series_once before insert on public.payroll_adjustments
  for each row execute function private.payroll_adjustments_series_once();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_series_once;

-- create_payroll_run (section 8) carries the next instalment unless it is on a run that isn't
-- reversed; carry_payroll_instalment (5.2's, unchanged but this) likewise ignores reversed runs,
-- both for the series' latest instalment and for the instalment already being on a run.
create or replace function private.carry_payroll_instalment(
  p_organisation_id uuid,
  p_run_id uuid,
  p_series_id uuid
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
  v_last public.payroll_adjustments%rowtype;
  v_id uuid := gen_random_uuid();
begin
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Adjustments change only while the run is a draft.' using errcode = 'MLPRD';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('payroll_series:' || coalesce(p_series_id::text, ''), 0));
  select a.* into v_last
  from public.payroll_adjustments a
  join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
  where a.organisation_id = p_organisation_id and a.series_id = p_series_id
    and r.period_start < v_run.period_start and r.status <> 'reversed'
  order by a.instalment_number desc
  limit 1;
  if v_last.id is null then
    raise exception 'That recurring item wasn''t found in an earlier run.' using errcode = 'P0002';
  end if;
  if v_last.instalment_number >= v_last.instalment_count then
    raise exception 'Every instalment of that item is already paid.' using errcode = 'MLPRD';
  end if;
  if exists (
    select 1
    from public.payroll_adjustments a
    join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
    where a.series_id = p_series_id and a.instalment_number = v_last.instalment_number + 1
      and r.status <> 'reversed'
  ) then
    raise exception 'That instalment is already on a run.' using errcode = 'MLPRD';
  end if;
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = v_last.worker_id
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
    v_id, p_organisation_id, p_run_id, v_last.worker_id, v_last.kind, v_last.label,
    v_last.amount_kobo, v_last.pensionable, v_last.taxable, p_series_id,
    v_last.instalment_number + 1, v_last.instalment_count, v_last.reason, v_uid
  );
  update public.payroll_runs r set needs_recalculation = true where r.id = p_run_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.instalment_carried', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'adjustment_id', v_id, 'series_id', p_series_id, 'worker_id', v_last.worker_id,
      'instalment', v_last.instalment_number + 1, 'of', v_last.instalment_count,
      'amount_kobo', v_last.amount_kobo::text
    ),
    null
  );
  return v_id;
end;
$$;
