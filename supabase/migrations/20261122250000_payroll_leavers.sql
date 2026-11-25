-- Slice 5.9c: leavers' final-pay items, the company's public-holiday pay multiplier, and the
-- loss-of-office exemption cap on every rule set version (docs/PHASE_5.md "As built in 5.9c",
-- docs/RULES_NIGERIA.md adviser answers 19 and 24).
--
-- 1. tax_rule_sets.loss_of_office_exempt_kobo: compensation for loss of employment (redundancy)
--    is exempt up to ₦50,000,000 (adviser answer 19). Held on each dated version (default
--    5000000000 kobo), never changed (its own guard, ENABLE ALWAYS, beside 5.0's guard, which this
--    slice doesn't replace so slice 5.9a's version of it stands).
-- 2. payroll_holiday_pay_rates: the company's public-holiday pay multiplier (owner decision on
--    adviser answer 24: contract-driven, default 1.0x). Insert-only dated versions from tomorrow or
--    later; the version in force on a day is the latest one starting on or before it, and none
--    means 1.0x. owner, hr and finance read and add (set_holiday_pay_multiplier), audited.
-- 3. payroll_final_pay_items: typed final-pay items on a final-pay off-cycle draft (5.7b): pay in
--    lieu of untaken leave, pay in lieu of notice, gratuity, and redundancy or loss-of-office
--    compensation. add_final_pay_item (owner, hr) writes the item and its earning rows in
--    payroll_adjustments (final_pay_item_id), with the taxable and pensionable flags the engine
--    already honours: nothing is pensionable; a loss-of-office payment (or notice pay that is part
--    of the settlement) is split into an exempt row and a taxable row, the exempt part capped per
--    worker across every such payment not discarded or reversed (the conservative reading).
--    Removing either row removes the whole item. payroll_final_pay_prefill gives the figures the
--    screen pre-fills from (leave balance, basic of the last day's pay version, the divisor, the
--    cap and what earlier items used).
--
-- Refusal codes MLTB1 to MLTB7:
--   MLTB1 final-pay items go only on a final-pay off-cycle run that is a draft;
--   MLTB2 the worker isn't on this run;
--   MLTB3 a holiday pay rate starts tomorrow or later and never changes;
--   MLTB4 the days or amount differ from the pre-filled figure: give the reason for the change;
--   MLTB5 the figures sent don't match what the database works out (reload and try again);
--   MLTB6 a final-pay item never changes, and goes only with its draft adjustment;
--   MLTB7 a rule set's loss-of-office cap never changes.
--
-- SQL does no money maths beyond the checks: the server works out the pre-filled amount and the
-- exempt part (src/lib/payroll/final-pay.ts) and the function checks them against the same
-- rounding and cap.

-- ---------------------------------------------------------------------------
-- 1. The loss-of-office exemption cap on every rule set version
-- ---------------------------------------------------------------------------

alter table public.tax_rule_sets
  add column loss_of_office_exempt_kobo bigint not null default 5000000000
    constraint tax_rule_sets_loss_of_office_exempt_range check (
      loss_of_office_exempt_kobo between 0 and 1000000000000000
    );

comment on column public.tax_rule_sets.loss_of_office_exempt_kobo is
  'Compensation for loss of employment (redundancy) exempt from PAYE, a worker across all such payments, in kobo of the version''s currency (tax adviser, answer 19: ₦50,000,000). Never changed.';

create function private.tax_rule_sets_exempt_cap_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.loss_of_office_exempt_kobo is distinct from old.loss_of_office_exempt_kobo then
    raise exception 'A version of the payroll rules never changes. Add a new version instead.'
      using errcode = 'MLTB7';
  end if;
  return new;
end;
$$;

revoke all on function private.tax_rule_sets_exempt_cap_guard() from public, anon, authenticated;

create trigger tax_rule_sets_exempt_cap_guard before update on public.tax_rule_sets
  for each row execute function private.tax_rule_sets_exempt_cap_guard();
alter table public.tax_rule_sets enable always trigger tax_rule_sets_exempt_cap_guard;

-- The cap a run uses: its rule set's, else the version in force on its pay date, else the
-- starting value.
create function private.payroll_exempt_cap(p_organisation_id uuid, p_run public.payroll_runs)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select t.loss_of_office_exempt_kobo from public.tax_rule_sets t
     where t.organisation_id = p_organisation_id and t.id = p_run.rule_set_id),
    (select t.loss_of_office_exempt_kobo from public.tax_rule_sets t
     where t.organisation_id = p_organisation_id and t.effective_from <= p_run.pay_date
       and (t.effective_to is null or t.effective_to >= p_run.pay_date)
     order by t.effective_from desc limit 1),
    5000000000::bigint
  )
$$;

revoke all on function private.payroll_exempt_cap(uuid, public.payroll_runs)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The public-holiday pay multiplier
-- ---------------------------------------------------------------------------

create table public.payroll_holiday_pay_rates (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  effective_from date not null
    constraint payroll_holiday_pay_rates_from_range check (
      effective_from between '2000-01-01' and '2100-12-31'
    ),
  -- Basis points on the overtime rate: 10000 is 1.0x (today's rule), up to 5.0x.
  multiplier_bps integer not null
    constraint payroll_holiday_pay_rates_multiplier_range check (multiplier_bps between 10000 and 50000),
  reason text not null
    constraint payroll_holiday_pay_rates_reason_text check (
      reason = btrim(reason) and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]' and reason !~* '(://|www\.)'
      and not private.has_personal_number(reason)
    ),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_holiday_pay_rates_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_holiday_pay_rates_from_key unique (organisation_id, effective_from)
);

comment on table public.payroll_holiday_pay_rates is
  'The company''s public-holiday pay multiplier on the overtime rate (slice 5.9c; adviser answer 24, owner decision). Dated, insert-only; the latest version starting on or before a day is in force; none means 1.0x.';

alter table public.payroll_holiday_pay_rates enable row level security;

create policy payroll_holiday_pay_rates_select on public.payroll_holiday_pay_rates
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.payroll_holiday_pay_rates from anon, authenticated, service_role;
grant select on table public.payroll_holiday_pay_rates to authenticated, service_role;

-- Insert-only, from tomorrow or later, for everyone (the secret key and the database owner too).
create function private.payroll_holiday_pay_rates_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A holiday pay rate never changes. Add a new one from tomorrow or later.'
      using errcode = 'MLTB3';
  end if;
  if new.effective_from <= private.org_today(new.organisation_id) then
    raise exception 'A new holiday pay rate starts tomorrow or later.' using errcode = 'MLTB3';
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.payroll_holiday_pay_rates_guard() from public, anon, authenticated;

create trigger payroll_holiday_pay_rates_guard
  before insert or update or delete on public.payroll_holiday_pay_rates
  for each row execute function private.payroll_holiday_pay_rates_guard();
alter table public.payroll_holiday_pay_rates enable always trigger payroll_holiday_pay_rates_guard;
create trigger payroll_holiday_pay_rates_no_truncate before truncate on public.payroll_holiday_pay_rates
  for each statement execute function private.payroll_no_truncate();
alter table public.payroll_holiday_pay_rates enable always trigger payroll_holiday_pay_rates_no_truncate;
create trigger payroll_holiday_pay_rates_audit after insert on public.payroll_holiday_pay_rates
  for each row execute function private.audit_row_change();

-- Adds a version (owner, hr or finance, trusted session) from tomorrow or later. Returns the
-- version in force before it and the new one. Refused when the multiplier is already the one in
-- force from that day (nothing would change).
create function private.set_holiday_pay_multiplier(
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
  if v_uid is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only an owner, HR or Finance can set the holiday pay rate.' using errcode = '42501';
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

revoke all on function private.set_holiday_pay_multiplier(uuid, integer, date, text) from public, anon;
grant execute on function private.set_holiday_pay_multiplier(uuid, integer, date, text) to authenticated;

create function public.set_holiday_pay_multiplier(
  p_organisation_id uuid,
  p_multiplier_bps integer,
  p_effective_from date,
  p_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_holiday_pay_multiplier(
    p_organisation_id, p_multiplier_bps, p_effective_from, p_reason
  )
$$;

revoke all on function public.set_holiday_pay_multiplier(uuid, integer, date, text) from public, anon;
grant execute on function public.set_holiday_pay_multiplier(uuid, integer, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Final-pay items
-- ---------------------------------------------------------------------------

create table public.payroll_final_pay_items (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  worker_id uuid not null,
  item_type text not null
    constraint payroll_final_pay_items_type_value check (
      item_type in ('leave_in_lieu', 'notice_in_lieu', 'gratuity', 'loss_of_office')
    ),
  -- Leave and notice: the days paid; leave also the balance the screen pre-filled.
  days integer
    constraint payroll_final_pay_items_days_range check (days between 1 and 366),
  balance_days integer
    constraint payroll_final_pay_items_balance_range check (balance_days between -366 and 366),
  -- Leave and notice on a monthly pay version: the basic of the version in force on the last
  -- day, the divisor, and days x basic ÷ divisor rounded half up (what the screen pre-filled).
  basic_monthly_kobo bigint
    constraint payroll_final_pay_items_basic_range check (basic_monthly_kobo between 0 and 100000000000),
  divisor_days integer
    constraint payroll_final_pay_items_divisor_range check (divisor_days between 1 and 31),
  computed_kobo bigint
    constraint payroll_final_pay_items_computed_range check (computed_kobo between 0 and 100000000000000),
  amount_kobo bigint not null
    constraint payroll_final_pay_items_amount check (amount_kobo > 0 and amount_kobo <= 100000000000),
  -- The part exempt from PAYE (loss of office, or notice pay that is part of the settlement),
  -- with the cap and what earlier items of the worker used when it was added.
  exempt_kobo bigint not null default 0,
  exempt_cap_kobo bigint,
  exempt_used_kobo bigint,
  part_of_settlement boolean not null default false,
  currency text not null default 'NGN'
    constraint payroll_final_pay_items_currency check (currency = 'NGN'),
  reason text not null
    constraint payroll_final_pay_items_reason_text check (
      reason = btrim(reason) and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]' and reason !~* '(://|www\.)'
      and not private.has_personal_number(reason)
    ),
  -- Why the days or amount differ from the pre-filled figures (needed when they do).
  change_reason text
    constraint payroll_final_pay_items_change_reason_text check (
      change_reason = btrim(change_reason) and char_length(change_reason) between 1 and 500
      and change_reason !~ '[\x01-\x1f\x7f-\x9f<>]' and change_reason !~* '(://|www\.)'
      and not private.has_personal_number(change_reason)
    ),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_final_pay_items_organisation_id_id_key unique (organisation_id, id),
  -- One item of each type a worker on a run, so nothing is paid twice by accident.
  constraint payroll_final_pay_items_once unique (run_id, worker_id, item_type),
  constraint payroll_final_pay_items_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payroll_final_pay_items_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payroll_final_pay_items_exempt check (exempt_kobo between 0 and amount_kobo),
  constraint payroll_final_pay_items_shape check (
    (item_type in ('leave_in_lieu', 'notice_in_lieu')) = (days is not null)
    and (item_type = 'leave_in_lieu' or balance_days is null)
    and (item_type in ('leave_in_lieu', 'notice_in_lieu')
      or (basic_monthly_kobo is null and divisor_days is null and computed_kobo is null))
    and ((basic_monthly_kobo is null) = (computed_kobo is null))
    and ((basic_monthly_kobo is null) = (divisor_days is null))
    and (item_type = 'notice_in_lieu' or not part_of_settlement)
    and (
      (item_type = 'loss_of_office' or part_of_settlement)
        = (exempt_cap_kobo is not null and exempt_used_kobo is not null)
    )
    and (item_type = 'loss_of_office' or part_of_settlement or exempt_kobo = 0)
  )
);

create index payroll_final_pay_items_worker_idx
  on public.payroll_final_pay_items (organisation_id, worker_id);

comment on table public.payroll_final_pay_items is
  'Typed final-pay items on a final-pay off-cycle run (slice 5.9c, adviser answer 19), each paid through its payroll_adjustments rows; kept with the figures they were worked out from.';

alter table public.payroll_final_pay_items enable row level security;

create policy payroll_final_pay_items_select on public.payroll_final_pay_items
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.payroll_final_pay_items from anon, authenticated, service_role;
grant select on table public.payroll_final_pay_items to authenticated, service_role;

alter table public.payroll_adjustments
  add column final_pay_item_id uuid,
  add constraint payroll_adjustments_final_pay_item_fkey
    foreign key (organisation_id, final_pay_item_id)
    references public.payroll_final_pay_items (organisation_id, id) on delete cascade;

create index payroll_adjustments_final_pay_item_idx
  on public.payroll_adjustments (final_pay_item_id) where final_pay_item_id is not null;

comment on column public.payroll_adjustments.final_pay_item_id is
  'The final-pay item (slice 5.9c) this earning pays, or null for an ordinary adjustment.';

-- Items: written only on a final-pay off-cycle draft for one of its workers; never changed;
-- deleted only while the run is a draft (with their adjustment rows).
create function private.payroll_final_pay_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype;
begin
  if tg_op = 'UPDATE' then
    raise exception 'A final-pay item never changes. Remove it and add it again.' using errcode = 'MLTB6';
  end if;
  if tg_op = 'DELETE' then
    if private.payroll_run_status(old.organisation_id, old.run_id) is distinct from 'draft' then
      raise exception 'A final-pay item goes only while its run is a draft.' using errcode = 'MLTB6';
    end if;
    return old;
  end if;
  select r.* into v_run from public.payroll_runs r
  where r.organisation_id = new.organisation_id and r.id = new.run_id;
  if v_run.id is null or v_run.kind <> 'off_cycle' or v_run.off_cycle_reason is distinct from 'final_pay'
    or v_run.status <> 'draft' or v_run.discarded_at is not null then
    raise exception 'Final-pay items go only on a final-pay run that is a draft.' using errcode = 'MLTB1';
  end if;
  if not exists (
    select 1 from public.payroll_run_workers w
    where w.organisation_id = new.organisation_id and w.run_id = new.run_id
      and w.worker_id = new.worker_id
  ) then
    raise exception 'That worker isn''t on this final-pay run.' using errcode = 'MLTB2';
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.payroll_final_pay_items_guard() from public, anon, authenticated;

create trigger payroll_final_pay_items_guard
  before insert or update or delete on public.payroll_final_pay_items
  for each row execute function private.payroll_final_pay_items_guard();
alter table public.payroll_final_pay_items enable always trigger payroll_final_pay_items_guard;
create trigger payroll_final_pay_items_no_truncate before truncate on public.payroll_final_pay_items
  for each statement execute function private.payroll_no_truncate();
alter table public.payroll_final_pay_items enable always trigger payroll_final_pay_items_no_truncate;
create trigger payroll_final_pay_items_audit after insert or delete on public.payroll_final_pay_items
  for each row execute function private.audit_row_change();

-- An item and its adjustment rows are whole at commit: every row is an earning of the item's run
-- and worker, never pensionable; the rows not taxable sum to the exempt part and the taxable rows
-- to the rest; an item that isn't exempt has only taxable rows. Checked when either is inserted.
create function private.payroll_final_pay_item_whole(p_organisation_id uuid, p_item_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.payroll_final_pay_items%rowtype;
  v_exempt bigint;
  v_taxable bigint;
  v_rows integer;
begin
  select i.* into v_item from public.payroll_final_pay_items i
  where i.organisation_id = p_organisation_id and i.id = p_item_id;
  if v_item.id is null then
    -- Removed in the same transaction: nothing to check.
    return;
  end if;
  if exists (
    select 1 from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.final_pay_item_id = p_item_id
      and (a.run_id <> v_item.run_id or a.worker_id <> v_item.worker_id or a.kind <> 'earning'
        or a.pensionable or a.instalment_count <> 1)
  ) then
    raise exception 'A final-pay item''s earnings don''t match the item.' using errcode = 'MLTB5';
  end if;
  select count(*),
    coalesce(sum(a.amount_kobo) filter (where not a.taxable), 0),
    coalesce(sum(a.amount_kobo) filter (where a.taxable), 0)
  into v_rows, v_exempt, v_taxable
  from public.payroll_adjustments a
  where a.organisation_id = p_organisation_id and a.final_pay_item_id = p_item_id;
  if v_rows = 0 or v_exempt <> v_item.exempt_kobo or v_exempt + v_taxable <> v_item.amount_kobo then
    raise exception 'A final-pay item''s earnings don''t add up to the item.' using errcode = 'MLTB5';
  end if;
end;
$$;

revoke all on function private.payroll_final_pay_item_whole(uuid, uuid) from public, anon, authenticated;

create function private.payroll_final_pay_items_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'payroll_final_pay_items' then
    perform private.payroll_final_pay_item_whole(new.organisation_id, new.id);
  elsif new.final_pay_item_id is not null then
    perform private.payroll_final_pay_item_whole(new.organisation_id, new.final_pay_item_id);
  end if;
  return null;
end;
$$;

revoke all on function private.payroll_final_pay_items_check() from public, anon, authenticated;

create constraint trigger payroll_final_pay_items_whole
  after insert on public.payroll_final_pay_items
  deferrable initially deferred
  for each row execute function private.payroll_final_pay_items_check();
alter table public.payroll_final_pay_items enable always trigger payroll_final_pay_items_whole;
create constraint trigger payroll_adjustments_final_pay_whole
  after insert on public.payroll_adjustments
  deferrable initially deferred
  for each row when (new.final_pay_item_id is not null)
  execute function private.payroll_final_pay_items_check();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_final_pay_whole;

-- Removing either earning row of an item removes the item (and so its other row, by the
-- cascade): an item is paid whole or not at all. remove_payroll_adjustment and 5.7b's discard
-- are unchanged.
create function private.payroll_adjustments_final_pay_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.final_pay_item_id is not null then
    delete from public.payroll_final_pay_items i
    where i.organisation_id = old.organisation_id and i.id = old.final_pay_item_id;
  end if;
  return null;
end;
$$;

revoke all on function private.payroll_adjustments_final_pay_removed() from public, anon, authenticated;

create trigger payroll_adjustments_final_pay_removed after delete on public.payroll_adjustments
  for each row when (old.final_pay_item_id is not null)
  execute function private.payroll_adjustments_final_pay_removed();
alter table public.payroll_adjustments enable always trigger payroll_adjustments_final_pay_removed;

-- What the screen pre-fills from, for each worker on a final-pay run (owner, hr, finance): the
-- last day, the basic of the monthly pay version in force on it (null for daily and hourly), the
-- company's divisor, the annual leave balance for the last day's year (the Phase 4 ledger; null
-- when the company has no active type coded `annual`), the run's loss-of-office cap and what the
-- worker's items already used (items on runs not discarded and not reversed, drafts and this
-- run's own included).
create function private.payroll_final_pay_prefill(p_organisation_id uuid, p_run_id uuid)
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
      'annual_balance_days', (
        select private.leave_balance(
          p_organisation_id, w.id, t.id,
          extract(year from coalesce(w.end_date, v_run.period_end))::integer
        )
        from public.leave_types t
        where t.organisation_id = p_organisation_id and t.code = 'annual' and t.status = 'active'
      ),
      'exempt_cap_kobo', private.payroll_exempt_cap(p_organisation_id, v_run)::text,
      'exempt_used_kobo', (
        select coalesce(sum(i.exempt_kobo), 0)::text
        from public.payroll_final_pay_items i
        join public.payroll_runs ir on ir.organisation_id = i.organisation_id and ir.id = i.run_id
        where i.organisation_id = p_organisation_id and i.worker_id = w.id
          and ir.status <> 'reversed' and ir.kind <> 'reversal' and ir.discarded_at is null
      )
    ) as doc
    from public.payroll_run_workers rw
    join public.workers w on w.organisation_id = rw.organisation_id and w.id = rw.worker_id
    join public.organisations o on o.id = p_organisation_id
    where rw.organisation_id = p_organisation_id and rw.run_id = p_run_id
  ) x;
  return v_out;
end;
$$;

revoke all on function private.payroll_final_pay_prefill(uuid, uuid) from public, anon;
grant execute on function private.payroll_final_pay_prefill(uuid, uuid) to authenticated, service_role;

create function public.payroll_final_pay_prefill(p_organisation_id uuid, p_run_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.payroll_final_pay_prefill(p_organisation_id, p_run_id)
$$;

revoke all on function public.payroll_final_pay_prefill(uuid, uuid) from public, anon;
grant execute on function public.payroll_final_pay_prefill(uuid, uuid) to authenticated, service_role;

-- Adds a final-pay item (owner or hr, trusted session) to a final-pay draft for one of its
-- workers, with its earning row(s); the run then needs recalculating. p_computed_kobo is the
-- pre-filled days x basic ÷ divisor the server worked out (null when the last day's pay version
-- isn't monthly); p_exempt_kobo the exempt part (0 when the item isn't exempt). Both are checked
-- against the database's own figures (MLTB5). A days or amount different from the pre-fill needs
-- p_change_reason (MLTB4). Returns the item id.
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
  p_change_reason text default null
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
  v_amount bigint;
  v_end date;
  v_basic bigint;
  v_divisor integer;
  v_computed bigint;
  v_balance integer;
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
  -- One worker's exemption at a time, across runs.
  perform pg_advisory_xact_lock(
    hashtextextended('payroll_final_pay:' || p_organisation_id::text || ':' || p_worker_id::text, 0)
  );

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
      select private.leave_balance(p_organisation_id, p_worker_id, t.id, extract(year from v_end)::integer)
      into v_balance
      from public.leave_types t
      where t.organisation_id = p_organisation_id and t.code = 'annual' and t.status = 'active';
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
    id, organisation_id, run_id, worker_id, item_type, days, balance_days, basic_monthly_kobo,
    divisor_days, computed_kobo, amount_kobo, exempt_kobo, exempt_cap_kobo, exempt_used_kobo,
    part_of_settlement, reason, change_reason, created_by
  )
  values (
    v_id, p_organisation_id, p_run_id, p_worker_id, p_item_type, p_days,
    case when p_item_type = 'leave_in_lieu' then v_balance end,
    v_basic, case when v_basic is not null then v_divisor end, v_computed, v_amount, v_exempt,
    case when v_exempting then v_cap end, case when v_exempting then v_used end,
    v_settlement, v_reason, v_change, v_uid
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
      'computed_kobo', v_computed::text, 'balance_days', v_balance,
      'part_of_settlement', v_settlement, 'change_reason', v_change
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text
) from public, anon;
grant execute on function private.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text
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
  p_change_reason text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_final_pay_item(
    p_organisation_id, p_run_id, p_worker_id, p_item_type, p_amount_kobo, p_reason, p_days,
    p_computed_kobo, p_exempt_kobo, p_part_of_settlement, p_change_reason
  )
$$;

revoke all on function public.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text
) from public, anon;
grant execute on function public.add_final_pay_item(
  uuid, uuid, uuid, text, text, text, integer, text, text, boolean, text
) to authenticated;
