-- Slice 2.8: changes to a live contract.
--
-- 1. `contract_changes`: one row per change made to a live contract after activation (a post's
--    requirement changed from a date, a post added, a post closed, a site added), with the date
--    it applies from and the reason or note. Insert-only. Read by the contract readers (owner,
--    admin, finance, ops_manager) only, so the reason a post closed stays out of what hr and line
--    managers read on `posts` (as 2.7 kept the end reason on the contract).
-- 2. `change_post_requirement(org, post, from, days, start, end, count, note)`: closes the
--    version in force on the from date the day before and inserts the new one, which runs to
--    where the old one ran. A version that hasn't started yet and starts on the from date is
--    replaced instead (2.7's guard lets only such a version be removed).
-- 3. `add_post(org, contract, site, post_name, role, band, unit, from, days, start, end, count,
--    add_site, note)`: a new post with its first requirement. Its rate key must have a line on
--    every rate card version from its start (the activation rule, per-row priced contracts only).
--    A client site that isn't on the contract yet is added with it when `add_site` is set.
-- 4. `close_post(org, post, last_day, reason)`: the last day staffed (inclusive, as 2.7's
--    `closed_on`). Requirements that would start after it are removed (they haven't started),
--    the rest close on it.
-- 5. `add_contract_site(org, contract, site, note)`: a site of the client with a geofence joins a
--    live contract (the 2.4 guard now lets only this function through).
-- 6. `cancel_post_requirement_change(org, requirement, note)`: takes back a change that hasn't
--    started (the post's latest version) and runs the version before it on to where the cancelled
--    one ran.
-- 7. Replaces 2.7's posts and roster_requirements guards, end_contract and end_due_contracts so a
--    post already closed by close_post can only move EARLIER (an earlier contract end, or closing
--    a post on an ending contract sooner), and a cancelled change can reopen the version before.
--
-- Every change applies from TOMORROW at the earliest (a day already in progress is never
-- changed); a post's last day (close_post) may be today, so the close takes effect tomorrow.
--
-- Every function is a security definer checking owner, admin or ops_manager through
-- private.has_role (private.session_uid: untrusted sessions are refused), locks the contract row
-- (so it can't race end_contract, activation or a rate change), runs in one transaction, writes a
-- `contract_changes` row and an audit event, and has a public invoker wrapper. Dates are the
-- company's calendar (private.org_today). Nothing is stored about money.
--
-- Refusals (SQLSTATE), mapped to plain English in src/server/business/live-changes.ts:
--   MLPC1 contract not live (draft or ended)      MLPC2 date refused
--   MLPC3 a later change is already scheduled     MLPC4 no rate line for the post's key
--   MLPC5 site refused                            MLPC6 post already closed or closing
--   MLPC7 reason missing or not plain text        MLPC8 values refused (days, hours, people, names)
--   MLPC9 nothing changes

-- ---------------------------------------------------------------------------
-- 1. contract_changes
-- ---------------------------------------------------------------------------

create table public.contract_changes (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  contract_id uuid not null,
  post_id uuid,
  site_id uuid,
  kind text not null
    constraint contract_changes_kind_value check (
      kind in (
        'requirement_changed', 'requirement_cancelled', 'post_added', 'post_closed', 'site_added'
      )
    ),
  -- Depends on kind: the first day a requirement change, a cancelled change or a new post applies;
  -- a closed post's LAST day staffed; the day a site was added. A log for people, never a source
  -- for pricing: Phase 6 prices from posts, roster_requirements and Work Units only.
  effective_on date not null,
  reason text
    constraint contract_changes_reason_text check (
      reason = btrim(reason)
      and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
      and reason !~* '(://|www\.)'
    ),
  -- What changed, for the history (counts, days, hours; never money).
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint contract_changes_organisation_id_id_key unique (organisation_id, id),
  constraint contract_changes_contract_fkey foreign key (organisation_id, contract_id)
    references public.contracts (organisation_id, id),
  constraint contract_changes_post_fkey foreign key (organisation_id, post_id)
    references public.posts (organisation_id, id),
  constraint contract_changes_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id),
  constraint contract_changes_post_kinds check (
    (kind = 'site_added') = (post_id is null) and (kind <> 'site_added' or site_id is not null)
  ),
  constraint contract_changes_closed_reason check (kind <> 'post_closed' or reason is not null)
);

create index contract_changes_contract_idx on public.contract_changes (organisation_id, contract_id, created_at);
create index contract_changes_post_idx on public.contract_changes (post_id) where post_id is not null;

comment on table public.contract_changes is
  'Changes made to a live contract after activation, with the date they apply and the reason. Insert-only; read by owner, admin, finance and ops_manager.';

create function private.contract_changes_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Contract changes are kept as they were recorded.' using errcode = 'MLPO1';
end;
$$;

revoke all on function private.contract_changes_guard() from public, anon, authenticated;

create trigger contract_changes_guard before update or delete on public.contract_changes
  for each row execute function private.contract_changes_guard();
create trigger contract_changes_audit after insert on public.contract_changes
  for each row execute function private.audit_row_change();

alter table public.contract_changes enable row level security;

create policy contract_changes_select on public.contract_changes for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));

revoke all on table public.contract_changes from anon, authenticated;
grant select on table public.contract_changes to authenticated;

-- ---------------------------------------------------------------------------
-- 2. contract_sites: add_contract_site may add a site to a live contract (replaces 2.4's guard)
-- ---------------------------------------------------------------------------

create or replace function private.contract_sites_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_client uuid;
  v_site_client uuid;
  v_adding boolean;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Remove the site and add the right one instead.' using errcode = 'MLCO3';
  end if;

  select c.status, c.client_id into v_status, v_client
  from public.contracts c
  where c.id = coalesce(new.contract_id, old.contract_id);

  -- private.add_contract_site sets this transaction-local flag to the contract it adds a site to
  -- (inserts only; a live contract's sites are never taken off). Nothing a signed-in user can
  -- call sets it: set_config is not exposed through the Data API.
  v_adding := tg_op = 'INSERT'
    and v_status = 'active'
    and coalesce(current_setting('metalira.contract_site_adding', true), '') = new.contract_id::text;

  if v_status is distinct from 'draft' and v_status is not null and not v_adding then
    raise exception 'A live contract''s sites change through Add post or Add site only.'
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

-- ---------------------------------------------------------------------------
-- 3. Shared checks
-- ---------------------------------------------------------------------------

-- Owner, admin or ops_manager of the organisation, in a trusted session (private.has_role uses
-- private.session_uid, so an untrusted password session is refused).
create function private.require_live_change_role(p_organisation_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t change live contracts.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_live_change_role(uuid) from public, anon, authenticated;

-- Checks the caller's role and locks the live contract row. Refuses a draft or ended contract,
-- and one whose last day has passed.
create function private.lock_live_contract(p_organisation_id uuid, p_contract_id uuid)
returns public.contracts
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
begin
  perform private.require_live_change_role(p_organisation_id);
  select * into v_contract
  from public.contracts c
  where c.id = p_contract_id and c.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'That contract wasn''t found.' using errcode = 'P0002';
  end if;
  if v_contract.status = 'draft' then
    raise exception 'This contract isn''t live yet. Change its headcount instead.'
      using errcode = 'MLPC1';
  end if;
  if v_contract.status <> 'active'
    or (v_contract.end_date is not null and v_contract.end_date < private.org_today(p_organisation_id)) then
    raise exception 'This contract has ended and can''t change.' using errcode = 'MLPC1';
  end if;
  return v_contract;
end;
$$;

revoke all on function private.lock_live_contract(uuid, uuid) from public, anon, authenticated;

-- A date the change applies from: today or later, and on or before the contract's last day.
create function private.check_live_change_date(
  p_contract public.contracts,
  p_from date,
  p_what text
)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_from is null then
    raise exception 'Choose the date % starts.', p_what using errcode = 'MLPC2';
  end if;
  if p_from <= private.org_today(p_contract.organisation_id) then
    raise exception 'A change to a live contract starts tomorrow or later.' using errcode = 'MLPC2';
  end if;
  if p_from < p_contract.go_live_date then
    raise exception 'The contract goes live on %. Choose that day or later.',
      to_char(p_contract.go_live_date, 'FMDD Mon YYYY') using errcode = 'MLPC2';
  end if;
  if p_contract.end_date is not null and p_from > p_contract.end_date then
    raise exception 'The contract ends on %. Choose that day or earlier.',
      to_char(p_contract.end_date, 'FMDD Mon YYYY') using errcode = 'MLPC2';
  end if;
end;
$$;

revoke all on function private.check_live_change_date(public.contracts, date, text) from public, anon, authenticated;

-- Days, hours and people of a requirement, checked with plain reasons before the table's checks.
-- Returns the days sorted, each once.
create function private.check_requirement_values(
  p_days smallint[],
  p_start time,
  p_end time,
  p_count integer
)
returns smallint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_days smallint[];
begin
  if p_days is null or cardinality(p_days) = 0 or array_position(p_days, null) is not null
    or not (p_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]) then
    raise exception 'Choose at least one day.' using errcode = 'MLPC8';
  end if;
  v_days := array(select distinct d from unnest(p_days) d order by d);
  if p_start is null or p_end is null then
    raise exception 'Choose the start and end times.' using errcode = 'MLPC8';
  end if;
  if date_part('minute', p_start)::integer % 15 <> 0 or date_part('second', p_start) <> 0
    or date_part('minute', p_end)::integer % 15 <> 0 or date_part('second', p_end) <> 0 then
    raise exception 'Times are on the quarter hour.' using errcode = 'MLPC8';
  end if;
  if p_count is null or p_count not between 1 and 200 then
    raise exception 'People required is 1 to 200.' using errcode = 'MLPC8';
  end if;
  return v_days;
end;
$$;

revoke all on function private.check_requirement_values(smallint[], time, time, integer) from public, anon, authenticated;

-- A reason or note: null when blank, else plain text of 500 characters or fewer.
create function private.check_change_reason(p_reason text, p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    if p_required then
      raise exception 'Say why.' using errcode = 'MLPC7';
    end if;
    return null;
  end if;
  if char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v_reason ~* '(://|www\.)' then
    raise exception 'Keep it to 500 characters of plain text, without web addresses.'
      using errcode = 'MLPC7';
  end if;
  return v_reason;
end;
$$;

revoke all on function private.check_change_reason(text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. add_contract_site
-- ---------------------------------------------------------------------------

-- Adds a site to a locked live contract (the caller has checked the role and locked it): the
-- site belongs to the contract's client, is in use and has a geofence (as activation requires).
create function private.add_contract_site_locked(
  p_contract public.contracts,
  p_site_id uuid,
  p_note text
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_site record;
  v_client_status text;
begin
  select s.id, s.name, s.client_id, s.status, s.geofence is not null as fenced into v_site
  from public.sites s
  where s.id = p_site_id and s.organisation_id = p_contract.organisation_id;
  if v_site.id is null then
    raise exception 'That site wasn''t found.' using errcode = 'MLPC5';
  end if;
  if v_site.client_id is distinct from p_contract.client_id then
    raise exception 'That site belongs to another client.' using errcode = 'MLPC5';
  end if;
  select c.status into v_client_status from public.clients c where c.id = p_contract.client_id;
  if v_client_status = 'archived' then
    raise exception 'The client is archived. Restore it first.' using errcode = 'MLPC5';
  end if;
  if v_site.status = 'archived' then
    raise exception '% is archived. Restore it first.', v_site.name using errcode = 'MLPC5';
  end if;
  if not v_site.fenced then
    raise exception 'No geofence at %. Set one on the site first.', v_site.name using errcode = 'MLPC5';
  end if;
  if exists (
    select 1 from public.contract_sites cs
    where cs.contract_id = p_contract.id and cs.site_id = p_site_id
  ) then
    raise exception '% is already on this contract.', v_site.name using errcode = 'MLPC5';
  end if;

  perform set_config('metalira.contract_site_adding', p_contract.id::text, true);
  insert into public.contract_sites (organisation_id, contract_id, site_id)
  values (p_contract.organisation_id, p_contract.id, p_site_id);
  perform set_config('metalira.contract_site_adding', '', true);

  insert into public.contract_changes (
    organisation_id, contract_id, site_id, kind, effective_on, reason, detail
  )
  values (
    p_contract.organisation_id, p_contract.id, p_site_id, 'site_added',
    private.org_today(p_contract.organisation_id), p_note, jsonb_build_object('site', v_site.name)
  );
  perform private.log_audit_impl(
    p_contract.organisation_id, 'contract.site_added', 'contracts', p_contract.id,
    null, jsonb_build_object('site_id', p_site_id, 'site', v_site.name), p_note
  );
end;
$$;

revoke all on function private.add_contract_site_locked(public.contracts, uuid, text) from public, anon, authenticated;

create function private.add_contract_site(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_site_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_note text;
begin
  v_contract := private.lock_live_contract(p_organisation_id, p_contract_id);
  v_note := private.check_change_reason(p_note, false);
  perform private.add_contract_site_locked(v_contract, p_site_id, v_note);
  return jsonb_build_object('contract_id', p_contract_id, 'site_id', p_site_id);
end;
$$;

revoke all on function private.add_contract_site(uuid, uuid, uuid, text) from public, anon;
grant execute on function private.add_contract_site(uuid, uuid, uuid, text) to authenticated;

create function public.add_contract_site(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_site_id uuid,
  p_note text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_contract_site(p_organisation_id, p_contract_id, p_site_id, p_note)
$$;

revoke all on function public.add_contract_site(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.add_contract_site(uuid, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. change_post_requirement
-- ---------------------------------------------------------------------------

-- "Change headcount from": the post's requirement from p_from is the given days, hours and
-- people. The version in force on p_from closes the day before (or, when it hasn't started and
-- starts on p_from, is replaced), and the new one runs to where it ran. Refused when a change is
-- already scheduled after p_from, when nothing changes, and outside the post's open dates.
create function private.change_post_requirement(
  p_organisation_id uuid,
  p_post_id uuid,
  p_from date,
  p_days smallint[],
  p_start time,
  p_end time,
  p_count integer,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract_id uuid;
  v_contract public.contracts%rowtype;
  v_post public.posts%rowtype;
  v_current public.roster_requirements%rowtype;
  v_today date;
  v_days smallint[];
  v_note text;
  v_later date;
  v_new uuid;
  v_closed uuid;
  v_replaced uuid;
begin
  select p.contract_id into v_contract_id
  from public.posts p
  where p.id = p_post_id and p.organisation_id = p_organisation_id;
  -- Role first, so a caller without it learns nothing about the post.
  perform private.require_live_change_role(p_organisation_id);
  if v_contract_id is null then
    raise exception 'That post wasn''t found.' using errcode = 'P0002';
  end if;
  v_contract := private.lock_live_contract(p_organisation_id, v_contract_id);
  select * into v_post from public.posts p where p.id = p_post_id for update;
  v_today := private.org_today(p_organisation_id);

  perform private.check_live_change_date(v_contract, p_from, 'the change');
  if p_from < v_post.opened_on then
    raise exception 'This post opens on %. Change it from that day or later.',
      to_char(v_post.opened_on, 'FMDD Mon YYYY') using errcode = 'MLPC2';
  end if;
  if v_post.closed_on is not null and p_from > v_post.closed_on then
    raise exception 'This post closes after %. Changes after that day can''t be made.',
      to_char(v_post.closed_on, 'FMDD Mon YYYY') using errcode = 'MLPC6';
  end if;
  v_days := private.check_requirement_values(p_days, p_start, p_end, p_count);
  v_note := private.check_change_reason(p_note, false);

  select min(r.effective_from) into v_later
  from public.roster_requirements r
  where r.post_id = p_post_id and r.effective_from > p_from;
  if v_later is not null then
    raise exception 'A change is already scheduled from %. Choose that day or later.',
      to_char(v_later, 'FMDD Mon YYYY') using errcode = 'MLPC3';
  end if;

  select * into v_current
  from public.roster_requirements r
  where r.post_id = p_post_id
    and r.effective_from <= p_from
    and (r.effective_to is null or r.effective_to >= p_from);
  if v_current.id is null then
    raise exception 'This post has no requirement on %.', to_char(p_from, 'FMDD Mon YYYY')
      using errcode = 'MLPC2';
  end if;
  if (v_current.days_of_week, v_current.start_time, v_current.end_time, v_current.required_count)
    = (v_days, p_start, p_end, p_count) then
    raise exception 'Nothing changes: the post already needs that from %.',
      to_char(p_from, 'FMDD Mon YYYY') using errcode = 'MLPC9';
  end if;

  if v_current.effective_from = p_from then
    -- Not started yet (p_from is tomorrow or later): replaced (the audit trigger keeps the before).
    delete from public.roster_requirements r where r.id = v_current.id;
    v_replaced := v_current.id;
  else
    update public.roster_requirements r
    set effective_to = p_from - 1
    where r.id = v_current.id;
    v_closed := v_current.id;
  end if;

  insert into public.roster_requirements (
    organisation_id, post_id, contract_id, site_id, effective_from, effective_to,
    days_of_week, start_time, end_time, required_count
  )
  values (
    p_organisation_id, p_post_id, v_post.contract_id, v_post.site_id, p_from,
    v_current.effective_to, v_days, p_start, p_end, p_count
  )
  returning id into v_new;

  insert into public.contract_changes (
    organisation_id, contract_id, post_id, site_id, kind, effective_on, reason, detail
  )
  values (
    p_organisation_id, v_post.contract_id, p_post_id, v_post.site_id, 'requirement_changed',
    p_from, v_note,
    jsonb_build_object(
      'before', jsonb_build_object(
        'days', v_current.days_of_week, 'start', v_current.start_time,
        'end', v_current.end_time, 'count', v_current.required_count
      ),
      'after', jsonb_build_object('days', v_days, 'start', p_start, 'end', p_end, 'count', p_count),
      'replaced', v_replaced is not null
    )
  );
  perform private.log_audit_impl(
    p_organisation_id, 'post.requirement_changed', 'posts', p_post_id,
    jsonb_build_object(
      'requirement_id', v_current.id, 'effective_from', v_current.effective_from,
      'effective_to', v_current.effective_to, 'days', v_current.days_of_week,
      'start', v_current.start_time, 'end', v_current.end_time,
      'count', v_current.required_count
    ),
    jsonb_build_object(
      'requirement_id', v_new, 'effective_from', p_from, 'effective_to', v_current.effective_to,
      'days', v_days, 'start', p_start, 'end', p_end, 'count', p_count,
      'replaced', v_replaced is not null
    ),
    v_note
  );

  return jsonb_build_object(
    'post_id', p_post_id, 'requirement_id', v_new, 'closed_id', v_closed,
    'replaced_id', v_replaced, 'effective_from', p_from, 'effective_to', v_current.effective_to
  );
end;
$$;

revoke all on function private.change_post_requirement(uuid, uuid, date, smallint[], time, time, integer, text)
  from public, anon;
grant execute on function private.change_post_requirement(uuid, uuid, date, smallint[], time, time, integer, text)
  to authenticated;

create function public.change_post_requirement(
  p_organisation_id uuid,
  p_post_id uuid,
  p_from date,
  p_days smallint[],
  p_start time,
  p_end time,
  p_count integer,
  p_note text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.change_post_requirement(
    p_organisation_id, p_post_id, p_from, p_days, p_start, p_end, p_count, p_note
  )
$$;

revoke all on function public.change_post_requirement(uuid, uuid, date, smallint[], time, time, integer, text)
  from public, anon;
grant execute on function public.change_post_requirement(uuid, uuid, date, smallint[], time, time, integer, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6. add_post
-- ---------------------------------------------------------------------------

-- A new post on a live contract from p_from with its first requirement. On contracts priced per
-- row (manned_post, per_visit) its rate key needs a line on the version in force on p_from and on
-- every later version up to the end (as activation's MLCT5). Its name is the post name (or the
-- role) and the band unless standard, unique among the open posts at the site.
create function private.add_post(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_site_id uuid,
  p_post_name text,
  p_role text,
  p_band text,
  p_unit text,
  p_from date,
  p_days smallint[],
  p_start time,
  p_end time,
  p_count integer,
  p_add_site boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_post_name text := nullif(btrim(coalesce(p_post_name, '')), '');
  v_role text := btrim(coalesce(p_role, ''));
  v_band text := coalesce(nullif(btrim(coalesce(p_band, '')), ''), 'standard');
  v_name text;
  v_label text;
  v_days smallint[];
  v_note text;
  v_site record;
  v_site_added boolean := false;
  v_version record;
  v_post uuid;
  v_requirement uuid;
begin
  v_contract := private.lock_live_contract(p_organisation_id, p_contract_id);
  perform private.check_live_change_date(v_contract, p_from, 'the post');
  v_days := private.check_requirement_values(p_days, p_start, p_end, p_count);
  v_note := private.check_change_reason(p_note, false);

  if char_length(v_role) not between 1 and 80 or v_role ~ '[\x01-\x1f\x7f-\x9f<>]' then
    raise exception 'Name the role (80 characters or fewer, plain text).' using errcode = 'MLPC8';
  end if;
  if char_length(v_band) > 40 or v_band ~ '[\x01-\x1f\x7f-\x9f<>]' then
    raise exception 'Keep the band to 40 characters of plain text.' using errcode = 'MLPC8';
  end if;
  if v_post_name is not null and (
    char_length(v_post_name) > 80 or v_post_name ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v_post_name ~* '(://|www\.)'
  ) then
    raise exception 'Keep the post name to 80 characters of plain text.' using errcode = 'MLPC8';
  end if;
  if p_unit is null or p_unit not in ('shift', 'hour', 'visit') then
    raise exception 'Choose how the post is billed: per shift, hour or visit.' using errcode = 'MLPC8';
  end if;
  v_name := coalesce(v_post_name, v_role)
    || case when private.rate_key_part(v_band) = 'standard' then '' else ' · ' || v_band end;
  v_label := v_role || case when private.rate_key_part(v_band) = 'standard' then '' else ' · ' || v_band end
    || ' (' || p_unit || ')';

  -- The site: on the contract already, or one of the client's sites added with the post.
  select s.id, s.name, s.status, s.geofence is not null as fenced into v_site
  from public.sites s
  where s.id = p_site_id and s.organisation_id = p_organisation_id;
  if v_site.id is null then
    raise exception 'That site wasn''t found.' using errcode = 'MLPC5';
  end if;
  if not exists (
    select 1 from public.contract_sites cs
    where cs.contract_id = p_contract_id and cs.site_id = p_site_id
  ) then
    if not coalesce(p_add_site, false) then
      raise exception '% isn''t on this contract. Add it with the post.', v_site.name
        using errcode = 'MLPC5';
    end if;
    perform private.add_contract_site_locked(v_contract, p_site_id, v_note);
    v_site_added := true;
  else
    if exists (
      select 1 from public.clients c where c.id = v_contract.client_id and c.status = 'archived'
    ) then
      raise exception 'The client is archived. Restore it first.' using errcode = 'MLPC5';
    end if;
    if v_site.status = 'archived' then
      raise exception '% is archived. Restore it first.', v_site.name using errcode = 'MLPC5';
    end if;
    if not v_site.fenced then
      raise exception 'No geofence at %. Set one on the site first.', v_site.name
        using errcode = 'MLPC5';
    end if;
  end if;

  if exists (
    -- Any post at the site still staffed on or after the new one's first day (open, or closing
    -- later), compared as rate keys are (2.7's MLCT6 rule).
    select 1 from public.posts p
    where p.contract_id = p_contract_id and p.site_id = p_site_id
      and (p.closed_on is null or p.closed_on >= p_from)
      and private.rate_key_part(p.name) = private.rate_key_part(v_name)
  ) then
    raise exception 'There''s already a post called % at % on or after that day.', v_name, v_site.name
      using errcode = 'MLPC8';
  end if;

  -- A rate card in force on the first day, and (priced per row) the key on every version.
  if not exists (
    select 1 from public.rate_cards r
    where r.contract_id = p_contract_id
      and r.effective_from <= p_from
      and (r.effective_to is null or r.effective_to >= p_from)
  ) then
    raise exception 'No rate card is in force on %.', to_char(p_from, 'FMDD Mon YYYY')
      using errcode = 'MLPC4';
  end if;
  if v_contract.type in ('manned_post', 'per_visit') then
    for v_version in
      select r.id, greatest(r.effective_from, p_from) as on_date
      from public.rate_cards r
      where r.contract_id = p_contract_id
        and (r.effective_to is null or r.effective_to >= p_from)
        and (v_contract.end_date is null or r.effective_from <= v_contract.end_date)
      order by r.effective_from
    loop
      if not exists (
        select 1 from public.rate_card_lines l
        where l.rate_card_id = v_version.id
          and private.rate_key_part(l.role) = private.rate_key_part(v_role)
          and coalesce(nullif(private.rate_key_part(l.band), ''), 'standard')
            = coalesce(nullif(private.rate_key_part(v_band), ''), 'standard')
          and l.unit = p_unit
      ) then
        raise exception '%', 'No rate for ' || v_label
          || case when v_version.on_date = p_from then ''
             else ' from ' || to_char(v_version.on_date, 'FMDD Mon YYYY') end
          || '. Add it to the rate card first.'
          using errcode = 'MLPC4';
      end if;
    end loop;
  end if;

  insert into public.posts (
    organisation_id, contract_id, site_id, name, role, band, unit, opened_on
  )
  values (p_organisation_id, p_contract_id, p_site_id, v_name, v_role, v_band, p_unit, p_from)
  returning id into v_post;

  insert into public.roster_requirements (
    organisation_id, post_id, contract_id, site_id, effective_from, effective_to,
    days_of_week, start_time, end_time, required_count
  )
  values (
    p_organisation_id, v_post, p_contract_id, p_site_id, p_from, v_contract.end_date,
    v_days, p_start, p_end, p_count
  )
  returning id into v_requirement;

  -- A contract already ending (end_contract closed its posts) closes this one with it.
  if v_contract.end_reason is not null then
    update public.posts p
    set status = 'closed', closed_on = v_contract.end_date, closed_reason = 'Contract ended'
    where p.id = v_post;
  end if;

  insert into public.contract_changes (
    organisation_id, contract_id, post_id, site_id, kind, effective_on, reason, detail
  )
  values (
    p_organisation_id, p_contract_id, v_post, p_site_id, 'post_added', p_from, v_note,
    jsonb_build_object(
      'name', v_name, 'days', v_days, 'start', p_start, 'end', p_end, 'count', p_count,
      'site_added', v_site_added
    )
  );
  perform private.log_audit_impl(
    p_organisation_id, 'post.added', 'posts', v_post, null,
    jsonb_build_object(
      'contract_id', p_contract_id, 'site_id', p_site_id, 'name', v_name, 'role', v_role,
      'band', v_band, 'unit', p_unit, 'opened_on', p_from, 'days', v_days, 'start', p_start,
      'end', p_end, 'count', p_count, 'site_added', v_site_added
    ),
    v_note
  );

  return jsonb_build_object(
    'post_id', v_post, 'requirement_id', v_requirement, 'name', v_name,
    'opened_on', p_from, 'site_added', v_site_added
  );
end;
$$;

revoke all on function private.add_post(
  uuid, uuid, uuid, text, text, text, text, date, smallint[], time, time, integer, boolean, text
) from public, anon;
grant execute on function private.add_post(
  uuid, uuid, uuid, text, text, text, text, date, smallint[], time, time, integer, boolean, text
) to authenticated;

create function public.add_post(
  p_organisation_id uuid,
  p_contract_id uuid,
  p_site_id uuid,
  p_post_name text,
  p_role text,
  p_band text,
  p_unit text,
  p_from date,
  p_days smallint[],
  p_start time,
  p_end time,
  p_count integer,
  p_add_site boolean default false,
  p_note text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.add_post(
    p_organisation_id, p_contract_id, p_site_id, p_post_name, p_role, p_band, p_unit, p_from,
    p_days, p_start, p_end, p_count, p_add_site, p_note
  )
$$;

revoke all on function public.add_post(
  uuid, uuid, uuid, text, text, text, text, date, smallint[], time, time, integer, boolean, text
) from public, anon;
grant execute on function public.add_post(
  uuid, uuid, uuid, text, text, text, text, date, smallint[], time, time, integer, boolean, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. close_post
-- ---------------------------------------------------------------------------

-- Closes a post after p_last_day (its last day staffed, today or later; the day before it opens
-- for a post that hasn't opened, meaning never staffed). Requirements that would start after
-- the last day are removed (none has started), the rest close on it. The post's own reason is
-- the plain "Post closed" (posts are read by hr and line managers); the reason given is kept on
-- contract_changes and in the audit log.
create function private.close_post(
  p_organisation_id uuid,
  p_post_id uuid,
  p_last_day date,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract_id uuid;
  v_contract public.contracts%rowtype;
  v_post public.posts%rowtype;
  v_today date;
  v_reason text;
  v_cancelled integer;
  v_closed integer;
begin
  select p.contract_id into v_contract_id
  from public.posts p
  where p.id = p_post_id and p.organisation_id = p_organisation_id;
  -- Role first, so a caller without it learns nothing about the post.
  perform private.require_live_change_role(p_organisation_id);
  if v_contract_id is null then
    raise exception 'That post wasn''t found.' using errcode = 'P0002';
  end if;
  v_contract := private.lock_live_contract(p_organisation_id, v_contract_id);
  select * into v_post from public.posts p where p.id = p_post_id for update;
  v_today := private.org_today(p_organisation_id);

  -- A post already closing (close_post, or an ending contract) can close sooner, never later.
  if v_post.status = 'closed' and (
    v_post.closed_on < v_today or p_last_day is null or p_last_day >= v_post.closed_on
  ) then
    raise exception 'This post already closes after %.%', to_char(v_post.closed_on, 'FMDD Mon YYYY'),
      case when v_post.closed_on >= v_today then ' Choose an earlier day to close it sooner.' else '' end
      using errcode = 'MLPC6';
  end if;
  if p_last_day is null then
    raise exception 'Choose the last day the post is staffed.' using errcode = 'MLPC2';
  end if;
  if p_last_day < v_today then
    raise exception 'The last day can''t be in the past.' using errcode = 'MLPC2';
  end if;
  if p_last_day < v_post.opened_on - 1 then
    raise exception 'This post opens on %. Its last day can''t be before that.',
      to_char(v_post.opened_on, 'FMDD Mon YYYY') using errcode = 'MLPC2';
  end if;
  if v_contract.end_date is not null and p_last_day >= v_contract.end_date then
    raise exception 'The contract ends on %, and the post closes with it. Choose an earlier day.',
      to_char(v_contract.end_date, 'FMDD Mon YYYY') using errcode = 'MLPC2';
  end if;
  v_reason := private.check_change_reason(p_reason, true);

  perform set_config('metalira.post_closing', p_post_id::text, true);
  delete from public.roster_requirements r
  where r.post_id = p_post_id and r.effective_from > p_last_day;
  get diagnostics v_cancelled = row_count;
  update public.roster_requirements r
  set effective_to = p_last_day
  where r.post_id = p_post_id and (r.effective_to is null or r.effective_to > p_last_day);
  get diagnostics v_closed = row_count;

  update public.posts p
  set status = 'closed', closed_on = p_last_day, closed_reason = 'Post closed'
  where p.id = p_post_id;
  perform set_config('metalira.post_closing', '', true);

  insert into public.contract_changes (
    organisation_id, contract_id, post_id, site_id, kind, effective_on, reason, detail
  )
  values (
    p_organisation_id, v_post.contract_id, p_post_id, v_post.site_id, 'post_closed', p_last_day,
    v_reason,
    jsonb_build_object(
      'name', v_post.name, 'requirements_closed', v_closed, 'requirements_cancelled', v_cancelled,
      'closed_on_before', v_post.closed_on
    )
  );
  perform private.log_audit_impl(
    p_organisation_id, 'post.closed', 'posts', p_post_id,
    jsonb_build_object('status', v_post.status, 'closed_on', v_post.closed_on),
    jsonb_build_object(
      'status', 'closed', 'closed_on', p_last_day, 'requirements_closed', v_closed,
      'requirements_cancelled', v_cancelled
    ),
    v_reason
  );

  return jsonb_build_object(
    'post_id', p_post_id, 'closed_on', p_last_day, 'requirements_closed', v_closed,
    'requirements_cancelled', v_cancelled
  );
end;
$$;

revoke all on function private.close_post(uuid, uuid, date, text) from public, anon;
grant execute on function private.close_post(uuid, uuid, date, text) to authenticated;

create function public.close_post(
  p_organisation_id uuid,
  p_post_id uuid,
  p_last_day date,
  p_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.close_post(p_organisation_id, p_post_id, p_last_day, p_reason)
$$;

revoke all on function public.close_post(uuid, uuid, date, text) from public, anon;
grant execute on function public.close_post(uuid, uuid, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. cancel_post_requirement_change
-- ---------------------------------------------------------------------------

-- Takes back a requirement change that hasn't started: the post's latest version, starting
-- tomorrow or later, with a version before it ending the day before. The cancelled version is
-- removed (the audit trigger keeps it) and the version before runs on to where it ran.
create function private.cancel_post_requirement_change(
  p_organisation_id uuid,
  p_requirement_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contract_id uuid;
  v_req public.roster_requirements%rowtype;
  v_previous public.roster_requirements%rowtype;
  v_later date;
  v_note text;
begin
  perform private.require_live_change_role(p_organisation_id);
  select r.contract_id into v_contract_id
  from public.roster_requirements r
  where r.id = p_requirement_id and r.organisation_id = p_organisation_id;
  if v_contract_id is null then
    raise exception 'That requirement wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.lock_live_contract(p_organisation_id, v_contract_id);
  select * into v_req from public.roster_requirements r where r.id = p_requirement_id;
  perform 1 from public.posts p where p.id = v_req.post_id for update;
  v_note := private.check_change_reason(p_note, false);

  if v_req.effective_from <= private.org_today(p_organisation_id) then
    raise exception 'This change has started and can''t be cancelled. Change the post again from a later day.'
      using errcode = 'MLPC2';
  end if;
  select min(r.effective_from) into v_later
  from public.roster_requirements r
  where r.post_id = v_req.post_id and r.effective_from > v_req.effective_from;
  if v_later is not null then
    raise exception 'A later change is scheduled from %. Cancel that one first.',
      to_char(v_later, 'FMDD Mon YYYY') using errcode = 'MLPC3';
  end if;
  select * into v_previous
  from public.roster_requirements r
  where r.post_id = v_req.post_id and r.effective_to = v_req.effective_from - 1;
  if v_previous.id is null then
    raise exception 'This is the post''s first requirement. Close the post instead.'
      using errcode = 'MLPC3';
  end if;

  delete from public.roster_requirements r where r.id = v_req.id;
  perform set_config('metalira.requirement_reopening', v_req.post_id::text, true);
  update public.roster_requirements r
  set effective_to = v_req.effective_to
  where r.id = v_previous.id;
  perform set_config('metalira.requirement_reopening', '', true);

  insert into public.contract_changes (
    organisation_id, contract_id, post_id, site_id, kind, effective_on, reason, detail
  )
  values (
    p_organisation_id, v_req.contract_id, v_req.post_id, v_req.site_id, 'requirement_cancelled',
    v_req.effective_from, v_note,
    jsonb_build_object(
      'before', jsonb_build_object(
        'days', v_req.days_of_week, 'start', v_req.start_time, 'end', v_req.end_time,
        'count', v_req.required_count
      ),
      'after', jsonb_build_object(
        'days', v_previous.days_of_week, 'start', v_previous.start_time,
        'end', v_previous.end_time, 'count', v_previous.required_count
      )
    )
  );
  perform private.log_audit_impl(
    p_organisation_id, 'post.requirement_change_cancelled', 'posts', v_req.post_id,
    jsonb_build_object(
      'requirement_id', v_req.id, 'effective_from', v_req.effective_from,
      'effective_to', v_req.effective_to, 'days', v_req.days_of_week, 'start', v_req.start_time,
      'end', v_req.end_time, 'count', v_req.required_count,
      'previous_effective_to', v_previous.effective_to
    ),
    jsonb_build_object('requirement_id', v_previous.id, 'effective_to', v_req.effective_to),
    v_note
  );

  return jsonb_build_object(
    'post_id', v_req.post_id, 'cancelled_id', v_req.id, 'restored_id', v_previous.id,
    'effective_from', v_req.effective_from, 'effective_to', v_req.effective_to
  );
end;
$$;

revoke all on function private.cancel_post_requirement_change(uuid, uuid, text) from public, anon;
grant execute on function private.cancel_post_requirement_change(uuid, uuid, text) to authenticated;

create function public.cancel_post_requirement_change(
  p_organisation_id uuid,
  p_requirement_id uuid,
  p_note text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.cancel_post_requirement_change(p_organisation_id, p_requirement_id, p_note)
$$;

revoke all on function public.cancel_post_requirement_change(uuid, uuid, text) from public, anon;
grant execute on function public.cancel_post_requirement_change(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. 2.7's guards and ending, replaced: a closed post only moves EARLIER
-- ---------------------------------------------------------------------------

-- As 2.7, plus: a closed post's last day may move EARLIER (never later, never reopening), and
-- only inside end_contract or end_due_contracts (flag `metalira.contract_ending`: the contract,
-- or '*' for the daily job) or close_post (flag `metalira.post_closing`: the post, and the new
-- last day is today or later). Nothing a signed-in user can call sets these flags: set_config is
-- not exposed through the Data API.
create or replace function private.posts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_start date;
  v_end date;
  v_ending text := coalesce(current_setting('metalira.contract_ending', true), '');
  v_closing text := coalesce(current_setting('metalira.post_closing', true), '');
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
    if new.status = 'closed' and new.closed_on < old.closed_on and (
      v_ending in (new.contract_id::text, '*')
      or (v_closing = new.id::text and new.closed_on >= private.org_today(new.organisation_id))
    ) then
      return new;
    end if;
    raise exception 'This post is closed and posts don''t reopen.' using errcode = 'MLPO1';
  end if;
  return new;
end;
$$;

revoke all on function private.posts_guard() from public, anon, authenticated;

-- As 2.7, plus: inside cancel_post_requirement_change (flag `metalira.requirement_reopening`,
-- the post) the version before a cancelled change may run on later again (to the cancelled
-- version's end, or open), still inside the post's dates.
create or replace function private.roster_requirements_guard()
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
    if coalesce(current_setting('metalira.requirement_reopening', true), '') = new.post_id::text
      and (new.effective_to is null or new.effective_to > old.effective_to) then
      if v_closed is not null and coalesce(new.effective_to, 'infinity') > v_closed then
        raise exception 'A requirement sits inside its post''s open dates.' using errcode = 'MLPO1';
      end if;
      return new;
    end if;
    if new.effective_to is null or new.effective_to < v_today - 1 then
      raise exception 'A requirement closes from yesterday at the earliest.' using errcode = 'MLPO1';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.roster_requirements_guard() from public, anon, authenticated;

create or replace function private.end_contract(
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
  v_moved integer;
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

  -- Slice 2.8: posts already closed (close_post) on a day after the end date close on it too, so
  -- no post stays staffed past the contract's end. Moving a closed post's last day EARLIER is
  -- allowed only under this function's flag (posts_guard).
  update public.posts p
  set closed_on = greatest(p_end_date, p.opened_on - 1)
  where p.contract_id = p_contract_id and p.status = 'closed' and p.closed_on > p_end_date;
  get diagnostics v_moved = row_count;
  v_posts := v_posts + v_moved;

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


-- As 2.7, plus posts already closed on a day after the end date close on it (the same rule as
-- end_contract; flag '*' for the posts guard).
create or replace function private.end_due_contracts(p_organisation_id uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform set_config('metalira.contract_ending', '*', true);
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
  ), moved as (
    update public.posts p
    set closed_on = greatest(due.end_date, p.opened_on - 1)
    from due
    where p.contract_id = due.id and p.status = 'closed' and p.closed_on > due.end_date
    returning p.id
  )
  select count(*) into v_count from due;
  perform set_config('metalira.contract_ending', '', true);
  return v_count;
end;
$$;

revoke all on function private.end_due_contracts(uuid) from public, anon, authenticated;
