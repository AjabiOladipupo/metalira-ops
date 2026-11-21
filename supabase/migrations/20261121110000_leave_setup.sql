-- Slice 4.1: the company calendar and leave setup (docs/PHASE_4.md 4.1).
--
-- 1. The working week: `organisations.default_work_days` (ISO days 1 to 7, Monday to Friday by
--    default) and `workers.usual_work_days` (null: the company's week). Slice 4.4 counts leave
--    days with them beyond the last rostered day.
-- 2. `public_holidays`: each company keeps its own list, one live holiday per date. A removed
--    holiday is kept with removed_at and removed_by, never deleted.
-- 3. `leave_types`: the company's own types (code, name, working or calendar days, paid, needs a
--    certificate, minimum service, the preset it came from and its source label). Retired, never
--    deleted. Every type uses the two-step approval (line manager, then HR; decision 9).
-- 4. `leave_entitlements`: dated versions per type (days a year, carry-over cap, pay percent and
--    the service the pay needs). No overlaps. A version in force is never changed except to close
--    it; a change is a new version from tomorrow or a future 1 January (rule 3).
-- 5. Functions (owner, admin and hr, trusted sessions): add_public_holiday,
--    remove_public_holiday, copy_public_holidays (with a dry run for its preview), set_work_week,
--    save_leave_type, add_leave_entitlement_version (dry run) and apply_leave_preset (dry run).
--
-- Presets (owner decision, 21 Nov 2026): two, A "Labour Act minimum" and B "Common private-sector
-- practice". The figures live in private.leave_preset_rows, mirror src/lib/leave/presets.ts and
-- docs/RULES_NIGERIA.md "Leave presets (Phase 4)", and are starting values the company edits.
-- They are not legal advice.
--
-- Who reads: leave types and entitlements, every member of the company (workers too: names,
-- days, paid or not); public holidays, every manager (a worker sees the dates through the leave
-- screen in 4.4). Nobody writes the tables directly: the functions do, and the row triggers audit
-- every change.
--
-- Refusals (SQLSTATE):
--   MLHD1 a live holiday already on that date
--   MLHD2 a holiday changed or deleted (only removal, once)
--   MLLV1 a change that doesn't start tomorrow or on a future 1 January
--   MLLV2 an entitlement version changed, or one in force deleted
--   MLLV3 a leave type deleted, or its code or company changed
--   MLLV4 a retired type's days changed
--   MLLV5 a type with that name already exists
--   22023 bad input (dates, days, percentages, names, preset)
--   42501 the wrong role, or an untrusted session
--   P0002 the holiday or type isn't in the organisation
-- Nothing here stores money: pay_percent is a whole percentage for Phase 5.

-- ---------------------------------------------------------------------------
-- 1. The working week
-- ---------------------------------------------------------------------------

-- ISO weekdays (1 Monday to 7 Sunday), at least one, each once, in order. Pure.
create function private.valid_work_days(p_days smallint[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_days is not null
    and cardinality(p_days) between 1 and 7
    and not exists (select 1 from unnest(p_days) d where d is null or d not between 1 and 7)
    and p_days = (select array_agg(distinct d order by d) from unnest(p_days) d)
$$;

revoke all on function private.valid_work_days(smallint[]) from public, anon;
grant execute on function private.valid_work_days(smallint[]) to authenticated, service_role;

alter table public.organisations
  add column default_work_days smallint[] not null default '{1,2,3,4,5}'
    constraint organisations_default_work_days_valid check (private.valid_work_days(default_work_days));

comment on column public.organisations.default_work_days is
  'The company''s working week as ISO weekdays (1 Monday to 7 Sunday). Leave counts working days on these when a worker has no roster and no usual days of their own (slice 4.4).';

-- Slice 4.0's my_reportees returns it to line managers (section 10 below).
alter table public.workers
  add column if not exists usual_work_days smallint[];

alter table public.workers
  add constraint workers_usual_work_days_valid
    check (usual_work_days is null or private.valid_work_days(usual_work_days));

comment on column public.workers.usual_work_days is
  'The worker''s usual working days as ISO weekdays, or null for the company''s default_work_days. Stands in beyond the last rostered day when leave is counted (slice 4.4).';

-- The People editors (owner, admin, hr) set it through the workers_update policy.
grant update (usual_work_days) on table public.workers to authenticated;

-- ---------------------------------------------------------------------------
-- 2. public_holidays
-- ---------------------------------------------------------------------------

create table public.public_holidays (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  holiday_date date not null
    constraint public_holidays_date_range check (holiday_date between '2000-01-01' and '2100-12-31'),
  name text not null
    constraint public_holidays_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 80
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  removed_at timestamptz,
  removed_by uuid,
  constraint public_holidays_organisation_id_id_key unique (organisation_id, id),
  constraint public_holidays_removed_pair check ((removed_at is null) = (removed_by is null))
);

-- One live holiday per company per date; removed ones stay beside it.
create unique index public_holidays_live_date_key
  on public.public_holidays (organisation_id, holiday_date)
  where removed_at is null;

comment on table public.public_holidays is
  'The company''s public holidays (slice 4.1), declared year by year. Leave of working-day types skips them. A removed holiday keeps its row with removed_at and removed_by.';

-- BEFORE UPDATE/DELETE: a holiday is never deleted, and the only change is removing it once.
create function private.public_holidays_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A holiday is never deleted. Remove it instead.' using errcode = 'MLHD2';
  end if;
  if old.removed_at is not null then
    raise exception 'This holiday was removed and can''t change.' using errcode = 'MLHD2';
  end if;
  if (new.id, new.organisation_id, new.holiday_date, new.name, new.created_at, new.created_by)
    is distinct from
    (old.id, old.organisation_id, old.holiday_date, old.name, old.created_at, old.created_by)
    or new.removed_at is null then
    raise exception 'A holiday never changes. Remove it and add the right one.' using errcode = 'MLHD2';
  end if;
  new.removed_at := now();
  new.removed_by := coalesce(new.removed_by, private.session_uid(), auth.uid());
  return new;
end;
$$;

revoke all on function private.public_holidays_guard() from public, anon, authenticated;

create trigger public_holidays_guard
  before update or delete on public.public_holidays
  for each row execute function private.public_holidays_guard();
create trigger public_holidays_audit
  after insert or update or delete on public.public_holidays
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 3. leave_types
-- ---------------------------------------------------------------------------

create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  -- Stable key (annual, sick, maternity, ...): presets find their types by it. Never changes.
  code text not null
    constraint leave_types_code_format check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null
    constraint leave_types_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 60
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  -- working_days skips the worker's off-days and the company's holidays; calendar_days counts
  -- every day (maternity, which the Act states in weeks).
  counting text not null default 'working_days'
    constraint leave_types_counting_values check (counting in ('working_days', 'calendar_days')),
  paid boolean not null default true,
  -- The approver ticks "Certificate seen" (no attachments in Phase 4).
  needs_certificate boolean not null default false,
  -- Months of service before the type can be requested (preset A's annual leave: 12).
  min_service_months smallint not null default 0
    constraint leave_types_min_service_range check (min_service_months between 0 and 120),
  -- The preset the type was created or last set from (owner decision, 21 Nov 2026: A or B).
  preset text
    constraint leave_types_preset_values check (preset in ('A', 'B')),
  -- Where the figures came from, shown beside them with "confirm with an adviser".
  source_label text
    constraint leave_types_source_label_text check (
      source_label = btrim(source_label)
      and char_length(source_label) between 1 and 200
      and source_label !~ '[\x01-\x1f\x7f-\x9f<>]'
      and source_label !~* '(://|www\.)'
    ),
  status text not null default 'active'
    constraint leave_types_status_values check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint leave_types_organisation_id_id_key unique (organisation_id, id),
  constraint leave_types_organisation_code_key unique (organisation_id, code)
);

create unique index leave_types_organisation_name_key
  on public.leave_types (organisation_id, lower(name));

comment on table public.leave_types is
  'The company''s leave types (slice 4.1). Every type goes to the line manager, then HR. Retired, never deleted. The days a year are dated versions in leave_entitlements.';

-- BEFORE UPDATE/DELETE: never deleted; the code and company never change.
create function private.leave_types_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A leave type is never deleted. Retire it instead.' using errcode = 'MLLV3';
  end if;
  if (new.id, new.organisation_id, new.code, new.created_at, new.created_by)
    is distinct from (old.id, old.organisation_id, old.code, old.created_at, old.created_by) then
    raise exception 'A leave type''s code never changes.' using errcode = 'MLLV3';
  end if;
  return new;
end;
$$;

revoke all on function private.leave_types_guard() from public, anon, authenticated;

create trigger leave_types_guard
  before update or delete on public.leave_types
  for each row execute function private.leave_types_guard();
create trigger leave_types_set_updated_at before update on public.leave_types
  for each row execute function private.set_updated_at();
create trigger leave_types_audit
  after insert or update or delete on public.leave_types
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. leave_entitlements
-- ---------------------------------------------------------------------------

create table public.leave_entitlements (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  leave_type_id uuid not null,
  effective_from date not null,
  -- Null means until a later version starts.
  effective_to date,
  days_per_year integer not null
    constraint leave_entitlements_days_range check (days_per_year between 0 and 366),
  -- Null: no carry-over (decision 2).
  carry_over_cap_days integer
    constraint leave_entitlements_cap_range check (carry_over_cap_days between 0 and 366),
  -- Whole percent of wages paid during the leave, for Phase 5 (no pay maths in Phase 4).
  pay_percent integer not null default 100
    constraint leave_entitlements_pay_range check (pay_percent between 0 and 100),
  -- Months of continuous service the pay needs (preset A's maternity pay: 6, Labour Act
  -- s.54(1)(c)). The leave itself can still be taken; Phase 5 decides the pay below it.
  pay_min_service_months smallint
    constraint leave_entitlements_pay_service_range check (pay_min_service_months between 0 and 120),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint leave_entitlements_organisation_id_id_key unique (organisation_id, id),
  constraint leave_entitlements_type_fkey foreign key (organisation_id, leave_type_id)
    references public.leave_types (organisation_id, id),
  constraint leave_entitlements_dates check (effective_to >= effective_from),
  -- One version in force per type per day.
  constraint leave_entitlements_no_overlap exclude using gist (
    leave_type_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);

create index leave_entitlements_type_from_idx
  on public.leave_entitlements (leave_type_id, effective_from);

comment on table public.leave_entitlements is
  'Dated versions of a leave type''s days a year, carry-over cap and pay (rule 3). A version in force is never changed except to close effective_to; a change is a new version from tomorrow or a future 1 January.';

-- BEFORE INSERT/UPDATE/DELETE (rule 3):
-- * a type's first version may start on any date; a later one starts tomorrow or later;
-- * only effective_to ever changes, never on a version that has ended, and a version in force
--   closes today at the earliest;
-- * only a version not yet in force may be deleted (a scheduled change being replaced).
create function private.leave_entitlements_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
begin
  if tg_op = 'INSERT' then
    if new.effective_from <= v_today and exists (
      select 1 from public.leave_entitlements e where e.leave_type_id = new.leave_type_id
    ) then
      raise exception 'A change to the days starts tomorrow or later.' using errcode = 'MLLV1';
    end if;
    new.created_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.effective_from <= v_today then
      raise exception 'This version is in force or past and is kept. Add a new version instead.'
        using errcode = 'MLLV2';
    end if;
    return old;
  end if;

  if (
    new.id, new.organisation_id, new.leave_type_id, new.effective_from, new.days_per_year,
    new.carry_over_cap_days, new.pay_percent, new.pay_min_service_months, new.created_at,
    new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.leave_type_id, old.effective_from, old.days_per_year,
    old.carry_over_cap_days, old.pay_percent, old.pay_min_service_months, old.created_at,
    old.created_by
  ) then
    raise exception 'An entitlement version never changes. Add a new version instead.'
      using errcode = 'MLLV2';
  end if;
  if new.effective_to is distinct from old.effective_to then
    if old.effective_to is not null and old.effective_to < v_today then
      raise exception 'This version has ended and can''t change.' using errcode = 'MLLV2';
    end if;
    if old.effective_from <= v_today and new.effective_to is not null
      and new.effective_to < v_today then
      raise exception 'A version in force closes today at the earliest.' using errcode = 'MLLV2';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.leave_entitlements_guard() from public, anon, authenticated;

create trigger leave_entitlements_guard
  before insert or update or delete on public.leave_entitlements
  for each row execute function private.leave_entitlements_guard();
create trigger leave_entitlements_audit
  after insert or update or delete on public.leave_entitlements
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 5. Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.public_holidays enable row level security;
alter table public.leave_types enable row level security;
alter table public.leave_entitlements enable row level security;

create policy public_holidays_select on public.public_holidays for select to authenticated
  using (organisation_id in (select private.role_org_ids(
    array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
  )));

-- Every member, workers included: names, days, paid or not.
create policy leave_types_select on public.leave_types for select to authenticated
  using (organisation_id in (select private.user_org_ids()));

create policy leave_entitlements_select on public.leave_entitlements for select to authenticated
  using (organisation_id in (select private.user_org_ids()));

revoke all on table public.public_holidays from anon, authenticated;
revoke all on table public.leave_types from anon, authenticated;
revoke all on table public.leave_entitlements from anon, authenticated;
grant select on table public.public_holidays to authenticated;
grant select on table public.leave_types to authenticated;
grant select on table public.leave_entitlements to authenticated;

-- The secret key may insert (the isolation registry seeds rows that way) but never delete or
-- truncate a holiday or a type. TRUNCATE skips row triggers, so statement triggers refuse it.
revoke delete, truncate on table public.public_holidays from service_role;
revoke delete, truncate on table public.leave_types from service_role;
revoke truncate on table public.leave_entitlements from service_role;

create function private.leave_setup_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Holidays, leave types and their versions are kept.' using errcode = 'MLLV3';
end;
$$;

revoke all on function private.leave_setup_no_truncate() from public, anon, authenticated;

create trigger public_holidays_no_truncate before truncate on public.public_holidays
  for each statement execute function private.leave_setup_no_truncate();
create trigger leave_types_no_truncate before truncate on public.leave_types
  for each statement execute function private.leave_setup_no_truncate();
create trigger leave_entitlements_no_truncate before truncate on public.leave_entitlements
  for each statement execute function private.leave_setup_no_truncate();

-- ---------------------------------------------------------------------------
-- 6. Shared checks
-- ---------------------------------------------------------------------------

-- Owner, admin or hr of the organisation, in a trusted session.
create function private.require_leave_setup_role(p_organisation_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Only an owner, an admin or HR can change leave settings.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_leave_setup_role(uuid) from public, anon, authenticated;

-- Plain text for names: trimmed, 1 to p_max characters, no control characters, angle brackets
-- or web addresses. Null when it fails. Pure.
create function private.leave_clean_name(p_name text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when btrim(p_name) is null then null
    when char_length(btrim(p_name)) not between 1 and p_max then null
    when btrim(p_name) ~ '[\x01-\x1f\x7f-\x9f<>]' or btrim(p_name) ~* '(://|www\.)' then null
    else btrim(p_name)
  end
$$;

revoke all on function private.leave_clean_name(text, integer) from public, anon, authenticated;

-- The start a change may take: tomorrow, or a 1 January after today (rule 3). Pure.
create function private.leave_change_date_ok(p_from date, p_today date)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_from is not null and p_today is not null and (
    p_from = p_today + 1
    or (p_from > p_today and extract(month from p_from) = 1 and extract(day from p_from) = 1)
  )
$$;

revoke all on function private.leave_change_date_ok(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Holidays and the working week
-- ---------------------------------------------------------------------------

create function private.add_public_holiday(
  p_organisation_id uuid,
  p_date date,
  p_name text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := private.leave_clean_name(p_name, 80);
  v_existing text;
  v_id uuid;
begin
  perform private.require_leave_setup_role(p_organisation_id);
  if p_date is null or p_date not between '2000-01-01' and '2100-12-31' then
    raise exception 'Choose the holiday''s date.' using errcode = '22023';
  end if;
  if v_name is null then
    raise exception 'Give the holiday a name of up to 80 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('holidays:' || p_organisation_id::text, 0));
  select h.name into v_existing
  from public.public_holidays h
  where h.organisation_id = p_organisation_id and h.holiday_date = p_date and h.removed_at is null;
  if v_existing is not null then
    raise exception '% is already a holiday: %.', to_char(p_date, 'FMDD Mon YYYY'), v_existing
      using errcode = 'MLHD1';
  end if;
  insert into public.public_holidays (organisation_id, holiday_date, name)
  values (p_organisation_id, p_date, v_name)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function private.add_public_holiday(uuid, date, text) from public, anon;
grant execute on function private.add_public_holiday(uuid, date, text) to authenticated;

create function public.add_public_holiday(p_organisation_id uuid, p_date date, p_name text)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_public_holiday(p_organisation_id, p_date, p_name)
$$;

revoke all on function public.add_public_holiday(uuid, date, text) from public, anon;
grant execute on function public.add_public_holiday(uuid, date, text) to authenticated;

-- Removes a live holiday: the row stays with removed_at and removed_by.
create function private.remove_public_holiday(p_organisation_id uuid, p_holiday_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_leave_setup_role(p_organisation_id);
  update public.public_holidays h
  set removed_at = now(), removed_by = private.session_uid()
  where h.id = p_holiday_id and h.organisation_id = p_organisation_id and h.removed_at is null;
  if not found then
    raise exception 'That holiday wasn''t found, or it was already removed.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function private.remove_public_holiday(uuid, uuid) from public, anon;
grant execute on function private.remove_public_holiday(uuid, uuid) to authenticated;

create function public.remove_public_holiday(p_organisation_id uuid, p_holiday_id uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.remove_public_holiday(p_organisation_id, p_holiday_id)
$$;

revoke all on function public.remove_public_holiday(uuid, uuid) from public, anon;
grant execute on function public.remove_public_holiday(uuid, uuid) to authenticated;

-- Copies one year's live holidays into another, same day and month, for the owner to edit
-- (holidays are declared year by year, and moveable ones fall on other dates). Skips a date that
-- is already a holiday in the target year, and 29 February in a year without one. Returns
-- {from_year, to_year, dry_run, copied: [{date, name}], skipped: [{date, name, reason}]}. The dry
-- run writes nothing: it is the confirm step's preview.
create function private.copy_public_holidays(
  p_organisation_id uuid,
  p_from_year integer,
  p_to_year integer,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_target date;
  v_copied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_existing text;
begin
  perform private.require_leave_setup_role(p_organisation_id);
  if p_from_year is null or p_to_year is null
    or p_from_year not between 2000 and 2100 or p_to_year not between 2000 and 2100 then
    raise exception 'Choose years between 2000 and 2100.' using errcode = '22023';
  end if;
  if p_from_year = p_to_year then
    raise exception 'Copy from one year into another.' using errcode = '22023';
  end if;
  if not coalesce(p_dry_run, false) then
    perform pg_advisory_xact_lock(hashtextextended('holidays:' || p_organisation_id::text, 0));
  end if;

  for v_row in
    select h.holiday_date, h.name
    from public.public_holidays h
    where h.organisation_id = p_organisation_id and h.removed_at is null
      and h.holiday_date between make_date(p_from_year, 1, 1) and make_date(p_from_year, 12, 31)
    order by h.holiday_date
  loop
    if extract(month from v_row.holiday_date) = 2 and extract(day from v_row.holiday_date) = 29
      and not (p_to_year % 4 = 0 and (p_to_year % 100 <> 0 or p_to_year % 400 = 0)) then
      v_skipped := v_skipped || jsonb_build_object(
        'date', v_row.holiday_date, 'name', v_row.name,
        'reason', '29 Feb isn''t in ' || p_to_year
      );
      continue;
    end if;
    v_target := make_date(
      p_to_year, extract(month from v_row.holiday_date)::integer,
      extract(day from v_row.holiday_date)::integer
    );
    select h.name into v_existing
    from public.public_holidays h
    where h.organisation_id = p_organisation_id and h.holiday_date = v_target
      and h.removed_at is null;
    if v_existing is not null then
      v_skipped := v_skipped || jsonb_build_object(
        'date', v_target, 'name', v_row.name, 'reason', 'Already a holiday: ' || v_existing
      );
      continue;
    end if;
    if not coalesce(p_dry_run, false) then
      insert into public.public_holidays (organisation_id, holiday_date, name)
      values (p_organisation_id, v_target, v_row.name);
    end if;
    v_copied := v_copied || jsonb_build_object('date', v_target, 'name', v_row.name);
  end loop;

  if not coalesce(p_dry_run, false) and jsonb_array_length(v_copied) > 0 then
    perform private.log_audit_impl(
      p_organisation_id, 'calendar.holidays_copied', 'public_holidays', null, null,
      jsonb_build_object(
        'from_year', p_from_year, 'to_year', p_to_year,
        'copied', jsonb_array_length(v_copied), 'skipped', jsonb_array_length(v_skipped)
      ),
      null
    );
  end if;

  return jsonb_build_object(
    'from_year', p_from_year,
    'to_year', p_to_year,
    'dry_run', coalesce(p_dry_run, false),
    'copied', v_copied,
    'skipped', v_skipped
  );
end;
$$;

revoke all on function private.copy_public_holidays(uuid, integer, integer, boolean) from public, anon;
grant execute on function private.copy_public_holidays(uuid, integer, integer, boolean) to authenticated;

create function public.copy_public_holidays(
  p_organisation_id uuid,
  p_from_year integer,
  p_to_year integer,
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.copy_public_holidays(p_organisation_id, p_from_year, p_to_year, p_dry_run)
$$;

revoke all on function public.copy_public_holidays(uuid, integer, integer, boolean) from public, anon;
grant execute on function public.copy_public_holidays(uuid, integer, integer, boolean) to authenticated;

-- Sets the company's working week. Owner, admin and hr (HR keeps the leave calendar, though only
-- owners and admins change other company settings). The organisations_audit trigger logs it.
create function private.set_work_week(p_organisation_id uuid, p_days smallint[])
returns smallint[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_days smallint[];
begin
  perform private.require_leave_setup_role(p_organisation_id);
  select array_agg(distinct d order by d) into v_days from unnest(p_days) d;
  if not private.valid_work_days(v_days) then
    raise exception 'Choose at least one working day.' using errcode = '22023';
  end if;
  update public.organisations o
  set default_work_days = v_days
  where o.id = p_organisation_id;
  return v_days;
end;
$$;

revoke all on function private.set_work_week(uuid, smallint[]) from public, anon;
grant execute on function private.set_work_week(uuid, smallint[]) to authenticated;

create function public.set_work_week(p_organisation_id uuid, p_days smallint[])
returns smallint[]
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_work_week(p_organisation_id, p_days)
$$;

revoke all on function public.set_work_week(uuid, smallint[]) from public, anon;
grant execute on function public.set_work_week(uuid, smallint[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Leave types and entitlement versions
-- ---------------------------------------------------------------------------

-- The values of an entitlement, for comparing and returning. Pure.
create function private.leave_entitlement_doc(
  p_days integer,
  p_cap integer,
  p_pay integer,
  p_pay_service smallint
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'days_per_year', p_days,
    'carry_over_cap_days', p_cap,
    'pay_percent', p_pay,
    'pay_min_service_months', p_pay_service
  )
$$;

revoke all on function private.leave_entitlement_doc(integer, integer, integer, smallint)
  from public, anon, authenticated;

-- Checks entitlement values (22023). No role check.
create function private.leave_check_entitlement(
  p_days integer,
  p_cap integer,
  p_pay integer,
  p_pay_service smallint
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_days is null or p_days not between 0 and 366 then
    raise exception 'Days a year is a whole number from 0 to 366.' using errcode = '22023';
  end if;
  if p_cap is not null and p_cap not between 0 and 366 then
    raise exception 'The carry-over cap is a whole number from 0 to 366 days.' using errcode = '22023';
  end if;
  if p_pay is null or p_pay not between 0 and 100 then
    raise exception 'Pay is a whole percentage from 0 to 100.' using errcode = '22023';
  end if;
  if p_pay_service is not null and p_pay_service not between 0 and 120 then
    raise exception 'The service the pay needs is 0 to 120 months.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.leave_check_entitlement(integer, integer, integer, smallint)
  from public, anon, authenticated;

-- The core of a new entitlement version, shared by add_leave_entitlement_version and
-- apply_leave_preset. No role check: only those definers call it, after theirs.
--
-- A type with no version gets its first one from 1 January of this year (company time), so this
-- year's balances can be granted (slice 4.4). Otherwise the change starts on p_from (tomorrow or
-- a future 1 January): scheduled versions from that date on are replaced (deleted: none is in
-- force yet), the version before it closes the day before, and the new one runs on. Values equal
-- to the version before, with nothing scheduled after, change nothing.
--
-- Returns {leave_type_id, effective_from, first, unchanged, before, after,
-- replaces: [{effective_from, days_per_year}]}.
create function private.leave_entitlement_write(
  p_organisation_id uuid,
  p_leave_type_id uuid,
  p_from date,
  p_days integer,
  p_cap integer,
  p_pay integer,
  p_pay_service smallint,
  p_dry_run boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := private.org_today(p_organisation_id);
  v_from date := p_from;
  v_first boolean;
  v_before public.leave_entitlements%rowtype;
  v_replaces jsonb;
  v_after jsonb := private.leave_entitlement_doc(p_days, p_cap, p_pay, p_pay_service);
  v_before_doc jsonb;
  v_unchanged boolean;
begin
  perform private.leave_check_entitlement(p_days, p_cap, p_pay, p_pay_service);
  if not coalesce(p_dry_run, false) then
    perform 1 from public.leave_types t where t.id = p_leave_type_id for update;
  end if;

  v_first := not exists (
    select 1 from public.leave_entitlements e where e.leave_type_id = p_leave_type_id
  );
  if v_first then
    v_from := make_date(extract(year from v_today)::integer, 1, 1);
  elsif not private.leave_change_date_ok(v_from, v_today) then
    raise exception 'A change to the days starts tomorrow or on a future 1 January.'
      using errcode = 'MLLV1';
  end if;

  select e.* into v_before
  from public.leave_entitlements e
  where e.leave_type_id = p_leave_type_id and e.effective_from < v_from
  order by e.effective_from desc
  limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object('effective_from', e.effective_from, 'days_per_year', e.days_per_year)
    order by e.effective_from
  ), '[]'::jsonb)
  into v_replaces
  from public.leave_entitlements e
  where e.leave_type_id = p_leave_type_id and e.effective_from >= v_from;

  if v_before.id is not null then
    v_before_doc := private.leave_entitlement_doc(
      v_before.days_per_year, v_before.carry_over_cap_days, v_before.pay_percent,
      v_before.pay_min_service_months
    );
  end if;
  v_unchanged := not v_first and v_before_doc = v_after and jsonb_array_length(v_replaces) = 0;

  if not coalesce(p_dry_run, false) and not v_unchanged then
    delete from public.leave_entitlements e
    where e.leave_type_id = p_leave_type_id and e.effective_from >= v_from;
    if v_before.id is not null then
      update public.leave_entitlements e
      set effective_to = v_from - 1
      where e.id = v_before.id;
    end if;
    insert into public.leave_entitlements (
      organisation_id, leave_type_id, effective_from, effective_to, days_per_year,
      carry_over_cap_days, pay_percent, pay_min_service_months
    )
    values (
      p_organisation_id, p_leave_type_id, v_from, null, p_days, p_cap, p_pay, p_pay_service
    );
  end if;

  return jsonb_build_object(
    'leave_type_id', p_leave_type_id,
    'effective_from', v_from,
    'first', v_first,
    'unchanged', v_unchanged,
    'before', v_before_doc,
    'after', v_after,
    'replaces', v_replaces
  );
end;
$$;

revoke all on function private.leave_entitlement_write(
  uuid, uuid, date, integer, integer, integer, smallint, boolean
) from public, anon, authenticated;

-- A new version of a type's days a year, carry-over cap and pay, from tomorrow or a future
-- 1 January (p_from). Owner, admin and hr. The dry run is the preview.
create function private.add_leave_entitlement_version(
  p_organisation_id uuid,
  p_leave_type_id uuid,
  p_from date,
  p_days_per_year integer,
  p_pay_percent integer,
  p_carry_over_cap_days integer default null,
  p_pay_min_service_months smallint default null,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type public.leave_types%rowtype;
  v_result jsonb;
begin
  perform private.require_leave_setup_role(p_organisation_id);
  select t.* into v_type
  from public.leave_types t
  where t.id = p_leave_type_id and t.organisation_id = p_organisation_id;
  if v_type.id is null then
    raise exception 'That leave type wasn''t found.' using errcode = 'P0002';
  end if;
  if v_type.status = 'retired' then
    raise exception 'This leave type is retired. Make it active to change its days.'
      using errcode = 'MLLV4';
  end if;
  if not v_type.paid and p_pay_percent is distinct from 0 then
    raise exception 'An unpaid leave type pays 0%%.' using errcode = '22023';
  end if;

  v_result := private.leave_entitlement_write(
    p_organisation_id, p_leave_type_id, p_from, p_days_per_year, p_carry_over_cap_days,
    p_pay_percent, p_pay_min_service_months, p_dry_run
  ) || jsonb_build_object('name', v_type.name, 'dry_run', coalesce(p_dry_run, false));

  if not coalesce(p_dry_run, false) and not (v_result ->> 'unchanged')::boolean then
    perform private.log_audit_impl(
      p_organisation_id, 'leave.entitlement_version_added', 'leave_types', p_leave_type_id,
      v_result -> 'before',
      (v_result -> 'after') || jsonb_build_object('effective_from', v_result -> 'effective_from'),
      null
    );
  end if;
  return v_result;
end;
$$;

revoke all on function private.add_leave_entitlement_version(
  uuid, uuid, date, integer, integer, integer, smallint, boolean
) from public, anon;
grant execute on function private.add_leave_entitlement_version(
  uuid, uuid, date, integer, integer, integer, smallint, boolean
) to authenticated;

create function public.add_leave_entitlement_version(
  p_organisation_id uuid,
  p_leave_type_id uuid,
  p_from date,
  p_days_per_year integer,
  p_pay_percent integer,
  p_carry_over_cap_days integer default null,
  p_pay_min_service_months smallint default null,
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_leave_entitlement_version(
    p_organisation_id, p_leave_type_id, p_from, p_days_per_year, p_pay_percent,
    p_carry_over_cap_days, p_pay_min_service_months, p_dry_run
  )
$$;

revoke all on function public.add_leave_entitlement_version(
  uuid, uuid, date, integer, integer, integer, smallint, boolean
) from public, anon;
grant execute on function public.add_leave_entitlement_version(
  uuid, uuid, date, integer, integer, integer, smallint, boolean
) to authenticated;

-- A code for a new type from its name (lower case, words joined by _), unique in the company.
create function private.leave_type_code(p_organisation_id uuid, p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base text;
  v_code text;
  v_n integer := 1;
begin
  v_base := left(btrim(regexp_replace(lower(p_name), '[^a-z0-9]+', '_', 'g'), '_'), 30);
  if v_base !~ '^[a-z]' then
    v_base := 'type_' || v_base;
  end if;
  v_base := left(rtrim(v_base, '_'), 30);
  if char_length(v_base) < 2 then
    v_base := 'type';
  end if;
  v_code := v_base;
  while exists (
    select 1 from public.leave_types t
    where t.organisation_id = p_organisation_id and t.code = v_code
  ) loop
    v_n := v_n + 1;
    v_code := v_base || '_' || v_n;
  end loop;
  return v_code;
end;
$$;

revoke all on function private.leave_type_code(uuid, text) from public, anon, authenticated;

-- Creates a type (p_leave_type_id null), with its first entitlement version from 1 January this
-- year, or changes an existing type's details (name, counting, paid, certificate, minimum
-- service, active or retired). The days of an existing type change only through
-- add_leave_entitlement_version; the entitlement arguments are ignored on an edit. Owner, admin
-- and hr. Returns the type's id.
create function private.save_leave_type(
  p_organisation_id uuid,
  p_name text,
  p_counting text,
  p_paid boolean,
  p_needs_certificate boolean,
  p_min_service_months smallint,
  p_status text,
  p_leave_type_id uuid default null,
  p_days_per_year integer default null,
  p_carry_over_cap_days integer default null,
  p_pay_percent integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := private.leave_clean_name(p_name, 60);
  v_id uuid;
  v_pay integer;
begin
  perform private.require_leave_setup_role(p_organisation_id);
  if v_name is null then
    raise exception 'Give the leave type a name of up to 60 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  if p_counting is null or p_counting not in ('working_days', 'calendar_days') then
    raise exception 'Choose working days or calendar days.' using errcode = '22023';
  end if;
  if p_paid is null or p_needs_certificate is null then
    raise exception 'Say whether the leave is paid and needs a certificate.' using errcode = '22023';
  end if;
  if p_min_service_months is null or p_min_service_months not between 0 and 120 then
    raise exception 'Minimum service is 0 to 120 months.' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'retired') then
    raise exception 'Choose active or retired.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.leave_types t
    where t.organisation_id = p_organisation_id and lower(t.name) = lower(v_name)
      and t.id is distinct from p_leave_type_id
  ) then
    raise exception 'A leave type called % already exists.', v_name using errcode = 'MLLV5';
  end if;

  if p_leave_type_id is null then
    if p_status <> 'active' then
      raise exception 'A new leave type starts active.' using errcode = '22023';
    end if;
    v_pay := case when p_paid then coalesce(p_pay_percent, 100) else 0 end;
    perform private.leave_check_entitlement(p_days_per_year, p_carry_over_cap_days, v_pay, null);
    perform pg_advisory_xact_lock(hashtextextended('leave_types:' || p_organisation_id::text, 0));
    insert into public.leave_types (
      organisation_id, code, name, counting, paid, needs_certificate, min_service_months, status
    )
    values (
      p_organisation_id, private.leave_type_code(p_organisation_id, v_name), v_name, p_counting,
      p_paid, p_needs_certificate, p_min_service_months, 'active'
    )
    returning id into v_id;
    perform private.leave_entitlement_write(
      p_organisation_id, v_id, null, p_days_per_year, p_carry_over_cap_days, v_pay, null, false
    );
    return v_id;
  end if;

  update public.leave_types t
  set name = v_name,
      counting = p_counting,
      paid = p_paid,
      needs_certificate = p_needs_certificate,
      min_service_months = p_min_service_months,
      status = p_status
  where t.id = p_leave_type_id and t.organisation_id = p_organisation_id
  returning t.id into v_id;
  if v_id is null then
    raise exception 'That leave type wasn''t found.' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

revoke all on function private.save_leave_type(
  uuid, text, text, boolean, boolean, smallint, text, uuid, integer, integer, integer
) from public, anon;
grant execute on function private.save_leave_type(
  uuid, text, text, boolean, boolean, smallint, text, uuid, integer, integer, integer
) to authenticated;

create function public.save_leave_type(
  p_organisation_id uuid,
  p_name text,
  p_counting text,
  p_paid boolean,
  p_needs_certificate boolean,
  p_min_service_months smallint,
  p_status text,
  p_leave_type_id uuid default null,
  p_days_per_year integer default null,
  p_carry_over_cap_days integer default null,
  p_pay_percent integer default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.save_leave_type(
    p_organisation_id, p_name, p_counting, p_paid, p_needs_certificate, p_min_service_months,
    p_status, p_leave_type_id, p_days_per_year, p_carry_over_cap_days, p_pay_percent
  )
$$;

revoke all on function public.save_leave_type(
  uuid, text, text, boolean, boolean, smallint, text, uuid, integer, integer, integer
) from public, anon;
grant execute on function public.save_leave_type(
  uuid, text, text, boolean, boolean, smallint, text, uuid, integer, integer, integer
) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Presets
-- ---------------------------------------------------------------------------

-- The two presets (owner decision, 21 Nov 2026; preset C dropped). Mirrors
-- src/lib/leave/presets.ts and docs/RULES_NIGERIA.md, which a unit test and the RLS suite
-- compare. Starting values a company edits, not legal advice. Pure.
create function private.leave_preset_rows(p_preset text)
returns table (
  code text,
  name text,
  counting text,
  paid boolean,
  needs_certificate boolean,
  min_service_months smallint,
  days_per_year integer,
  pay_percent integer,
  pay_min_service_months smallint,
  source_label text
)
language sql
immutable
set search_path = ''
as $$
  select v.code, v.name, v.counting, v.paid, v.needs_certificate, v.min_service_months::smallint,
    v.days_per_year, v.pay_percent, v.pay_min_service_months::smallint, v.source_label
  from (
    values
      ('A', 1, 'annual', 'Annual', 'working_days', true, false, 12, 6, 100, null::integer,
        'Labour Act s.18, as summarised by DLA Piper, WageIndicator and Chambers'),
      ('A', 2, 'sick', 'Sick', 'working_days', true, true, 0, 12, 100, null,
        'Labour Act s.16, as summarised by WageIndicator and DLA Piper'),
      ('A', 3, 'maternity', 'Maternity', 'calendar_days', true, true, 0, 84, 50, 6,
        'Labour Act s.54(1), text read on the jurist.ng mirror'),
      ('B', 1, 'annual', 'Annual', 'working_days', true, false, 0, 15, 100, null,
        'Common private-sector practice (Payoneer, CXC)'),
      ('B', 2, 'sick', 'Sick', 'working_days', true, true, 0, 12, 100, null,
        'Labour Act figure, commonly kept (WageIndicator)'),
      ('B', 3, 'maternity', 'Maternity', 'calendar_days', true, true, 0, 84, 100, null,
        'Common private-sector practice (Payoneer, CXC)'),
      ('B', 4, 'paternity', 'Paternity', 'working_days', true, false, 0, 5, 100, null,
        'Common private-sector practice (Payoneer, CXC)'),
      ('B', 5, 'compassionate', 'Compassionate', 'working_days', true, false, 0, 3, 100, null,
        'Common private-sector practice (CXC)')
  ) as v (
    preset, position, code, name, counting, paid, needs_certificate, min_service_months,
    days_per_year, pay_percent, pay_min_service_months, source_label
  )
  where v.preset = p_preset
  order by v.position
$$;

revoke all on function private.leave_preset_rows(text) from public, anon;
grant execute on function private.leave_preset_rows(text) to authenticated, service_role;

-- Applies preset A or B: creates each of its types the company doesn't have yet (first version
-- from 1 January this year) and, for those it has (found by code), sets the preset's details and
-- adds a version from p_from (tomorrow or a future 1 January; default the next 1 January) when
-- the days or pay differ. The company's other types are never deleted or changed. Owner, admin
-- and hr. Returns {preset, effective_from, dry_run, types: [{code, name, action, before, after,
-- details_changed}], kept: [{code, name}]}, action being create, version or unchanged. The dry
-- run writes nothing: it is the confirm step's preview.
create function private.apply_leave_preset(
  p_organisation_id uuid,
  p_preset text,
  p_from date default null,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_from date;
  v_row record;
  v_type public.leave_types%rowtype;
  v_write jsonb;
  v_details_changed boolean;
  v_types jsonb := '[]'::jsonb;
  v_kept jsonb;
  v_action text;
begin
  perform private.require_leave_setup_role(p_organisation_id);
  if p_preset is null or p_preset not in ('A', 'B') then
    raise exception 'Choose preset A or B.' using errcode = '22023';
  end if;
  v_today := private.org_today(p_organisation_id);
  v_from := coalesce(p_from, make_date(extract(year from v_today)::integer + 1, 1, 1));
  if not private.leave_change_date_ok(v_from, v_today) then
    raise exception 'Changes start tomorrow or on a future 1 January.' using errcode = 'MLLV1';
  end if;
  if not coalesce(p_dry_run, false) then
    perform pg_advisory_xact_lock(hashtextextended('leave_types:' || p_organisation_id::text, 0));
  end if;

  for v_row in select * from private.leave_preset_rows(p_preset) loop
    select t.* into v_type
    from public.leave_types t
    where t.organisation_id = p_organisation_id and t.code = v_row.code;

    if v_type.id is null then
      if exists (
        select 1 from public.leave_types t
        where t.organisation_id = p_organisation_id and lower(t.name) = lower(v_row.name)
      ) then
        raise exception 'A leave type called % already exists. Rename it, then apply the preset.',
          v_row.name using errcode = 'MLLV5';
      end if;
      if not coalesce(p_dry_run, false) then
        insert into public.leave_types (
          organisation_id, code, name, counting, paid, needs_certificate, min_service_months,
          preset, source_label, status
        )
        values (
          p_organisation_id, v_row.code, v_row.name, v_row.counting, v_row.paid,
          v_row.needs_certificate, v_row.min_service_months, p_preset, v_row.source_label, 'active'
        )
        returning * into v_type;
        perform private.leave_entitlement_write(
          p_organisation_id, v_type.id, null, v_row.days_per_year, null, v_row.pay_percent,
          v_row.pay_min_service_months, false
        );
      end if;
      v_types := v_types || jsonb_build_object(
        'code', v_row.code, 'name', v_row.name, 'action', 'create', 'before', null,
        'details_changed', true,
        'after', private.leave_entitlement_doc(
          v_row.days_per_year, null, v_row.pay_percent, v_row.pay_min_service_months
        ) || jsonb_build_object(
          'counting', v_row.counting, 'min_service_months', v_row.min_service_months,
          'effective_from', make_date(extract(year from v_today)::integer, 1, 1)
        )
      );
      continue;
    end if;

    v_details_changed := (
      v_type.counting, v_type.paid, v_type.needs_certificate, v_type.min_service_months,
      v_type.preset, v_type.source_label, v_type.status
    ) is distinct from (
      v_row.counting, v_row.paid, v_row.needs_certificate, v_row.min_service_months,
      p_preset, v_row.source_label, 'active'
    );
    if v_details_changed and not coalesce(p_dry_run, false) then
      update public.leave_types t
      set counting = v_row.counting,
          paid = v_row.paid,
          needs_certificate = v_row.needs_certificate,
          min_service_months = v_row.min_service_months,
          preset = p_preset,
          source_label = v_row.source_label,
          status = 'active'
      where t.id = v_type.id;
    end if;

    -- The company's carry-over cap stays as it is: presets set none.
    v_write := private.leave_entitlement_write(
      p_organisation_id, v_type.id, v_from, v_row.days_per_year,
      (
        select e.carry_over_cap_days from public.leave_entitlements e
        where e.leave_type_id = v_type.id and e.effective_from < v_from
        order by e.effective_from desc limit 1
      ),
      v_row.pay_percent, v_row.pay_min_service_months, p_dry_run
    );
    v_action := case
      when not (v_write ->> 'unchanged')::boolean then 'version'
      else 'unchanged'
    end;
    v_types := v_types || jsonb_build_object(
      'code', v_row.code, 'name', v_type.name, 'action', v_action,
      'details_changed', v_details_changed,
      'before', v_write -> 'before',
      'after', (v_write -> 'after') || jsonb_build_object(
        'counting', v_row.counting, 'min_service_months', v_row.min_service_months,
        'effective_from', v_write -> 'effective_from'
      )
    );
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name) order by t.name), '[]'::jsonb)
  into v_kept
  from public.leave_types t
  where t.organisation_id = p_organisation_id and t.status = 'active'
    and t.code not in (select r.code from private.leave_preset_rows(p_preset) r);

  if not coalesce(p_dry_run, false) then
    perform private.log_audit_impl(
      p_organisation_id, 'leave.preset_applied', 'leave_types', null, null,
      jsonb_build_object(
        'preset', p_preset, 'effective_from', v_from,
        'created', (select count(*) from jsonb_array_elements(v_types) e where e ->> 'action' = 'create'),
        'versioned', (select count(*) from jsonb_array_elements(v_types) e where e ->> 'action' = 'version')
      ),
      null
    );
  end if;

  return jsonb_build_object(
    'preset', p_preset,
    'effective_from', v_from,
    'dry_run', coalesce(p_dry_run, false),
    'types', v_types,
    'kept', v_kept
  );
end;
$$;

revoke all on function private.apply_leave_preset(uuid, text, date, boolean) from public, anon;
grant execute on function private.apply_leave_preset(uuid, text, date, boolean) to authenticated;

create function public.apply_leave_preset(
  p_organisation_id uuid,
  p_preset text,
  p_from date default null,
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.apply_leave_preset(p_organisation_id, p_preset, p_from, p_dry_run)
$$;

revoke all on function public.apply_leave_preset(uuid, text, date, boolean) from public, anon;
grant execute on function public.apply_leave_preset(uuid, text, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. my_reportees reads usual_work_days (slice 4.0's line-manager read)
-- ---------------------------------------------------------------------------

-- Slice 4.0 (20261121100000) fixed the shape of my_reportees with usual_work_days as null until
-- this slice added the column. Same functions, now returning w.usual_work_days; everything else
-- is identical to 4.0's definition. `create or replace` also creates them on a branch without
-- 4.0, so this migration applies either way.

create or replace function private.my_reportees(p_organisation_id uuid)
returns table (
  id uuid,
  staff_id text,
  first_name text,
  last_name text,
  phone text,
  email text,
  job_title text,
  department_id uuid,
  department_name text,
  employment_type public.employment_type,
  status public.worker_status,
  start_date date,
  end_date date,
  line_manager_worker_id uuid,
  line_manager_membership_id uuid,
  line_manager_name text,
  usual_work_days smallint[],
  supervisor_clock_in boolean,
  site_ids uuid[],
  site_names text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with keys as (
    -- The caller's line_manager membership in this company (trusted session only; at most
    -- one, as a login holds one role per company).
    select k.organisation_id, k.membership_id, k.worker_id
    from private.my_line_manager_keys() k
    where p_organisation_id is not null
      and k.organisation_id = p_organisation_id
  ),
  reportees as (
    select w.*
    from keys k
    join public.workers w
      on w.organisation_id = k.organisation_id
     and (
       w.line_manager_membership_id = k.membership_id
       or (k.worker_id is not null and w.line_manager_worker_id = k.worker_id)
     )
  )
  select
    r.id,
    r.staff_id,
    r.first_name,
    r.last_name,
    r.phone,
    r.email,
    r.job_title,
    r.department_id,
    d.name,
    r.employment_type,
    r.status,
    r.start_date,
    r.end_date,
    r.line_manager_worker_id,
    r.line_manager_membership_id,
    coalesce(
      nullif(btrim(lmw.first_name || ' ' || lmw.last_name), ''),
      nullif(btrim(p.full_name), '')
    ),
    r.usual_work_days,
    r.supervisor_clock_in,
    coalesce(mapped.site_ids, '{}'::uuid[]),
    coalesce(mapped.site_names, '{}'::text[])
  from reportees r
  left join public.departments d
    on d.organisation_id = r.organisation_id and d.id = r.department_id
  left join public.workers lmw
    on lmw.organisation_id = r.organisation_id and lmw.id = r.line_manager_worker_id
  left join public.memberships lmm
    on lmm.organisation_id = r.organisation_id and lmm.id = r.line_manager_membership_id
  left join public.profiles p on p.user_id = lmm.user_id
  -- The sites the reportee is mapped to now or from the next shift, as the People screens
  -- count them (an assignment ending today is already replaced).
  left join lateral (
    select
      array_agg(s.id order by s.name, s.id) as site_ids,
      array_agg(s.name order by s.name, s.id) as site_names
    from (
      select distinct si.id, si.name
      from public.worker_assignments a
      join public.sites si on si.organisation_id = a.organisation_id and si.id = a.site_id
      where a.organisation_id = r.organisation_id
        and a.worker_id = r.id
        and a.site_id is not null
        and (a.effective_to is null or a.effective_to > private.org_today(r.organisation_id))
    ) s
  ) mapped on true
  order by r.last_name, r.first_name, r.id
$$;

revoke all on function private.my_reportees(uuid) from public, anon;
grant execute on function private.my_reportees(uuid) to authenticated;

create or replace function public.my_reportees(p_organisation_id uuid)
returns table (
  id uuid,
  staff_id text,
  first_name text,
  last_name text,
  phone text,
  email text,
  job_title text,
  department_id uuid,
  department_name text,
  employment_type public.employment_type,
  status public.worker_status,
  start_date date,
  end_date date,
  line_manager_worker_id uuid,
  line_manager_membership_id uuid,
  line_manager_name text,
  usual_work_days smallint[],
  supervisor_clock_in boolean,
  site_ids uuid[],
  site_names text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.my_reportees(p_organisation_id)
$$;

revoke all on function public.my_reportees(uuid) from public, anon;
grant execute on function public.my_reportees(uuid) to authenticated;
