-- Slice 1.3: people schema.
--
-- Workers, departments, dated pay rates and the mapping of workers to clients, sites and
-- projects, plus name-only clients, sites and projects so mapping works before Phase 2
-- (owner decision 1: Phase 2 and Phase 8 extend those three with `alter table`).
--
-- Ground rules (CLAUDE.md, docs/PHASE_1.md):
-- * Every table has organisation_id, RLS through private.has_role() and the helpers below,
--   and is registered in tests/rls/tables/people.ts.
-- * References between tenant tables are composite (organisation_id, id) foreign keys, so a
--   row can never point at another organisation's row, whoever writes it.
-- * Money is bigint kobo with a `currency` column. Each amount is capped at 10^15 kobo, well
--   inside JavaScript's safe-integer range, so a value read back through PostgREST as a JSON
--   number is exact.
-- * Pay rates are dated versions. A version in force (effective_from on or before today in the
--   organisation's timezone) is never updated except to close it; a correction is a new
--   version. A scheduled (future) version may have its amounts changed or be cancelled, never
--   moved: cancelling reopens the version before it, so versions never leave a gap. Enforced
--   by trigger, not only by the server.
-- * Bank details (bank_name, account_name, bank_account_enc, bank_account_last4) are written
--   when a worker is created and are not updatable by signed-in users: changes go through the
--   two-person approval of slice 1.7 (CLAUDE.md rule 10). staff_id never changes after insert
--   either, and the unique index covers ended workers too, so an ID can't be freed and handed
--   to a new row carrying someone else's identity and a different bank account.
-- * memberships.worker_id (a worker's own login) is not updatable by signed-in users: the RLS
--   helpers below read it to decide who may see a worker's row and pay. Slice 1.9 sets it in
--   the invite-acceptance function.
-- * Personal data (NIN, bank account number, RSA PIN) is stored encrypted by the server
--   (src/server/crypto/pii.ts) in `_enc` bytea columns. The row audit trigger drops those
--   columns and the `_last4` siblings (private.audit_secret_key, 20261116090000, matches the
--   `_enc` suffix and the whole parts `bank_account` and `rsa_pin`); a separate trigger records
--   which fields were added, changed or removed, never the values.
-- * Workers and assignments are never deleted: employment ends, rows close. Pay versions in
--   force are never deleted; only a scheduled version can be cancelled.

-- ---------------------------------------------------------------------------
-- 1. Extensions and types
-- ---------------------------------------------------------------------------

-- uuid equality inside a GiST exclusion constraint (no overlapping pay rates per worker).
create extension if not exists btree_gist with schema extensions;

create type public.employment_type as enum ('permanent', 'contract', 'casual', 'daily');
create type public.worker_status as enum ('active', 'ended');
create type public.pay_type as enum ('monthly', 'daily', 'hourly');

-- Composite foreign-key target: workers point at their line manager's membership.
alter table public.memberships
  add constraint memberships_organisation_id_id_key unique (organisation_id, id);

-- ---------------------------------------------------------------------------
-- 2. Helpers used by triggers
-- ---------------------------------------------------------------------------

-- Today's date in the organisation's timezone (Africa/Lagos by default). Pay-rate locking is
-- by calendar day as the company sees it, not by the database server's UTC date.
create function private.org_today(org uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select o.timezone from public.organisations o where o.id = org),
    'Africa/Lagos'
  ))::date
$$;

-- ---------------------------------------------------------------------------
-- 3. Mapping targets: clients, sites, projects (name only until Phase 2 and 8)
-- ---------------------------------------------------------------------------
-- Plain-text rule, as on organisations.name (20261116090000_identity_hardening):
--   no control characters, no < or >:  value !~ '[\x01-\x1f\x7f-\x9f<>]'
--   no web address:                    value !~* '(://|www\.)'

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  name text not null
    constraint clients_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 200
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint clients_organisation_id_id_key unique (organisation_id, id)
);

create unique index clients_organisation_name_key on public.clients (organisation_id, lower(name));

comment on table public.clients is
  'Name-only until Phase 2 adds billing columns. Created by hand or by the people import for new names.';

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  client_id uuid not null,
  name text not null
    constraint sites_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 200
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint sites_organisation_id_id_key unique (organisation_id, id),
  constraint sites_client_fkey foreign key (organisation_id, client_id)
    references public.clients (organisation_id, id)
);

create unique index sites_client_name_key on public.sites (organisation_id, client_id, lower(name));

comment on table public.sites is
  'Name-only until Phase 2 adds the address and geofence. Every site belongs to a client.';

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  client_id uuid not null,
  name text not null
    constraint projects_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 200
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint projects_organisation_id_id_key unique (organisation_id, id),
  constraint projects_client_fkey foreign key (organisation_id, client_id)
    references public.clients (organisation_id, id)
);

create unique index projects_client_name_key
  on public.projects (organisation_id, client_id, lower(name));

comment on table public.projects is
  'Name-only until Phase 8 adds phases, owners and the overtime multiplier. Every project belongs to a client.';

-- ---------------------------------------------------------------------------
-- 4. Departments and workers
-- ---------------------------------------------------------------------------

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  name text not null
    constraint departments_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 200
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  -- Foreign key added after workers exists.
  head_worker_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint departments_organisation_id_id_key unique (organisation_id, id)
);

create unique index departments_organisation_name_key
  on public.departments (organisation_id, lower(name));

create table public.workers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),

  -- Identity and job. staff_id is the company's own ID (owner decision 2); the server
  -- generates the next one in the company's pattern only when it is left blank. Fixed once
  -- saved (no update grant).
  staff_id text not null
    constraint workers_staff_id_text check (
      staff_id = btrim(staff_id)
      and char_length(staff_id) between 1 and 64
      and staff_id !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  first_name text not null
    constraint workers_first_name_text check (
      first_name = btrim(first_name)
      and char_length(first_name) between 1 and 200
      and first_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and first_name !~* '(://|www\.)'
    ),
  last_name text not null
    constraint workers_last_name_text check (
      last_name = btrim(last_name)
      and char_length(last_name) between 1 and 200
      and last_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and last_name !~* '(://|www\.)'
    ),
  -- Nigerian mobile number in local 11-digit form (08031234567), as the import normalises it.
  phone text
    constraint workers_phone_format check (phone ~ '^0(70|80|81|90|91)[0-9]{8}$'),
  email text
    constraint workers_email_format check (
      char_length(email) between 3 and 320
      and email = lower(btrim(email))
      and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    ),
  job_title text
    constraint workers_job_title_text check (
      job_title = btrim(job_title)
      and char_length(job_title) between 1 and 200
      and job_title !~ '[\x01-\x1f\x7f-\x9f<>]'
      and job_title !~* '(://|www\.)'
    ),
  department_id uuid,
  -- The line manager is a worker or a manager-app user who is not a worker (owner decision 3),
  -- never both. Neither means the worker is not fully mapped yet.
  line_manager_worker_id uuid,
  line_manager_membership_id uuid,

  -- Employment.
  employment_type public.employment_type not null,
  start_date date not null,
  end_date date,
  status public.worker_status not null default 'active',

  -- Pay details. Bank columns change only through slice 1.7's approved requests.
  bank_name text
    constraint workers_bank_name_text check (
      bank_name = btrim(bank_name)
      and char_length(bank_name) between 1 and 200
      and bank_name !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  account_name text
    constraint workers_account_name_text check (
      account_name = btrim(account_name)
      and char_length(account_name) between 1 and 200
      and account_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and account_name !~* '(://|www\.)'
    ),
  bank_account_enc bytea,
  bank_account_last4 text
    constraint workers_bank_account_last4_format check (bank_account_last4 ~ '^[0-9]{4}$'),

  -- Tax and pension.
  nin_enc bytea,
  tin text
    constraint workers_tin_text check (
      tin = btrim(tin) and char_length(tin) between 1 and 200 and tin !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  tax_state text
    constraint workers_tax_state_text check (
      tax_state = btrim(tax_state)
      and char_length(tax_state) between 1 and 200
      and tax_state !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  pfa_name text
    constraint workers_pfa_name_text check (
      pfa_name = btrim(pfa_name)
      and char_length(pfa_name) between 1 and 200
      and pfa_name !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  rsa_pin_enc bytea,
  rsa_pin_last4 text
    constraint workers_rsa_pin_last4_format check (rsa_pin_last4 ~ '^[0-9]{4}$'),
  nhf_opt_in boolean not null default false,
  annual_rent_declared_kobo bigint
    constraint workers_annual_rent_range check (
      annual_rent_declared_kobo between 0 and 1000000000000000
    ),
  currency text not null default 'NGN' constraint workers_currency_ngn check (currency = 'NGN'),

  -- Next of kin.
  next_of_kin_name text
    constraint workers_next_of_kin_name_text check (
      next_of_kin_name = btrim(next_of_kin_name)
      and char_length(next_of_kin_name) between 1 and 200
      and next_of_kin_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and next_of_kin_name !~* '(://|www\.)'
    ),
  next_of_kin_phone text
    constraint workers_next_of_kin_phone_text check (
      next_of_kin_phone = btrim(next_of_kin_phone)
      and char_length(next_of_kin_phone) between 1 and 200
      and next_of_kin_phone !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),

  -- Flags. needs_pay_details is maintained by trigger (bank details missing, or no pay rate
  -- in force on the later of today and the start date); payroll refuses to pay these workers. supervisor_clock_in is set when the worker shares a
  -- phone number with another worker (owner decision 15).
  needs_pay_details boolean not null default true,
  supervisor_clock_in boolean not null default false,

  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),

  constraint workers_organisation_id_id_key unique (organisation_id, id),
  constraint workers_department_fkey foreign key (organisation_id, department_id)
    references public.departments (organisation_id, id),
  constraint workers_line_manager_worker_fkey foreign key (organisation_id, line_manager_worker_id)
    references public.workers (organisation_id, id),
  -- Removing a manager's membership leaves their reportees without a line manager.
  constraint workers_line_manager_membership_fkey
    foreign key (organisation_id, line_manager_membership_id)
    references public.memberships (organisation_id, id)
    on delete set null (line_manager_membership_id),
  constraint workers_one_line_manager check (
    num_nonnulls(line_manager_worker_id, line_manager_membership_id) <= 1
  ),
  constraint workers_not_own_line_manager check (line_manager_worker_id <> id),
  constraint workers_end_after_start check (end_date >= start_date),
  constraint workers_ended_has_end_date check (status <> 'ended' or end_date is not null),
  constraint workers_bank_account_last4_pair check (
    (bank_account_enc is null) = (bank_account_last4 is null)
  ),
  constraint workers_rsa_pin_last4_needs_value check (rsa_pin_last4 is null or rsa_pin_enc is not null)
);

-- Staff IDs are unique per organisation, ignoring case (EMP-0001 and emp-0001 are one ID),
-- across ended workers too: an ID is never reused.
create unique index workers_staff_id_key on public.workers (organisation_id, lower(staff_id));
create index workers_department_idx on public.workers (organisation_id, department_id);
create index workers_line_manager_worker_idx on public.workers (line_manager_worker_id);
create index workers_line_manager_membership_idx on public.workers (line_manager_membership_id);
create index workers_phone_idx on public.workers (organisation_id, phone);

comment on table public.workers is
  'People on the payroll. Personal data in *_enc columns is AES-256-GCM ciphertext written by src/server/crypto/pii.ts. Never deleted: end employment instead.';
comment on column public.workers.needs_pay_details is
  'Maintained by trigger at each write: true while bank details are missing or no pay rate is in force on the later of today and the start date. Payroll refuses to pay these workers, and still resolves the rate as of each pay date rather than trusting this flag.';
comment on column public.workers.supervisor_clock_in is
  'True when the worker shares a phone with another worker: a supervisor clocks them in.';

alter table public.departments
  add constraint departments_head_worker_fkey foreign key (organisation_id, head_worker_id)
    references public.workers (organisation_id, id);

-- A worker's own login (slice 1.9). At most one membership per worker.
alter table public.memberships
  add constraint memberships_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id);
create unique index memberships_worker_id_key on public.memberships (worker_id)
  where worker_id is not null;

-- From here on memberships.worker_id decides who reads a worker's row, pay and reportees
-- (private.my_worker_ids, private.is_line_manager_for). An admin linking any user to any
-- worker would hand them that worker's pay, so signed-in users can no longer write it; slice
-- 1.9's invite acceptance sets it in a security-definer function.
revoke update (worker_id) on table public.memberships from authenticated;

-- ---------------------------------------------------------------------------
-- 5. Pay rates (dated versions) and worker assignments (the mapping)
-- ---------------------------------------------------------------------------

create table public.pay_rates (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  pay_type public.pay_type not null,
  -- Monthly pay: basic is required and above zero; allowances are zero or more.
  basic_kobo bigint
    constraint pay_rates_basic_range check (basic_kobo between 0 and 1000000000000000),
  housing_kobo bigint
    constraint pay_rates_housing_range check (housing_kobo between 0 and 1000000000000000),
  transport_kobo bigint
    constraint pay_rates_transport_range check (transport_kobo between 0 and 1000000000000000),
  other_allowances_kobo bigint
    constraint pay_rates_other_allowances_range check (
      other_allowances_kobo between 0 and 1000000000000000
    ),
  -- Daily pay: the daily rate. Hourly pay: the hourly rate.
  daily_rate_kobo bigint
    constraint pay_rates_daily_rate_range check (daily_rate_kobo between 0 and 1000000000000000),
  hourly_rate_kobo bigint
    constraint pay_rates_hourly_rate_range check (hourly_rate_kobo between 0 and 1000000000000000),
  currency text not null default 'NGN' constraint pay_rates_currency_ngn check (currency = 'NGN'),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint pay_rates_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint pay_rates_dates check (effective_to >= effective_from),
  -- Exactly the amounts that belong to the pay type.
  constraint pay_rates_amounts_match_type check (
    case pay_type
      when 'monthly' then
        coalesce(basic_kobo, 0) > 0
        and num_nonnulls(housing_kobo, transport_kobo, other_allowances_kobo) = 3
        and num_nulls(daily_rate_kobo, hourly_rate_kobo) = 2
      when 'daily' then
        coalesce(daily_rate_kobo, 0) > 0
        and num_nulls(basic_kobo, housing_kobo, transport_kobo, other_allowances_kobo, hourly_rate_kobo) = 5
      when 'hourly' then
        coalesce(hourly_rate_kobo, 0) > 0
        and num_nulls(basic_kobo, housing_kobo, transport_kobo, other_allowances_kobo, daily_rate_kobo) = 5
    end
  ),
  -- One version in force per worker per day. A null effective_to means open-ended.
  constraint pay_rates_no_overlap exclude using gist (
    worker_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);

create index pay_rates_worker_from_idx on public.pay_rates (worker_id, effective_from);

comment on table public.pay_rates is
  'Dated pay versions. A version in force is never updated except to close effective_to; changes are new versions (public.add_pay_rate). Amounts are bigint kobo.';

create table public.worker_assignments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  client_id uuid,
  site_id uuid,
  project_id uuid,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint worker_assignments_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint worker_assignments_client_fkey foreign key (organisation_id, client_id)
    references public.clients (organisation_id, id),
  constraint worker_assignments_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id),
  constraint worker_assignments_project_fkey foreign key (organisation_id, project_id)
    references public.projects (organisation_id, id),
  constraint worker_assignments_dates check (effective_to >= effective_from),
  constraint worker_assignments_has_target check (num_nonnulls(client_id, site_id, project_id) >= 1)
);

create index worker_assignments_worker_idx on public.worker_assignments (worker_id, effective_from);
create index worker_assignments_client_idx on public.worker_assignments (client_id);
create index worker_assignments_site_idx on public.worker_assignments (site_id);
create index worker_assignments_project_idx on public.worker_assignments (project_id);

comment on table public.worker_assignments is
  'The mapping: which client, site and project a worker is on, by date. Rows close (effective_to) rather than change; history is kept.';

-- ---------------------------------------------------------------------------
-- 6. Trigger functions
-- ---------------------------------------------------------------------------
-- The check triggers run as the caller (no security definer). Only owner, admin and hr can
-- write these tables, and they can read everything the checks look at. An insert aimed at
-- another organisation sees nothing of it through RLS here and is then refused by RLS itself,
-- so the checks reveal nothing across tenants.

-- BEFORE INSERT/UPDATE on workers.
create function private.workers_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A manager-app user as line manager: a manager role in this organisation, not a worker
  -- login (a worker who manages others is referenced by line_manager_worker_id instead).
  if new.line_manager_membership_id is not null
    and (tg_op = 'INSERT' or new.line_manager_membership_id is distinct from old.line_manager_membership_id)
    and not exists (
      select 1
      from public.memberships m
      where m.id = new.line_manager_membership_id
        and m.organisation_id = new.organisation_id
        and m.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
        and m.worker_id is null
    ) then
    raise exception 'The line manager must be a manager in this company who is not on the worker list.'
      using errcode = 'MLLM2';
  end if;

  -- No cycles in the line-manager chain. The advisory lock serialises line-manager changes in
  -- one organisation so two concurrent edits cannot each close half of a loop.
  if new.line_manager_worker_id is not null
    and (tg_op = 'INSERT' or new.line_manager_worker_id is distinct from old.line_manager_worker_id) then
    if new.line_manager_worker_id = new.id then
      raise exception 'A worker can''t be their own line manager.' using errcode = 'MLLM1';
    end if;
    perform pg_advisory_xact_lock(
      hashtextextended('workers_line_manager:' || new.organisation_id::text, 0)
    );
    if exists (
      with recursive chain (id) as (
        select new.line_manager_worker_id
        union
        select w.line_manager_worker_id
        from public.workers w
        join chain c on w.id = c.id
        where w.line_manager_worker_id is not null
      )
      select 1 from chain where chain.id = new.id
    ) then
      raise exception 'That line manager reports to this worker, which would make a loop.'
        using errcode = 'MLLM1';
    end if;
  end if;

  -- A snapshot at write time: payroll still resolves the rate as of each pay date. The rate
  -- must be in force on the later of today and the start date, so a worker whose only rate
  -- starts next month, or whose rates have all closed, is flagged.
  new.needs_pay_details := new.bank_name is null
    or new.account_name is null
    or new.bank_account_enc is null
    or not exists (
      select 1
      from public.pay_rates p
      where p.worker_id = new.id
        and p.effective_from <= greatest(private.org_today(new.organisation_id), new.start_date)
        and (
          p.effective_to is null
          or p.effective_to >= greatest(private.org_today(new.organisation_id), new.start_date)
        )
    );

  return new;
end;
$$;

-- AFTER INSERT/UPDATE on workers. The row audit drops *_enc and *_last4 columns
-- (private.audit_secret_key), so a change to personal data alone would leave no trace; this
-- records which fields were added, changed or removed, never the values (CLAUDE.md rule 9).
create function private.workers_audit_personal_data()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changes jsonb := '[]'::jsonb;
  field text;
  old_value bytea;
  new_value bytea;
begin
  foreach field in array array['nin', 'bank_account', 'rsa_pin'] loop
    new_value := case field
      when 'nin' then new.nin_enc
      when 'bank_account' then new.bank_account_enc
      else new.rsa_pin_enc
    end;
    old_value := case
      when tg_op = 'INSERT' then null
      when field = 'nin' then old.nin_enc
      when field = 'bank_account' then old.bank_account_enc
      else old.rsa_pin_enc
    end;
    if new_value is distinct from old_value then
      changes := changes || jsonb_build_array(jsonb_build_object(
        'field', field,
        'change', case
          when old_value is null then 'added'
          when new_value is null then 'removed'
          else 'changed'
        end
      ));
    end if;
  end loop;

  if jsonb_array_length(changes) > 0 then
    insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
    values (
      new.organisation_id,
      auth.uid(),
      'workers.personal_data',
      'workers',
      new.id,
      jsonb_build_object('changes', changes)
    );
  end if;
  return null;
end;
$$;

-- BEFORE INSERT/UPDATE/DELETE on pay_rates: versions in force are history, and the boundary
-- between two versions only moves through add_pay_rate (closes the previous version) and
-- cancelling the latest scheduled version (pay_rates_reopen_previous reopens it), so the
-- versions of a worker never leave a gap.
create function private.pay_rates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
  v_start date;
begin
  if tg_op = 'INSERT' then
    -- Read as the caller: a worker of another organisation is invisible here and the insert
    -- is then refused by RLS, so nothing leaks.
    select w.start_date into v_start from public.workers w where w.id = new.worker_id;
    if new.effective_from < v_start then
      raise exception 'A pay rate can''t start before the employee''s start date.' using errcode = '22023';
    end if;
    if new.effective_from < v_today
      and exists (select 1 from public.pay_rates p where p.worker_id = new.worker_id) then
      raise exception 'A new pay rate can''t start in the past once the worker has one. Start it today or later.'
        using errcode = 'MLPR2';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
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
      if old.effective_to is not null and old.effective_to < v_today then
        raise exception 'This pay rate has ended and can''t be changed.' using errcode = 'MLPR1';
      end if;
      if new.effective_to is not null and new.effective_to < v_today - 1 then
        raise exception 'A pay rate in force can be closed from yesterday at the earliest.'
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

-- AFTER DELETE on pay_rates: cancelling a scheduled version (the guard allows only the latest
-- one) reopens the version before it to where the cancelled one ended, so no gap is left.
-- Runs as the caller: the update is checked by RLS, the column grant and the guard.
create function private.pay_rates_reopen_previous()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.pay_rates p
  set effective_to = old.effective_to
  where p.worker_id = old.worker_id
    and p.effective_to = old.effective_from - 1;
  return null;
end;
$$;

-- AFTER INSERT/UPDATE/DELETE on pay_rates: recompute the worker's needs_pay_details (the
-- workers BEFORE trigger does the work). Definer because signed-in users cannot write that
-- column directly.
create function private.pay_rates_refresh_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workers w
  set needs_pay_details = w.needs_pay_details
  where w.id = coalesce(new.worker_id, old.worker_id);
  return null;
end;
$$;

-- BEFORE INSERT/UPDATE on worker_assignments: the client follows from the site or project,
-- and a site or project of another client is refused.
create function private.worker_assignments_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if new.site_id is not null then
    select s.client_id into v_client
    from public.sites s
    where s.id = new.site_id and s.organisation_id = new.organisation_id;
    if v_client is not null then
      if new.client_id is null then
        new.client_id := v_client;
      elsif new.client_id <> v_client then
        raise exception 'That site belongs to another client.' using errcode = 'MLAS1';
      end if;
    end if;
  end if;

  if new.project_id is not null then
    v_client := null;
    select p.client_id into v_client
    from public.projects p
    where p.id = new.project_id and p.organisation_id = new.organisation_id;
    if v_client is not null then
      if new.client_id is null then
        new.client_id := v_client;
      elsif new.client_id <> v_client then
        raise exception 'That project belongs to another client.' using errcode = 'MLAS1';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Triggers
-- ---------------------------------------------------------------------------

create trigger clients_set_updated_at before update on public.clients
  for each row execute function private.set_updated_at();
create trigger sites_set_updated_at before update on public.sites
  for each row execute function private.set_updated_at();
create trigger projects_set_updated_at before update on public.projects
  for each row execute function private.set_updated_at();
create trigger departments_set_updated_at before update on public.departments
  for each row execute function private.set_updated_at();
create trigger workers_set_updated_at before update on public.workers
  for each row execute function private.set_updated_at();
create trigger pay_rates_set_updated_at before update on public.pay_rates
  for each row execute function private.set_updated_at();
create trigger worker_assignments_set_updated_at before update on public.worker_assignments
  for each row execute function private.set_updated_at();

create trigger workers_before_write before insert or update on public.workers
  for each row execute function private.workers_before_write();
create trigger workers_audit_personal_data after insert or update on public.workers
  for each row execute function private.workers_audit_personal_data();
create trigger pay_rates_guard before insert or update or delete on public.pay_rates
  for each row execute function private.pay_rates_guard();
create trigger pay_rates_refresh_worker after insert or update or delete on public.pay_rates
  for each row execute function private.pay_rates_refresh_worker();
create trigger pay_rates_reopen_previous after delete on public.pay_rates
  for each row execute function private.pay_rates_reopen_previous();
create trigger worker_assignments_before_write before insert or update on public.worker_assignments
  for each row execute function private.worker_assignments_before_write();

create trigger clients_audit after insert or update or delete on public.clients
  for each row execute function private.audit_row_change();
create trigger sites_audit after insert or update or delete on public.sites
  for each row execute function private.audit_row_change();
create trigger projects_audit after insert or update or delete on public.projects
  for each row execute function private.audit_row_change();
create trigger departments_audit after insert or update or delete on public.departments
  for each row execute function private.audit_row_change();
create trigger workers_audit after insert or update or delete on public.workers
  for each row execute function private.audit_row_change();
create trigger pay_rates_audit after insert or update or delete on public.pay_rates
  for each row execute function private.audit_row_change();
create trigger worker_assignments_audit after insert or update or delete on public.worker_assignments
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 8. RLS helpers (security definer, private, search_path = '')
-- ---------------------------------------------------------------------------

-- The worker records linked to the caller's own memberships (a worker's login, slice 1.9).
create function private.my_worker_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.worker_id
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.worker_id is not null
$$;

-- True when the caller is the line manager (role line_manager) named by these references.
create function private.is_line_manager_for(org uuid, lm_worker uuid, lm_membership uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (lm_worker is not null or lm_membership is not null) and exists (
    select 1
    from public.memberships m
    where m.organisation_id = org
      and m.user_id = (select auth.uid())
      and m.role = 'line_manager'
      and (m.id = lm_membership or (m.worker_id is not null and m.worker_id = lm_worker))
  )
$$;

-- True when worker `wid` reports to the caller as line manager.
create function private.is_reportee(wid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workers w
    where w.id = wid
      and private.is_line_manager_for(w.organisation_id, w.line_manager_worker_id, w.line_manager_membership_id)
  )
$$;

-- The department of the caller's own worker record(s).
create function private.my_department_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.department_id
  from public.workers w
  where w.id in (select private.my_worker_ids())
    and w.department_id is not null
$$;

-- Clients, sites and projects the caller's own worker record is or was assigned to.
create function private.my_assignment_target_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
  from public.worker_assignments a
  cross join lateral (values (a.client_id), (a.site_id), (a.project_id)) as t (id)
  where a.worker_id in (select private.my_worker_ids())
    and t.id is not null
$$;

-- ---------------------------------------------------------------------------
-- 9. Row-level security
-- ---------------------------------------------------------------------------
-- Write: owner, admin, hr. Read: those plus finance and ops_manager. Line managers read their
-- reportees (workers and assignments, not pay) and every department, client, site and project
-- name. A worker reads their own worker row, pay rates and assignments, and the department,
-- clients, sites and projects those point at.

alter table public.clients enable row level security;
alter table public.sites enable row level security;
alter table public.projects enable row level security;
alter table public.departments enable row level security;
alter table public.workers enable row level security;
alter table public.pay_rates enable row level security;
alter table public.worker_assignments enable row level security;

-- clients, sites, projects, departments
create policy clients_select on public.clients for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager'])
    or id in (select private.my_assignment_target_ids())
  );
create policy clients_insert on public.clients for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy clients_update on public.clients for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy clients_delete on public.clients for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

create policy sites_select on public.sites for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager'])
    or id in (select private.my_assignment_target_ids())
  );
create policy sites_insert on public.sites for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy sites_update on public.sites for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy sites_delete on public.sites for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

create policy projects_select on public.projects for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager'])
    or id in (select private.my_assignment_target_ids())
  );
create policy projects_insert on public.projects for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy projects_update on public.projects for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy projects_delete on public.projects for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

create policy departments_select on public.departments for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager'])
    or id in (select private.my_department_ids())
  );
create policy departments_insert on public.departments for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy departments_update on public.departments for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy departments_delete on public.departments for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

-- workers: no delete policy (employment ends instead).
create policy workers_select on public.workers for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager'])
    or id in (select private.my_worker_ids())
    or private.is_line_manager_for(organisation_id, line_manager_worker_id, line_manager_membership_id)
  );
create policy workers_insert on public.workers for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy workers_update on public.workers for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

-- pay_rates: line managers do not see pay. Delete cancels a scheduled version only (the guard
-- refuses a version in force or one with a later version after it).
create policy pay_rates_select on public.pay_rates for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager'])
    or worker_id in (select private.my_worker_ids())
  );
create policy pay_rates_insert on public.pay_rates for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy pay_rates_update on public.pay_rates for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy pay_rates_delete on public.pay_rates for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

-- worker_assignments: no delete policy (rows close instead).
create policy worker_assignments_select on public.worker_assignments for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager'])
    or worker_id in (select private.my_worker_ids())
    or private.is_reportee(worker_id)
  );
create policy worker_assignments_insert on public.worker_assignments for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy worker_assignments_update on public.worker_assignments for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

-- ---------------------------------------------------------------------------
-- 10. Table grants (revoke the table-level privilege, then grant columns)
-- ---------------------------------------------------------------------------
-- created_by, created_at, updated_at and needs_pay_details are never writable by signed-in
-- users. organisation_id, client_id and worker_id never change after insert.

revoke all on table public.clients from anon, authenticated;
grant select, delete on table public.clients to authenticated;
grant insert (id, organisation_id, name) on table public.clients to authenticated;
grant update (name) on table public.clients to authenticated;

revoke all on table public.sites from anon, authenticated;
grant select, delete on table public.sites to authenticated;
grant insert (id, organisation_id, client_id, name) on table public.sites to authenticated;
grant update (name) on table public.sites to authenticated;

revoke all on table public.projects from anon, authenticated;
grant select, delete on table public.projects to authenticated;
grant insert (id, organisation_id, client_id, name) on table public.projects to authenticated;
grant update (name) on table public.projects to authenticated;

revoke all on table public.departments from anon, authenticated;
grant select, delete on table public.departments to authenticated;
grant insert (id, organisation_id, name, head_worker_id) on table public.departments to authenticated;
grant update (name, head_worker_id) on table public.departments to authenticated;

revoke all on table public.workers from anon, authenticated;
grant select on table public.workers to authenticated;
grant insert (
  id, organisation_id, staff_id, first_name, last_name, phone, email, job_title, department_id,
  line_manager_worker_id, line_manager_membership_id, employment_type, start_date, end_date,
  status, bank_name, account_name, bank_account_enc, bank_account_last4, nin_enc, tin,
  tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in, annual_rent_declared_kobo,
  currency, next_of_kin_name, next_of_kin_phone, supervisor_clock_in
) on table public.workers to authenticated;
-- No bank columns: bank-detail changes need a second approver (slice 1.7). No staff_id: an ID
-- is fixed once saved, so it can't be freed for a new row with someone else's bank account.
grant update (
  first_name, last_name, phone, email, job_title, department_id,
  line_manager_worker_id, line_manager_membership_id, employment_type, start_date, end_date,
  status, nin_enc, tin, tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in,
  annual_rent_declared_kobo, next_of_kin_name, next_of_kin_phone, supervisor_clock_in
) on table public.workers to authenticated;

revoke all on table public.pay_rates from anon, authenticated;
grant select, delete on table public.pay_rates to authenticated;
grant insert (
  id, organisation_id, worker_id, pay_type, basic_kobo, housing_kobo, transport_kobo,
  other_allowances_kobo, daily_rate_kobo, hourly_rate_kobo, currency, effective_from, effective_to
) on table public.pay_rates to authenticated;
-- No effective_from: a scheduled version is cancelled and added again rather than moved.
grant update (
  pay_type, basic_kobo, housing_kobo, transport_kobo, other_allowances_kobo, daily_rate_kobo,
  hourly_rate_kobo, effective_to
) on table public.pay_rates to authenticated;

revoke all on table public.worker_assignments from anon, authenticated;
grant select on table public.worker_assignments to authenticated;
grant insert (
  id, organisation_id, worker_id, client_id, site_id, project_id, effective_from, effective_to
) on table public.worker_assignments to authenticated;
grant update (effective_to) on table public.worker_assignments to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Multi-row writes (security invoker: RLS and column grants apply to the caller)
-- ---------------------------------------------------------------------------
-- Each takes the organisation the caller is working in and only touches rows of it, so a user
-- who is hr in two companies can't act on the other one's workers from this one (the server
-- records its own audit event against the active organisation).

-- Adds a pay version from p_rate->>'effective_from' and closes the version before it the day
-- before. Amounts arrive as JSON strings of whole kobo and are cast straight to bigint, so a
-- fraction or a float is refused. Keys: pay_type, basic_kobo, housing_kobo, transport_kobo,
-- other_allowances_kobo, daily_rate_kobo, hourly_rate_kobo, effective_from. The start-date
-- rule is checked by private.pay_rates_guard on the insert.
create function public.add_pay_rate(p_organisation_id uuid, p_worker_id uuid, p_rate jsonb)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_from date := (p_rate ->> 'effective_from')::date;
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
  if v_from < private.org_today(p_organisation_id)
    and exists (select 1 from public.pay_rates p where p.worker_id = p_worker_id) then
    raise exception 'A new pay rate can''t start in the past once the worker has one. Start it today or later.'
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

-- Cancels a scheduled pay version (one that has not started) and reopens the version before
-- it, so a raise entered by mistake can be taken back. The guard refuses a version in force
-- or one with a later version after it; private.pay_rates_reopen_previous does the reopening.
create function public.cancel_pay_rate(p_organisation_id uuid, p_pay_rate_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_worker uuid;
  v_deleted uuid;
begin
  select p.worker_id into v_worker
  from public.pay_rates p
  where p.id = p_pay_rate_id
    and p.organisation_id = p_organisation_id;
  if v_worker is null then
    raise exception 'That pay rate wasn''t found.' using errcode = 'P0002';
  end if;

  -- Locks the worker row, as add_pay_rate does.
  perform 1 from public.workers w where w.id = v_worker for update;

  delete from public.pay_rates p
  where p.id = p_pay_rate_id
    and p.organisation_id = p_organisation_id
  returning p.id into v_deleted;
  if v_deleted is null then
    raise exception 'That pay rate wasn''t found.' using errcode = 'P0002';
  end if;
end;
$$;

-- Creates a worker and, optionally, their first pay rate in one transaction. p_worker carries
-- the workers columns by name (id included: personal data is encrypted for that row id before
-- the insert); bytea values are `\x` hex strings and bigint values are strings. Columns not
-- listed below (needs_pay_details, status, end_date, created_by, ...) are ignored.
create function public.create_worker(p_worker jsonb, p_pay_rate jsonb default null)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_org uuid;
begin
  insert into public.workers (
    id, organisation_id, staff_id, first_name, last_name, phone, email, job_title,
    department_id, line_manager_worker_id, line_manager_membership_id, employment_type,
    start_date, bank_name, account_name, bank_account_enc, bank_account_last4, nin_enc, tin,
    tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in, annual_rent_declared_kobo,
    next_of_kin_name, next_of_kin_phone, supervisor_clock_in
  )
  select
    r.id, r.organisation_id, r.staff_id, r.first_name, r.last_name, r.phone, r.email,
    r.job_title, r.department_id, r.line_manager_worker_id, r.line_manager_membership_id,
    r.employment_type, r.start_date, r.bank_name, r.account_name, r.bank_account_enc,
    r.bank_account_last4, r.nin_enc, r.tin, r.tax_state, r.pfa_name, r.rsa_pin_enc,
    r.rsa_pin_last4, coalesce(r.nhf_opt_in, false), r.annual_rent_declared_kobo,
    r.next_of_kin_name, r.next_of_kin_phone, coalesce(r.supervisor_clock_in, false)
  from jsonb_populate_record(null::public.workers, p_worker) as r
  returning id, organisation_id into v_id, v_org;

  if p_pay_rate is not null then
    perform public.add_pay_rate(v_org, v_id, p_pay_rate);
  end if;

  return v_id;
end;
$$;

-- Ends a worker's employment on p_end_date and closes their open assignments on that date.
-- Pay rates are left as they are: payroll stops at the end date.
create function public.end_employment(p_organisation_id uuid, p_worker_id uuid, p_end_date date)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_end_date is null then
    raise exception 'Choose the last working day.' using errcode = '22023';
  end if;

  update public.workers w
  set end_date = p_end_date,
      status = 'ended'
  where w.id = p_worker_id
    and w.organisation_id = p_organisation_id
    and w.status = 'active'
  returning w.id into v_id;
  if v_id is null then
    raise exception 'That employee wasn''t found or has already left.' using errcode = 'P0002';
  end if;

  update public.worker_assignments a
  set effective_to = p_end_date
  where a.worker_id = p_worker_id
    and a.organisation_id = p_organisation_id
    and a.effective_from <= p_end_date
    and (a.effective_to is null or a.effective_to > p_end_date);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.org_today(uuid) from public, anon;
revoke all on function private.my_worker_ids() from public, anon;
revoke all on function private.is_line_manager_for(uuid, uuid, uuid) from public, anon;
revoke all on function private.is_reportee(uuid) from public, anon;
revoke all on function private.my_department_ids() from public, anon;
revoke all on function private.my_assignment_target_ids() from public, anon;
revoke all on function private.workers_before_write() from public, anon, authenticated;
revoke all on function private.workers_audit_personal_data() from public, anon, authenticated;
revoke all on function private.pay_rates_guard() from public, anon, authenticated;
revoke all on function private.pay_rates_refresh_worker() from public, anon, authenticated;
revoke all on function private.pay_rates_reopen_previous() from public, anon, authenticated;
revoke all on function private.worker_assignments_before_write() from public, anon, authenticated;

grant execute on function private.org_today(uuid) to authenticated, service_role;
grant execute on function private.my_worker_ids() to authenticated, service_role;
grant execute on function private.is_line_manager_for(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function private.is_reportee(uuid) to authenticated, service_role;
grant execute on function private.my_department_ids() to authenticated, service_role;
grant execute on function private.my_assignment_target_ids() to authenticated, service_role;

revoke all on function public.add_pay_rate(uuid, uuid, jsonb) from public, anon;
revoke all on function public.cancel_pay_rate(uuid, uuid) from public, anon;
revoke all on function public.create_worker(jsonb, jsonb) from public, anon;
revoke all on function public.end_employment(uuid, uuid, date) from public, anon;
grant execute on function public.add_pay_rate(uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function public.cancel_pay_rate(uuid, uuid) to authenticated, service_role;
grant execute on function public.create_worker(jsonb, jsonb) to authenticated, service_role;
grant execute on function public.end_employment(uuid, uuid, date) to authenticated, service_role;
