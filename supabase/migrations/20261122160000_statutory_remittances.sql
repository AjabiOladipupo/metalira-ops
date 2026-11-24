-- Slice 5.6: statutory schedules and remittances (docs/PHASE_5.md 5.6, open questions 13 and 14;
-- CLAUDE.md rules 1, 4, 5, 6 and 9).
--
-- 1. Remittance due-day settings (open question 13): organisations gains paye_remit_day,
--    nhf_remit_day, nsitf_remit_day and itf_remit_day, each null (no due date) or a day of the
--    month (1 to 28) after the run's pay date. They are the company's own choice, not a Nigerian
--    rule; RULES_NIGERIA.md gives only pension's. Set through set_remittance_due_days (owner, hr).
-- 2. statutory_remittances: made when a run is approved (review -> approved), by an AFTER trigger
--    on payroll_runs, in the approval's own transaction, one row per kind and authority with an
--    amount above 0. Kinds: paye (authority: the payslip's tax state), pension (the payslip's PFA
--    name; employee and employer together), nhf, nsitf and itf (no authority). The amount is the
--    sum of the run's payslip lines in kobo; the sums per kind must equal the run's totals.
--    Due date: pension 7 working days after the pay date (RULES_NIGERIA "Pension": within 7
--    working days of paying salary), skipping Saturdays, Sundays and the company's public
--    holidays; the other kinds the company's day of the following month when it set one, else
--    null. Insert-only for everyone (the secret key and the database owner included).
-- 3. statutory_receipts: an evidence file the server checked (PDF, PNG or JPEG by its magic bytes,
--    10 MB or less) in the private bucket payroll-evidence at
--    {organisation_id}/{remittance_id}/{receipt_id}.{pdf,png,jpg}. Written only with the secret key
--    by record_statutory_receipt, naming the signed-in person the server checked; insert-only.
-- 4. statutory_payments: insert-only entries. A `payment` (paid on, amount, reference, the
--    receipt) is recorded once per remittance by owner, hr or finance in a trusted session, with a
--    receipt they checked themselves in the last hour; a wrong one is voided by a `void` entry
--    with a reason, after which a new payment may be recorded. Nothing is ever updated.
-- 5. Buckets. payroll-files (private, CSV) is shared with slice 5.4 (bank files) and created with
--    `on conflict do nothing`, so whichever slice lands first sets it up; schedules live at
--    {organisation_id}/{run_id}/schedules/{remittance_id}.csv. payroll-evidence (private) is this
--    slice's. Neither bucket has a storage policy from this slice: signed-in users can't list,
--    read, write or delete objects in them; the server writes with the secret key after an
--    RLS-checked read and hands out 60-second signed URLs (schedules) or signed upload tokens
--    for one exact path (receipts).
--
-- Refusals (SQLSTATE):
--   MLSR1 a payment is already recorded for this remittance (void it first)
--   MLSR2 the receipt isn't one you checked for this remittance in the last hour, or is used
--   MLSR3 the payment's date or amount is out of range
--   MLSR4 only a standing payment can be voided
--   MLSR5 the receipt file isn't in storage, or doesn't match what was checked
--   MLSR6 statutory records are kept as written (no update, delete or truncate)
--   MLSR7 the remittances don't match the run's payslips, or the run isn't posted
--   22023 bad input; 42501 the wrong role or an untrusted session; P0002 not in the company
-- No money maths here beyond sums: amounts are the payslip lines' kobo, summed.

-- ---------------------------------------------------------------------------
-- 1. Due-day settings
-- ---------------------------------------------------------------------------

alter table public.organisations
  add column paye_remit_day smallint
    constraint organisations_paye_remit_day check (paye_remit_day between 1 and 28),
  add column nhf_remit_day smallint
    constraint organisations_nhf_remit_day check (nhf_remit_day between 1 and 28),
  add column nsitf_remit_day smallint
    constraint organisations_nsitf_remit_day check (nsitf_remit_day between 1 and 28),
  add column itf_remit_day smallint
    constraint organisations_itf_remit_day check (itf_remit_day between 1 and 28);

comment on column public.organisations.paye_remit_day is
  'The company''s own due day for PAYE remittances: that day of the month after the pay date, or null for no due date (slice 5.6, open question 13). Not a Nigerian rule.';
comment on column public.organisations.nhf_remit_day is
  'As paye_remit_day, for NHF (slice 5.6).';
comment on column public.organisations.nsitf_remit_day is
  'As paye_remit_day, for NSITF (slice 5.6).';
comment on column public.organisations.itf_remit_day is
  'As paye_remit_day, for ITF (slice 5.6).';

-- ---------------------------------------------------------------------------
-- 2. Due dates
-- ---------------------------------------------------------------------------

-- p_days working days after p_from: Monday to Friday, leaving out the company's live public
-- holidays. No role check: only definers call it.
create function private.add_working_days(p_organisation_id uuid, p_from date, p_days integer)
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
    if extract(isodow from v_date) < 6 and not exists (
      select 1 from public.public_holidays h
      where h.organisation_id = p_organisation_id and h.holiday_date = v_date
        and h.removed_at is null
    ) then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_date;
end;
$$;

revoke all on function private.add_working_days(uuid, date, integer) from public, anon, authenticated;

-- A remittance's due date (open question 13): pension 7 working days after the pay date
-- (RULES_NIGERIA "Pension"); PAYE, NHF, NSITF and ITF the company's day of the month after the pay
-- date when it set one, else null (no rule in RULES_NIGERIA.md).
create function private.statutory_due_date(p_organisation_id uuid, p_kind text, p_pay_date date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org public.organisations%rowtype;
  v_day smallint;
begin
  if p_kind = 'pension' then
    return private.add_working_days(p_organisation_id, p_pay_date, 7);
  end if;
  select o.* into v_org from public.organisations o where o.id = p_organisation_id;
  v_day := case p_kind
    when 'paye' then v_org.paye_remit_day
    when 'nhf' then v_org.nhf_remit_day
    when 'nsitf' then v_org.nsitf_remit_day
    when 'itf' then v_org.itf_remit_day
  end;
  if v_day is null then
    return null;
  end if;
  return (date_trunc('month', p_pay_date) + interval '1 month')::date + (v_day - 1);
end;
$$;

revoke all on function private.statutory_due_date(uuid, text, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------

create table public.statutory_remittances (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  kind text not null
    constraint statutory_remittances_kind_value check (kind in ('paye', 'pension', 'nhf', 'nsitf', 'itf')),
  -- The tax state (PAYE) or PFA name (pension) from the payslips' snapshots; null for the levies,
  -- and for PAYE or pension owed by workers with none on file.
  authority_key text
    constraint statutory_remittances_authority_text check (
      char_length(authority_key) between 1 and 200 and authority_key !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  amount_kobo bigint not null constraint statutory_remittances_amount_positive check (amount_kobo > 0),
  currency text not null default 'NGN' constraint statutory_remittances_currency check (currency = 'NGN'),
  worker_count integer not null
    constraint statutory_remittances_worker_count check (worker_count > 0),
  due_date date,
  created_at timestamptz not null default now(),
  constraint statutory_remittances_organisation_id_id_key unique (organisation_id, id),
  constraint statutory_remittances_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint statutory_remittances_authority_kind check (
    authority_key is null or kind in ('paye', 'pension')
  ),
  constraint statutory_remittances_pension_due check (kind <> 'pension' or due_date is not null)
);

create unique index statutory_remittances_one_per_authority
  on public.statutory_remittances (run_id, kind, coalesce(authority_key, ''));
create index statutory_remittances_org_idx
  on public.statutory_remittances (organisation_id, created_at desc);

comment on table public.statutory_remittances is
  'What a posted payroll run owes each authority (slice 5.6): PAYE by tax state, pension by PFA (employee and employer), NHF, NSITF and ITF, summed from the payslip lines in kobo. Made at approval; insert-only.';

create table public.statutory_receipts (
  id uuid primary key,
  organisation_id uuid not null references public.organisations (id),
  remittance_id uuid not null,
  file_ext text not null constraint statutory_receipts_ext check (file_ext in ('pdf', 'png', 'jpg')),
  mime_type text not null
    constraint statutory_receipts_mime check (mime_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null constraint statutory_receipts_size check (size_bytes between 1 and 10485760),
  sha256 text not null constraint statutory_receipts_sha check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null,
  -- The person the server checked (owner, hr or finance of the company).
  checked_by uuid not null,
  created_at timestamptz not null default now(),
  constraint statutory_receipts_organisation_id_id_key unique (organisation_id, id),
  constraint statutory_receipts_path_key unique (storage_path),
  constraint statutory_receipts_remittance_fkey foreign key (organisation_id, remittance_id)
    references public.statutory_remittances (organisation_id, id),
  constraint statutory_receipts_path check (
    storage_path = organisation_id::text || '/' || remittance_id::text || '/' || id::text || '.' || file_ext
  ),
  constraint statutory_receipts_type_matches check (
    (file_ext = 'pdf' and mime_type = 'application/pdf')
    or (file_ext = 'png' and mime_type = 'image/png')
    or (file_ext = 'jpg' and mime_type = 'image/jpeg')
  )
);

create index statutory_receipts_remittance_idx
  on public.statutory_receipts (organisation_id, remittance_id);

comment on table public.statutory_receipts is
  'Proof-of-payment files the server checked by their magic bytes (slice 5.6), in the private payroll-evidence bucket. Written with the secret key only; insert-only.';

create table public.statutory_payments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  remittance_id uuid not null,
  entry text not null constraint statutory_payments_entry_value check (entry in ('payment', 'void')),
  -- A payment's details.
  paid_on date,
  paid_amount_kobo bigint,
  currency text not null default 'NGN' constraint statutory_payments_currency check (currency = 'NGN'),
  reference text
    constraint statutory_payments_reference_text check (
      char_length(reference) between 1 and 100 and reference !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  receipt_id uuid,
  -- A void's details.
  voids_payment_id uuid,
  reason text
    constraint statutory_payments_reason_text check (
      char_length(reason) between 1 and 500 and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  recorded_by uuid not null,
  created_at timestamptz not null default now(),
  constraint statutory_payments_organisation_id_id_key unique (organisation_id, id),
  constraint statutory_payments_remittance_fkey foreign key (organisation_id, remittance_id)
    references public.statutory_remittances (organisation_id, id),
  constraint statutory_payments_receipt_fkey foreign key (organisation_id, receipt_id)
    references public.statutory_receipts (organisation_id, id),
  constraint statutory_payments_voids_fkey foreign key (organisation_id, voids_payment_id)
    references public.statutory_payments (organisation_id, id),
  -- A receipt backs one payment; a payment is voided once.
  constraint statutory_payments_receipt_key unique (receipt_id),
  constraint statutory_payments_voids_key unique (voids_payment_id),
  constraint statutory_payments_shape check (
    case entry
      when 'payment' then
        paid_on is not null and paid_amount_kobo is not null and paid_amount_kobo > 0
        and paid_amount_kobo <= 100000000000000 and receipt_id is not null
        and voids_payment_id is null and reason is null
      else
        voids_payment_id is not null and reason is not null and paid_on is null
        and paid_amount_kobo is null and reference is null and receipt_id is null
    end
  )
);

create index statutory_payments_remittance_idx
  on public.statutory_payments (organisation_id, remittance_id, created_at);

comment on table public.statutory_payments is
  'Remittance payments as recorded (slice 5.6): a payment once per remittance with its receipt, and a void with a reason when one was wrong. Insert-only.';

-- ---------------------------------------------------------------------------
-- 4. Guards (every role, the secret key and the database owner included; ENABLE ALWAYS)
-- ---------------------------------------------------------------------------

-- The amount each kind and authority of a run owes, from its payslip lines.
create function private.statutory_amounts(p_organisation_id uuid, p_run_id uuid)
returns table (kind text, authority_key text, amount_kobo bigint, worker_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select g.kind, g.authority_key, g.amount_kobo, g.worker_count
  from (
    select
      k.kind,
      case k.kind when 'paye' then s.tax_state when 'pension' then s.pfa_name end as authority_key,
      sum(l.amount_kobo)::bigint as amount_kobo,
      (count(distinct s.id) filter (where l.amount_kobo > 0))::integer as worker_count
    from public.payslip_lines l
    join public.payslips s on s.organisation_id = l.organisation_id and s.id = l.payslip_id
    cross join lateral (
      select case
        when l.code = 'paye' then 'paye'
        when l.code in ('pension_employee', 'pension_employer') then 'pension'
        when l.code in ('nhf', 'nsitf', 'itf') then l.code
      end as kind
    ) k
    where l.organisation_id = p_organisation_id and l.run_id = p_run_id and k.kind is not null
    group by 1, 2
  ) g
  where g.amount_kobo > 0
$$;

revoke all on function private.statutory_amounts(uuid, uuid) from public, anon, authenticated;

-- BEFORE INSERT/UPDATE/DELETE on statutory_remittances: an insert is for a posted run, with the
-- amount and worker count its payslip lines give and the due date the rules give; nothing ever
-- changes or goes.
create function private.statutory_remittances_guard()
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
      and a.amount_kobo = new.amount_kobo and a.worker_count = new.worker_count
  ) or new.due_date is distinct from private.statutory_due_date(new.organisation_id, new.kind, v_run.pay_date) then
    raise exception 'A remittance must be what the run''s payslips owe.' using errcode = 'MLSR7';
  end if;
  new.currency := 'NGN';
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.statutory_remittances_guard() from public, anon, authenticated;

create trigger statutory_remittances_guard
  before insert or update or delete on public.statutory_remittances
  for each row execute function private.statutory_remittances_guard();

-- BEFORE INSERT/UPDATE/DELETE on statutory_receipts: insert-only, stamped now.
create function private.statutory_receipts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Receipts are kept as written.' using errcode = 'MLSR6';
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.statutory_receipts_guard() from public, anon, authenticated;

create trigger statutory_receipts_guard
  before insert or update or delete on public.statutory_receipts
  for each row execute function private.statutory_receipts_guard();

-- BEFORE INSERT/UPDATE/DELETE on statutory_payments: insert-only. A payment needs no standing
-- payment on its remittance and a receipt of that remittance; a void names a standing payment of
-- the same remittance. Serialised per remittance, so two payments can't both land.
create function private.statutory_payments_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Remittance payments are kept as written. Void a wrong one with a reason.'
      using errcode = 'MLSR6';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('statutory_remittance:' || new.remittance_id::text, 0));
  if new.entry = 'payment' then
    if exists (
      select 1 from public.statutory_payments p
      where p.organisation_id = new.organisation_id and p.remittance_id = new.remittance_id
        and p.entry = 'payment'
        and not exists (
          select 1 from public.statutory_payments v
          where v.organisation_id = p.organisation_id and v.voids_payment_id = p.id
        )
    ) then
      raise exception 'A payment is already recorded for this remittance. Void it first if it was wrong.'
        using errcode = 'MLSR1';
    end if;
    if not exists (
      select 1 from public.statutory_receipts r
      where r.organisation_id = new.organisation_id and r.id = new.receipt_id
        and r.remittance_id = new.remittance_id
    ) then
      raise exception 'The receipt isn''t one of this remittance''s.' using errcode = 'MLSR2';
    end if;
  else
    if not exists (
      select 1 from public.statutory_payments p
      where p.organisation_id = new.organisation_id and p.id = new.voids_payment_id
        and p.remittance_id = new.remittance_id and p.entry = 'payment'
    ) then
      raise exception 'Only a recorded payment can be voided.' using errcode = 'MLSR4';
    end if;
  end if;
  new.currency := 'NGN';
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.statutory_payments_guard() from public, anon, authenticated;

create trigger statutory_payments_guard
  before insert or update or delete on public.statutory_payments
  for each row execute function private.statutory_payments_guard();

-- TRUNCATE skips row triggers: refuse it.
create function private.statutory_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Statutory records are kept.' using errcode = 'MLSR6';
end;
$$;

revoke all on function private.statutory_no_truncate() from public, anon, authenticated;

create trigger statutory_remittances_no_truncate before truncate on public.statutory_remittances
  for each statement execute function private.statutory_no_truncate();
create trigger statutory_receipts_no_truncate before truncate on public.statutory_receipts
  for each statement execute function private.statutory_no_truncate();
create trigger statutory_payments_no_truncate before truncate on public.statutory_payments
  for each statement execute function private.statutory_no_truncate();

create trigger statutory_remittances_audit after insert on public.statutory_remittances
  for each row execute function private.audit_row_change();
create trigger statutory_receipts_audit after insert on public.statutory_receipts
  for each row execute function private.audit_row_change();
create trigger statutory_payments_audit after insert on public.statutory_payments
  for each row execute function private.audit_row_change();

-- session_replication_role = replica doesn't skip them.
alter table public.statutory_remittances enable always trigger statutory_remittances_guard;
alter table public.statutory_receipts enable always trigger statutory_receipts_guard;
alter table public.statutory_payments enable always trigger statutory_payments_guard;
alter table public.statutory_remittances enable always trigger statutory_remittances_no_truncate;
alter table public.statutory_receipts enable always trigger statutory_receipts_no_truncate;
alter table public.statutory_payments enable always trigger statutory_payments_no_truncate;

-- ---------------------------------------------------------------------------
-- 5. Made at approval
-- ---------------------------------------------------------------------------

-- AFTER UPDATE on payroll_runs, when a run moves review -> approved (5.3's approve_payroll_run):
-- one remittance per kind and authority with an amount above 0, in the approval's transaction.
-- The sums per kind must equal the run's totals, or the approval fails (MLSR7).
create function private.payroll_runs_make_remittances()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sums record;
begin
  insert into public.statutory_remittances (
    organisation_id, run_id, kind, authority_key, amount_kobo, worker_count, due_date
  )
  select new.organisation_id, new.id, a.kind, a.authority_key, a.amount_kobo, a.worker_count,
         private.statutory_due_date(new.organisation_id, a.kind, new.pay_date)
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

revoke all on function private.payroll_runs_make_remittances() from public, anon, authenticated;

create trigger payroll_runs_make_remittances
  after update of status on public.payroll_runs
  for each row
  when (old.status = 'review' and new.status = 'approved')
  execute function private.payroll_runs_make_remittances();

alter table public.payroll_runs enable always trigger payroll_runs_make_remittances;

-- ---------------------------------------------------------------------------
-- 6. Row-level security and grants: owner, hr and finance read; nobody writes directly
-- ---------------------------------------------------------------------------

alter table public.statutory_remittances enable row level security;
alter table public.statutory_receipts enable row level security;
alter table public.statutory_payments enable row level security;

create policy statutory_remittances_select on public.statutory_remittances
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy statutory_receipts_select on public.statutory_receipts
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy statutory_payments_select on public.statutory_payments
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.statutory_remittances, public.statutory_receipts,
  public.statutory_payments
  from anon, authenticated, service_role;
grant select on table public.statutory_remittances, public.statutory_receipts,
  public.statutory_payments
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Buckets
-- ---------------------------------------------------------------------------

-- Shared with slice 5.4 (bank files): whichever lands first creates it. CSV only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payroll-files', 'payroll-files', false, 10485760, array['text/csv'])
on conflict (id) do nothing;

-- Receipts for remittances: PDF, PNG and JPEG, 10 MB or less.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payroll-evidence',
  'payroll-evidence',
  false,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 8. Functions
-- ---------------------------------------------------------------------------

-- Owner, hr or finance of the organisation, in a trusted session: records and voids payments.
create function private.require_remittance_recorder(p_organisation_id uuid)
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
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only an owner, HR or Finance can record remittances.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function private.require_remittance_recorder(uuid) from public, anon, authenticated;

-- Records a receipt the server checked (the secret key only, no signed-in user): it read the
-- object back from payroll-evidence, checked its type from its magic bytes and its size, and
-- worked out its sha256. The object must be in the bucket at the receipt's own path with that
-- size and type; the actor must be an owner, hr or finance member of the company. Returns the id.
create function private.record_statutory_receipt(
  p_organisation_id uuid,
  p_remittance_id uuid,
  p_receipt_id uuid,
  p_actor uuid,
  p_file_ext text,
  p_size_bytes integer,
  p_sha256 text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_path text;
  v_mime text;
  v_size bigint;
  v_type text;
begin
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'Only the server checks receipts.' using errcode = '42501';
  end if;
  if p_organisation_id is null or p_remittance_id is null or p_receipt_id is null
    or p_actor is null then
    raise exception 'Name the company, the remittance, the receipt and who uploaded it.'
      using errcode = '22023';
  end if;
  if p_file_ext is null or p_file_ext not in ('pdf', 'png', 'jpg')
    or p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A receipt is a PDF, PNG or JPEG of 10 MB or less.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id and m.user_id = p_actor
      and m.role in ('owner', 'hr', 'finance')
  ) then
    raise exception 'Only an owner, HR or Finance can record remittances.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.statutory_remittances r
    where r.organisation_id = p_organisation_id and r.id = p_remittance_id
  ) then
    raise exception 'That remittance wasn''t found.' using errcode = 'P0002';
  end if;
  v_mime := case p_file_ext
    when 'pdf' then 'application/pdf' when 'png' then 'image/png' else 'image/jpeg'
  end;
  v_path := p_organisation_id::text || '/' || p_remittance_id::text || '/' || p_receipt_id::text
    || '.' || p_file_ext;
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype'
  into v_size, v_type
  from storage.objects o
  where o.bucket_id = 'payroll-evidence' and o.name = v_path;
  if not found then
    raise exception 'The receipt didn''t arrive. Choose the file again.' using errcode = 'MLSR5';
  end if;
  if v_size is distinct from p_size_bytes::bigint or v_type is distinct from v_mime then
    raise exception 'The receipt doesn''t match the file chosen. Choose it again.'
      using errcode = 'MLSR5';
  end if;
  perform set_config('metalira.audit_channel', 'web', true);
  insert into public.statutory_receipts (
    id, organisation_id, remittance_id, file_ext, mime_type, size_bytes, sha256, storage_path,
    checked_by
  )
  values (
    p_receipt_id, p_organisation_id, p_remittance_id, p_file_ext, v_mime, p_size_bytes, p_sha256,
    v_path, p_actor
  );
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, p_actor, 'payroll.remittance_receipt_checked', 'statutory_remittances',
    p_remittance_id, null,
    jsonb_build_object(
      'receipt_id', p_receipt_id, 'mime_type', v_mime, 'size_bytes', p_size_bytes,
      'sha256', p_sha256
    )
  );
  return p_receipt_id;
end;
$$;

revoke all on function private.record_statutory_receipt(uuid, uuid, uuid, uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function private.record_statutory_receipt(uuid, uuid, uuid, uuid, text, integer, text)
  to service_role;

create function public.record_statutory_receipt(
  p_organisation_id uuid,
  p_remittance_id uuid,
  p_receipt_id uuid,
  p_actor uuid,
  p_file_ext text,
  p_size_bytes integer,
  p_sha256 text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_statutory_receipt(
    p_organisation_id, p_remittance_id, p_receipt_id, p_actor, p_file_ext, p_size_bytes, p_sha256
  )
$$;

revoke all on function public.record_statutory_receipt(uuid, uuid, uuid, uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_statutory_receipt(uuid, uuid, uuid, uuid, text, integer, text)
  to service_role;

-- Records the payment of a remittance (owner, hr or finance, trusted session), once: paid on a
-- day from the run's period start to today (Lagos), an amount in kobo (as text, digits only), an
-- optional bank reference, and a receipt the caller checked for this remittance in the last hour
-- and no payment uses. Returns the payment's id.
create function private.record_statutory_payment(
  p_organisation_id uuid,
  p_remittance_id uuid,
  p_receipt_id uuid,
  p_paid_on date,
  p_paid_amount_kobo text,
  p_reference text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_remittance_recorder(p_organisation_id);
  v_rem public.statutory_remittances%rowtype;
  v_run public.payroll_runs%rowtype;
  v_amount bigint;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_id uuid;
  v_today date := (now() at time zone 'Africa/Lagos')::date;
begin
  if p_remittance_id is null or p_receipt_id is null then
    raise exception 'Choose the remittance and its receipt.' using errcode = '22023';
  end if;
  select r.* into v_rem
  from public.statutory_remittances r
  where r.organisation_id = p_organisation_id and r.id = p_remittance_id;
  if v_rem.id is null then
    raise exception 'That remittance wasn''t found.' using errcode = 'P0002';
  end if;
  select r.* into v_run
  from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = v_rem.run_id;
  if p_paid_amount_kobo is null or p_paid_amount_kobo !~ '^[0-9]{1,15}$' then
    raise exception 'Enter the amount paid.' using errcode = 'MLSR3';
  end if;
  v_amount := p_paid_amount_kobo::bigint;
  if v_amount <= 0 or v_amount > 100000000000000 then
    raise exception 'Enter the amount paid, above ₦0.' using errcode = 'MLSR3';
  end if;
  if p_paid_on is null or p_paid_on > v_today or p_paid_on < v_run.period_start then
    raise exception 'The payment date is from the pay period''s start to today.' using errcode = 'MLSR3';
  end if;
  if v_reference is not null and (
    char_length(v_reference) > 100 or v_reference ~ '[\x01-\x1f\x7f-\x9f<>]'
  ) then
    raise exception 'The reference is up to 100 characters, with no symbols like < or >.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.statutory_receipts c
    where c.organisation_id = p_organisation_id and c.id = p_receipt_id
      and c.remittance_id = p_remittance_id and c.checked_by = v_uid
      and c.created_at > now() - interval '1 hour'
  ) or exists (
    select 1 from public.statutory_payments p
    where p.organisation_id = p_organisation_id and p.receipt_id = p_receipt_id
  ) then
    raise exception 'Upload the receipt again, then record the payment.' using errcode = 'MLSR2';
  end if;

  insert into public.statutory_payments (
    organisation_id, remittance_id, entry, paid_on, paid_amount_kobo, reference, receipt_id,
    recorded_by
  )
  values (
    p_organisation_id, p_remittance_id, 'payment', p_paid_on, v_amount, v_reference, p_receipt_id,
    v_uid
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.remittance_paid', 'statutory_remittances', p_remittance_id, null,
    jsonb_build_object(
      'payment_id', v_id, 'receipt_id', p_receipt_id, 'kind', v_rem.kind, 'run_id', v_rem.run_id,
      'paid_on', p_paid_on, 'paid_amount_kobo', v_amount::text,
      'amount_due_kobo', v_rem.amount_kobo::text
    ),
    null
  );
  return v_id;
end;
$$;

revoke all on function private.record_statutory_payment(uuid, uuid, uuid, date, text, text)
  from public, anon;
grant execute on function private.record_statutory_payment(uuid, uuid, uuid, date, text, text)
  to authenticated;

create function public.record_statutory_payment(
  p_organisation_id uuid,
  p_remittance_id uuid,
  p_receipt_id uuid,
  p_paid_on date,
  p_paid_amount_kobo text,
  p_reference text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_statutory_payment(
    p_organisation_id, p_remittance_id, p_receipt_id, p_paid_on, p_paid_amount_kobo, p_reference
  )
$$;

revoke all on function public.record_statutory_payment(uuid, uuid, uuid, date, text, text)
  from public, anon;
grant execute on function public.record_statutory_payment(uuid, uuid, uuid, date, text, text)
  to authenticated;

-- Voids a recorded payment (owner, hr or finance, trusted session) with a reason, as a new entry;
-- the remittance is then unpaid and a new payment may be recorded. Returns the void's id.
create function private.void_statutory_payment(
  p_organisation_id uuid,
  p_payment_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_remittance_recorder(p_organisation_id);
  v_pay public.statutory_payments%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid;
begin
  if char_length(v_reason) not between 1 and 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]' then
    raise exception 'Say why the payment record is wrong, in up to 500 characters.'
      using errcode = '22023';
  end if;
  select p.* into v_pay
  from public.statutory_payments p
  where p.organisation_id = p_organisation_id and p.id = p_payment_id;
  if v_pay.id is null then
    raise exception 'That payment wasn''t found.' using errcode = 'P0002';
  end if;
  if v_pay.entry <> 'payment' or exists (
    select 1 from public.statutory_payments v
    where v.organisation_id = p_organisation_id and v.voids_payment_id = v_pay.id
  ) then
    raise exception 'Only a standing payment can be voided.' using errcode = 'MLSR4';
  end if;
  insert into public.statutory_payments (
    organisation_id, remittance_id, entry, voids_payment_id, reason, recorded_by
  )
  values (p_organisation_id, v_pay.remittance_id, 'void', v_pay.id, v_reason, v_uid)
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.remittance_payment_voided', 'statutory_remittances',
    v_pay.remittance_id, null,
    jsonb_build_object('payment_id', v_pay.id, 'void_id', v_id),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.void_statutory_payment(uuid, uuid, text) from public, anon;
grant execute on function private.void_statutory_payment(uuid, uuid, text) to authenticated;

create function public.void_statutory_payment(
  p_organisation_id uuid,
  p_payment_id uuid,
  p_reason text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.void_statutory_payment(p_organisation_id, p_payment_id, p_reason)
$$;

revoke all on function public.void_statutory_payment(uuid, uuid, text) from public, anon;
grant execute on function public.void_statutory_payment(uuid, uuid, text) to authenticated;

-- Sets the company's own remittance due days (owner or hr, trusted session; open question 13):
-- each null (no due date) or 1 to 28, the day of the month after the pay date. Remittances
-- already made keep their due dates; runs approved from now on use these.
create function private.set_remittance_due_days(
  p_organisation_id uuid,
  p_paye integer default null,
  p_nhf integer default null,
  p_nsitf integer default null,
  p_itf integer default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_before jsonb;
begin
  if v_uid is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr']) then
    raise exception 'Only an owner or HR can change payroll settings.' using errcode = '42501';
  end if;
  if (p_paye is not null and p_paye not between 1 and 28)
    or (p_nhf is not null and p_nhf not between 1 and 28)
    or (p_nsitf is not null and p_nsitf not between 1 and 28)
    or (p_itf is not null and p_itf not between 1 and 28) then
    raise exception 'A due day is 1 to 28, or none.' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'paye', o.paye_remit_day, 'nhf', o.nhf_remit_day, 'nsitf', o.nsitf_remit_day,
    'itf', o.itf_remit_day
  )
  into v_before
  from public.organisations o
  where o.id = p_organisation_id
  for update;
  update public.organisations o
  set paye_remit_day = p_paye, nhf_remit_day = p_nhf, nsitf_remit_day = p_nsitf,
      itf_remit_day = p_itf
  where o.id = p_organisation_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.remittance_due_days_set', 'organisations', p_organisation_id,
    v_before,
    jsonb_build_object('paye', p_paye, 'nhf', p_nhf, 'nsitf', p_nsitf, 'itf', p_itf),
    null
  );
end;
$$;

revoke all on function private.set_remittance_due_days(uuid, integer, integer, integer, integer)
  from public, anon;
grant execute on function private.set_remittance_due_days(uuid, integer, integer, integer, integer)
  to authenticated;

create function public.set_remittance_due_days(
  p_organisation_id uuid,
  p_paye integer default null,
  p_nhf integer default null,
  p_nsitf integer default null,
  p_itf integer default null
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_remittance_due_days(p_organisation_id, p_paye, p_nhf, p_nsitf, p_itf)
$$;

revoke all on function public.set_remittance_due_days(uuid, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.set_remittance_due_days(uuid, integer, integer, integer, integer)
  to authenticated;
