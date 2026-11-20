-- Slice 2.7: activation. A contract's headcount becomes posts and dated roster requirements,
-- which Phase 3 rosters against, Phase 4 turns into Work Units and Phase 6 prices.
--
-- 1. `posts`: the place where one role is staffed ("Gate A · Day"). One per headcount row at
--    activation (2.8 adds more). Never deleted; closed with a last day (`closed_on`) and a
--    reason, and never reopened.
-- 2. `roster_requirements`: how many people a post needs, on which days and hours, from which
--    date. Dated versions per post with no overlaps (GiST). A version is never edited except to
--    close `effective_to`; only a version that hasn't started may be removed (2.8 cancels).
-- 3. `private.required_shifts(org, from, to)`: one row per post and date with the start and end
--    as timestamps in the company's time zone (a night shift belongs to the day it starts and
--    ends the next day) and the people required. Phase 3 rosters against it.
-- 4. `activate_contract(org, contract, go_live_date, send_welcome)`: the checklist, then status
--    active, the posts and the requirements, in one transaction with the contract row locked.
--    Running it again changes nothing. Refusals list every missing item at once.
-- 5. `end_contract(org, contract, end_date, reason)`: closes the open posts, requirements and
--    rate card versions on the end date (cancelling those that would start after it), then
--    sets the contract's end date. A daily job sets the status to `ended` once the date has
--    passed (the 2.4 guards refuse rate card writes after that).
-- 6. Owner decision (19 Nov 2026): new worker assignments to an archived site or an archived
--    client are refused (existing ones are left alone).
--
-- Nothing here stores money. Posts carry the rate key (role, band, unit) copied from the
-- headcount row, so they match the rate card exactly as the headcount did (decision 5).
--
-- Refusals (SQLSTATE), mapped to plain English in src/server/business/activation.ts:
--   MLCT1 not a draft (ended)                  MLCT2 no active billing contact
--   MLCT3 no sites, or a site without geofence MLCT4 no rate card in force on the go-live date
--   MLCT5 a headcount row without a rate line  MLCT6 manned_post without headcount
--   MLCT7 go-live date outside the dates       MLCT8 client or a contract site archived
--   MLCT9 a rate line without a service type or WHT rate (guaranteed by the table; asserted)
--   An activation refusal carries every failed item in DETAIL as JSON [{code, message}].
--   MLCE1 contract not live                    MLCE2 end date refused
--   MLCE3 reason missing                       MLCE4 already ending on another date
--   MLPO1 post or requirement change refused (never edited, deleted or reopened)
--   MLAS6 site archived                        MLAS7 client archived

-- ---------------------------------------------------------------------------
-- 1. posts
-- ---------------------------------------------------------------------------

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  contract_id uuid not null,
  site_id uuid not null,
  -- The headcount row it came from at activation; null for posts added later (2.8).
  headcount_requirement_id uuid,
  -- "Gate A · Day": the post name (or the role) and the band unless it is `standard`.
  name text not null
    constraint posts_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 130
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  role text not null
    constraint posts_role_text check (
      role = btrim(role) and char_length(role) between 1 and 80 and role !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  band text not null default 'standard'
    constraint posts_band_text check (
      band = btrim(band) and char_length(band) between 1 and 40 and band !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  -- The rate key's unit, as on the headcount row.
  unit text not null
    constraint posts_unit_value check (unit in ('shift', 'hour', 'visit')),
  kind text generated always as (case when unit = 'visit' then 'visit' else 'shift' end) stored,
  status text not null default 'open'
    constraint posts_status_value check (status in ('open', 'closed')),
  opened_on date not null,
  -- The last day the post is staffed. The day before opened_on means it was never staffed.
  closed_on date,
  closed_reason text
    constraint posts_closed_reason_text check (
      closed_reason = btrim(closed_reason)
      and char_length(closed_reason) between 1 and 500
      and closed_reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint posts_organisation_id_id_key unique (organisation_id, id),
  -- Roster requirements copy the contract and site; this key lets them point at all three.
  constraint posts_org_id_contract_site_key unique (organisation_id, id, contract_id, site_id),
  constraint posts_contract_fkey foreign key (organisation_id, contract_id)
    references public.contracts (organisation_id, id),
  constraint posts_contract_site_fkey foreign key (organisation_id, contract_id, site_id)
    references public.contract_sites (organisation_id, contract_id, site_id),
  constraint posts_headcount_fkey foreign key (organisation_id, headcount_requirement_id)
    references public.headcount_requirements (organisation_id, id),
  constraint posts_closed_known check (
    (status = 'closed') = (closed_on is not null)
    and (status = 'closed') = (closed_reason is not null)
  ),
  constraint posts_closed_after_open check (closed_on >= opened_on - 1)
);

create unique index posts_headcount_key on public.posts (headcount_requirement_id)
  where headcount_requirement_id is not null;
create unique index posts_open_name_key on public.posts (contract_id, site_id, lower(name))
  where status = 'open';
create index posts_contract_idx on public.posts (organisation_id, contract_id);
create index posts_site_idx on public.posts (organisation_id, site_id);

comment on table public.posts is
  'Where one role is staffed on a contract ("Gate A · Day"). Created at activation from the headcount (2.7) or added later (2.8). Never deleted; closed with a last day and a reason, never reopened.';
comment on column public.posts.closed_on is
  'The last day the post is staffed (inclusive). The day before opened_on means it was never staffed.';

-- ---------------------------------------------------------------------------
-- 2. roster_requirements
-- ---------------------------------------------------------------------------

create table public.roster_requirements (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  post_id uuid not null,
  contract_id uuid not null,
  site_id uuid not null,
  effective_from date not null,
  -- Null means until the post closes.
  effective_to date,
  -- ISO weekdays, 1 = Monday to 7 = Sunday, sorted, each once.
  days_of_week smallint[] not null
    constraint roster_requirements_days_value check (
      cardinality(days_of_week) between 1 and 7
      and array_ndims(days_of_week) = 1
      and array_position(days_of_week, null) is null
      and days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    ),
  start_time time not null
    constraint roster_requirements_start_quarter check (
      date_part('minute', start_time)::integer % 15 = 0 and date_part('second', start_time) = 0
    ),
  -- At or before start_time means the next day; equal is a 24-hour post.
  end_time time not null
    constraint roster_requirements_end_quarter check (
      date_part('minute', end_time)::integer % 15 = 0 and date_part('second', end_time) = 0
    ),
  duration_minutes integer generated always as (
    case
      when end_time > start_time then (date_part('epoch', end_time - start_time) / 60)::integer
      else 1440 - (date_part('epoch', start_time - end_time) / 60)::integer
    end
  ) stored,
  required_count integer not null
    constraint roster_requirements_count_range check (required_count between 1 and 200),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint roster_requirements_organisation_id_id_key unique (organisation_id, id),
  constraint roster_requirements_post_fkey foreign key (organisation_id, post_id, contract_id, site_id)
    references public.posts (organisation_id, id, contract_id, site_id),
  constraint roster_requirements_dates check (effective_to >= effective_from),
  constraint roster_requirements_no_overlap exclude using gist (
    post_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);

create index roster_requirements_post_from_idx on public.roster_requirements (post_id, effective_from);
create index roster_requirements_org_dates_idx
  on public.roster_requirements (organisation_id, effective_from, effective_to);

comment on table public.roster_requirements is
  'How many people a post needs, on which days and hours, from which date. Dated versions per post; a version is never edited except to close effective_to.';

-- ---------------------------------------------------------------------------
-- 3. Guards: never deleted, never edited except closing
-- ---------------------------------------------------------------------------

-- BEFORE INSERT/UPDATE/DELETE on posts.
-- * never deleted; a post never moves contract, site or organisation and its key never changes;
-- * the only change is closing: open -> closed with a last day and a reason; closed never reopens;
-- * a new post opens inside the contract's dates on a contract that hasn't ended.
create function private.posts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_start date;
  v_end date;
begin
  if tg_op = 'DELETE' then
    raise exception 'Posts are never deleted. Close the post instead.' using errcode = 'MLPO1';
  end if;

  if tg_op = 'INSERT' then
    select c.status, c.start_date, c.end_date into v_status, v_start, v_end
    from public.contracts c
    where c.id = new.contract_id and c.organisation_id = new.organisation_id;
    if v_status is distinct from 'active' then
      raise exception 'Posts are added to a live contract only.' using errcode = 'MLPO1';
    end if;
    if new.opened_on < v_start or (v_end is not null and new.opened_on > v_end) then
      raise exception 'A post opens inside the contract''s dates.' using errcode = 'MLPO1';
    end if;
    if new.status <> 'open' then
      raise exception 'A new post is open.' using errcode = 'MLPO1';
    end if;
    return new;
  end if;

  if (
    new.id, new.organisation_id, new.contract_id, new.site_id, new.headcount_requirement_id, new.name,
    new.role, new.band, new.unit, new.opened_on, new.created_at, new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.contract_id, old.site_id, old.headcount_requirement_id, old.name,
    old.role, old.band, old.unit, old.opened_on, old.created_at, old.created_by
  ) then
    raise exception 'A post never changes. Close it and add a new one.' using errcode = 'MLPO1';
  end if;
  if old.status = 'closed' and (
    new.status, new.closed_on, new.closed_reason
  ) is distinct from (
    old.status, old.closed_on, old.closed_reason
  ) then
    raise exception 'This post is closed and posts don''t reopen.' using errcode = 'MLPO1';
  end if;
  return new;
end;
$$;

revoke all on function private.posts_guard() from public, anon, authenticated;

create trigger posts_guard before insert or update or delete on public.posts
  for each row execute function private.posts_guard();
create trigger posts_set_updated_at before update on public.posts
  for each row execute function private.set_updated_at();
create trigger posts_audit after insert or update or delete on public.posts
  for each row execute function private.audit_row_change();

-- BEFORE INSERT/UPDATE/DELETE on roster_requirements.
-- * a version sits inside its post's open dates;
-- * a version is never edited, except closing effective_to (from yesterday at the earliest, and
--   never on a version that has already ended);
-- * only a version that hasn't started is removed (2.8 cancels a scheduled change).
create function private.roster_requirements_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
  v_opened date;
  v_closed date;
begin
  if tg_op = 'DELETE' then
    if old.effective_from <= v_today then
      raise exception 'This requirement has started and can''t be removed. Close it instead.'
        using errcode = 'MLPO1';
    end if;
    return old;
  end if;

  select p.opened_on, p.closed_on into v_opened, v_closed
  from public.posts p
  where p.id = new.post_id and p.organisation_id = new.organisation_id;

  if tg_op = 'INSERT' then
    if new.effective_from < v_opened
      or (v_closed is not null and coalesce(new.effective_to, 'infinity') > v_closed) then
      raise exception 'A requirement sits inside its post''s open dates.' using errcode = 'MLPO1';
    end if;
    if new.days_of_week is not null and array_position(new.days_of_week, null) is null then
      new.days_of_week := array(select distinct d from unnest(new.days_of_week) d order by d);
    end if;
    return new;
  end if;

  if (
    new.id, new.organisation_id, new.post_id, new.contract_id, new.site_id, new.effective_from,
    new.days_of_week, new.start_time, new.end_time, new.required_count, new.created_at,
    new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.post_id, old.contract_id, old.site_id, old.effective_from,
    old.days_of_week, old.start_time, old.end_time, old.required_count, old.created_at,
    old.created_by
  ) then
    raise exception 'A requirement is never edited. Add a new version from a date instead.'
      using errcode = 'MLPO1';
  end if;
  if new.effective_to is distinct from old.effective_to then
    if old.effective_to is not null and old.effective_to < v_today then
      raise exception 'This requirement has ended and can''t change.' using errcode = 'MLPO1';
    end if;
    if new.effective_to is null or new.effective_to < v_today - 1 then
      raise exception 'A requirement closes from yesterday at the earliest.' using errcode = 'MLPO1';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.roster_requirements_guard() from public, anon, authenticated;

create trigger roster_requirements_guard
  before insert or update or delete on public.roster_requirements
  for each row execute function private.roster_requirements_guard();
create trigger roster_requirements_set_updated_at before update on public.roster_requirements
  for each row execute function private.set_updated_at();
create trigger roster_requirements_audit
  after insert or update or delete on public.roster_requirements
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants (docs/PHASE_2.md "Roles")
-- ---------------------------------------------------------------------------
-- Read by every manager role (rosters are built by ops and line managers in Phase 3). No
-- write grants at all: only activate_contract, end_contract and the 2.8 functions write them.

alter table public.posts enable row level security;
alter table public.roster_requirements enable row level security;

create policy posts_select on public.posts for select to authenticated
  using (private.has_role(
    organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
  ));
create policy roster_requirements_select on public.roster_requirements for select to authenticated
  using (private.has_role(
    organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
  ));

revoke all on table public.posts from anon, authenticated;
revoke all on table public.roster_requirements from anon, authenticated;
grant select on table public.posts to authenticated;
grant select on table public.roster_requirements to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Rate cards follow the posts (replaces the 2.4 placeholder)
-- ---------------------------------------------------------------------------

-- The rate keys of the contract's posts that are open today or later, on contracts priced per
-- row: a rate change must keep every one of them (add_rate_card_version, MLRC5).
create or replace function private.rate_card_open_post_keys(p_organisation_id uuid, p_contract_id uuid)
returns table (role text, band text, unit text)
language sql
stable
set search_path = ''
as $$
  select distinct p.role, p.band, p.unit
  from public.posts p
  join public.contracts c on c.id = p.contract_id and c.organisation_id = p.organisation_id
  where p.organisation_id = p_organisation_id
    and p.contract_id = p_contract_id
    -- Only per-row priced contracts (as headcount_unpriced_rows): fixed_monthly and per_job
    -- bill an agreed amount, so their posts need no rate line.
    and c.type in ('manned_post', 'per_visit')
    and (p.closed_on is null or p.closed_on >= private.org_today(p_organisation_id))
$$;

revoke all on function private.rate_card_open_post_keys(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Contracts: end_contract may move a live contract's end date (replaces the 2.4 trigger)
-- ---------------------------------------------------------------------------

create or replace function private.contracts_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_next integer;
  v_ending boolean;
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

  -- end_contract (below) sets this transaction-local flag to the contract it is ending, which
  -- lets a live contract's end date come forward (never move later). Nothing a signed-in user
  -- can call sets it: set_config is not exposed through the Data API.
  v_ending := old.status = 'active'
    and coalesce(current_setting('metalira.contract_ending', true), '') = new.id::text
    and new.end_date is not null
    and (old.end_date is null or new.end_date <= old.end_date)
    -- end_reason has no column grant, so only end_contract can satisfy this as well.
    and old.end_reason is null
    and new.end_reason is not null;

  if old.status <> 'draft' and (
    new.name, new.type, new.start_date, new.billing_frequency,
    new.billing_terms_days, new.vat_applies, new.sla, new.created_at, new.created_by
  ) is distinct from (
    old.name, old.type, old.start_date, old.billing_frequency,
    old.billing_terms_days, old.vat_applies, old.sla, old.created_at, old.created_by
  ) then
    raise exception 'This contract is live and its terms can''t change.' using errcode = 'MLCO1';
  end if;
  if old.status <> 'draft' and new.end_date is distinct from old.end_date and not v_ending then
    raise exception 'This contract is live and its terms can''t change. Use End contract.'
      using errcode = 'MLCO1';
  end if;

  return new;
end;
$$;

revoke all on function private.contracts_before_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. required_shifts: what Phase 3 rosters against
-- ---------------------------------------------------------------------------

-- One row per post and date from p_from to p_to (62 days at most): the requirement in force
-- that day, when the weekday is one of its days, the post is open that day, and the contract has
-- gone live and the day is on or before its end date. A shift belongs to the day it starts; times are the
-- company's wall clock in its time zone, so a night shift ends the next morning. Read by every
-- manager role of the organisation (as posts are); anyone else gets no rows.
create function private.required_shifts(p_organisation_id uuid, p_from date, p_to date)
returns table (
  requirement_id uuid,
  post_id uuid,
  site_id uuid,
  contract_id uuid,
  post_name text,
  role text,
  band text,
  unit text,
  kind text,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  required_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a from date on or before the to date.' using errcode = '22023';
  end if;
  if p_to - p_from > 61 then
    raise exception 'Ask for 62 days or fewer at a time.' using errcode = '22023';
  end if;
  if p_organisation_id is null or not private.has_role(
    p_organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
  ) then
    return;
  end if;
  select coalesce(o.timezone, 'Africa/Lagos') into v_tz
  from public.organisations o
  where o.id = p_organisation_id;

  return query
  select r.id, p.id, p.site_id, p.contract_id, p.name, p.role, p.band, p.unit, p.kind,
    d.day,
    (d.day + r.start_time) at time zone v_tz,
    ((d.day + r.start_time) + make_interval(mins => r.duration_minutes)) at time zone v_tz,
    r.required_count
  from generate_series(p_from, p_to, interval '1 day') as g(ts)
  cross join lateral (select g.ts::date as day) d
  join public.roster_requirements r
    on r.organisation_id = p_organisation_id
    and r.effective_from <= d.day
    and (r.effective_to is null or r.effective_to >= d.day)
    and extract(isodow from d.day)::smallint = any (r.days_of_week)
  join public.posts p
    on p.id = r.post_id
    and p.opened_on <= d.day
    and (p.closed_on is null or p.closed_on >= d.day)
  join public.contracts c
    on c.id = p.contract_id
    -- Ended contracts too: the dates bound them (posts and requirements close on the end
    -- date), so a night shift on the last day and past days stay visible after the job runs.
    and c.status in ('active', 'ended')
    and (c.go_live_date is null or c.go_live_date <= d.day)
    and (c.end_date is null or c.end_date >= d.day)
  order by d.day, r.start_time, p.name, p.id;
end;
$$;

revoke all on function private.required_shifts(uuid, date, date) from public, anon;
grant execute on function private.required_shifts(uuid, date, date) to authenticated;

create function public.required_shifts(p_organisation_id uuid, p_from date, p_to date)
returns table (
  requirement_id uuid,
  post_id uuid,
  site_id uuid,
  contract_id uuid,
  post_name text,
  role text,
  band text,
  unit text,
  kind text,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  required_count integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.required_shifts(p_organisation_id, p_from, p_to)
$$;

revoke all on function public.required_shifts(uuid, date, date) from public, anon;
grant execute on function public.required_shifts(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. activate_contract
-- ---------------------------------------------------------------------------

-- What an activation created (or found, when it ran before).
create function private.contract_activation_summary(
  p_contract_id uuid,
  p_activated_now boolean,
  p_send_welcome boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'contract_id', c.id,
    'status', c.status,
    'go_live_date', c.go_live_date,
    'activated_now', p_activated_now,
    'send_welcome', p_activated_now and coalesce(p_send_welcome, false),
    'posts', (select count(*) from public.posts p where p.contract_id = c.id),
    'requirements', (
      select count(*) from public.roster_requirements r where r.contract_id = c.id
    )
  )
  from public.contracts c
  where c.id = p_contract_id
$$;

revoke all on function private.contract_activation_summary(uuid, boolean, boolean)
  from public, anon, authenticated;

-- Checks the draft, then makes it live from p_go_live_date (null: the later of the start date and
-- the company's today): status active, one post per headcount row, one roster requirement per
-- post copying the days, hours and people, from the go-live date to the end date. Owner, admin and
-- ops_manager (through private.has_role, so an untrusted session is refused). The contract row is
-- locked for update, so headcount can't change beside it (the headcount guard takes a share lock)
-- and two activations at once give one set of posts. On an active contract it changes nothing and
-- returns what is there. Returns the summary as JSON; `send_welcome` is true only on the call that
-- activated, so the welcome email goes once per contract.
create function private.activate_contract(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_go_live_date date default null,
  p_send_welcome boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_client_status text;
  v_today date;
  v_go_live date;
  v_failures jsonb := '[]'::jsonb;
  v_list text;
  v_has_card boolean;
  v_version record;
  v_posts integer;
  v_requirements integer;
begin
  if auth.uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t activate contracts.' using errcode = '42501';
  end if;

  select * into v_contract
  from public.contracts c
  where c.id = p_contract_id and c.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'That contract wasn''t found.' using errcode = 'P0002';
  end if;

  if v_contract.status = 'active' then
    return private.contract_activation_summary(p_contract_id, false, false);
  end if;
  if v_contract.status <> 'draft' then
    raise exception 'This contract has ended and can''t be activated.'
      using errcode = 'MLCT1', detail = jsonb_build_array(jsonb_build_object(
        'code', 'MLCT1', 'message', 'This contract has ended and can''t be activated.'
      ))::text;
  end if;

  v_today := private.org_today(p_organisation_id);
  v_go_live := coalesce(p_go_live_date, greatest(v_contract.start_date, v_today));

  -- MLCT7: the go-live date sits inside the contract's dates and isn't in the past.
  if v_go_live < v_contract.start_date then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT7',
      'message', 'The go-live date is before the contract starts.');
  end if;
  if v_go_live < v_today then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT7',
      'message', 'The go-live date is in the past.');
  end if;
  if v_contract.end_date is not null and v_contract.end_date < v_go_live then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT7',
      'message', 'The contract ends before the go-live date.');
  end if;

  -- MLCT2: someone to send invoices to.
  if not exists (
    select 1 from public.client_contacts k
    where k.organisation_id = p_organisation_id
      and k.client_id = v_contract.client_id
      and k.role = 'billing'
      and k.status = 'active'
      and k.email is not null
  ) then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT2',
      'message', 'The client has no billing contact. Add one with an email address.');
  end if;

  -- MLCT8: the client and every site are in use.
  select c.status into v_client_status
  from public.clients c
  where c.id = v_contract.client_id and c.organisation_id = p_organisation_id;
  if v_client_status = 'archived' then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT8',
      'message', 'The client is archived. Restore it first.');
  end if;
  select string_agg(s.name, ', ' order by s.name) into v_list
  from public.contract_sites cs
  join public.sites s on s.id = cs.site_id and s.organisation_id = cs.organisation_id
  where cs.contract_id = p_contract_id and s.status = 'archived';
  if v_list is not null then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT8',
      'message', 'Archived sites: ' || v_list || '. Restore them or take them off the contract.');
  end if;

  -- MLCT3: sites, each with a geofence.
  if not exists (select 1 from public.contract_sites cs where cs.contract_id = p_contract_id) then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT3',
      'message', 'The contract has no sites. Add at least one.');
  end if;
  select string_agg(s.name, ', ' order by s.name) into v_list
  from public.contract_sites cs
  join public.sites s on s.id = cs.site_id and s.organisation_id = cs.organisation_id
  where cs.contract_id = p_contract_id and s.geofence is null;
  if v_list is not null then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT3',
      'message', 'No geofence at ' || v_list || '. Set one on each site.');
  end if;

  -- MLCT4: a rate card in force on the go-live date.
  select exists (
    select 1 from public.rate_cards r
    where r.contract_id = p_contract_id
      and r.effective_from <= v_go_live
      and (r.effective_to is null or r.effective_to >= v_go_live)
  ) into v_has_card;
  if not v_has_card then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT4',
      'message', 'No rate card is in force on ' || to_char(v_go_live, 'FMDD Mon YYYY') || '.');
  else
    -- MLCT5: every headcount row has a matching rate line on every rate card version from the
    -- go-live date to the end (a change scheduled while the contract was a draft too: nothing
    -- re-checks it once the posts exist). Keys are written as the app writes them
    -- (formatRateKey: "Guard · Night (shift)", "Guard (shift)" for the standard band).
    for v_version in
      select greatest(r.effective_from, v_go_live) as on_date
      from public.rate_cards r
      where r.contract_id = p_contract_id
        and (r.effective_to is null or r.effective_to >= v_go_live)
        and (v_contract.end_date is null or r.effective_from <= v_contract.end_date)
      order by r.effective_from
    loop
      select string_agg(k.label, ', ' order by k.first_seen)
      into v_list
      from (
        select u.role || case when lower(u.band) = 'standard' then '' else ' · ' || u.band end
            || ' (' || u.unit || ')' as label,
          min(u.ord) as first_seen
        from private.headcount_unpriced_rows(p_organisation_id, p_contract_id, v_version.on_date)
          with ordinality as u(headcount_requirement_id, role, band, unit, ord)
        group by 1
      ) k;
      if v_list is not null then
        v_failures := v_failures || jsonb_build_object('code', 'MLCT5',
          'message', 'No rate for ' || v_list
            || case when v_version.on_date = v_go_live then ''
               else ' from ' || to_char(v_version.on_date, 'FMDD Mon YYYY') end
            || '. Add it to the rate card.');
      end if;
    end loop;
    -- MLCT9: every line in force carries a service type and WHT rate (the table guarantees it).
    if exists (
      select 1 from public.rate_cards r
      join public.rate_card_lines l on l.rate_card_id = r.id
      where r.contract_id = p_contract_id
        and r.effective_from <= v_go_live
        and (r.effective_to is null or r.effective_to >= v_go_live)
        and (l.service_type is null or l.wht_rate_bps is null)
    ) then
      v_failures := v_failures || jsonb_build_object('code', 'MLCT9',
        'message', 'A rate line has no service type or WHT rate.');
    end if;
  end if;

  -- MLCT6: a manned-post contract says who it staffs.
  if v_contract.type = 'manned_post' and not exists (
    select 1 from public.headcount_requirements h where h.contract_id = p_contract_id
  ) then
    v_failures := v_failures || jsonb_build_object('code', 'MLCT6',
      'message', 'A manned-post contract needs headcount. Add the posts first.');
  end if;

  if jsonb_array_length(v_failures) > 0 then
    select string_agg(f ->> 'message', ' ') into v_list from jsonb_array_elements(v_failures) f;
    raise exception '%', v_list
      using errcode = v_failures -> 0 ->> 'code', detail = v_failures::text;
  end if;

  update public.contracts c
  set status = 'active',
    go_live_date = v_go_live,
    activated_at = now(),
    activated_by = auth.uid()
  where c.id = p_contract_id;

  -- A fixed-term contract's last rate card version closes with it, so no version is left open
  -- past the end once the contract has ended (and can no longer be written).
  if v_contract.end_date is not null then
    update public.rate_cards r
    set effective_to = v_contract.end_date
    where r.contract_id = p_contract_id and r.effective_to is null;
  end if;

  insert into public.posts (
    organisation_id, contract_id, site_id, headcount_requirement_id, name, role, band, unit,
    opened_on
  )
  select h.organisation_id, h.contract_id, h.site_id, h.id,
    coalesce(h.post_name, h.role)
      || case when lower(h.band) = 'standard' then '' else ' · ' || h.band end,
    h.role, h.band, h.unit, v_go_live
  from public.headcount_requirements h
  where h.contract_id = p_contract_id and h.organisation_id = p_organisation_id
  order by h.created_at, h.id;
  get diagnostics v_posts = row_count;

  insert into public.roster_requirements (
    organisation_id, post_id, contract_id, site_id, effective_from, effective_to,
    days_of_week, start_time, end_time, required_count
  )
  select p.organisation_id, p.id, p.contract_id, p.site_id, v_go_live, v_contract.end_date,
    h.days_of_week, h.start_time, h.end_time, h.required_count
  from public.posts p
  join public.headcount_requirements h on h.id = p.headcount_requirement_id
  where p.contract_id = p_contract_id;
  get diagnostics v_requirements = row_count;

  perform private.log_audit_impl(
    p_organisation_id, 'contract.activated', 'contracts', p_contract_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object(
      'status', 'active', 'go_live_date', v_go_live, 'posts', v_posts,
      'requirements', v_requirements, 'send_welcome', coalesce(p_send_welcome, false)
    ),
    null
  );

  return private.contract_activation_summary(p_contract_id, true, p_send_welcome);
end;
$$;

revoke all on function private.activate_contract(uuid, uuid, date, boolean) from public, anon;
grant execute on function private.activate_contract(uuid, uuid, date, boolean) to authenticated;

create function public.activate_contract(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_go_live_date date default null,
  p_send_welcome boolean default true
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.activate_contract(p_organisation_id, p_contract_id, p_go_live_date, p_send_welcome)
$$;

revoke all on function public.activate_contract(uuid, uuid, date, boolean) from public, anon;
grant execute on function public.activate_contract(uuid, uuid, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. end_contract
-- ---------------------------------------------------------------------------

-- Ends a live contract on p_end_date (its last day of service, today or later, not before the
-- go-live date, never later than an end date already agreed). In one transaction, with the
-- contract row locked: rate card versions and roster requirements that would start after the
-- end date are cancelled (latest first), the rest are closed on it, every open post is closed on
-- it with the reason, and the contract's end date and reason are set. The status becomes `ended`
-- the day after (private.end_due_contracts, daily), so the last days are still rostered. Calling
-- it again with the same date changes nothing. Owner, admin and ops_manager.
create function private.end_contract(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_end_date date,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_today date;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_card record;
  v_cards_cancelled integer := 0;
  v_cards_closed integer;
  v_reqs_cancelled integer;
  v_reqs_closed integer;
  v_posts integer;
begin
  if auth.uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t end contracts.' using errcode = '42501';
  end if;

  select * into v_contract
  from public.contracts c
  where c.id = p_contract_id and c.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'That contract wasn''t found.' using errcode = 'P0002';
  end if;
  if v_contract.status <> 'active' then
    raise exception 'Only a live contract can be ended.' using errcode = 'MLCE1';
  end if;
  if p_end_date is null then
    raise exception 'Choose the last day of service.' using errcode = 'MLCE2';
  end if;
  if v_contract.end_reason is not null then
    if v_contract.end_date = p_end_date then
      return jsonb_build_object(
        'contract_id', p_contract_id, 'end_date', p_end_date, 'changed', false,
        'posts_closed', 0, 'requirements_closed', 0, 'requirements_cancelled', 0,
        'rate_cards_closed', 0, 'rate_cards_cancelled', 0
      );
    end if;
    raise exception 'This contract is already ending on %.', to_char(v_contract.end_date, 'FMDD Mon YYYY')
      using errcode = 'MLCE4';
  end if;

  v_today := private.org_today(p_organisation_id);
  if p_end_date < v_today then
    raise exception 'The last day of service can''t be in the past.' using errcode = 'MLCE2';
  end if;
  if p_end_date < v_contract.go_live_date then
    raise exception 'The last day of service can''t be before the go-live date.' using errcode = 'MLCE2';
  end if;
  if v_contract.end_date is not null and p_end_date > v_contract.end_date then
    raise exception 'The contract already ends on %. It can end earlier, not later.',
      to_char(v_contract.end_date, 'FMDD Mon YYYY') using errcode = 'MLCE2';
  end if;
  if char_length(v_reason) not between 1 and 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]' then
    raise exception 'Say why the contract is ending (500 characters or fewer, plain text).'
      using errcode = 'MLCE3';
  end if;

  perform set_config('metalira.contract_ending', p_contract_id::text, true);

  -- Rate cards: cancel the versions that would start after the end date, latest first (each
  -- delete reopens the one before it), then close what is left on the end date.
  for v_card in
    select r.id from public.rate_cards r
    where r.contract_id = p_contract_id and r.effective_from > p_end_date
    order by r.effective_from desc
  loop
    delete from public.rate_card_lines l where l.rate_card_id = v_card.id;
    delete from public.rate_cards r where r.id = v_card.id;
    v_cards_cancelled := v_cards_cancelled + 1;
  end loop;
  update public.rate_cards r
  set effective_to = p_end_date
  where r.contract_id = p_contract_id
    and (r.effective_to is null or r.effective_to > p_end_date);
  get diagnostics v_cards_closed = row_count;

  -- Roster requirements: the same.
  delete from public.roster_requirements r
  where r.contract_id = p_contract_id and r.effective_from > p_end_date;
  get diagnostics v_reqs_cancelled = row_count;
  update public.roster_requirements r
  set effective_to = p_end_date
  where r.contract_id = p_contract_id
    and (r.effective_to is null or r.effective_to > p_end_date);
  get diagnostics v_reqs_closed = row_count;

  -- Posts: closed on the end date (a post that would only have opened later was never staffed).
  -- The reason itself stays on the contract (readers of contracts only): posts are read by hr
  -- and line managers too.
  update public.posts p
  set status = 'closed',
    closed_on = greatest(p_end_date, p.opened_on - 1),
    closed_reason = 'Contract ended'
  where p.contract_id = p_contract_id and p.status = 'open';
  get diagnostics v_posts = row_count;

  update public.contracts c
  set end_date = p_end_date, end_reason = v_reason
  where c.id = p_contract_id;

  perform set_config('metalira.contract_ending', '', true);

  perform private.log_audit_impl(
    p_organisation_id, 'contract.ended', 'contracts', p_contract_id,
    jsonb_build_object('end_date', v_contract.end_date),
    jsonb_build_object(
      'end_date', p_end_date, 'posts_closed', v_posts, 'requirements_closed', v_reqs_closed,
      'requirements_cancelled', v_reqs_cancelled, 'rate_cards_closed', v_cards_closed,
      'rate_cards_cancelled', v_cards_cancelled
    ),
    v_reason
  );

  return jsonb_build_object(
    'contract_id', p_contract_id, 'end_date', p_end_date, 'changed', true,
    'posts_closed', v_posts, 'requirements_closed', v_reqs_closed,
    'requirements_cancelled', v_reqs_cancelled, 'rate_cards_closed', v_cards_closed,
    'rate_cards_cancelled', v_cards_cancelled
  );
end;
$$;

revoke all on function private.end_contract(uuid, uuid, date, text) from public, anon;
grant execute on function private.end_contract(uuid, uuid, date, text) to authenticated;

create function public.end_contract(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_end_date date,
  p_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.end_contract(p_organisation_id, p_contract_id, p_end_date, p_reason)
$$;

revoke all on function public.end_contract(uuid, uuid, date, text) from public, anon;
grant execute on function public.end_contract(uuid, uuid, date, text) to authenticated;

-- Daily: live contracts whose end date has passed (in the company's own calendar) become ended,
-- and posts still open on them close on the end date. Covers contracts ended with end_contract
-- and fixed-term contracts that simply ran out. Pass an organisation to run it for one company.
create function private.end_due_contracts(p_organisation_id uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    update public.contracts c
    set status = 'ended', ended_at = now()
    where c.status = 'active'
      and c.end_date is not null
      and c.end_date < private.org_today(c.organisation_id)
      and (p_organisation_id is null or c.organisation_id = p_organisation_id)
    returning c.id, c.end_date
  ), closed as (
    update public.posts p
    set status = 'closed',
      closed_on = greatest(due.end_date, p.opened_on - 1),
      closed_reason = 'Contract ended'
    from due
    where p.contract_id = due.id and p.status = 'open'
    returning p.id
  )
  select count(*) into v_count from due;
  return v_count;
end;
$$;

revoke all on function private.end_due_contracts(uuid) from public, anon, authenticated;

select cron.schedule(
  'end-due-contracts',
  '15 0 * * *',
  'select private.end_due_contracts(null)'
);

-- ---------------------------------------------------------------------------
-- 10. No new assignments to archived sites or clients (owner decision, 19 Nov 2026)
-- ---------------------------------------------------------------------------

-- BEFORE INSERT/UPDATE on worker_assignments, after worker_assignments_before_write has filled
-- the client from the site (triggers run in name order). A new row, a row whose site or client
-- changes, or a closed row whose end moves later (reopening it) can't point at an archived site
-- or client. Existing rows are otherwise left alone: closing one (effective_to) is never refused.
-- Runs as the caller (owner, admin and hr read sites and clients' status under RLS), so a row
-- aimed at another company's site learns nothing here and is refused by RLS instead.
create function private.worker_assignments_target_active()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and new.site_id is not distinct from old.site_id
    and new.client_id is not distinct from old.client_id
    and not (
      old.effective_to is not null
      and (new.effective_to is null or new.effective_to > old.effective_to)
    ) then
    return new;
  end if;
  if new.site_id is not null and exists (
    select 1 from public.sites s
    where s.id = new.site_id and s.organisation_id = new.organisation_id and s.status = 'archived'
  ) then
    raise exception 'That site is archived. Restore it before assigning people to it.'
      using errcode = 'MLAS6';
  end if;
  if new.client_id is not null and exists (
    select 1 from public.clients c
    where c.id = new.client_id and c.organisation_id = new.organisation_id and c.status = 'archived'
  ) then
    raise exception 'That client is archived. Restore it before assigning people to it.'
      using errcode = 'MLAS7';
  end if;
  return new;
end;
$$;

revoke all on function private.worker_assignments_target_active() from public, anon, authenticated;

create trigger worker_assignments_target_active
  before insert or update on public.worker_assignments
  for each row execute function private.worker_assignments_target_active();
