-- Slice 5.0: tax rule sets (docs/PHASE_5.md 5.0, decisions 1 to 3).
--
-- 1. `tax_rule_sets`: each company's dated versions of the statutory figures the gross-to-net
--    engine uses (`rules`: PAYE bands, rent relief, pension, NHF, NSITF, ITF, the daily-worker
--    exemption) and the owner's pay-policy figures the earnings stage uses (`policy`: overtime
--    multiplier, off-day minutes, public-holiday mode). Kobo inside the jsonb are strings of
--    digits; rates are whole basis points. No overlaps (GiST). A version is never updated
--    except to close effective_to (today at the earliest) or to record the tax adviser's
--    confirmation once; a version in force or used by a posted run never changes or goes (rule
--    3). The guard holds for every role, the secret key and the database owner included.
-- 2. `private.tax_rule_set_template()`: the starting version "NTA 2025 v1" from 1 Jan 2026. It
--    mirrors src/lib/payroll/rule-set.ts NTA_2025_V1 and docs/RULES_NIGERIA.md (the RLS suite
--    compares them). Every figure is "confirm with a tax adviser before the first live payroll".
-- 3. Functions (private security definer behind public invoker wrappers, search_path ''):
--    ensure_tax_rule_set (owner, hr or the secret key; copies the template on first use,
--    idempotent), add_tax_rule_set_version (owner, hr; from tomorrow or later; dry run for the
--    preview) and confirm_tax_rule_set (owner; the adviser's confirmation).
-- 4. The hook private.tax_rule_set_in_posted_run(id) returns false until 5.3 posts payroll.
--
-- Who reads: owner, hr and finance (the plan's access table). Admins, ops managers, line
-- managers, client approvers and workers see nothing. Nobody writes the table directly: the
-- functions do, and the row trigger audits every change.
--
-- Refusals (SQLSTATE):
--   MLPR7 a new version that doesn't start tomorrow or later
--   MLPR8 a version in force, ended or used by a posted run changed or deleted
--   MLPR9 a version already confirmed by the adviser
--   22023 bad input (rules, policy, name, reason, note, dates)
--   42501 the wrong role, or an untrusted session
--   P0002 the version isn't in the organisation
-- No money maths here: the figures are stored, the TypeScript engine applies them (decision 5).

-- ---------------------------------------------------------------------------
-- 1. Shape checks for the jsonb documents (pure)
-- ---------------------------------------------------------------------------

-- An object whose keys are exactly p_keys.
create function private.tax_keys_are(p_doc jsonb, p_keys text[])
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' then
    return false;
  end if;
  return (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_doc) k)
    = (select array_agg(k order by k) from unnest(p_keys) k);
end;
$$;

-- A whole number from p_min to p_max.
create function private.tax_int_ok(p_value jsonb, p_min numeric, p_max numeric)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    return false;
  end if;
  v := (p_value #>> '{}')::numeric;
  return v = trunc(v) and v between p_min and p_max;
end;
$$;

-- Kobo as a string of 1 to 16 digits, at most 10^15 (p_positive: above 0).
create function private.tax_kobo_ok(p_value jsonb, p_positive boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return false;
  end if;
  v := p_value #>> '{}';
  if v !~ '^[0-9]{1,16}$' then
    return false;
  end if;
  return v::numeric <= 1000000000000000 and (not p_positive or v::numeric > 0);
end;
$$;

-- A base: 1 to 4 distinct salary components.
create function private.tax_base_ok(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array'
    or jsonb_array_length(p_value) not between 1 and 4 then
    return false;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_value) e
    where jsonb_typeof(e) <> 'string'
      or e #>> '{}' not in ('basic', 'housing', 'transport', 'other_allowances')
  ) then
    return false;
  end if;
  return (select count(distinct e #>> '{}') from jsonb_array_elements(p_value) e)
    = jsonb_array_length(p_value);
end;
$$;

-- The `rules` document (src/lib/payroll/rule-set.ts taxRulesJsonSchema checks the same).
create function private.tax_rules_valid(p_rules jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bands jsonb;
  v_band jsonb;
  v_n integer;
  i integer;
begin
  if not private.tax_keys_are(p_rules, array[
    'paye_bands', 'rent_relief', 'pension', 'nhf', 'nsitf', 'itf', 'daily_workers_exempt'
  ]) then
    return false;
  end if;

  v_bands := p_rules -> 'paye_bands';
  if jsonb_typeof(v_bands) <> 'array' then
    return false;
  end if;
  v_n := jsonb_array_length(v_bands);
  if v_n not between 1 and 12 then
    return false;
  end if;
  for i in 0 .. v_n - 1 loop
    v_band := v_bands -> i;
    if not private.tax_keys_are(v_band, array['width_kobo', 'rate_bps'])
      or not private.tax_int_ok(v_band -> 'rate_bps', 0, 10000) then
      return false;
    end if;
    -- Only the last band is open (null width); every other has a width above 0.
    if i = v_n - 1 then
      if jsonb_typeof(v_band -> 'width_kobo') <> 'null' then
        return false;
      end if;
    elsif not private.tax_kobo_ok(v_band -> 'width_kobo', true) then
      return false;
    end if;
  end loop;

  if not private.tax_keys_are(p_rules -> 'rent_relief', array['rate_bps', 'cap_kobo'])
    or not private.tax_int_ok(p_rules #> '{rent_relief,rate_bps}', 0, 10000)
    or not private.tax_kobo_ok(p_rules #> '{rent_relief,cap_kobo}', false) then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'pension', array['employee_bps', 'employer_bps', 'base'])
    or not private.tax_int_ok(p_rules #> '{pension,employee_bps}', 0, 10000)
    or not private.tax_int_ok(p_rules #> '{pension,employer_bps}', 0, 10000)
    or not private.tax_base_ok(p_rules #> '{pension,base}') then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'nhf', array['rate_bps', 'base'])
    or not private.tax_int_ok(p_rules #> '{nhf,rate_bps}', 0, 10000)
    or not private.tax_base_ok(p_rules #> '{nhf,base}') then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'nsitf', array['rate_bps'])
    or not private.tax_int_ok(p_rules #> '{nsitf,rate_bps}', 0, 10000) then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'itf', array['rate_bps', 'min_staff'])
    or not private.tax_int_ok(p_rules #> '{itf,rate_bps}', 0, 10000)
    or not private.tax_int_ok(p_rules #> '{itf,min_staff}', 1, 100000) then
    return false;
  end if;
  return jsonb_typeof(p_rules -> 'daily_workers_exempt') = 'boolean';
end;
$$;

-- The `policy` document (payPolicyJsonSchema checks the same).
create function private.tax_policy_valid(p_policy jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not private.tax_keys_are(p_policy, array[
    'overtime_multiplier_bps', 'off_day_paid_minutes', 'public_holiday_mode'
  ]) then
    return false;
  end if;
  return private.tax_int_ok(p_policy -> 'overtime_multiplier_bps', 10000, 50000)
    and private.tax_int_ok(p_policy -> 'off_day_paid_minutes', 0, 1440)
    and jsonb_typeof(p_policy -> 'public_holiday_mode') = 'string'
    and p_policy ->> 'public_holiday_mode' in ('worked_minutes_at_overtime_rate');
end;
$$;

-- Plain text: trimmed, 1 to p_max characters, no control characters, angle brackets or web
-- addresses. Null when it fails.
create function private.tax_clean_text(p_text text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when btrim(p_text) is null then null
    when char_length(btrim(p_text)) not between 1 and p_max then null
    when btrim(p_text) ~ '[\x01-\x1f\x7f-\x9f<>]' or btrim(p_text) ~* '(://|www\.)' then null
    else btrim(p_text)
  end
$$;

revoke all on function private.tax_keys_are(jsonb, text[]) from public, anon, authenticated;
revoke all on function private.tax_int_ok(jsonb, numeric, numeric) from public, anon, authenticated;
revoke all on function private.tax_kobo_ok(jsonb, boolean) from public, anon, authenticated;
revoke all on function private.tax_base_ok(jsonb) from public, anon, authenticated;
revoke all on function private.tax_rules_valid(jsonb) from public, anon;
revoke all on function private.tax_policy_valid(jsonb) from public, anon;
revoke all on function private.tax_clean_text(text, integer) from public, anon, authenticated;
-- The table's check constraints call these as whoever inserts.
grant execute on function private.tax_keys_are(jsonb, text[]) to authenticated, service_role;
grant execute on function private.tax_int_ok(jsonb, numeric, numeric) to authenticated, service_role;
grant execute on function private.tax_kobo_ok(jsonb, boolean) to authenticated, service_role;
grant execute on function private.tax_base_ok(jsonb) to authenticated, service_role;
grant execute on function private.tax_rules_valid(jsonb) to authenticated, service_role;
grant execute on function private.tax_policy_valid(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. tax_rule_sets
-- ---------------------------------------------------------------------------

create table public.tax_rule_sets (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  -- "NTA 2025 v1": the run names the dated rule set it used.
  name text not null
    constraint tax_rule_sets_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 60
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  effective_from date not null
    constraint tax_rule_sets_from_range check (effective_from between '2000-01-01' and '2100-12-31'),
  -- Null means until a later version starts.
  effective_to date,
  rules jsonb not null
    constraint tax_rule_sets_rules_shape check (private.tax_rules_valid(rules)),
  policy jsonb not null
    constraint tax_rule_sets_policy_shape check (private.tax_policy_valid(policy)),
  -- The kobo in `rules` (band widths, the rent relief cap) are in this currency.
  currency text not null default 'NGN'
    constraint tax_rule_sets_currency check (currency = 'NGN'),
  -- Where the figures came from, shown beside them.
  source_label text
    constraint tax_rule_sets_source_text check (
      source_label = btrim(source_label)
      and char_length(source_label) between 1 and 200
      and source_label !~ '[\x01-\x1f\x7f-\x9f<>]'
      and source_label !~* '(://|www\.)'
    ),
  -- The tax adviser's confirmation, recorded once by an owner (confirm_tax_rule_set). Until it
  -- is set every figure shows "confirm with a tax adviser before the first live payroll".
  adviser_confirmed_at timestamptz,
  adviser_confirmed_by uuid,
  adviser_note text
    constraint tax_rule_sets_note_text check (
      adviser_note = btrim(adviser_note)
      and char_length(adviser_note) between 1 and 500
      and adviser_note !~ '[\x01-\x1f\x7f-\x9f<>]'
      and adviser_note !~* '(://|www\.)'
    ),
  reason text not null
    constraint tax_rule_sets_reason_text check (
      reason = btrim(reason)
      and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
      and reason !~* '(://|www\.)'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint tax_rule_sets_organisation_id_id_key unique (organisation_id, id),
  constraint tax_rule_sets_dates check (effective_to >= effective_from),
  constraint tax_rule_sets_confirmed_pair
    check ((adviser_confirmed_at is null) = (adviser_confirmed_by is null)),
  constraint tax_rule_sets_note_needs_confirmation
    check (adviser_note is null or adviser_confirmed_at is not null),
  -- One version in force per company per day.
  constraint tax_rule_sets_no_overlap exclude using gist (
    organisation_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);

create index tax_rule_sets_org_from_idx on public.tax_rule_sets (organisation_id, effective_from);

comment on table public.tax_rule_sets is
  'Dated versions of the statutory figures and pay-policy figures payroll uses (slice 5.0, rule 3). Never updated except to close effective_to or record the tax adviser''s confirmation once; a change is a new version from tomorrow or later. Confirm every figure with a tax adviser before the first live payroll.';

-- True when a posted payroll run used this version. Slice 5.3 replaces it with a real check of
-- payroll_runs; until then nothing is posted.
create function private.tax_rule_set_in_posted_run(p_rule_set_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false and p_rule_set_id is not null
$$;

revoke all on function private.tax_rule_set_in_posted_run(uuid) from public, anon, authenticated;

-- BEFORE INSERT/UPDATE/DELETE (rule 3), for every role:
-- * an insert has no adviser confirmation and runs on (effective_to null); a company's first
--   version may start on any date, a later one tomorrow or later;
-- * the figures, name, start, source, reason and author never change;
-- * effective_to changes only on a version that hasn't ended: a version in force only closes
--   earlier, today at the earliest; a version not yet in force may close on any date from its
--   start; never on a version a posted run used;
-- * the adviser's confirmation is recorded once and never changed or removed;
-- * only a version not yet in force, and not used by a posted run, may be deleted (a scheduled
--   change being replaced).
create function private.tax_rule_sets_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
begin
  if tg_op = 'INSERT' then
    if new.adviser_confirmed_at is not null or new.adviser_confirmed_by is not null
      or new.adviser_note is not null then
      raise exception 'A new version starts unconfirmed. Record the adviser''s confirmation after.'
        using errcode = 'MLPR8';
    end if;
    if new.effective_to is not null then
      raise exception 'A new version runs on until a later one starts.' using errcode = 'MLPR8';
    end if;
    if new.effective_from <= v_today and exists (
      select 1 from public.tax_rule_sets t where t.organisation_id = new.organisation_id
    ) then
      raise exception 'A new version of the payroll rules starts tomorrow or later.'
        using errcode = 'MLPR7';
    end if;
    new.created_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.effective_from <= v_today or private.tax_rule_set_in_posted_run(old.id) then
      raise exception 'This version is in force, past or used by posted payroll, and is kept.'
        using errcode = 'MLPR8';
    end if;
    return old;
  end if;

  if (
    new.id, new.organisation_id, new.name, new.effective_from, new.rules, new.policy,
    new.currency, new.source_label, new.reason, new.created_at, new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.name, old.effective_from, old.rules, old.policy,
    old.currency, old.source_label, old.reason, old.created_at, old.created_by
  ) then
    raise exception 'A version of the payroll rules never changes. Add a new version instead.'
      using errcode = 'MLPR8';
  end if;

  if (new.adviser_confirmed_at, new.adviser_confirmed_by, new.adviser_note)
    is distinct from (old.adviser_confirmed_at, old.adviser_confirmed_by, old.adviser_note) then
    if old.adviser_confirmed_at is not null then
      raise exception 'The adviser''s confirmation is recorded once and kept.' using errcode = 'MLPR9';
    end if;
    if new.adviser_confirmed_at is null or new.adviser_confirmed_by is null then
      raise exception 'Record who confirmed and when.' using errcode = '22023';
    end if;
  end if;

  if new.effective_to is distinct from old.effective_to then
    if private.tax_rule_set_in_posted_run(old.id) then
      raise exception 'Posted payroll used this version; it is kept as it is.' using errcode = 'MLPR8';
    end if;
    if old.effective_to is not null and old.effective_to < v_today then
      raise exception 'This version has ended and can''t change.' using errcode = 'MLPR8';
    end if;
    if old.effective_from <= v_today then
      if new.effective_to is null
        or (old.effective_to is not null and new.effective_to > old.effective_to) then
        raise exception 'A version in force can only close earlier. Add a new version instead.'
          using errcode = 'MLPR8';
      end if;
      if new.effective_to < v_today then
        raise exception 'A version in force closes today at the earliest.' using errcode = 'MLPR8';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.tax_rule_sets_guard() from public, anon, authenticated;

create trigger tax_rule_sets_guard
  before insert or update or delete on public.tax_rule_sets
  for each row execute function private.tax_rule_sets_guard();
create trigger tax_rule_sets_audit
  after insert or update or delete on public.tax_rule_sets
  for each row execute function private.audit_row_change();

-- TRUNCATE skips row triggers, so a statement trigger refuses it.
create function private.tax_rule_sets_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Versions of the payroll rules are kept.' using errcode = 'MLPR8';
end;
$$;

revoke all on function private.tax_rule_sets_no_truncate() from public, anon, authenticated;

create trigger tax_rule_sets_no_truncate before truncate on public.tax_rule_sets
  for each statement execute function private.tax_rule_sets_no_truncate();

-- ---------------------------------------------------------------------------
-- 3. Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.tax_rule_sets enable row level security;

create policy tax_rule_sets_select on public.tax_rule_sets for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.tax_rule_sets from anon, authenticated;
grant select on table public.tax_rule_sets to authenticated;
-- The secret key may insert (the isolation registry seeds rows that way) but never truncate.
revoke truncate on table public.tax_rule_sets from service_role;

-- ---------------------------------------------------------------------------
-- 4. The starting version
-- ---------------------------------------------------------------------------

-- NTA 2025 v1: docs/RULES_NIGERIA.md (Nigeria Tax Act 2025 bands from 1 Jan 2026, PRA 2014,
-- NHF, NSITF, ITF) and the owner's pay policy of 15 Nov 2026. Mirrors
-- src/lib/payroll/rule-set.ts NTA_2025_V1 (tests/rls/tax-rule-sets.test.ts compares them).
-- Starting values; confirm with a tax adviser before the first live payroll. Pure.
create function private.tax_rule_set_template()
returns table (
  name text,
  effective_from date,
  rules jsonb,
  policy jsonb,
  source_label text
)
language sql
immutable
set search_path = ''
as $$
  select
    'NTA 2025 v1'::text,
    '2026-01-01'::date,
    jsonb_build_object(
      'paye_bands', jsonb_build_array(
        jsonb_build_object('width_kobo', '80000000', 'rate_bps', 0),
        jsonb_build_object('width_kobo', '220000000', 'rate_bps', 1500),
        jsonb_build_object('width_kobo', '900000000', 'rate_bps', 1800),
        jsonb_build_object('width_kobo', '1300000000', 'rate_bps', 2100),
        jsonb_build_object('width_kobo', '2500000000', 'rate_bps', 2300),
        jsonb_build_object('width_kobo', null, 'rate_bps', 2500)
      ),
      'rent_relief', jsonb_build_object('rate_bps', 2000, 'cap_kobo', '50000000'),
      'pension', jsonb_build_object(
        'employee_bps', 800, 'employer_bps', 1000,
        'base', jsonb_build_array('basic', 'housing', 'transport')
      ),
      'nhf', jsonb_build_object('rate_bps', 250, 'base', jsonb_build_array('basic')),
      'nsitf', jsonb_build_object('rate_bps', 100),
      'itf', jsonb_build_object('rate_bps', 100, 'min_staff', 5),
      'daily_workers_exempt', true
    ),
    jsonb_build_object(
      'overtime_multiplier_bps', 10000,
      'off_day_paid_minutes', 480,
      'public_holiday_mode', 'worked_minutes_at_overtime_rate'
    ),
    'Nigeria Tax Act 2025 bands from 1 Jan 2026, Pension Reform Act 2014, NHF, NSITF and ITF; Metalira''s default pay policy'::text
$$;

revoke all on function private.tax_rule_set_template() from public, anon;
grant execute on function private.tax_rule_set_template() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Shared checks
-- ---------------------------------------------------------------------------

-- Owner or hr of the organisation, in a trusted session.
create function private.require_payroll_rules_writer(p_organisation_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr']) then
    raise exception 'Only an owner or HR can change the payroll rules.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_payroll_rules_writer(uuid) from public, anon, authenticated;

-- The core of ensure_tax_rule_set: the company's first version, copied from the template, when
-- it has none. No role check (its callers check first). Returns the id of the version in force
-- today, or null when the only versions start later (never the case after the copy).
create function private.ensure_tax_rule_set_core(p_organisation_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_today date := private.org_today(p_organisation_id);
begin
  perform pg_advisory_xact_lock(hashtextextended('tax_rule_sets:' || p_organisation_id::text, 0));
  if not exists (select 1 from public.tax_rule_sets t where t.organisation_id = p_organisation_id) then
    insert into public.tax_rule_sets (
      organisation_id, name, effective_from, rules, policy, source_label, reason
    )
    select p_organisation_id, tpl.name, tpl.effective_from, tpl.rules, tpl.policy,
      tpl.source_label, 'Metalira''s starting values; confirm with a tax adviser before the first live payroll'
    from private.tax_rule_set_template() tpl;
  end if;
  select t.id into v_id
  from public.tax_rule_sets t
  where t.organisation_id = p_organisation_id
    and t.effective_from <= v_today
    and (t.effective_to is null or t.effective_to >= v_today);
  return v_id;
end;
$$;

revoke all on function private.ensure_tax_rule_set_core(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Functions
-- ---------------------------------------------------------------------------

-- Gives the company its first rule set (NTA 2025 v1 from 1 Jan 2026) if it has none, and
-- returns the id of the version in force today. Idempotent. Owner or hr in a trusted session,
-- or the secret key (the server's payroll run, 5.2).
create function private.ensure_tax_rule_set(p_organisation_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    perform private.require_payroll_rules_writer(p_organisation_id);
  elsif p_organisation_id is null
    or not exists (select 1 from public.organisations o where o.id = p_organisation_id) then
    raise exception 'That company wasn''t found.' using errcode = 'P0002';
  end if;
  return private.ensure_tax_rule_set_core(p_organisation_id);
end;
$$;

revoke all on function private.ensure_tax_rule_set(uuid) from public, anon;
grant execute on function private.ensure_tax_rule_set(uuid) to authenticated, service_role;

create function public.ensure_tax_rule_set(p_organisation_id uuid)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.ensure_tax_rule_set(p_organisation_id)
$$;

revoke all on function public.ensure_tax_rule_set(uuid) from public, anon;
grant execute on function public.ensure_tax_rule_set(uuid) to authenticated, service_role;

-- A new version of the payroll rules from p_effective_from (tomorrow or later). Owner or hr.
-- The company's first version (the template) is copied in first if it has none. Versions
-- scheduled from that date on are replaced (deleted: none is in force yet), the version before
-- closes the day before, and the new one runs on. Returns {effective_from, name, dry_run,
-- unchanged, before: {id, name, effective_from, rules, policy} | null, after: {rules, policy},
-- replaces: [{id, name, effective_from}]}. Figures equal to the version before, with nothing
-- scheduled after, change nothing. The dry run writes nothing: it is the confirm step's
-- preview.
create function private.add_tax_rule_set_version(
  p_organisation_id uuid,
  p_name text,
  p_rules jsonb,
  p_policy jsonb,
  p_effective_from date,
  p_reason text,
  p_source_label text default null,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_dry boolean := coalesce(p_dry_run, false);
  v_name text := private.tax_clean_text(p_name, 60);
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_source text := private.tax_clean_text(p_source_label, 200);
  v_today date;
  v_before public.tax_rule_sets%rowtype;
  v_before_doc jsonb;
  v_replaces jsonb;
  v_unchanged boolean;
  v_id uuid;
begin
  perform private.require_payroll_rules_writer(p_organisation_id);
  if v_name is null then
    raise exception 'Give the version a name of up to 60 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  if p_source_label is not null and btrim(p_source_label) <> '' and v_source is null then
    raise exception 'The source is up to 200 characters, with no web addresses.'
      using errcode = '22023';
  end if;
  if not private.tax_rules_valid(p_rules) then
    raise exception 'The tax figures aren''t complete or aren''t in range.' using errcode = '22023';
  end if;
  if not private.tax_policy_valid(p_policy) then
    raise exception 'The pay-policy figures aren''t complete or aren''t in range.' using errcode = '22023';
  end if;
  v_today := private.org_today(p_organisation_id);
  if p_effective_from is null or p_effective_from <= v_today
    or p_effective_from > '2100-12-31' then
    raise exception 'A new version of the payroll rules starts tomorrow or later.'
      using errcode = 'MLPR7';
  end if;

  if not v_dry then
    perform private.ensure_tax_rule_set_core(p_organisation_id);
  end if;

  select t.* into v_before
  from public.tax_rule_sets t
  where t.organisation_id = p_organisation_id and t.effective_from < p_effective_from
  order by t.effective_from desc
  limit 1;

  if v_before.id is not null then
    v_before_doc := jsonb_build_object(
      'id', v_before.id, 'name', v_before.name, 'effective_from', v_before.effective_from,
      'rules', v_before.rules, 'policy', v_before.policy
    );
  elsif not exists (select 1 from public.tax_rule_sets t where t.organisation_id = p_organisation_id) then
    -- A dry run before the company has any version: compare with the template it would get.
    select jsonb_build_object(
      'id', null, 'name', tpl.name, 'effective_from', tpl.effective_from,
      'rules', tpl.rules, 'policy', tpl.policy
    ) into v_before_doc
    from private.tax_rule_set_template() tpl;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object('id', t.id, 'name', t.name, 'effective_from', t.effective_from)
    order by t.effective_from
  ), '[]'::jsonb)
  into v_replaces
  from public.tax_rule_sets t
  where t.organisation_id = p_organisation_id and t.effective_from >= p_effective_from;

  v_unchanged := v_before_doc is not null
    and v_before_doc -> 'rules' = p_rules
    and v_before_doc -> 'policy' = p_policy
    and jsonb_array_length(v_replaces) = 0;

  if not v_dry and not v_unchanged then
    delete from public.tax_rule_sets t
    where t.organisation_id = p_organisation_id and t.effective_from >= p_effective_from;
    if v_before.id is not null and (
      v_before.effective_to is null or v_before.effective_to >= p_effective_from
    ) then
      update public.tax_rule_sets t
      set effective_to = p_effective_from - 1
      where t.id = v_before.id;
    end if;
    insert into public.tax_rule_sets (
      organisation_id, name, effective_from, rules, policy, source_label, reason
    )
    values (
      p_organisation_id, v_name, p_effective_from, p_rules, p_policy, v_source, v_reason
    )
    returning id into v_id;
    perform private.log_audit_impl(
      p_organisation_id, 'payroll.rule_set_version_added', 'tax_rule_sets', v_id,
      v_before_doc,
      jsonb_build_object(
        'name', v_name, 'effective_from', p_effective_from, 'rules', p_rules, 'policy', p_policy,
        'replaces', jsonb_array_length(v_replaces)
      ),
      v_reason
    );
  end if;

  return jsonb_build_object(
    'id', v_id,
    'name', v_name,
    'effective_from', p_effective_from,
    'dry_run', v_dry,
    'unchanged', v_unchanged,
    'before', v_before_doc,
    'after', jsonb_build_object('rules', p_rules, 'policy', p_policy),
    'replaces', v_replaces
  );
end;
$$;

revoke all on function private.add_tax_rule_set_version(
  uuid, text, jsonb, jsonb, date, text, text, boolean
) from public, anon;
grant execute on function private.add_tax_rule_set_version(
  uuid, text, jsonb, jsonb, date, text, text, boolean
) to authenticated;

create function public.add_tax_rule_set_version(
  p_organisation_id uuid,
  p_name text,
  p_rules jsonb,
  p_policy jsonb,
  p_effective_from date,
  p_reason text,
  p_source_label text default null,
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_tax_rule_set_version(
    p_organisation_id, p_name, p_rules, p_policy, p_effective_from, p_reason, p_source_label,
    p_dry_run
  )
$$;

revoke all on function public.add_tax_rule_set_version(
  uuid, text, jsonb, jsonb, date, text, text, boolean
) from public, anon;
grant execute on function public.add_tax_rule_set_version(
  uuid, text, jsonb, jsonb, date, text, text, boolean
) to authenticated;

-- Records the tax adviser's confirmation of a version, once, with a note (who advised, when).
-- Owner only, in a trusted session. Until it is recorded every figure of the version shows
-- "confirm with a tax adviser before the first live payroll".
create function private.confirm_tax_rule_set(
  p_organisation_id uuid,
  p_rule_set_id uuid,
  p_note text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_note text := private.tax_clean_text(p_note, 500);
  v_row public.tax_rule_sets%rowtype;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner']) then
    raise exception 'Only an owner can record the tax adviser''s confirmation.' using errcode = '42501';
  end if;
  if v_note is null then
    raise exception 'Say who confirmed the figures and when, in up to 500 characters.'
      using errcode = '22023';
  end if;
  select t.* into v_row
  from public.tax_rule_sets t
  where t.id = p_rule_set_id and t.organisation_id = p_organisation_id
  for update;
  if v_row.id is null then
    raise exception 'That version of the payroll rules wasn''t found.' using errcode = 'P0002';
  end if;
  if v_row.adviser_confirmed_at is not null then
    raise exception 'The adviser''s confirmation of this version is already recorded.'
      using errcode = 'MLPR9';
  end if;
  update public.tax_rule_sets t
  set adviser_confirmed_at = now(),
      adviser_confirmed_by = private.session_uid(),
      adviser_note = v_note
  where t.id = v_row.id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.rule_set_confirmed', 'tax_rule_sets', v_row.id, null,
    jsonb_build_object('name', v_row.name, 'effective_from', v_row.effective_from),
    v_note
  );
end;
$$;

revoke all on function private.confirm_tax_rule_set(uuid, uuid, text) from public, anon;
grant execute on function private.confirm_tax_rule_set(uuid, uuid, text) to authenticated;

create function public.confirm_tax_rule_set(
  p_organisation_id uuid,
  p_rule_set_id uuid,
  p_note text
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.confirm_tax_rule_set(p_organisation_id, p_rule_set_id, p_note)
$$;

revoke all on function public.confirm_tax_rule_set(uuid, uuid, text) from public, anon;
grant execute on function public.confirm_tax_rule_set(uuid, uuid, text) to authenticated;
