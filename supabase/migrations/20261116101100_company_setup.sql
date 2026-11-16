-- Slice 1.1: company setup wizard and company settings.
--
-- 1. organisations gains the business, invoice and setup columns the Setup board collects, and a
--    company_code that workers type when they sign in (slice 1.9). The code is generated here,
--    on insert, and no signed-in role may change it.
-- 2. The plan and expected headcount change only through public.choose_company_plan, and setup is
--    marked complete only through public.complete_company_setup (owner or admin). Every other new
--    column is updated directly by owners and admins under the existing organisations_update
--    policy; the organisations_audit trigger logs each change.
-- 3. Private Storage bucket `org-assets` for the company logo at {organisation_id}/logo.png or
--    {organisation_id}/logo.svg, under 1 MB. Members of the organisation read it (the app serves
--    it by signed URL); owners and admins write it. Nothing else may be stored in the bucket yet.
--    The app signs logo URLs with the download option, so Storage serves the file as an
--    attachment: an SVG written straight to the bucket (skipping the app's checks) still never
--    renders as a page when its URL is opened directly. In <img>, where the logo is shown,
--    scripts do not run.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
-- Plain-text rule as in 20261116090000_identity_hardening: no control characters, no < or >, no
-- web address. Repeated inline so the check constraints need no function grants.

alter table public.organisations
  add column trading_name text
    constraint organisations_trading_name_length check (char_length(trading_name) between 1 and 200)
    constraint organisations_trading_name_plain_text
      check (trading_name !~ '[\x01-\x1f\x7f-\x9f<>]' and trading_name !~* '(://|www\.)'),
  -- FIRS TIN (12345678-0001) or a 10 to 13 digit tax ID, stored without spaces.
  add column tin text
    constraint organisations_tin_format check (tin ~ '^([0-9]{8}-[0-9]{4}|[0-9]{10,13})$'),
  add column industry text
    constraint organisations_industry_value check (
      industry in ('security_facility', 'cleaning', 'staffing', 'field_sales', 'logistics', 'other')
    ),
  add column head_office_state text
    constraint organisations_head_office_state_value check (
      head_office_state in (
        'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
        'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT Abuja', 'Gombe', 'Imo',
        'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa',
        'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe',
        'Zamfara'
      )
    ),
  add column address text
    constraint organisations_address_length check (char_length(address) between 1 and 300)
    constraint organisations_address_plain_text
      check (address !~ '[\x01-\x1f\x7f-\x9f<>]' and address !~* '(://|www\.)'),
  -- Digits with an optional leading +, no spaces.
  add column phone text
    constraint organisations_phone_format check (phone ~ '^\+?[0-9]{7,15}$'),
  add column invoice_number_start integer not null default 1
    constraint organisations_invoice_number_start_range
      check (invoice_number_start between 1 and 999999999),
  add column payment_terms_days smallint not null default 30
    constraint organisations_payment_terms_days_range check (payment_terms_days between 0 and 365),
  add column vat_registered boolean not null default false,
  add column auto_email_receipts boolean not null default true,
  add column expected_workers integer
    constraint organisations_expected_workers_range check (expected_workers between 1 and 1000000),
  add column company_code text
    constraint organisations_company_code_format check (company_code ~ '^[2-9A-HJKMNP-Z]{6}$'),
  -- Furthest wizard step reached (1 Plan … 6 Ready); drives "Setup N of 5 done".
  add column setup_step smallint not null default 1
    constraint organisations_setup_step_range check (setup_step between 1 and 6),
  add column setup_completed_at timestamptz;

-- Existing columns now edited from the Business and Invoices steps.
alter table public.organisations
  add constraint organisations_legal_name_plain_text
    check (legal_name !~ '[\x01-\x1f\x7f-\x9f<>]' and legal_name !~* '(://|www\.)'),
  -- CAC number: optional RC, BN or IT prefix and 1 to 8 digits, stored as "RC 1234567".
  add constraint organisations_rc_number_format
    check (rc_number ~ '^((RC|BN|IT) )?[0-9]{1,8}$'),
  add constraint organisations_invoice_email_format
    check (
      invoice_email = lower(invoice_email)
      and invoice_email ~ '^[^@[:space:]<>]+@[^@[:space:]<>]+\.[^@[:space:]<>]+$'
    ),
  -- The logo can only be this organisation's own object in org-assets.
  add constraint organisations_logo_path_own_folder
    check (logo_path in (id::text || '/logo.png', id::text || '/logo.svg')),
  add constraint organisations_plan_value
    check (plan in ('trial', 'starter', 'workforce', 'business', 'ops_suite'));

comment on column public.organisations.company_code is
  'Six characters from 23456789ABCDEFGHJKMNPQRSTUVWXYZ, unique, generated on insert. Workers type it at sign-in. Never changed by signed-in users.';
comment on column public.organisations.setup_step is
  'Furthest setup wizard step reached: 1 Plan, 2 Business details, 3 Invoices and payments, 4 Clients and contracts, 5 Employees, 6 Ready.';

-- ---------------------------------------------------------------------------
-- 2. Company code
-- ---------------------------------------------------------------------------
-- No 0/O or 1/I/L: easy to read aloud and type on a phone. 31^6 is about 887 million codes.
-- Security definer so the collision check sees every organisation, not only the caller's.

create function private.generate_company_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  code text;
  bytes bytea;
begin
  loop
    bytes := extensions.gen_random_bytes(6);
    code := '';
    for i in 0..5 loop
      code := code || substr(alphabet, (get_byte(bytes, i) % 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.organisations o where o.company_code = code);
  end loop;
  return code;
end;
$$;

-- BEFORE INSERT on organisations: every new organisation gets a code.
create function private.organisations_set_company_code()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_code is null then
    new.company_code := private.generate_company_code();
  end if;
  return new;
end;
$$;

create trigger organisations_set_company_code
  before insert on public.organisations
  for each row execute function private.organisations_set_company_code();

-- Backfill organisations created before this migration (logged as organisations.update with no
-- actor), then require a code everywhere.
update public.organisations
set company_code = private.generate_company_code()
where company_code is null;

alter table public.organisations
  alter column company_code set not null,
  add constraint organisations_company_code_unique unique (company_code);

revoke all on function private.generate_company_code() from public, anon, authenticated;
revoke all on function private.organisations_set_company_code() from public, anon, authenticated;
-- Only the insert trigger (fired inside the security-definer public.create_organisation) and the
-- backfill above call this, so no signed-in role needs it.
grant execute on function private.generate_company_code() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Plan and setup completion RPCs (definer impl in private, invoker wrapper in public)
-- ---------------------------------------------------------------------------

-- Records the chosen plan and expected headcount. Nothing is charged and no limit applies until
-- pricing is final (Phase 0 decision); Metalira billing is Phase 9.
create function private.choose_company_plan_impl(
  p_organisation_id uuid,
  p_plan text,
  p_expected_workers integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to change the plan' using errcode = '42501';
  end if;
  if p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin']) then
    raise exception 'only owners and admins can change the plan' using errcode = '42501';
  end if;
  if p_plan is null or p_plan not in ('starter', 'workforce', 'business', 'ops_suite') then
    raise exception 'choose a plan' using errcode = '22023';
  end if;
  if p_expected_workers is null or p_expected_workers not between 1 and 1000000 then
    raise exception 'expected workers must be between 1 and 1,000,000' using errcode = '22023';
  end if;

  update public.organisations o
  set plan = p_plan,
      expected_workers = p_expected_workers
  where o.id = p_organisation_id;
end;
$$;

-- Marks setup complete (the first time is kept) and moves the wizard to Ready.
create function private.complete_company_setup_impl(p_organisation_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  completed timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to finish setup' using errcode = '42501';
  end if;
  if p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin']) then
    raise exception 'only owners and admins can finish setup' using errcode = '42501';
  end if;

  update public.organisations o
  set setup_completed_at = coalesce(o.setup_completed_at, now()),
      setup_step = 6
  where o.id = p_organisation_id
  returning o.setup_completed_at into completed;

  return completed;
end;
$$;

create function public.choose_company_plan(
  p_organisation_id uuid,
  p_plan text,
  p_expected_workers integer
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.choose_company_plan_impl(p_organisation_id, p_plan, p_expected_workers)
$$;

create function public.complete_company_setup(p_organisation_id uuid)
returns timestamptz
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.complete_company_setup_impl(p_organisation_id)
$$;

revoke all on function private.choose_company_plan_impl(uuid, text, integer) from public, anon;
revoke all on function private.complete_company_setup_impl(uuid) from public, anon;
revoke all on function public.choose_company_plan(uuid, text, integer) from public, anon;
revoke all on function public.complete_company_setup(uuid) from public, anon;
grant execute on function private.choose_company_plan_impl(uuid, text, integer) to authenticated;
grant execute on function private.complete_company_setup_impl(uuid) to authenticated;
grant execute on function public.choose_company_plan(uuid, text, integer) to authenticated;
grant execute on function public.complete_company_setup(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Column grants
-- ---------------------------------------------------------------------------
-- plan, expected_workers, company_code and setup_completed_at are deliberately not granted.

grant update (
  trading_name,
  tin,
  industry,
  head_office_state,
  address,
  phone,
  invoice_number_start,
  payment_terms_days,
  vat_registered,
  auto_email_receipts,
  setup_step
) on table public.organisations to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Logo storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-assets', 'org-assets', false, 1048576, array['image/png', 'image/svg+xml'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The organisation an org-assets object belongs to, or null when the name is not exactly
-- {organisation_id}/logo.png or {organisation_id}/logo.svg. Never raises on odd names.
create function private.org_asset_org_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/logo\.(png|svg)$'
      then split_part(object_name, '/', 1)::uuid
  end
$$;

revoke all on function private.org_asset_org_id(text) from public, anon;
grant execute on function private.org_asset_org_id(text) to authenticated, service_role;

create policy org_assets_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'org-assets'
    and private.org_asset_org_id(name) in (select private.user_org_ids())
  );

create policy org_assets_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'org-assets'
    and private.has_role(private.org_asset_org_id(name), array['owner', 'admin'])
  );

create policy org_assets_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'org-assets'
    and private.has_role(private.org_asset_org_id(name), array['owner', 'admin'])
  )
  with check (
    bucket_id = 'org-assets'
    and private.has_role(private.org_asset_org_id(name), array['owner', 'admin'])
  );

create policy org_assets_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'org-assets'
    and private.has_role(private.org_asset_org_id(name), array['owner', 'admin'])
  );
