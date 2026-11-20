-- Slice 2.4: contracts, dated rate cards and withholding tax per contract.
--
-- 1. `contracts`: what a company has agreed to do for a client, on what terms. Draft, then active
--    (slice 2.7 activates), then ended. Everything but the status, activation and end fields
--    freezes once the contract leaves draft. Never deleted.
-- 2. `contract_sites`: the client's sites a contract covers. Changed only while the contract is a
--    draft (2.8 adds sites to a live contract).
-- 3. `rate_cards` and `rate_card_lines`: dated versions of what the client pays, without VAT
--    (owner decision 3). No overlaps; versions sit inside the contract's dates. Once the contract
--    has left draft, a version in force or in the past is never changed except to close
--    effective_to, and lines are never edited: a change is a new version (rule 3). Lines are found
--    by their rate key (role, band, unit), never by id, so a new version never touches posts.
-- 4. Withholding tax is set per rate line (owner's accountant, 19 Nov 2026): each line has a
--    service type (services, management_fee, rent_hire, goods, other) and its WHT rate, which
--    defaults from the type (2%, 5%, 10%, 2%, 2%) and is versioned with the card. Phase 6 works out
--    the expected WHT per invoice line on the amount before VAT. Whether a client deducts WHT, and
--    whether it pays the VAT to the tax authority itself, are client settings (`clients.deducts_wht`,
--    `clients.withholds_vat`) written by owner, admin and finance through set_client_tax_settings.
-- 5. Writes. Contracts and their sites are written by owner, admin and ops_manager under RLS
--    (create_contract and update_draft_contract run as the caller). Rate cards have
--    no insert, update or delete grants: only the functions below write them. Each is a private
--    security definer function that checks the caller's role itself (through private.has_role,
--    so an untrusted session is refused) behind a public invoker wrapper, as for the other
--    definer functions. The actor on every audit row is still the caller (auth.uid()).
--
-- Money is bigint kobo with currency 'NGN' (rule 1). Amounts arrive as JSON strings of whole
-- kobo and are cast straight to bigint, so a fraction or a float is refused.
--
-- Refusals (SQLSTATE), mapped to plain English in src/server/business/contracts.ts:
--   MLCO1 contract field frozen or can't change     MLCO2 site of another client
--   MLCO3 sites change only on a draft              MLCO4 a version outside the contract dates
--   MLRC1 version in force, past or not the latest  MLRC2 starts in the past
--   MLRC3 a version from this date or later exists  MLRC4 version outside the contract dates
--   MLRC5 rate key missing for an open post         MLRC6 contract ended, or draft-only call
--   MLRC7 no rate card yet / last one can't go      MLRC8 lines invalid
--   MLCL1 client tax settings refused
-- (MLCT1-MLCT9 are kept for slice 2.7's activation checklist.)

-- ---------------------------------------------------------------------------
-- 1. contracts
-- ---------------------------------------------------------------------------

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  client_id uuid not null,
  -- Unique per organisation ignoring case. Left blank, the database gives the next CTR-0001.
  -- Never changes, and contracts are never deleted, so a reference is never reused.
  reference text not null
    constraint contracts_reference_format check (
      reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'
    ),
  name text not null
    constraint contracts_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 200
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  type text not null
    constraint contracts_type_value check (
      type in ('manned_post', 'per_visit', 'fixed_monthly', 'per_job')
    ),
  start_date date not null,
  -- Null means rolling.
  end_date date,
  -- Set at activation (2.7): the later of the start date and the activation day.
  go_live_date date,
  billing_frequency text not null default 'monthly'
    constraint contracts_billing_frequency_value check (
      billing_frequency in ('monthly', 'fortnightly', 'weekly', 'on_completion')
    ),
  -- Null means the client's terms, then the organisation's.
  billing_terms_days integer
    constraint contracts_billing_terms_days_range check (billing_terms_days between 0 and 180),
  -- Left out on insert, it follows organisations.vat_registered (contracts_before_write).
  vat_applies boolean not null,
  -- { coverage_target_bps: 0-10000, response_minutes: 1-10080, notes: text up to 1000 }
  sla jsonb not null default '{}'::jsonb
    constraint contracts_sla_shape check (
      jsonb_typeof(sla) = 'object'
      and (sla - array['coverage_target_bps', 'response_minutes', 'notes']) = '{}'::jsonb
      and (
        not sla ? 'coverage_target_bps'
        or (
          jsonb_typeof(sla -> 'coverage_target_bps') = 'number'
          and (sla ->> 'coverage_target_bps') ~ '^[0-9]{1,5}$'
          and (sla ->> 'coverage_target_bps')::integer between 0 and 10000
        )
      )
      and (
        not sla ? 'response_minutes'
        or (
          jsonb_typeof(sla -> 'response_minutes') = 'number'
          and (sla ->> 'response_minutes') ~ '^[0-9]{1,5}$'
          and (sla ->> 'response_minutes')::integer between 1 and 10080
        )
      )
      and (
        not sla ? 'notes'
        or (
          jsonb_typeof(sla -> 'notes') = 'string'
          and char_length(sla ->> 'notes') between 1 and 1000
          and (sla ->> 'notes') !~ '[\x01-\x08\x0b-\x1f\x7f-\x9f<>]'
        )
      )
    ),
  status text not null default 'draft'
    constraint contracts_status_value check (status in ('draft', 'active', 'ended')),
  activated_at timestamptz,
  activated_by uuid,
  ended_at timestamptz,
  end_reason text
    constraint contracts_end_reason_text check (
      end_reason = btrim(end_reason)
      and char_length(end_reason) between 1 and 500
      and end_reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint contracts_organisation_id_id_key unique (organisation_id, id),
  constraint contracts_client_fkey foreign key (organisation_id, client_id)
    references public.clients (organisation_id, id),
  constraint contracts_dates check (end_date >= start_date)
);

create unique index contracts_reference_key on public.contracts (organisation_id, lower(reference));
create index contracts_client_idx on public.contracts (organisation_id, client_id);

comment on table public.contracts is
  'What a company has agreed to do for a client. Draft, then active (2.7), then ended. Frozen once active except the status, activation and end fields. Never deleted.';
comment on column public.contracts.vat_applies is
  'Whether invoices on this contract carry VAT (7.5%, applied in Phase 6). Defaults to organisations.vat_registered.';

-- BEFORE INSERT/UPDATE on contracts:
-- * a blank reference becomes the next CTR-0001 of the organisation (one writer at a time);
-- * vat_applies left out follows the organisation's VAT registration;
-- * a new contract is a draft; the client, organisation and reference never change;
-- * once the contract has left draft only the status, activation and end-reason fields change
--   (end_date waits for end_contract in 2.7), and the status only moves forward (draft -> active -> ended, or draft -> ended).
-- Runs as the caller, so the reference look-up sees what RLS lets the writer see (every contract
-- of the organisation, for the roles that may insert).
create function private.contracts_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_next integer;
begin
  if tg_op = 'INSERT' then
    new.reference := nullif(btrim(coalesce(new.reference, '')), '');
    if new.reference is null then
      perform pg_advisory_xact_lock(
        hashtextextended('contracts_reference:' || new.organisation_id::text, 0)
      );
      select coalesce(max(substring(c.reference from '^[Cc][Tt][Rr]-([0-9]{1,9})$')::integer), 0) + 1
      into v_next
      from public.contracts c
      where c.organisation_id = new.organisation_id
        and c.reference ~* '^CTR-[0-9]{1,9}$';
      new.reference := 'CTR-' || lpad(v_next::text, 4, '0');
    end if;
    if new.vat_applies is null then
      select o.vat_registered into new.vat_applies
      from public.organisations o
      where o.id = new.organisation_id;
    end if;
    if new.status <> 'draft' or new.activated_at is not null or new.ended_at is not null then
      raise exception 'A new contract starts as a draft.' using errcode = 'MLCO1';
    end if;
    return new;
  end if;

  if new.organisation_id <> old.organisation_id or new.client_id <> old.client_id then
    raise exception 'A contract can''t move to another client.' using errcode = 'MLCO1';
  end if;
  if new.reference <> old.reference then
    raise exception 'A contract reference never changes.' using errcode = 'MLCO1';
  end if;

  if new.status <> old.status and not (
    (old.status = 'draft' and new.status in ('active', 'ended'))
    or (old.status = 'active' and new.status = 'ended')
  ) then
    raise exception 'A contract can''t go back to %.', new.status using errcode = 'MLCO1';
  end if;

  -- end_date is frozen too: ending or shortening a live contract is end_contract's job (2.7),
  -- which closes the dated versions with it. Slice 2.7 replaces this function to let it through.
  if old.status <> 'draft' and (
    new.name, new.type, new.start_date, new.end_date, new.billing_frequency,
    new.billing_terms_days, new.vat_applies, new.sla, new.created_at, new.created_by
  ) is distinct from (
    old.name, old.type, old.start_date, old.end_date, old.billing_frequency,
    old.billing_terms_days, old.vat_applies, old.sla, old.created_at, old.created_by
  ) then
    raise exception 'This contract is live and its terms can''t change.' using errcode = 'MLCO1';
  end if;

  return new;
end;
$$;

revoke all on function private.contracts_before_write() from public, anon, authenticated;

create trigger contracts_before_write before insert or update on public.contracts
  for each row execute function private.contracts_before_write();
create trigger contracts_set_updated_at before update on public.contracts
  for each row execute function private.set_updated_at();
create trigger contracts_audit after insert or update or delete on public.contracts
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 2. contract_sites
-- ---------------------------------------------------------------------------

create table public.contract_sites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  contract_id uuid not null,
  site_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint contract_sites_organisation_id_id_key unique (organisation_id, id),
  constraint contract_sites_contract_fkey foreign key (organisation_id, contract_id)
    references public.contracts (organisation_id, id),
  constraint contract_sites_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id),
  constraint contract_sites_pair_key unique (contract_id, site_id)
);

create index contract_sites_site_idx on public.contract_sites (organisation_id, site_id);

comment on table public.contract_sites is
  'The client''s sites a contract covers. Changed only while the contract is a draft.';

-- BEFORE INSERT/UPDATE/DELETE on contract_sites: the site belongs to the contract's client, and
-- the set changes only while the contract is a draft. Runs as the caller.
create function private.contract_sites_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_client uuid;
  v_site_client uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Remove the site and add the right one instead.' using errcode = 'MLCO3';
  end if;

  select c.status, c.client_id into v_status, v_client
  from public.contracts c
  where c.id = coalesce(new.contract_id, old.contract_id);

  if v_status is distinct from 'draft' and v_status is not null then
    raise exception 'Sites are added to a live contract from the contract page (later).'
      using errcode = 'MLCO3';
  end if;

  if tg_op = 'INSERT' then
    select s.client_id into v_site_client
    from public.sites s
    where s.id = new.site_id and s.organisation_id = new.organisation_id;
    if v_site_client is not null and v_client is not null and v_site_client <> v_client then
      raise exception 'That site belongs to another client.' using errcode = 'MLCO2';
    end if;
    return new;
  end if;
  return old;
end;
$$;

revoke all on function private.contract_sites_guard() from public, anon, authenticated;

create trigger contract_sites_guard before insert or update or delete on public.contract_sites
  for each row execute function private.contract_sites_guard();
create trigger contract_sites_audit after insert or update or delete on public.contract_sites
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 3. rate_cards and rate_card_lines
-- ---------------------------------------------------------------------------

create table public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  contract_id uuid not null,
  effective_from date not null,
  -- Null means until the contract ends.
  effective_to date,
  note text
    constraint rate_cards_note_text check (
      note = btrim(note)
      and char_length(note) between 1 and 300
      and note !~ '[\x01-\x1f\x7f-\x9f<>]'
      and note !~* '(://|www\.)'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint rate_cards_organisation_id_id_key unique (organisation_id, id),
  constraint rate_cards_contract_fkey foreign key (organisation_id, contract_id)
    references public.contracts (organisation_id, id),
  constraint rate_cards_dates check (effective_to >= effective_from),
  -- One version in force per contract per day.
  constraint rate_cards_no_overlap exclude using gist (
    contract_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);

create index rate_cards_contract_from_idx on public.rate_cards (contract_id, effective_from);

comment on table public.rate_cards is
  'Dated rate card versions of a contract, without VAT. Once the contract is live, a version in force or in the past is never changed except to close effective_to; a change is a new version (add_rate_card_version).';

create table public.rate_card_lines (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  rate_card_id uuid not null,
  role text not null
    constraint rate_card_lines_role_text check (
      role = btrim(role)
      and char_length(role) between 1 and 80
      and role !~ '[\x01-\x1f\x7f-\x9f<>]'
      and role !~* '(://|www\.)'
    ),
  -- Day, Night, Supervisor... `standard` when the role has one rate.
  band text not null default 'standard'
    constraint rate_card_lines_band_text check (
      band = btrim(band)
      and char_length(band) between 1 and 40
      and band !~ '[\x01-\x1f\x7f-\x9f<>]'
      and band !~* '(://|www\.)'
    ),
  unit text not null
    constraint rate_card_lines_unit_value check (unit in ('shift', 'hour', 'visit', 'month', 'job')),
  -- Above zero, up to ₦1,000,000,000 (100,000,000,000 kobo). Without VAT.
  rate_kobo bigint not null
    constraint rate_card_lines_rate_range check (rate_kobo between 1 and 100000000000),
  currency text not null default 'NGN'
    constraint rate_card_lines_currency_ngn check (currency = 'NGN'),
  -- The line's own overtime rate per hour (owner decision), or null.
  ot_rate_kobo bigint
    constraint rate_card_lines_ot_rate_range check (ot_rate_kobo between 1 and 100000000000),
  -- An entry helper, 10000 = 1.0×. What bills is ot_rate_kobo per overtime hour. On an hourly line
  -- rate_card_insert_lines works it out from the multiplier, (rate × bps + 5000) / 10000 (half up
  -- once, as roundHalfUp), and a typed rate must equal that. On any other unit the multiplier is
  -- display-only and needs ot_rate_kobo with it.
  ot_multiplier_bps integer
    constraint rate_card_lines_ot_multiplier_range check (ot_multiplier_bps between 10000 and 30000),
  -- What the line pays for, which sets its withholding tax (owner's accountant, 19 Nov 2026):
  -- services 2%, management_fee 5%, rent_hire 10%, goods 2%, other 2%. Facility management is
  -- split into service lines and a separate management fee line.
  service_type text not null default 'services'
    constraint rate_card_lines_service_type_value check (
      service_type in ('services', 'management_fee', 'rent_hire', 'goods', 'other')
    ),
  -- The WHT a client deducts on this line, 0 to 20% (twice the rate when the payee has no TIN).
  -- Left out, it follows the service type (rate_card_lines_guard). Phase 6 applies it to the
  -- line's amount before VAT.
  wht_rate_bps integer not null
    constraint rate_card_lines_wht_rate_range check (wht_rate_bps between 0 and 2000),
  sort_order integer not null default 0
    constraint rate_card_lines_sort_order_range check (sort_order between 0 and 1000),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint rate_card_lines_organisation_id_id_key unique (organisation_id, id),
  -- A multiplier never stands alone: the hourly rate it gives (or was typed with) is stored.
  constraint rate_card_lines_ot_needs_rate check (
    ot_multiplier_bps is null or ot_rate_kobo is not null
  ),
  constraint rate_card_lines_rate_card_fkey foreign key (organisation_id, rate_card_id)
    references public.rate_cards (organisation_id, id)
);

-- The rate key: one line per role, band and unit in a version.
create unique index rate_card_lines_key on public.rate_card_lines (
  rate_card_id, lower(role), lower(band), unit
);

comment on table public.rate_card_lines is
  'What the client pays per unit of one role and band, without VAT. Insert-only. Matched by the rate key (role, band, unit), never by id.';

-- BEFORE INSERT/UPDATE/DELETE on rate_cards. While the contract is a draft nothing has used the
-- card, so save_draft_rate_card may replace it. Once the contract has left draft:
-- * a version starts today or later (backdating waits for Phase 6, decision 4);
-- * a version in force or in the past never changes, except closing effective_to (from
--   yesterday at the earliest), and is never removed;
-- * a scheduled version never moves (cancel it and add it again), and only the latest one is
--   removed (cancel_rate_card_version), so versions never leave a gap.
-- Every version sits inside the contract's dates.
create function private.rate_cards_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_contract uuid := coalesce(new.contract_id, old.contract_id);
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
  v_status text;
  v_start date;
  v_end date;
begin
  select c.status, c.start_date, c.end_date into v_status, v_start, v_end
  from public.contracts c
  where c.id = v_contract;

  if tg_op = 'UPDATE' and (
    new.contract_id is distinct from old.contract_id
    or new.organisation_id is distinct from old.organisation_id
  ) then
    raise exception 'A rate card can''t move to another contract.' using errcode = 'MLRC1';
  end if;

  if tg_op in ('INSERT', 'UPDATE') and v_start is not null and (
    new.effective_from < v_start
    or (v_end is not null and coalesce(new.effective_to, new.effective_from) > v_end)
    or (v_end is not null and new.effective_from > v_end)
  ) then
    raise exception 'A rate card must sit inside the contract''s dates.' using errcode = 'MLRC4';
  end if;

  if v_status = 'draft' then
    return coalesce(new, old);
  end if;
  if v_status = 'ended' then
    raise exception 'This contract has ended and its rate card can''t change.' using errcode = 'MLRC6';
  end if;

  if tg_op = 'INSERT' then
    if new.effective_from < v_today then
      raise exception 'A rate change starts today or later.' using errcode = 'MLRC2';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.effective_from <= v_today then
      raise exception 'This rate card is already in force and can''t be removed.' using errcode = 'MLRC1';
    end if;
    if exists (
      select 1 from public.rate_cards r
      where r.contract_id = old.contract_id and r.effective_from > old.effective_from
    ) then
      raise exception 'A later rate change is scheduled after this one. Cancel that one first.'
        using errcode = 'MLRC1';
    end if;
    return old;
  end if;

  -- The end of a version followed by another is pinned to the day before the next one starts.
  if new.effective_to is distinct from old.effective_to and exists (
    select 1 from public.rate_cards r
    where r.contract_id = old.contract_id and r.effective_from > old.effective_from
  ) then
    raise exception 'A later rate card follows this one, so its end date can''t change. Cancel the later one first.'
      using errcode = 'MLRC1';
  end if;

  if new.effective_from is distinct from old.effective_from then
    raise exception 'A rate card''s start date can''t move. Cancel it and add it again from the new date.'
      using errcode = 'MLRC1';
  end if;

  if old.effective_from <= v_today then
    if new.note is distinct from old.note or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by then
      raise exception 'This rate card is already in force and can''t be changed. Add a new version instead.'
        using errcode = 'MLRC1';
    end if;
    if new.effective_to is distinct from old.effective_to then
      if old.effective_to is not null and old.effective_to < v_today then
        raise exception 'This rate card has ended and can''t be changed.' using errcode = 'MLRC1';
      end if;
      if new.effective_to is not null and new.effective_to < v_today - 1 then
        raise exception 'A rate card in force can be closed from yesterday at the earliest.'
          using errcode = 'MLRC1';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.rate_cards_guard() from public, anon, authenticated;

-- AFTER DELETE on rate_cards: cancelling the latest version reopens the version before it to
-- where the cancelled one ended, so no gap is left.
create function private.rate_cards_reopen_previous()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.rate_cards r
  set effective_to = old.effective_to
  where r.contract_id = old.contract_id
    and r.effective_to = old.effective_from - 1;
  return null;
end;
$$;

revoke all on function private.rate_cards_reopen_previous() from public, anon, authenticated;

create trigger rate_cards_guard before insert or update or delete on public.rate_cards
  for each row execute function private.rate_cards_guard();
create trigger rate_cards_reopen_previous after delete on public.rate_cards
  for each row execute function private.rate_cards_reopen_previous();
create trigger rate_cards_set_updated_at before update on public.rate_cards
  for each row execute function private.set_updated_at();
create trigger rate_cards_audit after insert or update or delete on public.rate_cards
  for each row execute function private.audit_row_change();

-- The WHT rate a service type starts with (owner's accountant, 19 Nov 2026). The app shows the
-- same defaults (src/lib/rate-cards.ts DEFAULT_WHT_BPS).
create function private.default_wht_rate_bps(p_service_type text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_service_type
    when 'management_fee' then 500
    when 'rent_hire' then 1000
    else 200
  end
$$;

revoke all on function private.default_wht_rate_bps(text) from public, anon, authenticated;

-- BEFORE INSERT/UPDATE/DELETE on rate_card_lines. A line left without a WHT rate takes its
-- service type's default. Lines are never edited. While the contract is
-- a draft they are replaced with the card. Once it has left draft, lines are added only to a
-- scheduled version or to a version created in this same transaction (add_rate_card_version
-- from today: created_at is the transaction's now()), and removed only with a scheduled version.
create function private.rate_card_lines_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_card uuid := coalesce(new.rate_card_id, old.rate_card_id);
  v_from date;
  v_created timestamptz;
  v_status text;
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
begin
  if tg_op = 'UPDATE' then
    raise exception 'Rate card lines are never edited. Add a new version instead.'
      using errcode = 'MLRC1';
  end if;
  if tg_op = 'INSERT' and new.wht_rate_bps is null then
    new.wht_rate_bps := private.default_wht_rate_bps(new.service_type);
  end if;

  select r.effective_from, r.created_at, c.status into v_from, v_created, v_status
  from public.rate_cards r
  join public.contracts c on c.id = r.contract_id
  where r.id = v_card;

  if v_status is null or v_status = 'draft' then
    return coalesce(new, old);
  end if;
  if v_from > v_today or (tg_op = 'INSERT' and v_created = now()) then
    return coalesce(new, old);
  end if;
  raise exception 'This rate card is already in force and its lines can''t change. Add a new version instead.'
    using errcode = 'MLRC1';
end;
$$;

revoke all on function private.rate_card_lines_guard() from public, anon, authenticated;

create trigger rate_card_lines_guard before insert or update or delete on public.rate_card_lines
  for each row execute function private.rate_card_lines_guard();
create trigger rate_card_lines_audit after insert or update or delete on public.rate_card_lines
  for each row execute function private.audit_row_change();

-- AFTER UPDATE on contracts: moving a draft's start date moves its first rate card with it (they start on the contract's start date), and any version left outside the
-- new dates is refused with a plain reason. Definer: signed-in users have no grants on the
-- dated tables; the guards above still check every change.
create function private.contracts_after_dates_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'draft'
    or (new.start_date = old.start_date and new.end_date is not distinct from old.end_date) then
    return null;
  end if;

  if new.start_date <> old.start_date then
    if exists (
      select 1 from public.rate_cards r
      where r.contract_id = new.id
        and r.effective_from > old.start_date and r.effective_from <= new.start_date
    ) then
      raise exception 'A scheduled rate change starts before the new start date. Cancel it first.'
        using errcode = 'MLCO4';
    end if;
    update public.rate_cards r
    set effective_from = new.start_date
    where r.contract_id = new.id and r.effective_from = old.start_date;
  end if;

  if exists (
    select 1 from public.rate_cards r
    where r.contract_id = new.id
      and (
        r.effective_from < new.start_date
        or coalesce(r.effective_to, r.effective_from) > coalesce(new.end_date, 'infinity')
      )
  ) or exists (
    -- The first rate card starts on the start date (save_draft_rate_card), so no day goes unpriced.
    select 1 from public.rate_cards r
    where r.contract_id = new.id
      and r.effective_from = (select min(f.effective_from) from public.rate_cards f where f.contract_id = new.id)
      and r.effective_from <> new.start_date
  ) then
    raise exception 'A rate card starts outside the new dates. Cancel it first.'
      using errcode = 'MLCO4';
  end if;
  return null;
end;
$$;

revoke all on function private.contracts_after_dates_change() from public, anon, authenticated;

create trigger contracts_after_dates_change after update on public.contracts
  for each row execute function private.contracts_after_dates_change();

-- ---------------------------------------------------------------------------
-- 5. Row-level security and grants (docs/PHASE_2.md "Roles")
-- ---------------------------------------------------------------------------
-- Contracts, contract sites, rate cards and WHT rates are read by owner, admin, finance and
-- ops_manager. Contracts and contract sites are written by owner, admin and ops_manager. Rate
-- cards and WHT rates are written only by the functions in section 6 (no write grants).

alter table public.contracts enable row level security;
alter table public.contract_sites enable row level security;
alter table public.rate_cards enable row level security;
alter table public.rate_card_lines enable row level security;

create policy contracts_select on public.contracts for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));
create policy contracts_insert on public.contracts for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));
create policy contracts_update on public.contracts for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));

revoke all on table public.contracts from anon, authenticated;
grant select on table public.contracts to authenticated;
grant insert (
  id, organisation_id, client_id, reference, name, type, start_date, end_date,
  billing_frequency, billing_terms_days, vat_applies, sla
) on table public.contracts to authenticated;
-- No status, activation or end fields: activation and ending are functions (2.7).
grant update (
  name, type, start_date, end_date, billing_frequency, billing_terms_days, vat_applies, sla
) on table public.contracts to authenticated;

create policy contract_sites_select on public.contract_sites for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));
create policy contract_sites_insert on public.contract_sites for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));
-- A draft's sites can be taken off again (the guard refuses it once the contract is live).
create policy contract_sites_delete on public.contract_sites for delete to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));

revoke all on table public.contract_sites from anon, authenticated;
grant select, delete on table public.contract_sites to authenticated;
grant insert (id, organisation_id, contract_id, site_id) on table public.contract_sites to authenticated;

create policy rate_cards_select on public.rate_cards for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));
create policy rate_card_lines_select on public.rate_card_lines for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));

revoke all on table public.rate_cards from anon, authenticated;
revoke all on table public.rate_card_lines from anon, authenticated;
grant select on table public.rate_cards to authenticated;
grant select on table public.rate_card_lines to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Writes
-- ---------------------------------------------------------------------------

-- The rate keys of the contract's open posts. Posts arrive in slice 2.7, which replaces this
-- function; until then a contract has no posts, so nothing can be missing.
create function private.rate_card_open_post_keys(p_organisation_id uuid, p_contract_id uuid)
returns table (role text, band text, unit text)
language sql
stable
set search_path = ''
as $$
  select null::text, null::text, null::text where false
$$;

revoke all on function private.rate_card_open_post_keys(uuid, uuid) from public, anon, authenticated;

-- A version and its lines as JSON, for the audit row's before and after. Amounts as strings of
-- whole kobo, the way they arrive.
create function private.rate_card_snapshot(p_rate_card_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'effective_from', r.effective_from,
    'effective_to', r.effective_to,
    'note', r.note,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', l.role,
        'band', l.band,
        'unit', l.unit,
        'rate_kobo', l.rate_kobo::text,
        'currency', l.currency,
        'ot_rate_kobo', l.ot_rate_kobo::text,
        'ot_multiplier_bps', l.ot_multiplier_bps,
        'service_type', l.service_type,
        'wht_rate_bps', l.wht_rate_bps
      ) order by l.sort_order, l.id)
      from public.rate_card_lines l
      where l.rate_card_id = r.id
    ), '[]'::jsonb)
  )
  from public.rate_cards r
  where r.id = p_rate_card_id
$$;

revoke all on function private.rate_card_snapshot(uuid) from public, anon, authenticated;

-- Inserts the lines of a version from a JSON array of
--   { role, band?, unit, rate_kobo: "1250000", ot_rate_kobo?: "160000" | null,
--     ot_multiplier_bps?: 15000 | null, service_type?: "services", wht_rate_bps?: 200 | null }
-- A missing WHT rate follows the service type.
-- Amounts must be JSON strings of whole kobo. 1 to 100 lines; the table checks the rest
-- (ranges, currency, a rate key once per version).
create function private.rate_card_insert_lines(
  p_organisation_id uuid,
  p_rate_card_id uuid,
  p_lines jsonb
)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_line jsonb;
  v_index integer := 0;
  v_rate bigint;
  v_ot bigint;
  v_mult integer;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one rate line.' using errcode = 'MLRC8';
  end if;
  if jsonb_array_length(p_lines) > 100 then
    raise exception 'A rate card has 100 lines or fewer.' using errcode = 'MLRC8';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object'
      or jsonb_typeof(v_line -> 'rate_kobo') is distinct from 'string'
      or (v_line ? 'ot_rate_kobo' and jsonb_typeof(v_line -> 'ot_rate_kobo') not in ('string', 'null'))
      or (v_line ? 'ot_multiplier_bps' and jsonb_typeof(v_line -> 'ot_multiplier_bps') not in ('number', 'null'))
      or (v_line ? 'wht_rate_bps' and jsonb_typeof(v_line -> 'wht_rate_bps') not in ('number', 'null'))
    then
      raise exception 'Rate line % is not in the expected shape.', v_index + 1 using errcode = 'MLRC8';
    end if;
    -- Whole kobo and whole basis points as digits only, checked before the casts so junk gets a
    -- plain reason.
    if (v_line ->> 'rate_kobo') !~ '^[0-9]{1,12}$'
      or ((v_line ->> 'ot_rate_kobo') is not null and (v_line ->> 'ot_rate_kobo') !~ '^[0-9]{1,12}$')
    then
      raise exception 'Rate line % needs amounts in whole kobo.', v_index + 1 using errcode = 'MLRC8';
    end if;
    if ((v_line ->> 'ot_multiplier_bps') is not null and (v_line ->> 'ot_multiplier_bps') !~ '^[0-9]{1,5}$')
      or ((v_line ->> 'wht_rate_bps') is not null and (v_line ->> 'wht_rate_bps') !~ '^[0-9]{1,5}$')
    then
      raise exception 'Rate line % needs rates in whole basis points.', v_index + 1
        using errcode = 'MLRC8';
    end if;
    v_rate := (v_line ->> 'rate_kobo')::bigint;
    v_ot := (v_line ->> 'ot_rate_kobo')::bigint;
    v_mult := (v_line ->> 'ot_multiplier_bps')::integer;
    -- On an hourly line the multiplier gives the overtime rate, half up once (exact in bigint).
    if v_line ->> 'unit' = 'hour' and v_mult is not null then
      if v_ot is null then
        v_ot := (v_rate * v_mult + 5000) / 10000;
      elsif v_ot <> (v_rate * v_mult + 5000) / 10000 then
        raise exception 'Rate line % has an overtime rate that doesn''t match its multiplier.',
          v_index + 1 using errcode = 'MLRC8';
      end if;
    end if;
    insert into public.rate_card_lines (
      organisation_id, rate_card_id, role, band, unit, rate_kobo, ot_rate_kobo,
      ot_multiplier_bps, service_type, wht_rate_bps, sort_order
    )
    values (
      p_organisation_id,
      p_rate_card_id,
      btrim(v_line ->> 'role'),
      coalesce(nullif(btrim(v_line ->> 'band'), ''), 'standard'),
      v_line ->> 'unit',
      v_rate,
      v_ot,
      v_mult,
      coalesce(nullif(v_line ->> 'service_type', ''), 'services'),
      (v_line ->> 'wht_rate_bps')::integer,
      v_index
    );
    v_index := v_index + 1;
  end loop;
  return v_index;
end;
$$;

revoke all on function private.rate_card_insert_lines(uuid, uuid, jsonb) from public, anon, authenticated;

-- Locks the contract row and returns its status, after the caller's role is checked. Every
-- rate card write goes through here first, so writes to one contract happen one at a
-- time.
create function private.lock_contract_for_rates(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_roles text[]
)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_organisation_id is null or not private.has_role(p_organisation_id, p_roles) then
    raise exception 'Your role can''t change rates on this contract.' using errcode = '42501';
  end if;
  select c.status into v_status
  from public.contracts c
  where c.id = p_contract_id and c.organisation_id = p_organisation_id
  for update;
  if v_status is null then
    raise exception 'That contract wasn''t found.' using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;

revoke all on function private.lock_contract_for_rates(uuid, uuid, text[]) from public, anon, authenticated;

-- save_draft_rate_card: writes the rate card of a draft contract, replacing what was there
-- (nothing has used it). Refused once a rate change is scheduled on top of it.
create function private.save_draft_rate_card(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_effective_from date,
  p_lines jsonb,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_card uuid;
  v_count integer;
  v_before jsonb;
begin
  v_status := private.lock_contract_for_rates(
    p_organisation_id, p_contract_id, array['owner', 'admin', 'ops_manager']
  );
  if v_status <> 'draft' then
    raise exception 'This contract is live. Use Change rates from instead.' using errcode = 'MLRC6';
  end if;
  if p_effective_from is null then
    raise exception 'Choose the date the rates start.' using errcode = '22023';
  end if;
  -- The first rate card starts with the contract, so no day of it goes unpriced (a gap could
  -- never be filled once live: backdating is refused).
  if p_effective_from <> (select c.start_date from public.contracts c where c.id = p_contract_id) then
    raise exception 'The first rate card starts on the contract''s start date.' using errcode = 'MLRC4';
  end if;

  select count(*), min(r.id::text)::uuid into v_count, v_card
  from public.rate_cards r
  where r.contract_id = p_contract_id;
  if v_count > 1 then
    raise exception 'A rate change is scheduled. Cancel it before editing the first rate card.'
      using errcode = 'MLRC3';
  end if;

  if v_card is null then
    insert into public.rate_cards (organisation_id, contract_id, effective_from, note)
    values (p_organisation_id, p_contract_id, p_effective_from, nullif(btrim(p_note), ''))
    returning id into v_card;
  else
    v_before := private.rate_card_snapshot(v_card);
    delete from public.rate_card_lines l where l.rate_card_id = v_card;
    update public.rate_cards r
    set effective_from = p_effective_from, effective_to = null, note = nullif(btrim(p_note), '')
    where r.id = v_card;
  end if;
  perform private.rate_card_insert_lines(p_organisation_id, v_card, p_lines);

  perform private.log_audit_impl(
    p_organisation_id, 'rate_card.draft_saved', 'rate_cards', v_card,
    v_before, private.rate_card_snapshot(v_card), null
  );
  return v_card;
end;
$$;

-- add_rate_card_version: "Change rates from". Adds a version from p_effective_from and closes
-- the one before it the day before, in one transaction. On a live contract the date is today or
-- later; on a draft it is after the current card (a change already agreed). Refused when an open
-- post's rate key is missing from the new lines (2.7 supplies the posts).
create function private.add_rate_card_version(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_effective_from date,
  p_lines jsonb,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_card uuid;
  v_previous uuid;
  v_previous_to date;
  v_missing text;
begin
  v_status := private.lock_contract_for_rates(
    p_organisation_id, p_contract_id, array['owner', 'admin', 'ops_manager']
  );
  if v_status = 'ended' then
    raise exception 'This contract has ended and its rates can''t change.' using errcode = 'MLRC6';
  end if;
  if p_effective_from is null then
    raise exception 'Choose the date the new rates start.' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Add at least one rate line.' using errcode = 'MLRC8';
  end if;

  select r.id, r.effective_to into v_previous, v_previous_to
  from public.rate_cards r
  where r.contract_id = p_contract_id
  order by r.effective_from desc
  limit 1;
  if v_previous is null then
    raise exception 'This contract has no rate card yet. Add the first one.' using errcode = 'MLRC7';
  end if;
  if exists (
    select 1 from public.rate_cards r
    where r.contract_id = p_contract_id and r.effective_from >= p_effective_from
  ) then
    raise exception 'A rate card from this date or later already exists. Cancel it first.'
      using errcode = 'MLRC3';
  end if;
  if v_status <> 'draft' and p_effective_from < private.org_today(p_organisation_id) then
    raise exception 'A rate change starts today or later.' using errcode = 'MLRC2';
  end if;

  select string_agg(k.role || ' · ' || k.band || ' (' || k.unit || ')', ', ')
  into v_missing
  from private.rate_card_open_post_keys(p_organisation_id, p_contract_id) k
  where not exists (
    select 1 from jsonb_array_elements(p_lines) l
    where lower(btrim(l.value ->> 'role')) = lower(k.role)
      and lower(coalesce(nullif(btrim(l.value ->> 'band'), ''), 'standard')) = lower(k.band)
      and l.value ->> 'unit' = k.unit
  );
  if v_missing is not null then
    raise exception 'The new rates leave out %, which open posts need.', v_missing
      using errcode = 'MLRC5';
  end if;

  update public.rate_cards r
  set effective_to = p_effective_from - 1
  where r.id = v_previous;

  insert into public.rate_cards (organisation_id, contract_id, effective_from, effective_to, note)
  values (
    p_organisation_id, p_contract_id, p_effective_from, v_previous_to, nullif(btrim(p_note), '')
  )
  returning id into v_card;
  perform private.rate_card_insert_lines(p_organisation_id, v_card, p_lines);

  perform private.log_audit_impl(
    p_organisation_id, 'rate_card.version_added', 'rate_cards', v_card,
    jsonb_build_object(
      'closes', v_previous, 'effective_to_before', v_previous_to,
      'effective_to_after', p_effective_from - 1
    ),
    private.rate_card_snapshot(v_card), null
  );
  return v_card;
end;
$$;

-- cancel_rate_card_version: takes back the latest version before it starts and reopens the one
-- before it. On a draft any latest version may go (even the only one).
create function private.cancel_rate_card_version(p_organisation_id uuid, p_rate_card_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract uuid;
  v_status text;
  v_from date;
  v_before jsonb;
begin
  select r.contract_id, r.effective_from into v_contract, v_from
  from public.rate_cards r
  where r.id = p_rate_card_id and r.organisation_id = p_organisation_id;
  if v_contract is null then
    -- The role check comes first for every caller, so an outsider learns nothing.
    perform private.lock_contract_for_rates(
      p_organisation_id, null, array['owner', 'admin', 'ops_manager']
    );
  end if;
  v_status := private.lock_contract_for_rates(
    p_organisation_id, v_contract, array['owner', 'admin', 'ops_manager']
  );

  if exists (
    select 1 from public.rate_cards r
    where r.contract_id = v_contract and r.effective_from > v_from
  ) then
    raise exception 'A later rate change is scheduled after this one. Cancel that one first.'
      using errcode = 'MLRC1';
  end if;
  if v_status <> 'draft' then
    if v_from <= private.org_today(p_organisation_id) then
      raise exception 'This rate card is already in force and can''t be cancelled.'
        using errcode = 'MLRC1';
    end if;
    if not exists (
      select 1 from public.rate_cards r
      where r.contract_id = v_contract and r.id <> p_rate_card_id
    ) then
      raise exception 'A live contract needs a rate card. Add the new one first.'
        using errcode = 'MLRC7';
    end if;
  end if;

  v_before := private.rate_card_snapshot(p_rate_card_id);
  delete from public.rate_card_lines l where l.rate_card_id = p_rate_card_id;
  delete from public.rate_cards r where r.id = p_rate_card_id;

  perform private.log_audit_impl(
    p_organisation_id, 'rate_card.version_cancelled', 'rate_cards', p_rate_card_id,
    v_before, null, null
  );
end;
$$;

revoke all on function private.save_draft_rate_card(uuid, uuid, date, jsonb, text) from public, anon;
revoke all on function private.add_rate_card_version(uuid, uuid, date, jsonb, text) from public, anon;
revoke all on function private.cancel_rate_card_version(uuid, uuid) from public, anon;
grant execute on function private.save_draft_rate_card(uuid, uuid, date, jsonb, text) to authenticated;
grant execute on function private.add_rate_card_version(uuid, uuid, date, jsonb, text) to authenticated;
grant execute on function private.cancel_rate_card_version(uuid, uuid) to authenticated;

-- Public invoker wrappers: what the Data API exposes.
create function public.save_draft_rate_card(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_effective_from date,
  p_lines jsonb,
  p_note text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.save_draft_rate_card(
    p_organisation_id, p_contract_id, p_effective_from, p_lines, p_note
  )
$$;

create function public.add_rate_card_version(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_effective_from date,
  p_lines jsonb,
  p_note text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_rate_card_version(
    p_organisation_id, p_contract_id, p_effective_from, p_lines, p_note
  )
$$;

create function public.cancel_rate_card_version(p_organisation_id uuid, p_rate_card_id uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.cancel_rate_card_version(p_organisation_id, p_rate_card_id)
$$;

revoke all on function public.save_draft_rate_card(uuid, uuid, date, jsonb, text) from public, anon;
revoke all on function public.add_rate_card_version(uuid, uuid, date, jsonb, text) from public, anon;
revoke all on function public.cancel_rate_card_version(uuid, uuid) from public, anon;
grant execute on function public.save_draft_rate_card(uuid, uuid, date, jsonb, text) to authenticated;
grant execute on function public.add_rate_card_version(uuid, uuid, date, jsonb, text) to authenticated;
grant execute on function public.cancel_rate_card_version(uuid, uuid) to authenticated;

-- create_contract: a draft contract with its sites in one transaction, as the caller. p_contract carries the contracts
-- columns by name; reference left blank gets the next CTR number.
create function public.create_contract(
  p_organisation_id uuid,
  p_contract jsonb,
  p_site_ids uuid[] default '{}'
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.contracts (
    organisation_id, client_id, reference, name, type, start_date, end_date,
    billing_frequency, billing_terms_days, vat_applies, sla
  )
  values (
    p_organisation_id,
    (p_contract ->> 'client_id')::uuid,
    nullif(btrim(coalesce(p_contract ->> 'reference', '')), ''),
    p_contract ->> 'name',
    p_contract ->> 'type',
    (p_contract ->> 'start_date')::date,
    (p_contract ->> 'end_date')::date,
    coalesce(p_contract ->> 'billing_frequency', 'monthly'),
    (p_contract ->> 'billing_terms_days')::integer,
    (p_contract ->> 'vat_applies')::boolean,
    coalesce(p_contract -> 'sla', '{}'::jsonb)
  )
  returning id into v_id;

  insert into public.contract_sites (organisation_id, contract_id, site_id)
  select p_organisation_id, v_id, s.site_id
  from (select distinct unnest(coalesce(p_site_ids, '{}')) as site_id) s;

  return v_id;
end;
$$;

-- update_draft_contract: a draft's terms and its sites, as the caller.
create function public.update_draft_contract(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_contract jsonb,
  p_site_ids uuid[] default '{}'
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.contracts c
  set name = p_contract ->> 'name',
    type = p_contract ->> 'type',
    start_date = (p_contract ->> 'start_date')::date,
    end_date = (p_contract ->> 'end_date')::date,
    billing_frequency = coalesce(p_contract ->> 'billing_frequency', 'monthly'),
    billing_terms_days = (p_contract ->> 'billing_terms_days')::integer,
    vat_applies = coalesce((p_contract ->> 'vat_applies')::boolean, c.vat_applies),
    sla = coalesce(p_contract -> 'sla', '{}'::jsonb)
  where c.id = p_contract_id
    and c.organisation_id = p_organisation_id
    and c.status = 'draft'
  returning c.id into v_id;
  if v_id is null then
    raise exception 'That draft contract wasn''t found.' using errcode = 'P0002';
  end if;

  delete from public.contract_sites cs
  where cs.contract_id = p_contract_id
    and cs.organisation_id = p_organisation_id
    and not (cs.site_id = any (coalesce(p_site_ids, '{}')));
  insert into public.contract_sites (organisation_id, contract_id, site_id)
  select p_organisation_id, p_contract_id, s.site_id
  from (select distinct unnest(coalesce(p_site_ids, '{}')) as site_id) s
  where not exists (
    select 1 from public.contract_sites cs
    where cs.contract_id = p_contract_id and cs.site_id = s.site_id
  );
  return v_id;
end;
$$;

revoke all on function public.create_contract(uuid, jsonb, uuid[]) from public, anon;
revoke all on function public.update_draft_contract(uuid, uuid, jsonb, uuid[]) from public, anon;
grant execute on function public.create_contract(uuid, jsonb, uuid[]) to authenticated;
grant execute on function public.update_draft_contract(uuid, uuid, jsonb, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Client tax settings (owner's accountant, 19 Nov 2026)
-- ---------------------------------------------------------------------------
-- deducts_wht: whether the client is expected to deduct WHT from its payments ('expected', the
-- default) or doesn't ('not_deducted'). The app applies no turnover threshold: whether a client
-- counts as small is its own decision, and Phase 6 learns it from the payments and flags
-- differences.
-- withholds_vat: government MDAs and appointed VAT withholding agents pay the VAT to the tax
-- authority themselves, so their payments arrive without it, on every contract.
-- Like the other billing columns (slice 2.1) they are not granted to signed-in users: they are
-- read through public.client_billing (owner, admin, finance, ops_manager; not hr or line
-- managers) and written by set_client_tax_settings (owner, admin, finance), audited by the row
-- trigger and an app event with the reason.
alter table public.clients
  add column deducts_wht text not null default 'expected'
    constraint clients_deducts_wht_value check (deducts_wht in ('expected', 'not_deducted')),
  add column withholds_vat boolean not null default false;

comment on column public.clients.deducts_wht is
  'Whether the client is expected to deduct WHT (expected) or does not (not_deducted). Phase 6 learns it from payments; no threshold is applied.';
comment on column public.clients.withholds_vat is
  'The client pays the VAT to the tax authority itself (government MDAs, appointed VAT withholding agents).';

drop function public.client_billing(uuid, uuid);
drop function private.client_billing(uuid, uuid);

create function private.client_billing(p_organisation_id uuid, p_client_id uuid default null)
returns table (
  client_id uuid,
  legal_name text,
  rc_number text,
  tin text,
  billing_address text,
  state text,
  billing_terms_days integer,
  notes text,
  deducts_wht text,
  withholds_vat boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.legal_name, c.rc_number, c.tin, c.billing_address, c.state,
    c.billing_terms_days, c.notes, c.deducts_wht, c.withholds_vat
  from public.clients c
  where c.organisation_id = p_organisation_id
    and (p_client_id is null or c.id = p_client_id)
    and private.has_role(p_organisation_id, array['owner', 'admin', 'finance', 'ops_manager'])
$$;

revoke all on function private.client_billing(uuid, uuid) from public, anon;
grant execute on function private.client_billing(uuid, uuid) to authenticated;

create function public.client_billing(p_organisation_id uuid, p_client_id uuid default null)
returns table (
  client_id uuid,
  legal_name text,
  rc_number text,
  tin text,
  billing_address text,
  state text,
  billing_terms_days integer,
  notes text,
  deducts_wht text,
  withholds_vat boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.client_billing(p_organisation_id, p_client_id)
$$;

revoke all on function public.client_billing(uuid, uuid) from public, anon;
grant execute on function public.client_billing(uuid, uuid) to authenticated;

-- Sets a client's tax settings: owner, admin and finance (finance does not otherwise update
-- clients). The clients row trigger audits the change; the app event carries the reason.
create function private.set_client_tax_settings(
  p_organisation_id uuid,
  p_client_id uuid,
  p_deducts_wht text,
  p_withholds_vat boolean,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
begin
  if p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'finance']) then
    raise exception 'Your role can''t change a client''s tax settings.' using errcode = '42501';
  end if;
  if p_deducts_wht is null or p_withholds_vat is null then
    raise exception 'Choose both tax settings.' using errcode = 'MLCL1';
  end if;
  select jsonb_build_object('deducts_wht', c.deducts_wht, 'withholds_vat', c.withholds_vat)
  into v_before
  from public.clients c
  where c.id = p_client_id and c.organisation_id = p_organisation_id
  for update;
  if v_before is null then
    raise exception 'That client wasn''t found.' using errcode = 'P0002';
  end if;
  update public.clients c
  set deducts_wht = p_deducts_wht, withholds_vat = p_withholds_vat
  where c.id = p_client_id;
  perform private.log_audit_impl(
    p_organisation_id, 'clients.tax_settings_changed', 'clients', p_client_id, v_before,
    jsonb_build_object('deducts_wht', p_deducts_wht, 'withholds_vat', p_withholds_vat),
    p_reason
  );
end;
$$;

revoke all on function private.set_client_tax_settings(uuid, uuid, text, boolean, text) from public, anon;
grant execute on function private.set_client_tax_settings(uuid, uuid, text, boolean, text) to authenticated;

create function public.set_client_tax_settings(
  p_organisation_id uuid,
  p_client_id uuid,
  p_deducts_wht text,
  p_withholds_vat boolean,
  p_reason text default null
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_client_tax_settings(
    p_organisation_id, p_client_id, p_deducts_wht, p_withholds_vat, p_reason
  )
$$;

revoke all on function public.set_client_tax_settings(uuid, uuid, text, boolean, text) from public, anon;
grant execute on function public.set_client_tax_settings(uuid, uuid, text, boolean, text) to authenticated;
