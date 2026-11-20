-- Slice 2.5: headcount, the staffing plan a client signs up to on a contract.
--
-- 1. `headcount_requirements`: one row per post the client wants staffed at one of the contract's
--    sites ("Gate A · Day"): the role and band (matched to the rate card by the rate key
--    (role, band, unit), never by id), what each occurrence is billed per (shift, hour or visit),
--    the days of the week, the hours (an end at or before the start ends the next day; equal
--    times are a 24-hour post) and how many people. Slice 2.7 turns each row into a post and a
--    dated roster requirement at activation.
-- 2. Drafts only. Rows are added, changed and removed while the contract is a draft; once it has
--    left draft the rows are frozen for every role (2.8 changes live posts instead). The guard
--    takes a share lock on the contract row, so a write can't slip in beside activation, which
--    locks the contract for update.
-- 3. A row's site is one of the contract's sites (composite foreign key on contract_sites), and a
--    site with headcount can't be taken off the contract until its rows are removed.
-- 4. Read by owner, admin, finance and ops_manager; written by owner, admin and ops_manager under
--    RLS (docs/PHASE_2.md "Roles"). Every change is audited by the row trigger, with its channel.
-- 5. `private.headcount_unpriced_rows(org, contract, date)` lists rows with no matching rate line
--    on that date, for activation's checklist (2.7). Only manned_post and per_visit contracts are
--    priced per row: fixed_monthly and per_job bill an agreed amount, so their headcount is
--    staffing only and never "unpriced".
--
-- Nothing here stores money. The weekly totals are a preview computed in src/lib/headcount.ts.
--
-- Refusals (SQLSTATE), mapped to plain English in src/server/business/headcount.ts:
--   MLHC1 contract not a draft, or a row moving contract     MLHC2 site still has headcount

-- ---------------------------------------------------------------------------
-- 1. headcount_requirements
-- ---------------------------------------------------------------------------

-- A row's site must be one of the contract's sites: the composite key it points at.
alter table public.contract_sites
  add constraint contract_sites_org_contract_site_key unique (organisation_id, contract_id, site_id);

create table public.headcount_requirements (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  contract_id uuid not null,
  site_id uuid not null,
  -- "Gate A". Optional: without one the post is named after the role.
  post_name text
    constraint headcount_requirements_post_name_text check (
      post_name = btrim(post_name)
      and char_length(post_name) between 1 and 80
      and post_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and post_name !~* '(://|www\.)'
    ),
  role text not null
    constraint headcount_requirements_role_text check (
      role = btrim(role)
      and char_length(role) between 1 and 80
      and role !~ '[\x01-\x1f\x7f-\x9f<>]'
      and role !~* '(://|www\.)'
    ),
  -- Day, Night, Supervisor... `standard` when the role has one rate (as on rate_card_lines).
  band text not null default 'standard'
    constraint headcount_requirements_band_text check (
      band = btrim(band)
      and char_length(band) between 1 and 40
      and band !~ '[\x01-\x1f\x7f-\x9f<>]'
      and band !~* '(://|www\.)'
    ),
  -- The rate key's unit: what one occurrence is billed per.
  unit text not null
    constraint headcount_requirements_unit_value check (unit in ('shift', 'hour', 'visit')),
  -- What a post is (2.7 copies it): a visit, or a shift billed per shift or per hour.
  kind text generated always as (case when unit = 'visit' then 'visit' else 'shift' end) stored,
  -- ISO weekdays, 1 = Monday to 7 = Sunday; stored sorted, each once (the guard sorts them).
  days_of_week smallint[] not null
    constraint headcount_requirements_days_value check (
      cardinality(days_of_week) between 1 and 7
      and array_ndims(days_of_week) = 1
      and array_position(days_of_week, null) is null
      and days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    ),
  -- Lagos time, on the quarter hour.
  start_time time not null
    constraint headcount_requirements_start_quarter check (
      date_part('minute', start_time)::integer % 15 = 0 and date_part('second', start_time) = 0
    ),
  -- At or before start_time means the next day; equal to it is a 24-hour post.
  end_time time not null
    constraint headcount_requirements_end_quarter check (
      date_part('minute', end_time)::integer % 15 = 0 and date_part('second', end_time) = 0
    ),
  duration_minutes integer generated always as (
    case
      when end_time > start_time then (date_part('epoch', end_time - start_time) / 60)::integer
      else 1440 - (date_part('epoch', start_time - end_time) / 60)::integer
    end
  ) stored
    constraint headcount_requirements_duration_range check (duration_minutes between 15 and 1440),
  required_count integer not null
    constraint headcount_requirements_count_range check (required_count between 1 and 200),
  notes text
    constraint headcount_requirements_notes_text check (
      notes = btrim(notes)
      and char_length(notes) between 1 and 500
      and notes !~ '[\x01-\x08\x0b-\x1f\x7f-\x9f<>]'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint headcount_requirements_organisation_id_id_key unique (organisation_id, id),
  constraint headcount_requirements_contract_fkey foreign key (organisation_id, contract_id)
    references public.contracts (organisation_id, id),
  constraint headcount_requirements_contract_site_fkey
    foreign key (organisation_id, contract_id, site_id)
    references public.contract_sites (organisation_id, contract_id, site_id)
);

-- One part of a rate key (role or band) as it is compared, the twin of normaliseKeyPart in
-- src/lib/rate-cards.ts: runs of whitespace (ASCII, no-break and other Unicode spaces,
-- zero-width space, BOM) become one space, the ends are trimmed and only A-Z are lower-cased.
-- ASCII-only folding gives the same answer in JavaScript and here whatever the collation, so the
-- Headcount tab and activation never disagree about a match.
create function private.rate_key_part(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select translate(
    btrim(regexp_replace(
      coalesce(p_text, ''),
      '[\t\n\v\f\r    -​    　﻿]+',
      ' ',
      'g'
    )),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz'
  )
$$;

revoke all on function private.rate_key_part(text) from public, anon;
-- The unique index evaluates it as whoever writes the row: signed-in users and the secret key.
grant execute on function private.rate_key_part(text) to authenticated, service_role;

-- One post of a name and band per site: "Gate A · Day" once at Apapa. Without a post name the
-- role names the post. Compared as rate keys are.
create unique index headcount_requirements_post_key on public.headcount_requirements (
  contract_id,
  site_id,
  private.rate_key_part(coalesce(post_name, role)),
  private.rate_key_part(band)
);
create index headcount_requirements_contract_idx
  on public.headcount_requirements (organisation_id, contract_id);

comment on table public.headcount_requirements is
  'The staffing plan a client signs up to on a contract: per site, post, role, band, days, hours and people. Changed only while the contract is a draft; activation (2.7) turns each row into a post and a roster requirement.';
comment on column public.headcount_requirements.end_time is
  'At or before start_time means the shift ends the next day; equal to start_time is a 24-hour post.';

-- BEFORE INSERT/UPDATE/DELETE on headcount_requirements:
-- * a row never moves to another contract or organisation;
-- * the contract (old and new) is a draft, read under a share lock so activation, which locks
--   the contract for update, never misses a row written beside it;
-- * a blank post name is null, a blank band is `standard`, and the days are stored sorted, each
--   once.
-- Definer so the lock and status read don't depend on the caller's column grants; RLS on the
-- table itself still decides who may write the row.
create function private.headcount_requirements_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' and (
    new.organisation_id is distinct from old.organisation_id
    or new.contract_id is distinct from old.contract_id
  ) then
    raise exception 'A headcount row can''t move to another contract.' using errcode = 'MLHC1';
  end if;

  select c.status into v_status
  from public.contracts c
  where c.id = coalesce(new.contract_id, old.contract_id)
    and c.organisation_id = coalesce(new.organisation_id, old.organisation_id)
  for share;

  if v_status is not null and v_status <> 'draft' then
    raise exception 'This contract is no longer a draft, so its headcount can''t change.'
      using errcode = 'MLHC1';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  new.post_name := nullif(btrim(coalesce(new.post_name, '')), '');
  new.band := coalesce(nullif(btrim(coalesce(new.band, '')), ''), 'standard');
  if new.days_of_week is not null and array_position(new.days_of_week, null) is null then
    new.days_of_week := array(select distinct d from unnest(new.days_of_week) d order by d);
  end if;
  return new;
end;
$$;

revoke all on function private.headcount_requirements_guard() from public, anon, authenticated;

create trigger headcount_requirements_guard
  before insert or update or delete on public.headcount_requirements
  for each row execute function private.headcount_requirements_guard();
create trigger headcount_requirements_set_updated_at before update on public.headcount_requirements
  for each row execute function private.set_updated_at();
create trigger headcount_requirements_audit
  after insert or update or delete on public.headcount_requirements
  for each row execute function private.audit_row_change();

-- BEFORE DELETE on contract_sites: a site with headcount stays on the contract until its rows
-- are removed, with a plain reason instead of a foreign key error. Definer so the count sees
-- every row whatever the caller may read.
create function private.contract_sites_headcount_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
  v_site text;
begin
  select count(*) into v_rows
  from public.headcount_requirements h
  where h.contract_id = old.contract_id and h.site_id = old.site_id;
  if v_rows > 0 then
    select s.name into v_site from public.sites s where s.id = old.site_id;
    raise exception 'Remove the headcount at % first (% %).',
      coalesce(v_site, 'that site'), v_rows, case when v_rows = 1 then 'row' else 'rows' end
      using errcode = 'MLHC2';
  end if;
  return old;
end;
$$;

revoke all on function private.contract_sites_headcount_guard() from public, anon, authenticated;

create trigger contract_sites_headcount_guard before delete on public.contract_sites
  for each row execute function private.contract_sites_headcount_guard();

-- ---------------------------------------------------------------------------
-- 2. Row-level security and grants (docs/PHASE_2.md "Roles")
-- ---------------------------------------------------------------------------

alter table public.headcount_requirements enable row level security;

create policy headcount_requirements_select on public.headcount_requirements
  for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));
create policy headcount_requirements_insert on public.headcount_requirements
  for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));
create policy headcount_requirements_update on public.headcount_requirements
  for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));
-- A draft's rows can be taken off again (the guard refuses it once the contract is live).
create policy headcount_requirements_delete on public.headcount_requirements
  for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));

revoke all on table public.headcount_requirements from anon, authenticated;
grant select, delete on table public.headcount_requirements to authenticated;
grant insert (
  id, organisation_id, contract_id, site_id, post_name, role, band, unit, days_of_week,
  start_time, end_time, required_count, notes
) on table public.headcount_requirements to authenticated;
grant update (
  site_id, post_name, role, band, unit, days_of_week, start_time, end_time, required_count, notes
) on table public.headcount_requirements to authenticated;

-- ---------------------------------------------------------------------------
-- 3. For activation (2.7)
-- ---------------------------------------------------------------------------

-- The contract's headcount rows whose rate key (role, band, unit) has no line on the rate card
-- in force on p_on. Empty for fixed_monthly and per_job contracts (not priced per row) and for
-- rows that match. Keys are compared with private.rate_key_part, as src/lib/rate-cards.ts does.
-- Outside the contract's dates no rate card applies, so every row is unpriced (as
-- rateCardInForce with the contract's end date). Called by definer functions only.
create function private.headcount_unpriced_rows(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_on date
)
returns table (headcount_requirement_id uuid, role text, band text, unit text)
language sql
stable
set search_path = ''
as $$
  select h.id, h.role, h.band, h.unit
  from public.headcount_requirements h
  join public.contracts c on c.id = h.contract_id and c.organisation_id = h.organisation_id
  where h.organisation_id = p_organisation_id
    and h.contract_id = p_contract_id
    and c.type in ('manned_post', 'per_visit')
    and not exists (
      select 1
      from public.rate_cards r
      join public.rate_card_lines l on l.rate_card_id = r.id
      where r.contract_id = h.contract_id
        and p_on >= c.start_date
        and (c.end_date is null or p_on <= c.end_date)
        and r.effective_from <= p_on
        and (r.effective_to is null or r.effective_to >= p_on)
        and private.rate_key_part(l.role) = private.rate_key_part(h.role)
        and private.rate_key_part(l.band) = private.rate_key_part(h.band)
        and l.unit = h.unit
    )
  order by h.created_at, h.id
$$;

revoke all on function private.headcount_unpriced_rows(uuid, uuid, date) from public, anon, authenticated;
