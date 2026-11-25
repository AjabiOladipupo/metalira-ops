-- Slice 5.10: the Phase 5 round-2 fix-up (docs/PHASE_5.md "5.10"), from the phase-level money
-- and security reviews of 25 Nov 2026 and the owner's decisions of the same day.
--
-- 1. Declared rent (security M1): workers.annual_rent_declared_kobo is changed only by the owner
--    or hr (workers_rent_declared_guard, ENABLE ALWAYS; MLFZ2), and every change writes a
--    payroll.rent_declared_set audit row. Writes to workers, NHF numbers and the ITF switch stamp
--    clock_timestamp() (money L1), so approval's "written after the read began" checks see a
--    write made in a transaction that began before the read.
-- 2. private.payroll_run_touchers (security L1) also names, for the run's workers in its tax year,
--    whoever recorded an opening balance, declared a relief, uploaded a proof, verified a relief
--    or last set the declared rent. Approval, release, reversal approval and supplementary
--    confirmation all read this one list.
-- 3. The holiday pay multiplier is set by the owner or hr only (owner decision; security L2).
-- 4. Personal numbers (security L3): private.people_bulk_reason refuses one; official_holidays'
--    name, source and reason are checked too.
-- 5. Regular allowances (money L4): payroll_adjustments.regular, set by HR on a recurring earning;
--    only those are regular pay (NSITF's base). Later instalments inherit it from their series.
-- 6. The worker's first in-app pay month (money M2): payroll_tax_context gives each worker's
--    first_pay_month; private.payroll_ytd_months mirrors src/lib/payroll/ytd.ts, and approval
--    compares the months each payslip's year_to_date step counted.
-- 7. Approval (5.9a's approve_payroll_run, two additions): the months check above, and the
--    3-month window for clawbacks again (money L5, MLYA1).
-- 8. save_payroll_results (5.9a's, one change): a pre-tax clawback is at most what the corrected
--    payslip's taxable earnings paid less what earlier corrections of it already clawed back
--    before tax on other standing runs (money L3).
-- 9. Anomaly severities: no_opening_balance and leaver_carry_unrecoverable are warnings.
-- 10. Final pay (money M1): the leave-in-lieu pre-fill takes off days on other standing runs'
--    leave_in_lieu items; a second item of a type the worker already has on another standing run
--    needs p_further_reason (MLFZ1), kept on the item.
--
-- Refusal codes MLFZ1 to MLFZ2 (no collision: grep of the migrations and src for MLFZ):
--   MLFZ1 the worker already has this kind of final-pay item on another run: confirm it is a
--         further item and say why;
--   MLFZ2 only an owner or HR can change the declared rent.

-- ---------------------------------------------------------------------------
-- 1. Declared rent, and clock stamps on the engine's other inputs
-- ---------------------------------------------------------------------------

-- Who set the declared rent now on file, and when (security review round 2, M-1): stamped on the
-- row by the guard below from the session, never taken from the writer, so the touchers list
-- reads it from here rather than from audit rows a manager could write by hand. Null for rents set
-- before slice 5.10 (no setter was recorded) and for writes by the secret key.
alter table public.workers
  add column rent_declared_by uuid,
  add column rent_declared_at timestamptz;

comment on column public.workers.rent_declared_by is
  'Slice 5.10: the signed-in user who set annual_rent_declared_kobo to its current value (null: the secret key, or set before 5.10). Stamped by workers_rent_declared_guard; read by private.payroll_run_touchers.';

-- Refuses a change to the declared rent by anyone but an owner or hr, whatever the path (the
-- Data API, a definer function acting for the signed-in user). With no signed-in user (the secret
-- key, migrations, the database owner) it is server code and allowed. Stamps who set it and when;
-- the stamp columns can't be written any other way.
create function private.workers_rent_declared_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and coalesce(new.annual_rent_declared_kobo, 0) <> 0)
    or (tg_op = 'UPDATE'
      and new.annual_rent_declared_kobo is distinct from old.annual_rent_declared_kobo) then
    if auth.uid() is not null and not (
      private.session_uid() is not null
      and private.has_role(new.organisation_id, array['owner', 'hr'])
    ) then
      raise exception 'Only an owner or HR can change the declared rent.' using errcode = 'MLFZ2';
    end if;
    new.rent_declared_by := private.session_uid();
    new.rent_declared_at := clock_timestamp();
  elsif tg_op = 'UPDATE' then
    new.rent_declared_by := old.rent_declared_by;
    new.rent_declared_at := old.rent_declared_at;
  else
    new.rent_declared_by := null;
    new.rent_declared_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.workers_rent_declared_guard() from public, anon, authenticated;

create trigger workers_rent_declared_guard before insert or update on public.workers
  for each row execute function private.workers_rent_declared_guard();
alter table public.workers enable always trigger workers_rent_declared_guard;

-- One semantic audit row per change (payroll.%: hidden from admins by 5.8's audit policy).
create function private.workers_rent_declared_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and coalesce(new.annual_rent_declared_kobo, 0) <> 0)
    or (tg_op = 'UPDATE'
      and new.annual_rent_declared_kobo is distinct from old.annual_rent_declared_kobo) then
    -- Written directly (not through log_audit_impl, which needs a signed-in manager), so the
    -- secret key's writes are audited too, with no actor.
    insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
    values (
      new.organisation_id, auth.uid(), 'payroll.rent_declared_set', 'workers', new.id,
      case when tg_op = 'UPDATE'
        then jsonb_build_object('rent_declared_kobo', old.annual_rent_declared_kobo::text) end,
      jsonb_build_object('rent_declared_kobo', new.annual_rent_declared_kobo::text)
    );
  end if;
  return null;
end;
$$;

revoke all on function private.workers_rent_declared_audit() from public, anon, authenticated;

create trigger workers_rent_declared_audit
  after insert or update of annual_rent_declared_kobo on public.workers
  for each row execute function private.workers_rent_declared_audit();
-- The touchers list reads it (security review round 2, L-a): fires in replica mode too.
alter table public.workers enable always trigger workers_rent_declared_audit;

-- Money review round 2, L1: updated_at is the statement's clock, not the transaction's start, so
-- a worker written after approval's read began is seen even when its transaction began before.
-- Fires after workers_set_updated_at (triggers fire in name order).
create function private.stamp_updated_at_clock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function private.stamp_updated_at_clock() from public, anon, authenticated;

create trigger workers_stamp_clock before insert or update on public.workers
  for each row execute function private.stamp_updated_at_clock();
alter table public.workers enable always trigger workers_stamp_clock;

-- The same for the other writes approval compares with its read (money review round 2): pay
-- rates (created_at on insert, updated_at on every write), timesheet and leave decisions and run
-- adjustments (created_at). The triggers are named to fire after every other BEFORE trigger.
create function private.stamp_created_at_clock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function private.stamp_created_at_clock() from public, anon, authenticated;

create trigger zz_stamp_clock before insert on public.timesheet_decisions
  for each row execute function private.stamp_created_at_clock();
create trigger zz_stamp_clock before insert on public.leave_decisions
  for each row execute function private.stamp_created_at_clock();
create trigger zz_stamp_clock before insert on public.payroll_adjustments
  for each row execute function private.stamp_created_at_clock();
create trigger zz_stamp_clock before insert on public.pay_rates
  for each row execute function private.stamp_created_at_clock();
create trigger zz_stamp_updated_clock before insert or update on public.pay_rates
  for each row execute function private.stamp_updated_at_clock();

-- 5.9a's private.payroll_tax_records_guard (its only version), with one change marked "Slice
-- 5.10": NHF numbers and the ITF switch are stamped clock_timestamp() (money review round 2, L1).
-- Their writers take the company's payroll tax lock exclusively before the insert, so the stamp
-- comes after any approval holding the lock shared has finished.
create or replace function private.payroll_tax_records_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'These payroll records are kept as written. Add a new one instead.'
      using errcode = 'MLYA5';
  end if;
  -- Slice 5.10: the statement's clock for the two records approval compares with its read.
  new.created_at := case
    when tg_table_name in ('payroll_nhf_numbers', 'payroll_itf_turnover') then clock_timestamp()
    else now()
  end;
  -- One branch per table, each in its own block: PL/pgSQL can't name a column the row lacks.
  if tg_table_name = 'payroll_opening_balances' then
    if new.supersedes_id is not null and not exists (
      select 1 from public.payroll_opening_balances b
      where b.organisation_id = new.organisation_id and b.id = new.supersedes_id
        and b.worker_id = new.worker_id and b.tax_year = new.tax_year
    ) then
      raise exception 'A correction names an opening balance of the same worker and tax year.'
        using errcode = 'MLYA2';
    end if;
  elsif tg_table_name = 'payroll_relief_declarations' then
    if new.supersedes_id is not null and not exists (
      select 1 from public.payroll_relief_declarations d
      where d.organisation_id = new.organisation_id and d.id = new.supersedes_id
        and d.worker_id = new.worker_id and d.tax_year = new.tax_year and d.kind = new.kind
    ) then
      raise exception 'A correction names a declaration of the same worker, tax year and relief.'
        using errcode = 'MLYA2';
    end if;
  elsif tg_table_name in ('payroll_relief_proofs', 'payroll_relief_verifications') then
    if not exists (
      select 1 from public.payroll_relief_declarations d
      where d.organisation_id = new.organisation_id and d.id = new.declaration_id
        and d.worker_id = new.worker_id
    ) then
      raise exception 'That declaration isn''t this worker''s.' using errcode = 'MLYA2';
    end if;
  end if;
  return new;
end;
$$;

-- 5.7c's public.log_audit (migration 20261122200000, its latest version), with
-- payroll.rent_declared_set added to the reserved list (marked "Slice 5.10"; security review round
-- 2, M-1): only workers_rent_declared_audit writes it. payroll.% as a whole isn't reserved
-- (payroll.relief_proof_opened is written through mutate()). The grants stand.
create or replace function public.log_audit(
  p_organisation_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_action in (
    'payroll.bank_file_downloaded', 'payroll.supplementary_file_downloaded',
    'payroll.instalment_not_carried', 'payroll.results_saved', 'payroll.run_created',
    'payroll.run_submitted', 'payroll.adjustment_added', 'payroll.adjustment_removed',
    'payroll.anomalies_acknowledged', 'payroll.instalment_carried', 'worker_auth.locked',
    'people.bank_details_single_approver',
    -- Slice 5.10.
    'payroll.rent_declared_set'
  ) then
    raise exception 'That audit event is written only by the change it records.'
      using errcode = '42501';
  end if;
  return private.log_audit_impl(
    p_organisation_id, p_action, p_entity, p_entity_id, p_before, p_after, p_reason
  );
end;
$$;

-- 5.9a's private.set_payroll_nhf_number (its only version), with one check added (marked "Slice
-- 5.10"; security review round 2, L-3): the reason mustn't hold the last 4 of the number being
-- saved, nor of the one on file (the server compares the whole numbers; the database sees only
-- ciphertext and the last 4). Letters and digits only, case ignored. The grants stand.
create or replace function private.set_payroll_nhf_number(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_id uuid,
  p_nhf_number_enc bytea,
  p_last4 text,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_tax_writer(p_organisation_id);
  v_reason text := private.payroll_tax_text(p_reason, 500);
  v_on_file text;
begin
  if p_id is null or (p_nhf_number_enc is null) <> (p_last4 is null)
    or (p_last4 is not null and p_last4 !~ '^[A-Za-z0-9/-]{1,4}$')
    or (p_nhf_number_enc is not null and octet_length(p_nhf_number_enc) not between 30 and 200) then
    raise exception 'An NHF number is 4 to 20 letters, digits, / or -.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  ) then
    raise exception 'That worker wasn''t found.' using errcode = 'P0002';
  end if;
  -- Slice 5.10: no part of the number in the reason the audit log keeps.
  select n.nhf_number_last4 into v_on_file
  from public.payroll_nhf_numbers n
  where n.organisation_id = p_organisation_id and n.worker_id = p_worker_id
  order by n.created_at desc, n.id desc
  limit 1;
  if exists (
    select 1
    from unnest(array[p_last4, v_on_file]) x(last4)
    where x.last4 is not null
      and regexp_replace(x.last4, '[^[:alnum:]]', '', 'g') <> ''
      and position(
        lower(regexp_replace(x.last4, '[^[:alnum:]]', '', 'g'))
        in lower(regexp_replace(v_reason, '[^[:alnum:]]', '', 'g'))
      ) > 0
  ) then
    raise exception 'Leave the NHF number out of the reason: the reason is kept in the audit log.'
      using errcode = '22023';
  end if;
  perform private.payroll_tax_org_lock(p_organisation_id, false);
  insert into public.payroll_nhf_numbers (
    id, organisation_id, worker_id, nhf_number_enc, nhf_number_last4, reason, created_by
  )
  values (p_id, p_organisation_id, p_worker_id, p_nhf_number_enc, p_last4, v_reason, v_uid);
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.nhf_number_set', 'payroll_nhf_numbers', p_id, null,
    jsonb_build_object(
      'worker_id', p_worker_id, 'on_file', p_last4 is not null, 'last4', p_last4
    ),
    v_reason
  );
  return p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Everyone who touched a run (rule 10)
-- ---------------------------------------------------------------------------

-- 5.2's private.payroll_run_touchers (its only version), with the tax records of the run's
-- workers added (marked "Slice 5.10"): whoever recorded an opening balance, declared a relief,
-- uploaded a proof (checked_by: the user the server named after checking the signed-in user) or
-- verified a relief for one of them in the run's tax year, whoever set the declared rent now on
-- file in that year (the row's stamp), and whoever set the NHF number now on file.
-- Each changed what the run pays, so none may approve, release, approve the reversal of or
-- confirm a supplementary file for it. No role check: definers call it.
create or replace function private.payroll_run_touchers(p_organisation_id uuid, p_run_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  with run as (
    select extract(year from r.pay_date)::integer as yr
    from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.id = p_run_id
  ),
  ws as (
    select s.worker_id from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    union
    select a.worker_id from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
  )
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
        'payroll.adjustment_added', 'payroll.adjustment_removed', 'payroll.anomalies_acknowledged',
        'payroll.instalment_carried')
    -- Slice 5.10 (security review round 2, L1): the tax records of the run's workers in its tax
    -- year.
    union all
    select b.created_by
    from public.payroll_opening_balances b, run
    where b.organisation_id = p_organisation_id and b.tax_year = run.yr
      and b.worker_id in (select worker_id from ws)
    union all
    select d.created_by
    from public.payroll_relief_declarations d, run
    where d.organisation_id = p_organisation_id and d.tax_year = run.yr
      and d.worker_id in (select worker_id from ws)
    union all
    select p.checked_by
    from public.payroll_relief_proofs p
    join public.payroll_relief_declarations d
      on d.organisation_id = p.organisation_id and d.id = p.declaration_id
    cross join run
    where p.organisation_id = p_organisation_id and d.tax_year = run.yr
      and p.worker_id in (select worker_id from ws)
    union all
    select v.created_by
    from public.payroll_relief_verifications v
    join public.payroll_relief_declarations d
      on d.organisation_id = v.organisation_id and d.id = v.declaration_id
    cross join run
    where v.organisation_id = p_organisation_id and d.tax_year = run.yr
      and v.worker_id in (select worker_id from ws)
    -- Whoever set the declared rent now on file in the run's tax year (Lagos dates), read from
    -- the row's own stamp (security review round 2, M-1), never from the audit log.
    union all
    select w.rent_declared_by
    from public.workers w, run
    where w.organisation_id = p_organisation_id and w.id in (select worker_id from ws)
      and extract(year from (w.rent_declared_at at time zone 'Africa/Lagos'))::integer = run.yr
    -- And whoever saved or removed the NHF number on file (NHF is taken only with one).
    union all
    select n.created_by
    from (
      select distinct on (nn.worker_id) nn.created_by
      from public.payroll_nhf_numbers nn
      where nn.organisation_id = p_organisation_id
        and nn.worker_id in (select worker_id from ws)
      order by nn.worker_id, nn.created_at desc, nn.id desc
    ) n
  ) t
$$;

revoke all on function private.payroll_run_touchers(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The holiday pay multiplier: owner and hr
-- ---------------------------------------------------------------------------

-- 5.9c's private.set_holiday_pay_multiplier (its only version), with the role check changed
-- (marked "Slice 5.10"; owner decision 25 Nov 2026, docs/PHASE_5.md's roles table: payroll
-- settings are written by owner and hr). The grants stand.
create or replace function private.set_holiday_pay_multiplier(
  p_organisation_id uuid,
  p_multiplier_bps integer,
  p_effective_from date,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_before integer;
  v_id uuid;
begin
  -- Slice 5.10: owner and hr only (finance reads the rate).
  if v_uid is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr']) then
    raise exception 'Only an owner or HR can set the holiday pay rate.' using errcode = '42501';
  end if;
  if p_multiplier_bps is null or p_multiplier_bps not between 10000 and 50000 then
    raise exception 'The multiplier is 1.0 to 5.0 times the overtime rate.' using errcode = '22023';
  end if;
  if p_effective_from is null or p_effective_from <= private.org_today(p_organisation_id)
    or p_effective_from > '2100-12-31'::date then
    raise exception 'A new holiday pay rate starts tomorrow or later.' using errcode = 'MLTB3';
  end if;
  if v_reason is null or private.has_personal_number(v_reason) then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  perform set_config('metalira.audit_channel', 'web', true);
  perform pg_advisory_xact_lock(hashtextextended('payroll_holiday_pay:' || p_organisation_id::text, 0));
  select h.multiplier_bps into v_before
  from public.payroll_holiday_pay_rates h
  where h.organisation_id = p_organisation_id and h.effective_from <= p_effective_from
  order by h.effective_from desc
  limit 1;
  v_before := coalesce(v_before, 10000);
  if v_before = p_multiplier_bps and not exists (
    select 1 from public.payroll_holiday_pay_rates h
    where h.organisation_id = p_organisation_id and h.effective_from = p_effective_from
  ) then
    raise exception 'That is already the holiday pay rate from that day.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.payroll_holiday_pay_rates h
    where h.organisation_id = p_organisation_id and h.effective_from = p_effective_from
  ) then
    raise exception 'A holiday pay rate already starts that day. Choose another day.'
      using errcode = 'MLTB3';
  end if;
  insert into public.payroll_holiday_pay_rates (
    organisation_id, effective_from, multiplier_bps, reason, created_by
  )
  values (p_organisation_id, p_effective_from, p_multiplier_bps, v_reason, v_uid)
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.holiday_pay_rate_added', 'payroll_holiday_pay_rates', v_id,
    jsonb_build_object('multiplier_bps', v_before),
    jsonb_build_object('multiplier_bps', p_multiplier_bps, 'effective_from', p_effective_from),
    v_reason
  );
  return jsonb_build_object(
    'id', v_id, 'before_bps', v_before, 'after_bps', p_multiplier_bps,
    'effective_from', p_effective_from
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Personal numbers in free text
-- ---------------------------------------------------------------------------

-- U.1's private.people_bulk_reason (its only version), with private.has_personal_number added
-- (marked "Slice 5.10"; security review round 2, L3): the reason goes to the audit log.
create or replace function private.people_bulk_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Give a reason for ending their employment.' using errcode = 'MLBU3';
  end if;
  if char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]' or v_reason ~* '(://|www\.)' then
    raise exception 'Keep the reason to 500 characters of plain text, without web addresses.'
      using errcode = 'MLBU3';
  end if;
  -- Slice 5.10: no personal numbers (10 or more digits, or an RSA PIN).
  if private.has_personal_number(v_reason) then
    raise exception 'Leave personal numbers out of the reason (10 or more digits, or an RSA PIN).'
      using errcode = 'MLBU3';
  end if;
  return v_reason;
end;
$$;

-- The official holiday calendar is read by every signed-in user, so its free text never holds a
-- personal number (security review round 2, L3). The seeded rows pass.
alter table public.official_holidays
  add constraint official_holidays_name_no_personal_number
    check (not private.has_personal_number(name)),
  add constraint official_holidays_source_no_personal_number
    check (not private.has_personal_number(source)),
  add constraint official_holidays_reason_no_personal_number
    check (not private.has_personal_number(reason));

-- ---------------------------------------------------------------------------
-- 5. Regular allowances (NSITF's base)
-- ---------------------------------------------------------------------------

-- Money review round 2, L4: an explicit flag, set by HR on a recurring earning (2 or more
-- instalments). Only flagged adjustments are regular monthly pay; a bonus or arrears paid in
-- instalments is irregular. src/lib/payroll/run.ts adjustmentLines reads it.
alter table public.payroll_adjustments add column regular boolean not null default false;
alter table public.payroll_adjustments
  add constraint payroll_adjustments_regular_shape check (
    not regular or (
      kind = 'earning' and instalment_count > 1 and corrects_payslip_id is null
      and final_pay_item_id is null
    )
  );

comment on column public.payroll_adjustments.regular is
  'A recurring allowance HR marked as regular monthly pay (slice 5.10): in NSITF''s base. Only an earning over 2 or more instalments; later instalments inherit it from their series.';

-- A later instalment (carried, or re-created after a reversal) keeps its series' flag, whatever
-- the inserting function wrote.
create function private.payroll_adjustments_series_regular()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_regular boolean;
begin
  if new.series_id is distinct from new.id then
    select a.regular into v_regular
    from public.payroll_adjustments a
    where a.organisation_id = new.organisation_id and a.series_id = new.series_id
      and a.id <> new.id
    order by a.instalment_number, a.created_at
    limit 1;
    if found then
      new.regular := v_regular;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_adjustments_series_regular() from public, anon, authenticated;

create trigger payroll_adjustments_series_regular before insert on public.payroll_adjustments
  for each row execute function private.payroll_adjustments_series_regular();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_series_regular;

-- 5.2's add_payroll_adjustment (its only version), with p_regular added (marked "Slice 5.10").
-- The signature changes, so the old one goes.
drop function public.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text
);
drop function private.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text
);

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
  p_reason text,
  p_regular boolean default false
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
  -- Slice 5.10: a recurring allowance is an earning over 2 or more instalments.
  if coalesce(p_regular, false) and (p_kind <> 'earning' or p_instalments < 2) then
    raise exception 'Only an earning over 2 or more instalments is a recurring allowance.'
      using errcode = '22023';
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
    series_id, instalment_number, instalment_count, reason, created_by, regular
  )
  values (
    v_id, p_organisation_id, p_run_id, p_worker_id, p_kind, v_label, v_amount,
    p_kind = 'earning' and coalesce(p_pensionable, false),
    p_kind = 'earning' and coalesce(p_taxable, true),
    v_id, 1, p_instalments, v_reason, v_uid, coalesce(p_regular, false)
  );
  update public.payroll_runs r set needs_recalculation = true where r.id = p_run_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.adjustment_added', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'adjustment_id', v_id, 'worker_id', p_worker_id, 'kind', p_kind, 'label', v_label,
      'amount_kobo', v_amount::text, 'instalments', p_instalments,
      'regular', coalesce(p_regular, false)
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text, boolean
) from public, anon;
grant execute on function private.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text, boolean
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
  p_reason text,
  p_regular boolean default false
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_payroll_adjustment(
    p_organisation_id, p_run_id, p_worker_id, p_kind, p_label, p_amount_kobo, p_pensionable,
    p_taxable, p_instalments, p_reason, p_regular
  )
$$;

revoke all on function public.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text, boolean
) from public, anon;
grant execute on function public.add_payroll_adjustment(
  uuid, uuid, uuid, text, text, text, boolean, boolean, integer, text, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The worker's first in-app pay month and the months elapsed
-- ---------------------------------------------------------------------------

-- The first month of the worker's earliest standing payslip in Metalira, any year (runs approved
-- or released, not reversals, not p_run_id); null before the first. No role check: definers call
-- it.
create function private.payroll_first_pay_month(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_run_id uuid
)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select date_trunc('month', min(x.pay_date))::date
  from public.payslips o
  join public.payroll_runs x on x.organisation_id = o.organisation_id and x.id = o.run_id
  where o.organisation_id = p_organisation_id and o.worker_id = p_worker_id
    and x.kind <> 'reversal' and x.status in ('approved', 'released')
    and (p_run_id is null or o.run_id <> p_run_id)
$$;

revoke all on function private.payroll_first_pay_month(uuid, uuid, uuid) from public, anon, authenticated;

-- The months elapsed in the tax year that src/lib/payroll/ytd.ts yearToDateFor counts for a
-- payslip of p_run_id (money review round 2, M2): from the later of 1 January, the start date
-- and, without an opening balance in force, the worker's first in-app pay month (this payslip's
-- when it is the first, or later); from the month after the latest exempt payslip (a daily
-- worker's under a rule set that exempted them); never after the pay date's month; to the pay
-- date's month or a later counted payslip's. No role check: definers call it.
create function private.payroll_ytd_months(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_pay_date date,
  p_run_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_year integer := extract(year from p_pay_date)::integer;
  v_pay_month integer := extract(month from p_pay_date)::integer;
  v_start integer := 1;
  v_joined date;
  v_first date;
  v_opening uuid;
  v_as_of date;
  v_exempt integer;
  v_last integer;
begin
  select w.start_date into v_joined
  from public.workers w
  where w.organisation_id = p_organisation_id and w.id = p_worker_id;
  if v_joined is not null then
    if extract(year from v_joined)::integer = v_year then
      v_start := greatest(v_start, extract(month from v_joined)::integer);
    elsif extract(year from v_joined)::integer > v_year then
      v_start := v_pay_month;
    end if;
  end if;
  select b.id, b.as_of_month into v_opening, v_as_of
  from private.payroll_opening_in_force(p_organisation_id, p_worker_id, v_year) b
  where b.id is not null;
  if v_opening is null then
    v_first := private.payroll_first_pay_month(p_organisation_id, p_worker_id, p_run_id);
    if v_first is null or v_first > date_trunc('month', p_pay_date)::date then
      v_first := date_trunc('month', p_pay_date)::date;
    end if;
    if extract(year from v_first)::integer = v_year then
      v_start := greatest(v_start, extract(month from v_first)::integer);
    end if;
  end if;
  with slips as (
    select x.pay_date,
      (o.employment_type = 'daily' and exists (
        select 1 from public.tax_rule_sets t
        where t.organisation_id = x.organisation_id and t.id = x.rule_set_id
          and t.rules ->> 'daily_workers_exempt' = 'true'
      )) as exempt
    from public.payslips o
    join public.payroll_runs x on x.organisation_id = o.organisation_id and x.id = o.run_id
    where o.organisation_id = p_organisation_id and o.worker_id = p_worker_id
      and o.run_id <> p_run_id
      and x.kind <> 'reversal' and x.status in ('approved', 'released')
      and extract(year from x.pay_date)::integer = v_year
  )
  select
    max(extract(month from s.pay_date)::integer) filter (where s.exempt),
    max(extract(month from s.pay_date)::integer) filter (
      where not s.exempt
        and (v_as_of is null or s.pay_date >= (v_as_of + interval '1 month')::date)
    )
  into v_exempt, v_last
  from slips s;
  if v_exempt is not null then
    v_start := greatest(v_start, v_exempt + 1);
  end if;
  v_start := least(v_start, v_pay_month);
  return greatest(v_pay_month, coalesce(v_last, v_pay_month)) - v_start + 1;
end;
$$;

revoke all on function private.payroll_ytd_months(uuid, uuid, date, uuid) from public, anon, authenticated;

-- 5.9a's private.payroll_tax_context (its only version), with first_pay_month added per worker
-- (marked "Slice 5.10"). The grants stand.
create or replace function private.payroll_tax_context(
  p_organisation_id uuid,
  p_pay_date date,
  p_worker_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_year integer := extract(year from p_pay_date)::integer;
begin
  perform private.require_payroll_reader(p_organisation_id);
  if p_pay_date is null then
    raise exception 'Choose the pay date.' using errcode = '22023';
  end if;
  if p_worker_ids is null or cardinality(p_worker_ids) > 5000 then
    raise exception 'Name up to 5,000 workers.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'version', 1,
    'headcount', (
      select count(*)::integer from public.workers w
      where w.organisation_id = p_organisation_id
        and w.start_date <= p_pay_date and (w.end_date is null or w.end_date >= p_pay_date)
    ),
    'itf_turnover_over_50m', private.itf_turnover_on(p_organisation_id, p_pay_date),
    'go_live_month', (
      select to_char(date_trunc('month', min(r.pay_date)), 'YYYY-MM-DD')
      from public.payroll_runs r
      where r.organisation_id = p_organisation_id and r.kind <> 'reversal'
        and r.status in ('approved', 'released')
    ),
    'workers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'worker_id', w.id,
          'has_nhf_number', coalesce((
            select n.nhf_number_enc is not null from public.payroll_nhf_numbers n
            where n.organisation_id = w.organisation_id and n.worker_id = w.id
            order by n.created_at desc, n.id desc
            limit 1
          ), false),
          'rent_declared_kobo', coalesce(w.annual_rent_declared_kobo, 0)::text,
          -- Slice 5.10 (money review round 2, M2): the worker's first in-app pay month.
          'first_pay_month', to_char(
            private.payroll_first_pay_month(w.organisation_id, w.id, null), 'YYYY-MM-DD'
          ),
          'opening', (
            select jsonb_build_object(
              'id', b.id, 'as_of_month', b.as_of_month,
              'gross_kobo', b.ytd_gross_kobo::text,
              'chargeable_kobo', b.ytd_chargeable_kobo::text,
              'paye_kobo', b.ytd_paye_kobo::text, 'pension_kobo', b.ytd_pension_kobo::text
            )
            from private.payroll_opening_in_force(w.organisation_id, w.id, v_year) b
            where b.id is not null
          ),
          'reliefs', coalesce((
            select jsonb_agg(
              jsonb_build_object('id', r.id, 'kind', r.kind, 'annual_kobo', r.annual_amount_kobo::text)
              order by r.id::text collate "C"
            )
            from private.payroll_verified_reliefs(w.organisation_id, w.id, v_year) r
          ), '[]'::jsonb)
        )
        order by w.id::text collate "C"
      )
      from public.workers w
      where w.organisation_id = p_organisation_id and w.id = any (p_worker_ids)
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Approval
-- ---------------------------------------------------------------------------

-- The moment this migration ran (money review round 2, L2): the engine's cap base, months elapsed
-- and NSITF base change output without changing a run's inputs hash, so a run worked out before
-- it is sent back to HR at approval (MLPRD) instead of being approved on the old rules. Written
-- as a constant at migration time.
do $do$
begin
  execute format(
    'create function private.payroll_fixup2_at() returns timestamptz language sql immutable '
    'set search_path = '''' as %L',
    'select ' || quote_literal(clock_timestamp()::text) || '::timestamptz'
  );
end;
$do$;

revoke all on function private.payroll_fixup2_at() from public, anon, authenticated;

-- 5.9a's approve_payroll_run (migration 20261122230000, its latest version), with two additions
-- marked "Slice 5.10": the months each payslip's year_to_date step counted are checked, and the
-- 3-month overpayment window is checked again. Everything else is as it was. The grants stand.
-- (5.9a's own MLPRE check of opening-balance recorders and relief verifiers stays; the wider
-- private.payroll_run_touchers above now covers it too.)
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
  v_year_start date;
  v_year_end date;
begin
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'review' then
    raise exception 'Only a run waiting for approval is approved.' using errcode = 'MLPRD';
  end if;
  if v_uid = any (private.payroll_run_touchers(p_organisation_id, p_run_id)) then
    raise exception 'You prepared or changed this run, so a different person must approve it.'
      using errcode = 'MLPRE';
  end if;
  -- Slice 5.9a (security review M3): whoever recorded an opening balance in force, or verified a
  -- relief in force, for one of the run's workers in its tax year changed what the run pays.
  if exists (
    select 1
    from public.payslips s
    cross join lateral private.payroll_opening_in_force(
      p_organisation_id, s.worker_id, extract(year from v_run.pay_date)::integer
    ) b
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id and b.created_by = v_uid
  ) or exists (
    select 1
    from public.payslips s
    cross join lateral private.payroll_verified_reliefs(
      p_organisation_id, s.worker_id, extract(year from v_run.pay_date)::integer
    ) r
    join public.payroll_relief_verifications v
      on v.organisation_id = p_organisation_id and v.declaration_id = r.id
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      and v.created_by = v_uid
  ) then
    raise exception 'You prepared or changed this run, so a different person must approve it.'
      using errcode = 'MLPRE';
  end if;
  if v_run.needs_recalculation or v_run.calculated_at is null or v_run.inputs_sha256 is null then
    raise exception 'The run needs recalculating. Return it to HR.' using errcode = 'MLPRD';
  end if;
  -- Slice 5.10 (money review round 2, L2): worked out before the engine changed.
  if v_run.calculated_at < private.payroll_fixup2_at() then
    raise exception 'The run was worked out before the payroll engine changed on 25 Nov 2026. Return it to HR to recalculate.'
      using errcode = 'MLPRD';
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

  -- Slice 5.9a: cumulative year-to-date PAYE (tax adviser) reads every standing payslip of the
  -- worker in the tax year (the calendar year of the pay date), the opening balance in force and
  -- the verified reliefs; it replaces 5.7b's month aggregate, so 5.8's month lock becomes a tax
  -- year lock. Approvals take one lock per (company, worker, tax year), in worker order, after
  -- the leave locks; writers of a worker's opening balance or reliefs take the same lock (one
  -- each, so no cycle). Then this approval is refused if another run's payslip for one of its
  -- workers in the year was approved after the read began, or if the year's standing payslips,
  -- the opening balance in force or the verified reliefs aren't the ones each payslip's PAYE
  -- counted (its trace's year_to_date step, by the server's rule: with an opening balance, only
  -- payslips paid after its as-of month count). That also covers a write whose transaction began
  -- before the read and committed after it, which a timestamp can't show.
  v_year_start := date_trunc('year', v_run.pay_date)::date;
  v_year_end := (v_year_start + interval '1 year')::date;
  -- Shared with writers of NHF numbers and the ITF switch, who take it exclusively (money L1).
  perform private.payroll_tax_org_lock(p_organisation_id, true);
  for v_worker in
    select distinct s.worker_id from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    order by s.worker_id
  loop
    perform private.payroll_year_lock(
      p_organisation_id, v_worker, extract(year from v_run.pay_date)::integer
    );
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
      and x.pay_date >= v_year_start and x.pay_date < v_year_end
      and x.approved_at > v_check.read_started_at
  ) or exists (
    with mine as (
      select s.worker_id,
        (
          select st from jsonb_array_elements(
            case when jsonb_typeof(s.trace -> 'steps') = 'array' then s.trace -> 'steps'
              else '[]'::jsonb end
          ) st
          where st ->> 'step' = 'year_to_date'
          limit 1
        ) as ytd
      from public.payslips s
      where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    )
    select 1
    from mine m
    left join lateral (
      select b.id, b.as_of_month
      from private.payroll_opening_in_force(
        p_organisation_id, m.worker_id, extract(year from v_run.pay_date)::integer
      ) b
      where b.id is not null
    ) ob on true
    -- Only payslips the bands ran on (an exempt daily worker's under NTA 2025 v1 has no step).
    where m.ytd is not null and (
      coalesce(m.ytd -> 'inputs' ->> 'opening_balance_id', '') <> coalesce(ob.id::text, '')
      or coalesce(m.ytd -> 'inputs' ->> 'relief_ids', '')
        <> private.payroll_verified_relief_ids(
          p_organisation_id, m.worker_id, extract(year from v_run.pay_date)::integer
        )
      -- Slice 5.10 (money review round 2, M2): and the months elapsed it counted (from the
      -- worker's first in-app pay month without an opening balance), by the server's rule.
      or coalesce(m.ytd -> 'inputs' ->> 'months', '')
        <> private.payroll_ytd_months(p_organisation_id, m.worker_id, v_run.pay_date, p_run_id)::text
      or (case when (m.ytd -> 'inputs' ->> 'payslips') ~ '^[0-9]{1,4}$'
          then (m.ytd -> 'inputs' ->> 'payslips')::integer else -1 end)
        <> (
          select count(*)::integer
          from public.payslips o
          join public.payroll_runs x on x.organisation_id = o.organisation_id and x.id = o.run_id
          where o.organisation_id = p_organisation_id and o.worker_id = m.worker_id
            and o.run_id <> p_run_id
            and x.kind <> 'reversal' and x.status in ('approved', 'released')
            and x.pay_date >= v_year_start and x.pay_date < v_year_end
            and (ob.as_of_month is null
              or x.pay_date >= (ob.as_of_month + interval '1 month')::date)
            -- A daily worker's payslip under a rule set that exempted them isn't in the year (the
            -- server's rule: a later rule set never taxes months a dated rule exempted).
            and not (o.employment_type = 'daily' and exists (
              select 1 from public.tax_rule_sets t
              where t.organisation_id = x.organisation_id and t.id = x.rule_set_id
                and t.rules ->> 'daily_workers_exempt' = 'true'
            ))
        )
    )
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  -- Slice 5.9a (money review M5): an opening balance covering the pay date's month would count it
  -- twice.
  if exists (
    select 1
    from public.payslips s
    cross join lateral private.payroll_opening_in_force(
      p_organisation_id, s.worker_id, extract(year from v_run.pay_date)::integer
    ) b
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      and b.as_of_month >= date_trunc('month', v_run.pay_date)::date
  ) then
    raise exception 'An opening balance covers this run''s pay-date month. Correct it to an earlier month, then recalculate.'
      using errcode = 'MLYA6';
  end if;
  -- Slice 5.10 (money review round 2, L5): the overpayment window again at approval, measured as
  -- add_payroll_correction measures it (the corrected payslip's pay date against today less the
  -- rule set's months), so a correction that aged past it while waiting isn't approved.
  if exists (
    select 1
    from public.payroll_adjustments a
    join public.payslips cs
      on cs.organisation_id = a.organisation_id and cs.id = a.corrects_payslip_id
    join public.payroll_runs cr on cr.organisation_id = cs.organisation_id and cr.id = cs.run_id
    join public.tax_rule_sets t
      on t.organisation_id = p_organisation_id and t.id = v_run.rule_set_id
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id and a.kind = 'deduction'
      and (t.rules #>> '{adviser,clawback,max_age_months}') ~ '^[0-9]{1,3}$'
      and cr.pay_date < (
        private.org_today(p_organisation_id)
        - make_interval(months => (t.rules #>> '{adviser,clawback,max_age_months}')::integer)
      )::date
  ) then
    raise exception 'An overpayment this run deducts was paid longer ago than the rule set''s overpayment window, so it can''t be deducted from wages (Labour Act s.5(5)). Remove it and recover it another way, outside payroll.'
      using errcode = 'MLYA1';
  end if;
  -- Slice 5.10 (money review round 2, L3): the clawbacks of a corrected payslip, this run's and
  -- other standing runs' together, are at most what its taxable earnings paid (save checks it
  -- too; this catches a run saved at the same moment as another).
  if exists (
    select 1
    from (
      select a.corrects_payslip_id as slip, -sum(l.amount_kobo) as taken
      from public.payroll_adjustments a
      join public.payslip_sources o
        on o.organisation_id = a.organisation_id and o.source_kind = 'adjustment'
          and o.source_id = a.id and o.run_id = p_run_id
      join public.payslip_lines l
        on l.organisation_id = o.organisation_id and l.payslip_id = o.payslip_id
          and l.position = any (o.line_positions) and l.code = 'clawback'
      where a.organisation_id = p_organisation_id and a.run_id = p_run_id
        and a.kind = 'deduction' and a.corrects_payslip_id is not null
      group by a.corrects_payslip_id
    ) c
    where c.taken + private.payroll_clawed_back_kobo(p_organisation_id, c.slip, p_run_id)
      > coalesce((
        select sum(cl.amount_kobo) from public.payslip_lines cl
        where cl.organisation_id = p_organisation_id and cl.payslip_id = c.slip
          and cl.kind = 'earning' and cl.taxable
      ), 0)
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  -- Slice 5.9a (money review L1, security review M4): the engine's other inputs written after the
  -- read began: an NHF number of one of the run's workers, the ITF switch, or any worker of the
  -- company (headcount, start and end dates, declared rent).
  if exists (
    select 1 from public.payroll_nhf_numbers n
    where n.organisation_id = p_organisation_id and n.created_at > v_check.read_started_at
      and n.worker_id in (
        select s.worker_id from public.payslips s
        where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      )
  ) or exists (
    select 1 from public.payroll_itf_turnover t
    where t.organisation_id = p_organisation_id and t.created_at > v_check.read_started_at
  ) or exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.updated_at > v_check.read_started_at
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

-- ---------------------------------------------------------------------------
-- 8. Saving results: clawbacks cumulative per corrected payslip
-- ---------------------------------------------------------------------------

-- What earlier corrections of p_payslip_id clawed back before tax on runs other than p_run_id
-- whose payslips stand (their adjustment sources: freed when a run is reversed), in kobo. No role
-- check: definers call it.
create function private.payroll_clawed_back_kobo(
  p_organisation_id uuid,
  p_payslip_id uuid,
  p_run_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(-sum(l.amount_kobo), 0)::bigint
  from public.payroll_adjustments a
  join public.payslip_sources o
    on o.organisation_id = a.organisation_id and o.source_kind = 'adjustment'
      and o.source_id = a.id and o.stands and o.run_id <> p_run_id
  join public.payslip_lines l
    on l.organisation_id = o.organisation_id and l.payslip_id = o.payslip_id
      and l.position = any (o.line_positions) and l.code = 'clawback'
  where a.organisation_id = p_organisation_id and a.corrects_payslip_id = p_payslip_id
    and a.kind = 'deduction'
$$;

revoke all on function private.payroll_clawed_back_kobo(uuid, uuid, uuid) from public, anon, authenticated;

-- 5.9a's private.save_payroll_results (migration 20261122230000, its latest version), copied
-- exactly except for the one change marked "Slice 5.10" (the pre-tax clawback cap is cumulative
-- per corrected payslip). The grants stand.
create or replace function private.save_payroll_results(
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
  -- Slice 5.7c: a leave refund pays back exactly what the leave deduction took.
  v_refund bigint;
  v_owed bigint;
  v_mismatch boolean;
  -- Slice 5.10 (L3): this run's clawbacks so far per corrected payslip.
  v_clawed jsonb := '{}'::jsonb;
  v_corrected uuid;
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
  -- Slice 5.10 (money review round 2, L3): one run at a time per corrected payslip, in uuid
  -- order, so two runs saving clawbacks of the same payslip can't both use the same room.
  for v_corrected in
    select distinct a.corrects_payslip_id from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
      and a.kind = 'deduction' and a.corrects_payslip_id is not null
    order by a.corrects_payslip_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('payroll_clawback:' || v_corrected::text, 0));
  end loop;

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
      -- Slice 5.9a: a pre-tax clawback is negative, as a leave deduction.
      v_amount := private.payroll_kobo(
        v_line -> 'amount_kobo', v_code in ('leave_deduction', 'clawback'), 'a line''s amount'
      );
      if jsonb_typeof(v_line -> 'pensionable') <> 'boolean'
        or jsonb_typeof(v_line -> 'taxable') <> 'boolean'
        or jsonb_typeof(v_line -> 'sources') <> 'array' then
        raise exception 'A payslip line isn''t in the expected shape.' using errcode = 'MLPR6';
      end if;
      begin
        -- Slice 5.9a: an earning line's regular flag (NSITF's base), as the engine decided it.
        insert into public.payslip_lines (
          organisation_id, payslip_id, run_id, position, code, kind, label, amount_kobo,
          pensionable, taxable, regular
        )
        values (
          p_organisation_id, v_slip_id, p_run_id, v_pos, v_code, v_kind, v_line ->> 'label',
          v_amount, (v_line ->> 'pensionable')::boolean, (v_line ->> 'taxable')::boolean,
          case when v_kind = 'earning' and jsonb_typeof(v_line -> 'regular') = 'boolean'
            then (v_line ->> 'regular')::boolean end
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

      -- Slice 5.9a: a clawback line pays exactly one adjustment too.
      if v_code in ('adjustment_earning', 'deduction', 'clawback') and not (
        jsonb_array_length(v_line -> 'sources') = 1
        and v_line -> 'sources' -> 0 ->> 'kind' = 'adjustment'
      ) then
        raise exception 'An adjustment line pays exactly one adjustment.' using errcode = 'MLPR6';
      end if;
      -- Slice 5.7c: a leave refund line pays exactly one refund, and only refund lines pay one.
      if v_code = 'leave_refund' and not (
        jsonb_array_length(v_line -> 'sources') = 1
        and v_line -> 'sources' -> 0 ->> 'kind' = 'leave_refund'
      ) then
        raise exception 'A leave refund line pays exactly one refund.' using errcode = 'MLPR6';
      end if;
      if v_code <> 'leave_refund' and exists (
        select 1 from jsonb_array_elements(v_line -> 'sources') x where x ->> 'kind' = 'leave_refund'
      ) then
        raise exception 'Only a leave refund line pays a refund.' using errcode = 'MLPR6';
      end if;
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
          -- Slice 5.7c: leave cancelled after a posted payslip deducted these days; the refund
          -- names the deduction's exact days.
          when 'leave_refund' then exists (
            select 1 from public.leave_requests q
            where q.organisation_id = p_organisation_id and q.id = v_src_id
              and q.worker_id = v_worker and q.status = 'cancelled'
          ) and exists (
            select 1
            from public.payslip_sources o
            join public.payroll_runs orun
              on orun.organisation_id = o.organisation_id and orun.id = o.run_id
            where o.organisation_id = p_organisation_id and o.source_kind = 'leave_request'
              and o.source_id = v_src_id and o.worker_id = v_worker and o.stands
              and o.run_id <> p_run_id and orun.status in ('approved', 'released')
              and orun.kind = 'regular'
              and o.from_date = v_from and o.to_date = v_to
          )
          else false
        end) then
          raise exception 'A payslip pays a source that isn''t this worker''s to pay (%).', v_src_kind
            using errcode = 'MLPR6';
        end if;
        if v_src_kind = 'adjustment' then
          select a.* into v_adj from public.payroll_adjustments a
          where a.organisation_id = p_organisation_id and a.id = v_src_id;
          if not (
            (v_code = 'adjustment_earning' and v_adj.kind = 'earning' and v_amount = v_adj.amount_kobo
              -- Slice 5.10 (L4): regular pay only when HR marked the allowance regular.
              and coalesce((v_line ->> 'regular')::boolean, false) = v_adj.regular)
            or (v_code = 'deduction' and v_adj.kind = 'deduction' and v_amount <= v_adj.amount_kobo)
            -- Slice 5.9a: a deduction correcting an earning of a payslip in the same tax year as
            -- this run, recovered before tax up to what that payslip's taxable earnings paid (the
            -- rest carried after tax: money review M2, M6; security review L1), with the
            -- correction's pensionable flag (add_payroll_correction checks it against the
            -- corrected payslip's pensionable pay).
            or (v_code = 'clawback' and v_adj.kind = 'deduction'
              and v_adj.corrects_payslip_id is not null
              and v_amount <= 0
              and -v_amount <= least(v_adj.amount_kobo, greatest(coalesce((
                select sum(cl.amount_kobo)
                from public.payslip_lines cl
                where cl.organisation_id = p_organisation_id
                  and cl.payslip_id = v_adj.corrects_payslip_id
                  and cl.kind = 'earning' and cl.taxable
              ), 0)
                -- Slice 5.10 (money review round 2, L3): less what earlier corrections of the
                -- same payslip clawed back before tax on other runs whose payslips stand.
                - private.payroll_clawed_back_kobo(
                  p_organisation_id, v_adj.corrects_payslip_id, p_run_id
                )
                -- and less this run's earlier clawbacks of it.
                - coalesce((v_clawed ->> v_adj.corrects_payslip_id::text)::bigint, 0), 0))
              and exists (
                select 1
                from public.payslips cs
                join public.payroll_runs cr
                  on cr.organisation_id = cs.organisation_id and cr.id = cs.run_id
                where cs.organisation_id = p_organisation_id and cs.id = v_adj.corrects_payslip_id
                  and extract(year from cr.pay_date) = extract(year from v_run.pay_date)
              )
              and (v_line ->> 'pensionable')::boolean = v_adj.pensionable
              and (v_line ->> 'taxable')::boolean)
          ) then
            raise exception 'A payslip line doesn''t pay its adjustment''s amount.' using errcode = 'MLPR6';
          end if;
          if v_code = 'clawback' then
            v_clawed := jsonb_set(
              v_clawed, array[v_adj.corrects_payslip_id::text],
              to_jsonb(coalesce((v_clawed ->> v_adj.corrects_payslip_id::text)::bigint, 0) - v_amount)
            );
          end if;
        end if;
        -- Slice 5.7c (money review H1): keyed by kind, id and days, so one leave request can back
        -- this period's leave and an earlier period's arrears on one payslip.
        v_key := v_src_kind || ':' || v_src_id::text || ':' || v_from::text || ':' || v_to::text;
        if v_src_kind = 'adjustment' and v_sources ? v_key then
          raise exception 'An adjustment is paid on two lines.' using errcode = 'MLPR6';
        end if;
        if v_sources ? v_key then
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
      -- Slice 5.7c: a refund is exactly what the deduction took, never more.
      if v_src ->> 'kind' = 'leave_refund' then
        -- Line by line (money review L3): the refund's lines, in order, pay back the posted lines
        -- in order; a leave deduction's earning line with its own taxable and pensionable flags, an
        -- after-tax leave arrears line outside tax and pension.
        with mine as (
          select l.amount_kobo, l.taxable, l.pensionable,
            row_number() over (order by l.position) as n
          from public.payslip_lines l
          where l.organisation_id = p_organisation_id and l.payslip_id = v_slip_id
            and l.position in (select x::integer from jsonb_array_elements_text(v_src -> 'positions') x)
        ),
        -- Slice 5.9a: a pre-tax leave deduction cut to fit (money review M2) carried its rest after
        -- tax; its refund pays that rest back after tax, after the pre-tax lines, so the worker
        -- nets ₦0 for the cancelled days (5.7c's case D under NTA 2025 v2).
        posted as (
          select ol.*
          from public.payslip_sources o
          join public.payroll_runs orun
            on orun.organisation_id = o.organisation_id and orun.id = o.run_id
          join public.payslip_lines ol
            on ol.organisation_id = o.organisation_id and ol.payslip_id = o.payslip_id
              and ol.position = any (o.line_positions)
              and ol.code in ('leave_deduction', 'leave_arrears')
          where o.organisation_id = p_organisation_id and o.source_kind = 'leave_request'
            and o.source_id = (v_src ->> 'id')::uuid and o.worker_id = v_worker and o.stands
            and o.run_id <> p_run_id and orun.status in ('approved', 'released')
            and orun.kind = 'regular'
            and o.from_date = (v_src ->> 'from')::date and o.to_date = (v_src ->> 'to')::date
        ),
        expected as (
          select 0 as grp, p.position,
            case
              when p.code = 'leave_arrears'
                then coalesce(
                  private.leave_arrears_wanted(p.organisation_id, p.payslip_id, p.label),
                  p.amount_kobo
                )
              else -p.amount_kobo
            end as amount_kobo,
            case when p.code = 'leave_arrears' then false else p.taxable end as taxable,
            case when p.code = 'leave_arrears' then false else p.pensionable end as pensionable
          from posted p
          union all
          select 1 as grp, p.position,
            private.recovery_carried_kobo(p.organisation_id, p.payslip_id, p.label),
            false, false
          from posted p
          where p.code = 'leave_deduction'
        ),
        theirs as (
          select e.amount_kobo, e.taxable, e.pensionable,
            row_number() over (order by e.grp, e.position) as n
          from expected e
          where e.amount_kobo > 0
        )
        -- One statement: the CTEs above are visible to it alone.
        select coalesce((select sum(amount_kobo) from mine), 0),
               coalesce((select sum(amount_kobo) from theirs), 0),
               exists (
                 select 1 from mine m full join theirs t on t.n = m.n
                 where m.n is null or t.n is null
                   or m.amount_kobo <> t.amount_kobo
                   or m.taxable <> t.taxable or m.pensionable <> t.pensionable
               )
        into v_refund, v_owed, v_mismatch;
        if v_refund <= 0 or v_refund <> v_owed or v_mismatch then
          raise exception 'A leave refund isn''t what the leave deduction took.' using errcode = 'MLPR6';
        end if;
      end if;
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

-- ---------------------------------------------------------------------------
-- 9. Anomaly severities
-- ---------------------------------------------------------------------------

-- 5.9a's private.payroll_anomaly_severity (its latest version), with two warnings added.
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
      'leave_correction_pending', 'carry_settled_later', 'refund_uncollected_carry',
      'deduction_capped', 'paye_overwithheld', 'nhf_not_deducted', 'rent_relief_unverified',
      'paye_not_withheld', 'recovery_carried',
      -- Slice 5.10 (money review round 2, M2 and M3).
      'no_opening_balance', 'leaver_carry_unrecoverable'
    ) then 'warning'
  end
$$;

-- ---------------------------------------------------------------------------
-- 10. Final pay paid once (money review round 2, M1)
-- ---------------------------------------------------------------------------

-- Why a second item of a type the worker already has on another standing run was added.
alter table public.payroll_final_pay_items
  add column further_reason text
    constraint payroll_final_pay_items_further_reason_text check (
      further_reason = btrim(further_reason) and char_length(further_reason) between 1 and 500
      and further_reason !~ '[\x01-\x1f\x7f-\x9f<>]' and further_reason !~* '(://|www\.)'
      and not private.has_personal_number(further_reason)
    );

comment on column public.payroll_final_pay_items.further_reason is
  'Slice 5.10: why this item was added although the worker already had one of the same type on another standing run (not discarded, not reversed), so it isn''t the same item paid twice.';

-- 5.9c's private.payroll_leave_in_lieu (its only version), with p_run_id added (marked "Slice
-- 5.10"): days on leave_in_lieu items of the worker on other standing runs (not this one, not
-- discarded, not reversed, not a reversal; drafts included) come off the pre-fill, so two
-- final-pay runs don't pay the same untaken leave. The signature changes, so the old one goes;
-- its only callers, payroll_final_pay_prefill and add_final_pay_item, are replaced below.
drop function private.payroll_leave_in_lieu(uuid, uuid, date, date);

create function private.payroll_leave_in_lieu(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_start date,
  p_end date,
  p_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type uuid;
  v_year integer := extract(year from p_end)::integer;
  v_entitlement integer;
  v_months integer;
  v_service integer;
  v_taken integer;
  v_elsewhere integer;
  v_days integer;
begin
  select t.id into v_type from public.leave_types t
  where t.organisation_id = p_organisation_id and t.code = 'annual' and t.status = 'active';
  if v_type is null then
    return null;
  end if;
  select e.days_per_year into v_entitlement
  from public.leave_entitlements e
  where e.organisation_id = p_organisation_id and e.leave_type_id = v_type
    and e.effective_from <= p_end and (e.effective_to is null or e.effective_to >= p_end)
  order by e.effective_from desc
  limit 1;
  v_entitlement := coalesce(v_entitlement, 0);
  v_service := private.payroll_complete_months(p_start, p_end);
  v_months := private.payroll_complete_months(greatest(p_start, make_date(v_year, 1, 1)), p_end);
  select greatest(-coalesce(sum(l.days), 0), 0)::integer into v_taken
  from public.leave_ledger l
  where l.organisation_id = p_organisation_id and l.worker_id = p_worker_id
    and l.leave_type_id = v_type and l.leave_year = v_year
    and l.kind in ('taken', 'returned');
  -- Slice 5.10: leave in lieu already on another standing final-pay run.
  select coalesce(sum(i.days), 0)::integer into v_elsewhere
  from public.payroll_final_pay_items i
  join public.payroll_runs ir on ir.organisation_id = i.organisation_id and ir.id = i.run_id
  where i.organisation_id = p_organisation_id and i.worker_id = p_worker_id
    and i.item_type = 'leave_in_lieu'
    and ir.id is distinct from p_run_id
    and ir.status <> 'reversed' and ir.kind <> 'reversal' and ir.discarded_at is null
    -- The same leave year: a run whose period ends in it (money review round 2, L-B).
    and extract(year from ir.period_end)::integer = v_year;
  v_days := case
    when v_service < 6 then 0
    else greatest(floor(v_entitlement * v_months / 12.0)::integer - v_taken - v_elsewhere, 0)
  end;
  return jsonb_build_object(
    'entitlement_days', v_entitlement, 'months_in_year', v_months, 'taken_days', v_taken,
    'service_months', v_service, 'paid_elsewhere_days', v_elsewhere, 'days', v_days,
    'year', v_year
  );
end;
$$;

revoke all on function private.payroll_leave_in_lieu(uuid, uuid, date, date, uuid)
  from public, anon, authenticated;

-- 5.9c's private.payroll_final_pay_prefill (its only version), with two changes marked "Slice
-- 5.10": the leave pre-fill knows the run, and other_run_item_types lists the item types the
-- worker already has on other standing runs. The grants stand.
create or replace function private.payroll_final_pay_prefill(p_organisation_id uuid, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype;
  v_out jsonb;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only an owner, HR or Finance can read payroll.' using errcode = '42501';
  end if;
  select r.* into v_run from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = p_run_id;
  if v_run.id is null then
    raise exception 'That payroll run wasn''t found.' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(x.doc order by x.worker_id), '[]'::jsonb) into v_out
  from (
    select w.id as worker_id, jsonb_build_object(
      'worker_id', w.id,
      'start_date', w.start_date,
      'end_date', coalesce(w.end_date, v_run.period_end),
      'basic_monthly_kobo', (
        select case when pr.pay_type = 'monthly' then pr.basic_kobo::text end
        from public.pay_rates pr
        where pr.organisation_id = p_organisation_id and pr.worker_id = w.id
          and pr.effective_from <= coalesce(w.end_date, v_run.period_end)
          and (pr.effective_to is null or pr.effective_to >= coalesce(w.end_date, v_run.period_end))
        order by pr.effective_from desc
        limit 1
      ),
      'divisor_days', o.hourly_rate_divisor_days,
      -- Slice 5.10: less leave in lieu on other standing runs.
      'leave', private.payroll_leave_in_lieu(
        p_organisation_id, w.id, w.start_date, coalesce(w.end_date, v_run.period_end), p_run_id
      ),
      'exempt_cap_kobo', private.payroll_exempt_cap(p_organisation_id, v_run)::text,
      'exempt_used_kobo', (
        select coalesce(sum(i.exempt_kobo), 0)::text
        from public.payroll_final_pay_items i
        join public.payroll_runs ir on ir.organisation_id = i.organisation_id and ir.id = i.run_id
        where i.organisation_id = p_organisation_id and i.worker_id = w.id
          and ir.status <> 'reversed' and ir.kind <> 'reversal' and ir.discarded_at is null
      ),
      -- Slice 5.10: the item types already on another standing run.
      'other_run_item_types', coalesce((
        select jsonb_agg(distinct i.item_type)
        from public.payroll_final_pay_items i
        join public.payroll_runs ir on ir.organisation_id = i.organisation_id and ir.id = i.run_id
        where i.organisation_id = p_organisation_id and i.worker_id = w.id
          and ir.id <> p_run_id
          and ir.status <> 'reversed' and ir.kind <> 'reversal' and ir.discarded_at is null
      ), '[]'::jsonb)
    ) as doc
    from public.payroll_run_workers rw
    join public.workers w on w.organisation_id = rw.organisation_id and w.id = rw.worker_id
    join public.organisations o on o.id = p_organisation_id
    where rw.organisation_id = p_organisation_id and rw.run_id = p_run_id
  ) x;
  return v_out;
end;
$$;

-- 5.9c's add_final_pay_item (its only version), with p_further_reason added (marked "Slice
-- 5.10"): an item of a type the worker already has on another standing run (not this one, not
-- discarded, not reversed, not a reversal; drafts included) is refused (MLFZ1) unless it is
-- confirmed as a further item with a reason, as 5.7a's MLRVC asks of a further correction. The
-- leave pre-fill knows the run. The signature changes, so the old one goes.
drop function public.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text
);
drop function private.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text
);

create function private.add_final_pay_item(
  p_organisation_id uuid,
  p_run_id uuid,
  p_worker_id uuid,
  p_item_type text,
  p_amount_kobo text,
  p_reason text,
  p_days integer default null,
  p_computed_kobo text default null,
  p_exempt_kobo text default null,
  p_part_of_settlement boolean default false,
  p_change_reason text default null,
  p_further_reason text default null
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
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_change text;
  v_further text;
  v_amount bigint;
  v_end date;
  v_basic bigint;
  v_divisor integer;
  v_computed bigint;
  v_balance integer;
  v_leave jsonb;
  v_settlement boolean := coalesce(p_part_of_settlement, false) and p_item_type = 'notice_in_lieu';
  v_exempting boolean;
  v_cap bigint;
  v_used bigint;
  v_room bigint;
  v_exempt bigint := 0;
  v_id uuid := gen_random_uuid();
  v_adj uuid;
  v_base text;
begin
  if p_item_type is null
    or p_item_type not in ('leave_in_lieu', 'notice_in_lieu', 'gratuity', 'loss_of_office') then
    raise exception 'Choose the kind of final-pay item.' using errcode = '22023';
  end if;
  if p_amount_kobo is null or p_amount_kobo !~ '^[0-9]{1,12}$' then
    raise exception 'The amount is whole kobo, above ₦0 and at most ₦1,000,000,000.' using errcode = '22023';
  end if;
  v_amount := p_amount_kobo::bigint;
  if v_amount <= 0 or v_amount > 100000000000 then
    raise exception 'The amount is above ₦0 and at most ₦1,000,000,000.' using errcode = '22023';
  end if;
  if v_reason is null or private.has_personal_number(v_reason) then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  if p_change_reason is not null and btrim(p_change_reason) <> '' then
    v_change := private.tax_clean_text(p_change_reason, 500);
    if v_change is null or private.has_personal_number(v_change) then
      raise exception 'Give the reason for the change in up to 500 characters, with no web addresses or personal numbers.'
        using errcode = '22023';
    end if;
  end if;
  -- Slice 5.10: why a further item of the same type.
  if p_further_reason is not null and btrim(p_further_reason) <> '' then
    v_further := private.tax_clean_text(p_further_reason, 500);
    if v_further is null or private.has_personal_number(v_further) then
      raise exception 'Say why this is a further item in up to 500 characters, with no web addresses or personal numbers.'
        using errcode = '22023';
    end if;
  end if;
  if p_item_type in ('leave_in_lieu', 'notice_in_lieu') then
    if p_days is null or p_days not between 1 and 366 then
      raise exception 'Enter the days, 1 to 366.' using errcode = '22023';
    end if;
  elsif p_days is not null then
    raise exception 'Days are only for leave and notice pay.' using errcode = '22023';
  end if;

  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.kind <> 'off_cycle' or v_run.off_cycle_reason is distinct from 'final_pay'
    or v_run.status <> 'draft' or v_run.discarded_at is not null then
    raise exception 'Final-pay items go only on a final-pay run that is a draft.' using errcode = 'MLTB1';
  end if;
  select coalesce(w.end_date, v_run.period_end) into v_end
  from public.payroll_run_workers rw
  join public.workers w on w.organisation_id = rw.organisation_id and w.id = rw.worker_id
  where rw.organisation_id = p_organisation_id and rw.run_id = p_run_id
    and rw.worker_id = p_worker_id;
  if v_end is null then
    raise exception 'That worker isn''t on this final-pay run.' using errcode = 'MLTB2';
  end if;
  perform set_config('metalira.audit_channel', 'web', true);
  -- One worker's exemption at a time, across runs.
  perform pg_advisory_xact_lock(
    hashtextextended('payroll_final_pay:' || p_organisation_id::text || ':' || p_worker_id::text, 0)
  );

  -- Slice 5.10 (money review round 2, M1): under the worker's lock, so two runs can't both pass.
  if v_further is null and exists (
    select 1
    from public.payroll_final_pay_items i
    join public.payroll_runs ir on ir.organisation_id = i.organisation_id and ir.id = i.run_id
    where i.organisation_id = p_organisation_id and i.worker_id = p_worker_id
      and i.item_type = p_item_type and ir.id <> p_run_id
      and ir.status <> 'reversed' and ir.kind <> 'reversal' and ir.discarded_at is null
  ) then
    raise exception 'This worker already has this kind of final-pay item on another run. If this is a further item, not the same one again, say why.'
      using errcode = 'MLFZ1';
  end if;

  if p_item_type in ('leave_in_lieu', 'notice_in_lieu') then
    select case when pr.pay_type = 'monthly' then pr.basic_kobo end into v_basic
    from public.pay_rates pr
    where pr.organisation_id = p_organisation_id and pr.worker_id = p_worker_id
      and pr.effective_from <= v_end and (pr.effective_to is null or pr.effective_to >= v_end)
    order by pr.effective_from desc
    limit 1;
    if v_basic is not null then
      select o.hourly_rate_divisor_days into v_divisor
      from public.organisations o where o.id = p_organisation_id;
      -- The check of the server's figure: days x basic ÷ divisor, rounded half up once.
      v_computed := (2 * p_days::bigint * v_basic + v_divisor) / (2 * v_divisor);
      if p_computed_kobo is distinct from v_computed::text then
        raise exception 'The pre-filled amount is out of date. Reload the page and try again.'
          using errcode = 'MLTB5';
      end if;
    elsif p_computed_kobo is not null then
      raise exception 'The pre-filled amount is out of date. Reload the page and try again.'
        using errcode = 'MLTB5';
    end if;
    if p_item_type = 'leave_in_lieu' then
      -- Slice 5.10: the pre-fill net of leave in lieu on other standing runs.
      select private.payroll_leave_in_lieu(p_organisation_id, w.id, w.start_date, v_end, p_run_id)
      into v_leave
      from public.workers w
      where w.organisation_id = p_organisation_id and w.id = p_worker_id;
      v_balance := (v_leave ->> 'days')::integer;
    end if;
    if v_change is null and (
      v_computed is null or v_amount <> v_computed
      or (p_item_type = 'leave_in_lieu' and (v_balance is null or p_days <> v_balance))
    ) then
      raise exception 'The days or amount differ from the pre-filled figure. Give the reason for the change.'
        using errcode = 'MLTB4';
    end if;
  elsif p_computed_kobo is not null then
    raise exception 'Only leave and notice pay are pre-filled.' using errcode = '22023';
  end if;

  v_exempting := p_item_type = 'loss_of_office' or v_settlement;
  if v_exempting then
    v_cap := private.payroll_exempt_cap(p_organisation_id, v_run);
    select coalesce(sum(i.exempt_kobo), 0) into v_used
    from public.payroll_final_pay_items i
    join public.payroll_runs ir on ir.organisation_id = i.organisation_id and ir.id = i.run_id
    where i.organisation_id = p_organisation_id and i.worker_id = p_worker_id
      and ir.status <> 'reversed' and ir.kind <> 'reversal' and ir.discarded_at is null;
    v_room := greatest(v_cap - v_used, 0);
    v_exempt := least(v_amount, v_room);
    if p_exempt_kobo is distinct from v_exempt::text then
      raise exception 'The exempt part is out of date. Reload the page and try again.'
        using errcode = 'MLTB5';
    end if;
  elsif p_exempt_kobo is not null and p_exempt_kobo <> '0' then
    raise exception 'Only a loss-of-office payment has an exempt part.' using errcode = '22023';
  end if;

  insert into public.payroll_final_pay_items (
    id, organisation_id, run_id, worker_id, item_type, days, prefill_days, basic_monthly_kobo,
    divisor_days, computed_kobo, amount_kobo, exempt_kobo, exempt_cap_kobo, exempt_used_kobo,
    part_of_settlement, reason, change_reason, created_by, further_reason
  )
  values (
    v_id, p_organisation_id, p_run_id, p_worker_id, p_item_type, p_days,
    case when p_item_type = 'leave_in_lieu' then v_balance end,
    v_basic, case when v_basic is not null then v_divisor end, v_computed, v_amount, v_exempt,
    case when v_exempting then v_cap end, case when v_exempting then v_used end,
    v_settlement, v_reason, v_change, v_uid, v_further
  );

  -- The label the screen shows (src/lib/payroll/final-pay.ts finalPayLabel).
  v_base := case p_item_type
    when 'leave_in_lieu' then 'Pay in lieu of untaken leave, ' || p_days
      || case when p_days = 1 then ' day' else ' days' end
    when 'notice_in_lieu' then 'Pay in lieu of notice, ' || p_days
      || case when p_days = 1 then ' day' else ' days' end
    when 'gratuity' then 'Gratuity'
    else 'Redundancy or loss-of-office compensation'
  end;
  if not v_exempting then
    v_adj := gen_random_uuid();
    insert into public.payroll_adjustments (
      id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
      series_id, instalment_number, instalment_count, reason, created_by, final_pay_item_id
    )
    values (
      v_adj, p_organisation_id, p_run_id, p_worker_id, 'earning', v_base, v_amount, false, true,
      v_adj, 1, 1, v_reason, v_uid, v_id
    );
  else
    if v_exempt > 0 then
      v_adj := gen_random_uuid();
      insert into public.payroll_adjustments (
        id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
        series_id, instalment_number, instalment_count, reason, created_by, final_pay_item_id
      )
      values (
        v_adj, p_organisation_id, p_run_id, p_worker_id, 'earning', v_base || ', exempt part',
        v_exempt, false, false, v_adj, 1, 1, v_reason, v_uid, v_id
      );
    end if;
    if v_amount > v_exempt then
      v_adj := gen_random_uuid();
      insert into public.payroll_adjustments (
        id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
        series_id, instalment_number, instalment_count, reason, created_by, final_pay_item_id
      )
      values (
        v_adj, p_organisation_id, p_run_id, p_worker_id, 'earning', v_base || ', taxable part',
        v_amount - v_exempt, false, true, v_adj, 1, 1, v_reason, v_uid, v_id
      );
    end if;
  end if;

  update public.payroll_runs r set needs_recalculation = true where r.id = p_run_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.final_pay_item_added', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'item_id', v_id, 'worker_id', p_worker_id, 'item_type', p_item_type, 'days', p_days,
      'amount_kobo', v_amount::text, 'exempt_kobo', v_exempt::text,
      'computed_kobo', v_computed::text, 'prefill_days', v_balance,
      'part_of_settlement', v_settlement, 'change_reason', v_change,
      'further_reason', v_further
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text, text
) from public, anon;
grant execute on function private.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text, text
) to authenticated;

create function public.add_final_pay_item(
  p_organisation_id uuid,
  p_run_id uuid,
  p_worker_id uuid,
  p_item_type text,
  p_amount_kobo text,
  p_reason text,
  p_days integer default null,
  p_computed_kobo text default null,
  p_exempt_kobo text default null,
  p_part_of_settlement boolean default false,
  p_change_reason text default null,
  p_further_reason text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_final_pay_item(
    p_organisation_id, p_run_id, p_worker_id, p_item_type, p_amount_kobo, p_reason, p_days,
    p_computed_kobo, p_exempt_kobo, p_part_of_settlement, p_change_reason, p_further_reason
  )
$$;

revoke all on function public.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text, text
) from public, anon;
grant execute on function public.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text, text
) to authenticated;
