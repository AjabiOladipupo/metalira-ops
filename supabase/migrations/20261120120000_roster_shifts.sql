-- Slice 3.2: the roster grid. Who works which post on which day.
--
-- 1. `shifts`: one row per post and day, made the first time someone is assigned to that
--    post-day (`private.materialise_shift`). The times and the people required are copied from
--    the roster requirement in force that day, as they were then. Unique on (post, day).
-- 2. `shift_assignments`: one worker on one shift, with the shift's start and end copied, so a
--    GiST exclusion refuses two overlapping assignments for one worker (an overnight shift
--    included). Never deleted: removal is a status change with who, when and an optional reason.
-- 3. `assign_worker_to_shift`, `remove_assignment` and `copy_last_week` (with a dry run for the
--    preview), owner, admin and ops_manager, trusted sessions only (private.has_role).
--
-- Later requirement changes (2.8) and shift rows. A shift row keeps the times and count from
-- when it was made; the roster never trusts them afterwards. Every check and every screen reads
-- the requirement in force that day (`private.post_day_requirement`, the rule
-- `required_shifts` uses) at the time it runs: an assignment is refused when the post-day is no
-- longer staffed or already has as many people as the requirement now asks for, and the grid
-- shows the live count beside who is assigned, with a "Hours changed" note when an assignment's
-- copied times differ from today's requirement. We chose recompute-at-read over marking rows
-- stale because requirements change only through dated versions (2.8, from tomorrow at the
-- earliest), so the live answer is always one cheap lookup away; a stale flag would need a write
-- into this table from every 2.8 function and could still drift. When a requirement version
-- that hasn't started is removed (2.8 replaces or cancels it, or a post closes), the shift's
-- `requirement_id` is set to null by its foreign key and nothing else changes.
--
-- What is refused (SQLSTATE, mapped to plain English in src/server/workforce/roster.ts):
--   MLRS1 the post isn't staffed that day (no requirement, closed post, contract not live)
--   MLRS2 the worker has left, or hasn't started, by that day
--   MLRS3 the site is archived
--   MLRS4 the shift already has the people it needs (no override: keep it simple)
--   MLRS5 the worker is already on an overlapping shift (also 23P01 from the exclusion)
--   MLRS6 the day has passed (assigning and removing)
--   MLRS7 the worker is already on this shift
--   MLRS8 the assignment was already removed
--   MLRS9 the shift was cancelled
--   MLRS0 the reason isn't plain text (500 characters, no web addresses)
--
-- Workers not mapped to the site are allowed; the screen flags them. Leave blocking comes with
-- Phase 4. `roster_publications` is left to slice 3.3, which builds publishing.
-- Nothing here stores money.

-- ---------------------------------------------------------------------------
-- 1. The requirement in force for one post on one day
-- ---------------------------------------------------------------------------

-- One row (or none) with the requirement in force for a post on a day, by the same rule as
-- private.required_shifts: the weekday is one of its days, the post is open that day, and the
-- contract has gone live and the day is on or before its end date. Times are the company's wall
-- clock; a shift belongs to the day it starts. No role check: only the definers below call it.
create function private.post_day_requirement(p_organisation_id uuid, p_post_id uuid, p_date date)
returns table (
  requirement_id uuid,
  post_id uuid,
  site_id uuid,
  contract_id uuid,
  post_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  required_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, p.id, p.site_id, p.contract_id, p.name,
    (p_date + r.start_time) at time zone tz.zone,
    ((p_date + r.start_time) + make_interval(mins => r.duration_minutes)) at time zone tz.zone,
    r.required_count
  from public.posts p
  join public.roster_requirements r
    on r.post_id = p.id
    and r.organisation_id = p.organisation_id
    and r.effective_from <= p_date
    and (r.effective_to is null or r.effective_to >= p_date)
    and extract(isodow from p_date)::smallint = any (r.days_of_week)
  join public.contracts c
    on c.id = p.contract_id
    and c.status in ('active', 'ended')
    and (c.go_live_date is null or c.go_live_date <= p_date)
    and (c.end_date is null or c.end_date >= p_date)
  cross join lateral (
    select coalesce(
      (select o.timezone from public.organisations o where o.id = p_organisation_id),
      'Africa/Lagos'
    ) as zone
  ) tz
  where p.organisation_id = p_organisation_id
    and p.id = p_post_id
    and p.opened_on <= p_date
    and (p.closed_on is null or p.closed_on >= p_date)
$$;

revoke all on function private.post_day_requirement(uuid, uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. shifts
-- ---------------------------------------------------------------------------

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  post_id uuid not null,
  contract_id uuid not null,
  site_id uuid not null,
  -- The requirement in force when the row was made. Null once that version was removed before
  -- it started (2.8); the roster reads the live requirement anyway (see the header).
  requirement_id uuid,
  shift_date date not null,
  -- Copied from the requirement when the row was made (company time zone; a night shift ends
  -- the next day).
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  required_count integer not null
    constraint shifts_required_count_range check (required_count between 1 and 200),
  status text not null default 'open'
    constraint shifts_status_value check (status in ('open', 'cancelled')),
  -- Phase 4 ties each shift-post to its Work Unit.
  work_unit_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint shifts_organisation_id_id_key unique (organisation_id, id),
  -- Assignments copy the site and day; this key lets them point at all three.
  constraint shifts_org_id_site_date_key unique (organisation_id, id, site_id, shift_date),
  constraint shifts_post_day_key unique (post_id, shift_date),
  constraint shifts_post_fkey foreign key (organisation_id, post_id, contract_id, site_id)
    references public.posts (organisation_id, id, contract_id, site_id),
  constraint shifts_requirement_fkey foreign key (organisation_id, requirement_id)
    references public.roster_requirements (organisation_id, id)
    on delete set null (requirement_id),
  constraint shifts_times check (ends_at > starts_at)
);

create index shifts_site_date_idx on public.shifts (organisation_id, site_id, shift_date);
create index shifts_requirement_idx on public.shifts (requirement_id) where requirement_id is not null;

comment on table public.shifts is
  'One post on one day, made on the first assignment (slice 3.2). Times and people copied from the requirement then; the roster always checks the requirement in force. Never deleted.';

-- ---------------------------------------------------------------------------
-- 3. shift_assignments
-- ---------------------------------------------------------------------------

create table public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  shift_id uuid not null,
  -- Copied from the shift (composite foreign key), for reads by site and week.
  site_id uuid not null,
  shift_date date not null,
  worker_id uuid not null,
  -- Copied from the requirement in force when the worker was assigned.
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'assigned'
    constraint shift_assignments_status_value check (status in ('assigned', 'removed')),
  assigned_by uuid default auth.uid(),
  assigned_at timestamptz not null default now(),
  removed_by uuid,
  removed_at timestamptz,
  removed_reason text
    constraint shift_assignments_removed_reason_text check (
      removed_reason = btrim(removed_reason)
      and char_length(removed_reason) between 1 and 500
      and removed_reason !~ '[\x01-\x1f\x7f-\x9f<>]'
      and removed_reason !~* '(://|www\.)'
    ),
  created_at timestamptz not null default now(),
  constraint shift_assignments_organisation_id_id_key unique (organisation_id, id),
  constraint shift_assignments_shift_fkey foreign key (organisation_id, shift_id, site_id, shift_date)
    references public.shifts (organisation_id, id, site_id, shift_date),
  constraint shift_assignments_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint shift_assignments_times check (ends_at > starts_at),
  constraint shift_assignments_removed_known check (
    (status = 'removed') = (removed_at is not null)
    and (status = 'removed' or (removed_by is null and removed_reason is null))
  ),
  -- One worker can't be on two shifts that overlap, overnight shifts included.
  constraint shift_assignments_no_overlap exclude using gist (
    worker_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'assigned')
);

create unique index shift_assignments_shift_worker_key
  on public.shift_assignments (shift_id, worker_id) where status = 'assigned';
create index shift_assignments_site_date_idx
  on public.shift_assignments (organisation_id, site_id, shift_date);
create index shift_assignments_org_starts_idx
  on public.shift_assignments (organisation_id, starts_at);
create index shift_assignments_worker_idx on public.shift_assignments (worker_id, shift_date);

comment on table public.shift_assignments is
  'One worker on one shift (slice 3.2). Times copied from the requirement; no overlapping assignments per worker. Never deleted: removal sets status removed with who, when and why.';

-- ---------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------

-- BEFORE INSERT/UPDATE/DELETE on shifts.
-- * never deleted; a new row is open, for a post-day that is staffed, with the requirement's
--   times and people;
-- * the only changes are open -> cancelled and the foreign key nulling requirement_id.
create function private.shifts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req record;
  v_name text;
  v_closed date;
begin
  if tg_op = 'DELETE' then
    raise exception 'Shifts are never deleted.' using errcode = 'MLRS1';
  end if;

  if tg_op = 'INSERT' then
    select * into v_req
    from private.post_day_requirement(new.organisation_id, new.post_id, new.shift_date);
    if not found then
      select p.name, p.closed_on into v_name, v_closed
      from public.posts p
      where p.id = new.post_id and p.organisation_id = new.organisation_id;
      if v_closed is not null and new.shift_date > v_closed then
        raise exception '% closed after %.', v_name, to_char(v_closed, 'FMDD Mon YYYY')
          using errcode = 'MLRS1';
      end if;
      raise exception '% isn''t staffed on %.', coalesce(v_name, 'This post'),
        to_char(new.shift_date, 'FMDy FMDD Mon YYYY')
        using errcode = 'MLRS1';
    end if;
    new.status := 'open';
    new.requirement_id := v_req.requirement_id;
    new.contract_id := v_req.contract_id;
    new.site_id := v_req.site_id;
    new.starts_at := v_req.starts_at;
    new.ends_at := v_req.ends_at;
    new.required_count := v_req.required_count;
    return new;
  end if;

  if (
    new.id, new.organisation_id, new.post_id, new.contract_id, new.site_id, new.shift_date,
    new.starts_at, new.ends_at, new.required_count, new.work_unit_id, new.created_at,
    new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.post_id, old.contract_id, old.site_id, old.shift_date,
    old.starts_at, old.ends_at, old.required_count, old.work_unit_id, old.created_at,
    old.created_by
  ) then
    raise exception 'A shift keeps the times it was made with.' using errcode = 'MLRS1';
  end if;
  if new.requirement_id is distinct from old.requirement_id and new.requirement_id is not null then
    raise exception 'A shift keeps the requirement it was made from.' using errcode = 'MLRS1';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'This shift was cancelled.' using errcode = 'MLRS9';
  end if;
  return new;
end;
$$;

revoke all on function private.shifts_guard() from public, anon, authenticated;

create trigger shifts_guard before insert or update or delete on public.shifts
  for each row execute function private.shifts_guard();
create trigger shifts_set_updated_at before update on public.shifts
  for each row execute function private.set_updated_at();
create trigger shifts_audit after insert or update or delete on public.shifts
  for each row execute function private.audit_row_change();

-- BEFORE INSERT/UPDATE/DELETE on shift_assignments. Checks every path (the functions below, the
-- secret key, the database owner):
-- * never deleted;
-- * a new assignment is for a staffed post-day that hasn't passed, at a site in use, for a worker
--   employed that day, not already on the shift, not over the people the requirement asks for
--   now, and not on an overlapping shift. Times come from the requirement in force;
-- * the only change is assigned -> removed (who, when, why), before the day has passed.
create function private.shift_assignments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_req record;
  v_post public.posts%rowtype;
  v_site_status text;
  v_worker public.workers%rowtype;
  v_name text;
  v_today date := private.org_today(coalesce(new.organisation_id, old.organisation_id));
  v_assigned integer;
  v_clash record;
  v_zone text;
begin
  if tg_op = 'DELETE' then
    raise exception 'Assignments are never deleted. Remove the worker from the shift instead.'
      using errcode = 'MLRS8';
  end if;

  if tg_op = 'UPDATE' then
    if (
      new.id, new.organisation_id, new.shift_id, new.site_id, new.shift_date, new.worker_id,
      new.starts_at, new.ends_at, new.assigned_by, new.assigned_at, new.created_at
    ) is distinct from (
      old.id, old.organisation_id, old.shift_id, old.site_id, old.shift_date, old.worker_id,
      old.starts_at, old.ends_at, old.assigned_by, old.assigned_at, old.created_at
    ) then
      raise exception 'An assignment never changes. Remove it and assign again.'
        using errcode = 'MLRS8';
    end if;
    if old.status = 'removed' then
      raise exception 'This assignment was already removed.' using errcode = 'MLRS8';
    end if;
    if new.status = 'removed' then
      if old.shift_date < v_today then
        raise exception 'This day has passed and its roster can''t change.' using errcode = 'MLRS6';
      end if;
      new.removed_at := coalesce(new.removed_at, now());
      new.removed_by := coalesce(new.removed_by, private.session_uid(), auth.uid());
    end if;
    return new;
  end if;

  -- INSERT
  if new.status is distinct from 'assigned' or new.removed_at is not null
    or new.removed_by is not null or new.removed_reason is not null then
    raise exception 'A new assignment is assigned.' using errcode = 'MLRS8';
  end if;

  select * into v_shift
  from public.shifts s
  where s.id = new.shift_id and s.organisation_id = new.organisation_id
  for update;
  if not found then
    raise exception 'That shift wasn''t found.' using errcode = 'P0002';
  end if;
  select * into v_post from public.posts p where p.id = v_shift.post_id;
  if v_shift.status = 'cancelled' then
    raise exception '% on % was cancelled.', v_post.name, to_char(v_shift.shift_date, 'FMDy FMDD Mon')
      using errcode = 'MLRS9';
  end if;
  if v_shift.shift_date < v_today then
    raise exception 'This day has passed and its roster can''t change.' using errcode = 'MLRS6';
  end if;

  if v_post.closed_on is not null and v_shift.shift_date > v_post.closed_on then
    raise exception '% closed after %.', v_post.name, to_char(v_post.closed_on, 'FMDD Mon YYYY')
      using errcode = 'MLRS1';
  end if;
  select * into v_req
  from private.post_day_requirement(new.organisation_id, v_shift.post_id, v_shift.shift_date);
  if not found then
    raise exception '% isn''t staffed on %.', v_post.name, to_char(v_shift.shift_date, 'FMDy FMDD Mon')
      using errcode = 'MLRS1';
  end if;

  select s.status into v_site_status from public.sites s where s.id = v_shift.site_id;
  if v_site_status = 'archived' then
    raise exception 'This site is archived. Rosters are for sites in use.' using errcode = 'MLRS3';
  end if;

  select * into v_worker
  from public.workers w
  where w.id = new.worker_id and w.organisation_id = new.organisation_id;
  if not found then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  v_name := v_worker.first_name || ' ' || v_worker.last_name;
  if v_worker.status = 'ended' and (v_worker.end_date is null or v_worker.end_date < v_shift.shift_date) then
    raise exception '% has left the company.', v_name using errcode = 'MLRS2';
  end if;
  if v_worker.end_date is not null and v_worker.end_date < v_shift.shift_date then
    raise exception '% leaves on %.', v_name, to_char(v_worker.end_date, 'FMDD Mon YYYY')
      using errcode = 'MLRS2';
  end if;
  if v_worker.start_date > v_shift.shift_date then
    raise exception '% starts on %.', v_name, to_char(v_worker.start_date, 'FMDD Mon YYYY')
      using errcode = 'MLRS2';
  end if;

  if exists (
    select 1 from public.shift_assignments a
    where a.shift_id = v_shift.id and a.worker_id = new.worker_id and a.status = 'assigned'
  ) then
    raise exception '% is already on this shift.', v_name using errcode = 'MLRS7';
  end if;

  select count(*) into v_assigned
  from public.shift_assignments a
  where a.shift_id = v_shift.id and a.status = 'assigned';
  if v_assigned >= v_req.required_count then
    raise exception '% on % already has the % % it needs.', v_post.name,
      to_char(v_shift.shift_date, 'FMDy FMDD Mon'), v_req.required_count,
      case when v_req.required_count = 1 then 'person' else 'people' end
      using errcode = 'MLRS4';
  end if;

  new.site_id := v_shift.site_id;
  new.shift_date := v_shift.shift_date;
  new.starts_at := v_req.starts_at;
  new.ends_at := v_req.ends_at;
  new.assigned_at := now();
  new.assigned_by := coalesce(new.assigned_by, private.session_uid(), auth.uid());

  select a.starts_at, a.ends_at, p.name into v_clash
  from public.shift_assignments a
  join public.shifts s on s.id = a.shift_id
  join public.posts p on p.id = s.post_id
  where a.worker_id = new.worker_id
    and a.status = 'assigned'
    and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
  order by a.starts_at
  limit 1;
  if found then
    select coalesce(o.timezone, 'Africa/Lagos') into v_zone
    from public.organisations o where o.id = new.organisation_id;
    raise exception '% is already on % %–% then.', v_name, v_clash.name,
      to_char(v_clash.starts_at at time zone v_zone, 'FMDy HH24:MI'),
      to_char(v_clash.ends_at at time zone v_zone, 'HH24:MI')
      using errcode = 'MLRS5';
  end if;

  return new;
end;
$$;

revoke all on function private.shift_assignments_guard() from public, anon, authenticated;

create trigger shift_assignments_guard
  before insert or update or delete on public.shift_assignments
  for each row execute function private.shift_assignments_guard();
create trigger shift_assignments_audit
  after insert or update or delete on public.shift_assignments
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 5. Row-level security and grants
-- ---------------------------------------------------------------------------
-- Read: owner, admin and ops_manager (the roster builders); line managers read the shifts at
-- the sites their reportees (or they themselves) are mapped to and their reportees' assignments
-- (they assign in Phase 4's My team; read-only now); a worker reads their own assignments and
-- the shift rows they are on. Shift rows carry no names, and a worker never sees another
-- worker's assignment. No write grants: only the functions below write.

-- Sites where the caller's own worker record or one of their reportees is mapped today or later.
create function private.line_manager_site_ids(p_organisation_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct wa.site_id
  from public.worker_assignments wa
  join public.workers w on w.id = wa.worker_id and w.organisation_id = wa.organisation_id
  where wa.organisation_id = p_organisation_id
    and wa.site_id is not null
    and (wa.effective_to is null or wa.effective_to >= private.org_today(p_organisation_id))
    and (
      w.id in (select private.my_worker_ids())
      or private.is_line_manager_for(p_organisation_id, w.line_manager_worker_id, w.line_manager_membership_id)
    )
$$;

revoke all on function private.line_manager_site_ids(uuid) from public, anon;
grant execute on function private.line_manager_site_ids(uuid) to authenticated, service_role;

alter table public.shifts enable row level security;
alter table public.shift_assignments enable row level security;

create policy shift_assignments_select on public.shift_assignments for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'ops_manager'])
    or worker_id in (select private.my_worker_ids())
    or (private.has_role(organisation_id, array['line_manager']) and private.is_reportee(worker_id))
  );

create policy shifts_select on public.shifts for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'ops_manager'])
    or (
      private.has_role(organisation_id, array['line_manager'])
      and site_id in (select private.line_manager_site_ids(organisation_id))
    )
    -- Through shift_assignments' own policy: the worker's own rows and a line manager's
    -- reportees' rows.
    or exists (
      select 1 from public.shift_assignments a
      where a.shift_id = shifts.id and a.organisation_id = shifts.organisation_id
    )
  );

revoke all on table public.shifts from anon, authenticated;
revoke all on table public.shift_assignments from anon, authenticated;
grant select on table public.shifts to authenticated;
grant select on table public.shift_assignments to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Writes
-- ---------------------------------------------------------------------------

-- Owner, admin or ops_manager of the organisation, in a trusted session.
create function private.require_roster_role(p_organisation_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t change rosters.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_roster_role(uuid) from public, anon, authenticated;

-- The shift row for a post-day, made if it isn't there yet (MLRS1 when the post isn't staffed
-- that day). No role check: only the definers below call it.
create function private.materialise_shift(p_organisation_id uuid, p_post_id uuid, p_date date)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select s.id into v_id
  from public.shifts s
  where s.post_id = p_post_id and s.shift_date = p_date and s.organisation_id = p_organisation_id;
  if v_id is not null then
    return v_id;
  end if;
  -- The guard fills the times, people, contract and site from the requirement in force.
  insert into public.shifts (
    organisation_id, post_id, contract_id, site_id, shift_date, starts_at, ends_at, required_count
  )
  select p_organisation_id, p.id, p.contract_id, p.site_id, p_date, now(), now() + interval '1 minute', 1
  from public.posts p
  where p.id = p_post_id and p.organisation_id = p_organisation_id
  on conflict (post_id, shift_date) do nothing
  returning id into v_id;
  if v_id is null then
    select s.id into v_id
    from public.shifts s
    where s.post_id = p_post_id and s.shift_date = p_date and s.organisation_id = p_organisation_id;
  end if;
  if v_id is null then
    raise exception 'That post wasn''t found.' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

revoke all on function private.materialise_shift(uuid, uuid, date) from public, anon, authenticated;

-- A worker with no mapping to the site in force that day (flagged on the screen, never refused).
create function private.mapped_to_site(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_site_id uuid,
  p_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.worker_assignments wa
    where wa.organisation_id = p_organisation_id
      and wa.worker_id = p_worker_id
      and wa.site_id = p_site_id
      and wa.effective_from <= p_date
      and (wa.effective_to is null or wa.effective_to >= p_date)
  )
$$;

revoke all on function private.mapped_to_site(uuid, uuid, uuid, date) from public, anon, authenticated;

-- Assigns a worker to a post on a day, making the shift row on the first assignment. Returns
-- {assignment_id, shift_id, mapped}.
create function private.assign_worker_to_shift(
  p_organisation_id uuid,
  p_post_id uuid,
  p_shift_date date,
  p_worker_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift_id uuid;
  v_site_id uuid;
  v_id uuid;
begin
  perform private.require_roster_role(p_organisation_id);
  if p_shift_date is null then
    raise exception 'Choose a day.' using errcode = '22023';
  end if;
  select p.site_id into v_site_id
  from public.posts p
  where p.id = p_post_id and p.organisation_id = p_organisation_id;
  if v_site_id is null then
    raise exception 'That post wasn''t found.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.workers w where w.id = p_worker_id and w.organisation_id = p_organisation_id
  ) then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;

  v_shift_id := private.materialise_shift(p_organisation_id, p_post_id, p_shift_date);
  -- The guard fills the site, day and times, and checks everything else.
  insert into public.shift_assignments (
    organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at
  )
  values (
    p_organisation_id, v_shift_id, v_site_id, p_shift_date, p_worker_id,
    now(), now() + interval '1 minute'
  )
  returning id into v_id;

  return jsonb_build_object(
    'assignment_id', v_id,
    'shift_id', v_shift_id,
    'mapped', private.mapped_to_site(p_organisation_id, p_worker_id, v_site_id, p_shift_date)
  );
end;
$$;

revoke all on function private.assign_worker_to_shift(uuid, uuid, date, uuid) from public, anon;
grant execute on function private.assign_worker_to_shift(uuid, uuid, date, uuid) to authenticated;

create function public.assign_worker_to_shift(
  p_organisation_id uuid,
  p_post_id uuid,
  p_shift_date date,
  p_worker_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.assign_worker_to_shift(p_organisation_id, p_post_id, p_shift_date, p_worker_id)
$$;

revoke all on function public.assign_worker_to_shift(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.assign_worker_to_shift(uuid, uuid, date, uuid) to authenticated;

-- Takes a worker off a shift: the row stays, marked removed with who, when and the reason.
create function private.remove_assignment(
  p_organisation_id uuid,
  p_assignment_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.shift_assignments%rowtype;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
begin
  perform private.require_roster_role(p_organisation_id);
  select * into v_row
  from public.shift_assignments a
  where a.id = p_assignment_id and a.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'That assignment wasn''t found.' using errcode = 'P0002';
  end if;
  if v_row.status = 'removed' then
    raise exception 'This assignment was already removed.' using errcode = 'MLRS8';
  end if;
  if v_reason is not null and (
    char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]' or v_reason ~* '(://|www\.)'
  ) then
    raise exception 'Keep the reason to 500 characters of plain text, without web addresses.'
      using errcode = 'MLRS0';
  end if;

  update public.shift_assignments a
  set status = 'removed',
    removed_at = now(),
    removed_by = private.session_uid(),
    removed_reason = v_reason
  where a.id = p_assignment_id;

  return jsonb_build_object(
    'assignment_id', p_assignment_id,
    'shift_id', v_row.shift_id,
    'worker_id', v_row.worker_id,
    'shift_date', v_row.shift_date
  );
end;
$$;

revoke all on function private.remove_assignment(uuid, uuid, text) from public, anon;
grant execute on function private.remove_assignment(uuid, uuid, text) to authenticated;

create function public.remove_assignment(
  p_organisation_id uuid,
  p_assignment_id uuid,
  p_reason text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.remove_assignment(p_organisation_id, p_assignment_id, p_reason)
$$;

revoke all on function public.remove_assignment(uuid, uuid, text) from public, anon;
grant execute on function public.remove_assignment(uuid, uuid, text) to authenticated;

-- Copies the previous week's assignments at a site into the week starting p_week_start (a
-- Monday): each worker onto the same post on the same weekday, when the post is still staffed
-- that day, the worker is still employed, the shift has room and the worker is free then. Every
-- assignment it can't copy is listed with the reason; one already on the roster is counted, not
-- copied twice. With p_dry_run the same work is done and then rolled back, so the preview and the
-- copy can't disagree. Returns {copied, already, source, skipped: [{post_id, post_name,
-- shift_date, worker_id, worker_name, code, reason}]}.
create function private.copy_last_week(
  p_organisation_id uuid,
  p_site_id uuid,
  p_week_start date,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source record;
  v_target date;
  v_shift_id uuid;
  v_copied integer := 0;
  v_already integer := 0;
  v_total integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_code text;
  v_message text;
  v_result jsonb;
begin
  perform private.require_roster_role(p_organisation_id);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'A roster week starts on a Monday.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.sites s where s.id = p_site_id and s.organisation_id = p_organisation_id
  ) then
    raise exception 'That site wasn''t found.' using errcode = 'P0002';
  end if;
  -- One copy per site at a time.
  perform pg_advisory_xact_lock(hashtextextended('roster_copy:' || p_site_id::text, 0));

  begin
    for v_source in
      select a.worker_id, s.post_id, s.shift_date, p.name as post_name,
        w.first_name || ' ' || w.last_name as worker_name
      from public.shift_assignments a
      join public.shifts s on s.id = a.shift_id
      join public.posts p on p.id = s.post_id
      join public.workers w on w.id = a.worker_id
      where a.organisation_id = p_organisation_id
        and a.site_id = p_site_id
        and a.status = 'assigned'
        and a.shift_date between p_week_start - 7 and p_week_start - 1
      order by a.shift_date, a.starts_at, p.name, w.last_name, w.first_name, a.id
      limit 5000
    loop
      v_total := v_total + 1;
      v_target := v_source.shift_date + 7;
      begin
        v_shift_id := private.materialise_shift(p_organisation_id, v_source.post_id, v_target);
        insert into public.shift_assignments (
          organisation_id, shift_id, site_id, shift_date, worker_id, starts_at, ends_at
        )
        values (
          p_organisation_id, v_shift_id, p_site_id, v_target, v_source.worker_id,
          now(), now() + interval '1 minute'
        );
        v_copied := v_copied + 1;
      exception
        when sqlstate 'MLRS7' then
          v_already := v_already + 1;
        when sqlstate 'MLRS1' or sqlstate 'MLRS2' or sqlstate 'MLRS3' or sqlstate 'MLRS4'
          or sqlstate 'MLRS5' or sqlstate 'MLRS6' or sqlstate 'MLRS9'
          or sqlstate '23P01' or sqlstate '23505' then
          get stacked diagnostics v_code = returned_sqlstate, v_message = message_text;
          if v_code = '23P01' then
            v_code := 'MLRS5';
            v_message := v_source.worker_name || ' is already on an overlapping shift.';
          elsif v_code = '23505' then
            v_code := 'MLRS7';
            v_message := v_source.worker_name || ' is already on this shift.';
          end if;
          v_skipped := v_skipped || jsonb_build_object(
            'post_id', v_source.post_id,
            'post_name', v_source.post_name,
            'shift_date', v_target,
            'worker_id', v_source.worker_id,
            'worker_name', v_source.worker_name,
            'code', v_code,
            'reason', v_message
          );
      end;
    end loop;

    v_result := jsonb_build_object(
      'week_start', p_week_start,
      'source', v_total,
      'copied', v_copied,
      'already', v_already,
      'skipped', v_skipped,
      'dry_run', coalesce(p_dry_run, false)
    );

    if coalesce(p_dry_run, false) then
      -- Undo everything above; v_result survives (variables aren't transactional).
      raise exception 'dry run' using errcode = 'MLRSD';
    end if;
  exception
    when sqlstate 'MLRSD' then
      return v_result;
  end;

  if v_copied > 0 then
    perform private.log_audit_impl(
      p_organisation_id, 'roster.week_copied', 'sites', p_site_id, null,
      jsonb_build_object(
        'week_start', p_week_start, 'copied', v_copied, 'already', v_already,
        'skipped', jsonb_array_length(v_skipped)
      ),
      null
    );
  end if;
  return v_result;
end;
$$;

revoke all on function private.copy_last_week(uuid, uuid, date, boolean) from public, anon;
grant execute on function private.copy_last_week(uuid, uuid, date, boolean) to authenticated;

create function public.copy_last_week(
  p_organisation_id uuid,
  p_site_id uuid,
  p_week_start date,
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.copy_last_week(p_organisation_id, p_site_id, p_week_start, p_dry_run)
$$;

revoke all on function public.copy_last_week(uuid, uuid, date, boolean) from public, anon;
grant execute on function public.copy_last_week(uuid, uuid, date, boolean) to authenticated;
