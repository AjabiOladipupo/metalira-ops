-- Slice 5.9b: statutory deadlines and remittances per the tax adviser (docs/PHASE_5.md 5.9b;
-- adviser's answers of 24 Nov 2026; CLAUDE.md rules 2, 4 and 5).
--
-- 1. public.official_holidays: the platform's official holiday calendar, kept by Metalira, for
--    counting statutory deadlines. Federal public holidays (gazetted or declared under the Public
--    Holidays Act) for every deadline, and a state's own public holidays for that state's PAYE.
--    A company's own holiday list (public.public_holidays, slice 4.1) stays for pay purposes
--    only (overtime, roster, leave) and no longer moves a statutory deadline.
--
--    DELIBERATE TENANCY EXCEPTION (CLAUDE.md rule 2): this is platform reference data, the same
--    for every company, so it has no organisation_id. Row-level security is on: any signed-in
--    user may read it (it is public law, not a company's data); anon reads nothing. Nobody
--    writes it from the app: rows come from a migration or the secret key (a Metalira admin
--    path), never from a customer. It is insert-only for everyone, the secret key and the
--    database owner included (rule 4): a wrong date is withdrawn by a `withdrawal` row naming it
--    with a reason, and the table is its own audit trail (audit_log needs an organisation, and
--    no company makes these changes). tests/rls/tables/official_holidays.ts declares it as a
--    platform table and tests/rls/official-holidays.test.ts proves the rules above.
--
--    Seeded with the 2026 and 2027 federal holidays we could verify: the fixed days in the Act's
--    schedule, Good Friday and Easter Monday (their dates follow Easter), and the 2026 Muslim
--    holidays the Federal Ministry of Interior declared. Not seeded, for an admin to add once
--    declared: the 2027 Eid-el-Fitr, Eid-el-Kabir and Eid-el-Maulud dates; any substitute day the
--    Ministry declares when a holiday falls on a weekend (26 Dec 2026; 1 May, 12 Jun, 25 and
--    26 Dec 2027); and every state's own holidays.
--
-- 2. Due dates (adviser, 24 Nov 2026), worked out by private.statutory_due_date and mirrored by
--    remittanceDeadline in src/lib/payroll/statutory.ts. A working day is Monday to Friday less
--    the federal holidays and, for PAYE, the tax state's holidays.
--    - Pension (PRA 2014 s.11(3)(b)): the 7th working day counting the day salary is actually
--      paid as day 1, or the next working day when that day isn't one (paid Sunday 25 Oct 2026:
--      day 1 Monday 26 Oct, due Tuesday 3 Nov). The actual day is the release ("I uploaded it
--      to the bank", slice 5.4); before release the scheduled pay date, provisionally.
--    - PAYE: the 10th of the following month (statutory penalty after the 21st, NTAA 2025 s.107).
--    - NHF (NHF Act s.9(2)): within 1 month of the deduction: the same day of the next month,
--      or that month's last day when it has no such day.
--    - NSITF (ECA 2010 s.33(1)): on or before the 15th of the following month.
--    - ITF (ITF Act s.6(2)): by 1 April of the following year.
--    - A fixed date that isn't a working day is brought back to the working day before (paying
--      early is never late; whether the law moves it to the next working day is for the adviser).
--    - The company's own day (organisations.*_remit_day, slice 5.6) applies only when it is
--      earlier than the statutory date; a later one is ignored (the screen says so).
--    statutory_remittances.due_date is stamped at approval from the scheduled pay date, so it
--    is provisional; the screens work the due date out on read from the actual paid day, the
--    calendar and the company's days as they are now.
--
-- Refusals (SQLSTATE):
--   MLDD1 the official calendar is kept as written (no update, delete or truncate)
--   MLDD2 not a well-formed holiday or withdrawal (scope, state, date, name, source or reason)
--   MLDD3 a withdrawal must name a holiday that stands
--   MLDD4 that day is already an official holiday for that scope and state
--   22023 bad input to a due-date function

-- ---------------------------------------------------------------------------
-- 1. The official holiday calendar
-- ---------------------------------------------------------------------------

create table public.official_holidays (
  id uuid primary key default gen_random_uuid(),
  entry text not null
    constraint official_holidays_entry_value check (entry in ('holiday', 'withdrawal')),
  holiday_date date
    constraint official_holidays_date_range check (holiday_date between '2000-01-01' and '2100-12-31'),
  name text
    constraint official_holidays_name_text check (
      char_length(name) between 1 and 120 and name !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  -- federal: every deadline; state: that state's PAYE deadlines.
  scope text
    constraint official_holidays_scope_value check (scope in ('federal', 'state')),
  -- The normalised tax-state key (private.normalise_tax_state), as statutory_remittances keeps a
  -- PAYE authority: 'lagos', 'fct abuja'. Only for scope state.
  state_key text,
  -- Where the date comes from: the Act, or the Ministry of Interior's declaration and its date.
  source text
    constraint official_holidays_source_text check (
      char_length(source) between 1 and 300 and source !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  -- A withdrawal names the holiday it withdraws, with why.
  withdraws_id uuid references public.official_holidays (id),
  reason text
    constraint official_holidays_reason_text check (
      char_length(reason) between 3 and 500 and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  -- Who added it: the migration's name, or the Metalira admin who used the secret key.
  recorded_by text not null
    constraint official_holidays_recorded_by_text check (
      char_length(recorded_by) between 1 and 120 and recorded_by !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  created_at timestamptz not null default now(),
  -- A holiday is withdrawn at most once.
  constraint official_holidays_one_withdrawal unique (withdraws_id),
  constraint official_holidays_shape check (
    case entry
      when 'holiday' then holiday_date is not null and name is not null and scope is not null
        and source is not null and withdraws_id is null and reason is null
        and ((scope = 'federal') = (state_key is null))
      else withdraws_id is not null and reason is not null and holiday_date is null
        and name is null and scope is null and state_key is null and source is null
    end
  )
);

create index official_holidays_date_idx on public.official_holidays (holiday_date)
  where entry = 'holiday';

comment on table public.official_holidays is
  'Platform-wide official holiday calendar for statutory deadlines (slice 5.9b): federal holidays and per-state holidays, kept by Metalira. Deliberately no organisation_id (platform reference data); read-only for signed-in users, written only by migration or the secret key; insert-only, corrected by withdrawal rows.';

-- Whether p_date is a standing official holiday: federal, or of p_state_key when one is given.
-- No role check: public data, only definers call it.
create function private.official_holiday(p_date date, p_state_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.official_holidays h
    where h.entry = 'holiday' and h.holiday_date = p_date
      and (h.scope = 'federal' or (p_state_key is not null and h.scope = 'state'
        and h.state_key = p_state_key))
      and not exists (
        select 1 from public.official_holidays w where w.withdraws_id = h.id
      )
  )
$$;

revoke all on function private.official_holiday(date, text) from public, anon, authenticated;

-- BEFORE INSERT/UPDATE/DELETE: insert-only; a holiday is well formed and not a second standing
-- one for its day, scope and state; a withdrawal names a standing holiday.
create function private.official_holidays_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'The official holiday calendar is kept as written; withdraw a wrong date.'
      using errcode = 'MLDD1';
  end if;
  if new.entry = 'holiday' then
    if new.scope = 'state' and (
      new.state_key is null
      or new.state_key is distinct from private.normalise_tax_state(new.state_key)
      or private.nigerian_state_name(new.state_key) is null
    ) then
      raise exception 'A state holiday names one of the 36 states or FCT Abuja by its key.'
        using errcode = 'MLDD2';
    end if;
    if exists (
      select 1 from public.official_holidays h
      where h.entry = 'holiday' and h.holiday_date = new.holiday_date and h.scope = new.scope
        and h.state_key is not distinct from new.state_key
        and not exists (select 1 from public.official_holidays w where w.withdraws_id = h.id)
    ) then
      raise exception 'That day is already an official holiday.' using errcode = 'MLDD4';
    end if;
  elsif new.entry = 'withdrawal' then
    if not exists (
      select 1 from public.official_holidays h
      where h.id = new.withdraws_id and h.entry = 'holiday'
        and not exists (select 1 from public.official_holidays w where w.withdraws_id = h.id)
    ) then
      raise exception 'A withdrawal names a holiday that stands.' using errcode = 'MLDD3';
    end if;
  else
    raise exception 'An entry is a holiday or a withdrawal.' using errcode = 'MLDD2';
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.official_holidays_guard() from public, anon, authenticated;

create trigger official_holidays_guard
  before insert or update or delete on public.official_holidays
  for each row execute function private.official_holidays_guard();
alter table public.official_holidays enable always trigger official_holidays_guard;

create function private.official_holidays_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'The official holiday calendar is kept as written.' using errcode = 'MLDD1';
end;
$$;

revoke all on function private.official_holidays_no_truncate() from public, anon, authenticated;

create trigger official_holidays_no_truncate before truncate on public.official_holidays
  for each statement execute function private.official_holidays_no_truncate();
alter table public.official_holidays enable always trigger official_holidays_no_truncate;

alter table public.official_holidays enable row level security;

-- Every signed-in user reads the calendar (public law, the same for every company); anon gets
-- nothing (no grant). Not `using (true)`: the isolation suite refuses always-true policies.
create policy official_holidays_select on public.official_holidays
  for select to authenticated
  using ((select auth.uid()) is not null);

revoke all on table public.official_holidays from anon, authenticated;
grant select on table public.official_holidays to authenticated;
-- The secret key (a Metalira admin path) may insert; nothing may change or remove a row.
revoke update, delete, truncate on table public.official_holidays from service_role;

-- Seed: 2026 and 2027 federal holidays we could verify (see the header for what's left out).
insert into public.official_holidays (entry, holiday_date, name, scope, source, recorded_by)
values
  ('holiday', '2026-01-01', 'New Year''s Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2026-03-19', 'Eid-el-Fitr', 'federal', 'Federal Ministry of Interior declaration, March 2026', 'migration 20261122240000'),
  ('holiday', '2026-03-20', 'Eid-el-Fitr holiday', 'federal', 'Federal Ministry of Interior declaration, March 2026', 'migration 20261122240000'),
  ('holiday', '2026-04-03', 'Good Friday', 'federal', 'Public Holidays Act, schedule (Easter 5 Apr 2026)', 'migration 20261122240000'),
  ('holiday', '2026-04-06', 'Easter Monday', 'federal', 'Public Holidays Act, schedule (Easter 5 Apr 2026)', 'migration 20261122240000'),
  ('holiday', '2026-05-01', 'Workers'' Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2026-05-27', 'Eid-el-Kabir', 'federal', 'Federal Ministry of Interior declaration, 25 May 2026', 'migration 20261122240000'),
  ('holiday', '2026-05-28', 'Eid-el-Kabir holiday', 'federal', 'Federal Ministry of Interior declaration, 25 May 2026', 'migration 20261122240000'),
  ('holiday', '2026-06-12', 'Democracy Day', 'federal', 'Public Holidays Act, schedule (as amended 2019)', 'migration 20261122240000'),
  ('holiday', '2026-08-25', 'Eid-el-Maulud', 'federal', 'Federal Ministry of Interior declaration, August 2026', 'migration 20261122240000'),
  ('holiday', '2026-10-01', 'Independence Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2026-12-25', 'Christmas Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2026-12-26', 'Boxing Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2027-01-01', 'New Year''s Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2027-03-26', 'Good Friday', 'federal', 'Public Holidays Act, schedule (Easter 28 Mar 2027)', 'migration 20261122240000'),
  ('holiday', '2027-03-29', 'Easter Monday', 'federal', 'Public Holidays Act, schedule (Easter 28 Mar 2027)', 'migration 20261122240000'),
  ('holiday', '2027-05-01', 'Workers'' Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2027-06-12', 'Democracy Day', 'federal', 'Public Holidays Act, schedule (as amended 2019)', 'migration 20261122240000'),
  ('holiday', '2027-10-01', 'Independence Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2027-12-25', 'Christmas Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000'),
  ('holiday', '2027-12-26', 'Boxing Day', 'federal', 'Public Holidays Act, schedule', 'migration 20261122240000');

-- ---------------------------------------------------------------------------
-- 2. Deadline working days (official calendar only)
-- ---------------------------------------------------------------------------

-- Monday to Friday and not an official holiday (federal, or of p_state_key when given).
create function private.deadline_working_day(p_date date, p_state_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select extract(isodow from p_date) < 6 and not private.official_holiday(p_date, p_state_key)
$$;

revoke all on function private.deadline_working_day(date, text) from public, anon, authenticated;

-- p_days deadline working days after p_from. Mirrors addWorkingDays.
create function private.deadline_add_working_days(p_state_key text, p_from date, p_days integer)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_date date := p_from;
  v_left integer := p_days;
begin
  if p_from is null or p_days is null or p_days < 0 or p_days > 60 then
    raise exception 'Count 0 to 60 working days from a date.' using errcode = '22023';
  end if;
  while v_left > 0 loop
    v_date := v_date + 1;
    if private.deadline_working_day(v_date, p_state_key) then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_date;
end;
$$;

revoke all on function private.deadline_add_working_days(text, date, integer)
  from public, anon, authenticated;

-- The deadline working day on or before p_date. Mirrors workingDayOnOrBefore.
create function private.deadline_on_or_before(p_state_key text, p_date date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_date date := p_date;
begin
  while not private.deadline_working_day(v_date, p_state_key) loop
    v_date := v_date - 1;
  end loop;
  return v_date;
end;
$$;

revoke all on function private.deadline_on_or_before(text, date) from public, anon, authenticated;

-- The deadline working day on or after p_date. Mirrors workingDayOnOrAfter.
create function private.deadline_on_or_after(p_state_key text, p_date date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_date date := p_date;
begin
  while not private.deadline_working_day(v_date, p_state_key) loop
    v_date := v_date + 1;
  end loop;
  return v_date;
end;
$$;

revoke all on function private.deadline_on_or_after(text, date) from public, anon, authenticated;

-- The statutory deadline of a kind for salary paid on p_paid_on (adviser, 24 Nov 2026), before
-- any company day. p_state_key is the PAYE authority's key (its state's holidays count); null
-- for the other kinds. Mirrors statutoryDeadline.
create function private.statutory_deadline(p_kind text, p_paid_on date, p_state_key text)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_next date;
  v_state text := case when p_kind = 'paye' then p_state_key end;
begin
  if p_paid_on is null then
    raise exception 'A deadline needs the pay date.' using errcode = '22023';
  end if;
  v_next := (date_trunc('month', p_paid_on) + interval '1 month')::date;
  return case p_kind
    when 'pension' then private.deadline_add_working_days(
      null, private.deadline_on_or_after(null, p_paid_on), 6
    )
    when 'paye' then private.deadline_on_or_before(v_state, v_next + 9)
    -- Postgres keeps the day and clamps to the month's end (31 Jan + 1 month = 28 Feb).
    when 'nhf' then private.deadline_on_or_before(null, (p_paid_on + interval '1 month')::date)
    when 'nsitf' then private.deadline_on_or_before(null, v_next + 14)
    when 'itf' then private.deadline_on_or_before(
      null, make_date(extract(year from p_paid_on)::integer + 1, 4, 1)
    )
  end;
end;
$$;

revoke all on function private.statutory_deadline(text, date, text) from public, anon, authenticated;

-- A remittance's due date: the statutory deadline, or the company's own day of the month after
-- the pay date when that is earlier (a later one never applies). Mirrors remittanceDeadline.
create function private.statutory_due_date(
  p_organisation_id uuid,
  p_kind text,
  p_paid_on date,
  p_authority_key text
)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org public.organisations%rowtype;
  v_day smallint;
  v_statutory date := private.statutory_deadline(p_kind, p_paid_on, p_authority_key);
  v_custom date;
begin
  if p_kind = 'pension' then
    return v_statutory;
  end if;
  select o.* into v_org from public.organisations o where o.id = p_organisation_id;
  v_day := case p_kind
    when 'paye' then v_org.paye_remit_day
    when 'nhf' then v_org.nhf_remit_day
    when 'nsitf' then v_org.nsitf_remit_day
    when 'itf' then v_org.itf_remit_day
  end;
  if v_day is null then
    return v_statutory;
  end if;
  v_custom := (date_trunc('month', p_paid_on) + interval '1 month')::date + (v_day - 1);
  return least(v_custom, v_statutory);
end;
$$;

revoke all on function private.statutory_due_date(uuid, text, date, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Remittances stamp the provisional due date (5.6's functions, only the due date changed)
-- ---------------------------------------------------------------------------

create or replace function private.statutory_remittances_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Remittances are kept as written.' using errcode = 'MLSR6';
  end if;
  select r.* into v_run
  from public.payroll_runs r
  where r.organisation_id = new.organisation_id and r.id = new.run_id;
  if v_run.id is null or v_run.status not in ('approved', 'released') then
    raise exception 'Only a posted payroll run owes remittances.' using errcode = 'MLSR7';
  end if;
  if not exists (
    select 1 from private.statutory_amounts(new.organisation_id, new.run_id) a
    where a.kind = new.kind and a.authority_key is not distinct from new.authority_key
      and a.authority_name is not distinct from new.authority_name
      and a.authority_variants = new.authority_variants
      and a.amount_kobo = new.amount_kobo and a.worker_count = new.worker_count
  ) or new.due_date is distinct from private.statutory_due_date(
    new.organisation_id, new.kind, v_run.pay_date, new.authority_key
  ) then
    raise exception 'A remittance must be what the run''s payslips owe.' using errcode = 'MLSR7';
  end if;
  new.currency := 'NGN';
  new.created_at := now();
  return new;
end;
$$;

create or replace function private.payroll_runs_make_remittances()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sums record;
begin
  insert into public.statutory_remittances (
    organisation_id, run_id, kind, authority_key, authority_name, authority_variants, amount_kobo,
    worker_count, due_date
  )
  select new.organisation_id, new.id, a.kind, a.authority_key, a.authority_name,
         a.authority_variants, a.amount_kobo, a.worker_count,
         private.statutory_due_date(new.organisation_id, a.kind, new.pay_date, a.authority_key)
  from private.statutory_amounts(new.organisation_id, new.id) a
  order by a.kind, a.authority_key nulls first;

  select
    coalesce(sum(m.amount_kobo) filter (where m.kind = 'paye'), 0) as paye,
    coalesce(sum(m.amount_kobo) filter (where m.kind = 'pension'), 0) as pension,
    coalesce(sum(m.amount_kobo) filter (where m.kind = 'nhf'), 0) as nhf,
    coalesce(sum(m.amount_kobo) filter (where m.kind = 'nsitf'), 0) as nsitf,
    coalesce(sum(m.amount_kobo) filter (where m.kind = 'itf'), 0) as itf
  into v_sums
  from public.statutory_remittances m
  where m.organisation_id = new.organisation_id and m.run_id = new.id;
  if (v_sums.paye, v_sums.pension, v_sums.nhf, v_sums.nsitf, v_sums.itf) is distinct from (
    new.paye_kobo, new.pension_employee_kobo + new.pension_employer_kobo, new.nhf_kobo,
    new.nsitf_kobo, new.itf_kobo
  ) then
    raise exception 'The run''s statutory lines don''t add up to its totals.' using errcode = 'MLSR7';
  end if;
  return null;
end;
$$;

-- 5.6's due-date helpers counted the company's own holidays; nothing calls them now.
drop function private.statutory_due_date(uuid, text, date);
drop function private.add_working_days(uuid, date, integer);
drop function private.working_day_on_or_before(uuid, date);

comment on column public.statutory_remittances.due_date is
  'The due date stamped at approval from the scheduled pay date (slice 5.9b rules), so provisional: the screens work the due date out on read from the day salary was actually paid (the release), the official holiday calendar and the company''s days as they are now.';
comment on column public.organisations.paye_remit_day is
  'The company''s own PAYE due day (1 to 28) of the month after the pay date, or null. Applies only when earlier than the statutory deadline (slice 5.9b).';
comment on column public.organisations.nhf_remit_day is
  'As paye_remit_day, for NHF: applies only when earlier than the statutory deadline.';
comment on column public.organisations.nsitf_remit_day is
  'As paye_remit_day, for NSITF: applies only when earlier than the statutory deadline.';
comment on column public.organisations.itf_remit_day is
  'As paye_remit_day, for ITF: applies only when earlier than the statutory deadline.';
