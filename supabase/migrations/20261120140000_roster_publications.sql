-- Slice 3.3: publishing a roster, and the worker's read of their published shifts.
--
-- 1. `roster_publications`: one row per publish of one site's week (version 1, 2, ...). Insert
--    only. The snapshot lists what was published, by id: each assignment with its worker, shift,
--    post, day and times. No names and no personal data, so the audit log and later reads stay
--    small and safe. Counts of people on shifts and places still open sit beside it.
-- 2. `publish_roster(org, site, week_start, dry_run)`: owner, admin and ops_manager, trusted
--    sessions only. Takes the site's roster lock (the one assign and copy use), builds the
--    snapshot, compares it with the previous version and inserts the next. Returns who is
--    affected and how (added, removed, changed) with their shifts that week, so the server can
--    tell each of them once. The dry run does the same work and inserts nothing: it is the
--    confirm step's preview (Lira rule: preview, then confirm).
-- 3. `roster_publication_status(org, site, week_start)`: the latest version and which post-days
--    changed since it, for the grid's "Changed since publish" marks.
-- 4. `my_published_shifts(from, to)`: a worker's own shifts that are in the latest publication of
--    their site-week and still assigned, with post and site names (workers can't read posts or
--    sites). Nothing about anyone else.
--
-- What a worker sees between publishes (decided here): only what was published. A new
-- assignment shows on their phone after the next publish. Times are the published ones. A
-- removal takes effect at once: an assignment that is no longer assigned drops off their list
-- before the republish (we never show someone a shift they were taken off), and the republish
-- then tells them.
--
-- Times in the snapshot are the requirement in force for that post-day when it was published
-- (private.post_day_requirement, the rule the grid reads), else the assignment's copied times
-- when the post-day is no longer staffed. So a dated requirement change (2.8) shows as "changed"
-- for the people on those shifts at the next publish.
--
-- Refusals (SQLSTATE):
--   MLRP1 the week has fully passed
--   MLRP2 nothing changed since the latest version (a publish, not the dry run)
--   MLRS3 the site is archived (as in 3.2)
--   22023 not a Monday, or a range over 62 days
--   42501 the wrong role, or an untrusted session
--   P0002 the site isn't in the organisation
-- Nothing here stores money.

-- ---------------------------------------------------------------------------
-- 1. roster_publications
-- ---------------------------------------------------------------------------

create table public.roster_publications (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  site_id uuid not null,
  -- The Monday of the week (company time zone; a shift belongs to the day it starts).
  week_start date not null
    constraint roster_publications_week_start_monday check (extract(isodow from week_start) = 1),
  version integer not null
    constraint roster_publications_version_range check (version >= 1),
  published_at timestamptz not null default now(),
  published_by uuid default auth.uid(),
  -- [{a: assignment, w: worker, s: shift, p: post, d: day, from, to}], ids and times only.
  snapshot jsonb not null default '[]'::jsonb
    constraint roster_publications_snapshot_array check (jsonb_typeof(snapshot) = 'array'),
  assigned_count integer not null default 0
    constraint roster_publications_assigned_range check (assigned_count >= 0),
  open_count integer not null default 0
    constraint roster_publications_open_range check (open_count >= 0),
  constraint roster_publications_organisation_id_id_key unique (organisation_id, id),
  constraint roster_publications_site_week_version_key unique (site_id, week_start, version),
  constraint roster_publications_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id)
);

create index roster_publications_latest_idx
  on public.roster_publications (organisation_id, site_id, week_start, version desc);

comment on table public.roster_publications is
  'Each publish of one site''s roster week (slice 3.3): version, who and when, a snapshot of assignment ids and times, and the counts. Insert only.';

-- BEFORE INSERT/UPDATE/DELETE: insert only. A new row takes the next version for its site-week
-- and the time now, whoever inserts it.
create function private.roster_publications_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A published roster never changes. Publish again instead.' using errcode = 'MLRP0';
  end if;
  select coalesce(max(p.version), 0) + 1 into new.version
  from public.roster_publications p
  where p.site_id = new.site_id and p.week_start = new.week_start;
  new.published_at := now();
  new.published_by := coalesce(new.published_by, private.session_uid(), auth.uid());
  return new;
end;
$$;

revoke all on function private.roster_publications_guard() from public, anon, authenticated;

create trigger roster_publications_guard
  before insert or update or delete on public.roster_publications
  for each row execute function private.roster_publications_guard();

alter table public.roster_publications enable row level security;

-- The roster builders read publications. Workers read their published shifts through
-- my_published_shifts, never this table.
create policy roster_publications_select on public.roster_publications for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'admin', 'ops_manager'])));

revoke all on table public.roster_publications from anon, authenticated;
grant select on table public.roster_publications to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The roster as it stands, and what changed since a snapshot
-- ---------------------------------------------------------------------------

-- The site's week as a snapshot would record it now: every assigned assignment, with the
-- requirement's times for that post-day (else the copied times). No role check: only the
-- definers below call it.
create function private.roster_week_snapshot(
  p_organisation_id uuid,
  p_site_id uuid,
  p_week_start date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'a', a.id,
        'w', a.worker_id,
        's', a.shift_id,
        'p', s.post_id,
        'd', a.shift_date,
        'from', coalesce(r.starts_at, a.starts_at),
        'to', coalesce(r.ends_at, a.ends_at)
      )
      order by a.shift_date, coalesce(r.starts_at, a.starts_at), a.id
    ),
    '[]'::jsonb
  )
  from public.shift_assignments a
  join public.shifts s on s.id = a.shift_id and s.organisation_id = a.organisation_id
  left join lateral (
    select q.starts_at, q.ends_at
    from private.post_day_requirement(a.organisation_id, s.post_id, a.shift_date) q
    limit 1
  ) r on true
  where a.organisation_id = p_organisation_id
    and a.site_id = p_site_id
    and a.shift_date between p_week_start and p_week_start + 6
    and a.status = 'assigned'
$$;

revoke all on function private.roster_week_snapshot(uuid, uuid, date) from public, anon, authenticated;

-- Each (worker, shift) that differs between two snapshots: added (only in the new one), removed
-- (only in the old one) or changed (in both with different times). Pure.
create function private.roster_snapshot_diff(p_old jsonb, p_new jsonb)
returns table (worker_id uuid, shift_id uuid, post_id uuid, shift_date date, kind text)
language sql
immutable
set search_path = ''
as $$
  with o as (
    select (e ->> 'w')::uuid as w, (e ->> 's')::uuid as s, (e ->> 'p')::uuid as p,
      (e ->> 'd')::date as d, (e ->> 'from')::timestamptz as f, (e ->> 'to')::timestamptz as t
    from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) e
  ),
  n as (
    select (e ->> 'w')::uuid as w, (e ->> 's')::uuid as s, (e ->> 'p')::uuid as p,
      (e ->> 'd')::date as d, (e ->> 'from')::timestamptz as f, (e ->> 'to')::timestamptz as t
    from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) e
  )
  select coalesce(n.w, o.w), coalesce(n.s, o.s), coalesce(n.p, o.p), coalesce(n.d, o.d),
    case
      when o.w is null then 'added'
      when n.w is null then 'removed'
      else 'changed'
    end
  from n
  full join o on o.w = n.w and o.s = n.s
  where o.w is null or n.w is null or o.f is distinct from n.f or o.t is distinct from n.t
$$;

revoke all on function private.roster_snapshot_diff(jsonb, jsonb) from public, anon, authenticated;

-- The checks shared by publish and status: role, a Monday, a site of this organisation.
create function private.roster_publish_check(
  p_organisation_id uuid,
  p_site_id uuid,
  p_week_start date
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.require_roster_role(p_organisation_id);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'A roster week starts on a Monday.' using errcode = '22023';
  end if;
  select s.status into v_status
  from public.sites s
  where s.id = p_site_id and s.organisation_id = p_organisation_id;
  if v_status is null then
    raise exception 'That site wasn''t found.' using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;

revoke all on function private.roster_publish_check(uuid, uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. publish_roster
-- ---------------------------------------------------------------------------

-- Publishes one site's week. Returns {publication_id, version, previous_version, published_at,
-- site_id, site_name, time_zone, week_start, assigned, open, dry_run, nothing_changed,
-- counts: {added, removed, changed}, affected: [{worker_id, worker_name, kind,
-- shifts: [{shift_date, starts_at, ends_at, post_name}]}]}. A worker's kind is added or removed
-- when every change for them is that, else changed. Their shifts are the ones they have at this
-- site that week in the new version.
create function private.publish_roster(
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
  v_site_status text;
  v_today date;
  v_prev public.roster_publications%rowtype;
  v_snapshot jsonb;
  v_open integer;
  v_assigned integer;
  v_affected jsonb;
  v_counts jsonb;
  v_id uuid;
  v_version integer;
  v_published_at timestamptz;
  v_site_name text;
  v_zone text;
begin
  v_site_status := private.roster_publish_check(p_organisation_id, p_site_id, p_week_start);
  v_today := private.org_today(p_organisation_id);
  if p_week_start + 6 < v_today then
    raise exception 'This week has passed. Publish this week or a later one.' using errcode = 'MLRP1';
  end if;
  if v_site_status = 'archived' then
    raise exception 'This site is archived. Rosters are for sites in use.' using errcode = 'MLRS3';
  end if;

  -- Exclusive with assign (shared) and copy (exclusive) on this site, so the snapshot is one
  -- consistent roster, and two publishes of one week take turns.
  perform pg_advisory_xact_lock(hashtextextended('roster_copy:' || p_site_id::text, 0));

  select * into v_prev
  from public.roster_publications p
  where p.organisation_id = p_organisation_id and p.site_id = p_site_id
    and p.week_start = p_week_start
  order by p.version desc
  limit 1;

  v_snapshot := private.roster_week_snapshot(p_organisation_id, p_site_id, p_week_start);
  v_assigned := jsonb_array_length(v_snapshot);

  -- Places still open: each staffed post-day's people required now, less those assigned.
  select coalesce(sum(greatest(r.required_count - coalesce(c.n, 0), 0)), 0)::integer into v_open
  from private.required_shifts(p_organisation_id, p_week_start, p_week_start + 6) r
  left join lateral (
    select count(*) as n
    from jsonb_array_elements(v_snapshot) e
    where (e ->> 'p')::uuid = r.post_id and (e ->> 'd')::date = r.shift_date
  ) c on true
  where r.site_id = p_site_id;

  with d as (
    select * from private.roster_snapshot_diff(
      case when v_prev.id is null then '[]'::jsonb else v_prev.snapshot end,
      v_snapshot
    )
  ),
  per_worker as (
    select d.worker_id,
      case
        when bool_and(d.kind = 'added') then 'added'
        when bool_and(d.kind = 'removed') then 'removed'
        else 'changed'
      end as kind
    from d
    group by d.worker_id
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'worker_id', pw.worker_id,
        'worker_name', w.first_name || ' ' || w.last_name,
        'kind', pw.kind,
        'shifts', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'shift_date', e ->> 'd',
              'starts_at', e ->> 'from',
              'ends_at', e ->> 'to',
              'post_name', p.name
            )
            order by e ->> 'from'
          ), '[]'::jsonb)
          from jsonb_array_elements(v_snapshot) e
          join public.posts p on p.id = (e ->> 'p')::uuid
          where (e ->> 'w')::uuid = pw.worker_id
        )
      )
      order by w.last_name, w.first_name, pw.worker_id
    ), '[]'::jsonb),
    jsonb_build_object(
      'added', count(*) filter (where pw.kind = 'added'),
      'removed', count(*) filter (where pw.kind = 'removed'),
      'changed', count(*) filter (where pw.kind = 'changed')
    )
  into v_affected, v_counts
  from per_worker pw
  join public.workers w on w.id = pw.worker_id and w.organisation_id = p_organisation_id;

  select s.name, coalesce(o.timezone, 'Africa/Lagos') into v_site_name, v_zone
  from public.sites s
  join public.organisations o on o.id = s.organisation_id
  where s.id = p_site_id;

  if v_prev.id is not null and jsonb_array_length(v_affected) = 0 and not coalesce(p_dry_run, false) then
    raise exception 'Nothing has changed since version % was published.', v_prev.version
      using errcode = 'MLRP2';
  end if;

  if not coalesce(p_dry_run, false) then
    insert into public.roster_publications (
      organisation_id, site_id, week_start, version, snapshot, assigned_count, open_count
    )
    values (p_organisation_id, p_site_id, p_week_start, 1, v_snapshot, v_assigned, v_open)
    returning id, version, published_at into v_id, v_version, v_published_at;

    perform private.log_audit_impl(
      p_organisation_id, 'roster.published', 'roster_publications', v_id, null,
      jsonb_build_object(
        'site_id', p_site_id, 'week_start', p_week_start, 'version', v_version,
        'assigned', v_assigned, 'open', v_open, 'workers', v_counts
      ),
      null
    );
  end if;

  return jsonb_build_object(
    'publication_id', v_id,
    'version', coalesce(v_version, coalesce(v_prev.version, 0) + 1),
    'previous_version', v_prev.version,
    'published_at', v_published_at,
    'site_id', p_site_id,
    'site_name', v_site_name,
    'time_zone', v_zone,
    'week_start', p_week_start,
    'assigned', v_assigned,
    'open', v_open,
    'dry_run', coalesce(p_dry_run, false),
    'nothing_changed', v_prev.id is not null and jsonb_array_length(v_affected) = 0,
    'counts', v_counts,
    'affected', v_affected
  );
end;
$$;

revoke all on function private.publish_roster(uuid, uuid, date, boolean) from public, anon;
grant execute on function private.publish_roster(uuid, uuid, date, boolean) to authenticated;

create function public.publish_roster(
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
  select private.publish_roster(p_organisation_id, p_site_id, p_week_start, p_dry_run)
$$;

revoke all on function public.publish_roster(uuid, uuid, date, boolean) from public, anon;
grant execute on function public.publish_roster(uuid, uuid, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. roster_publication_status
-- ---------------------------------------------------------------------------

-- The latest version of a site's week and what changed since: {version, published_at,
-- assigned, open, workers_affected, changed: [{post_id, shift_date}]}, or {version: null} when
-- the week was never published. Owner, admin and ops_manager.
create function private.roster_publication_status(
  p_organisation_id uuid,
  p_site_id uuid,
  p_week_start date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prev public.roster_publications%rowtype;
  v_changed jsonb;
  v_workers integer;
begin
  perform private.roster_publish_check(p_organisation_id, p_site_id, p_week_start);
  select * into v_prev
  from public.roster_publications p
  where p.organisation_id = p_organisation_id and p.site_id = p_site_id
    and p.week_start = p_week_start
  order by p.version desc
  limit 1;
  if v_prev.id is null then
    return jsonb_build_object('version', null, 'changed', '[]'::jsonb, 'workers_affected', 0);
  end if;

  with d as (
    select * from private.roster_snapshot_diff(
      v_prev.snapshot,
      private.roster_week_snapshot(p_organisation_id, p_site_id, p_week_start)
    )
  )
  select
    coalesce((
      select jsonb_agg(distinct jsonb_build_object('post_id', d.post_id, 'shift_date', d.shift_date))
      from d
    ), '[]'::jsonb),
    (select count(distinct d.worker_id)::integer from d)
  into v_changed, v_workers;

  return jsonb_build_object(
    'version', v_prev.version,
    'published_at', v_prev.published_at,
    'assigned', v_prev.assigned_count,
    'open', v_prev.open_count,
    'workers_affected', v_workers,
    'changed', v_changed
  );
end;
$$;

revoke all on function private.roster_publication_status(uuid, uuid, date) from public, anon;
grant execute on function private.roster_publication_status(uuid, uuid, date) to authenticated;

create function public.roster_publication_status(
  p_organisation_id uuid,
  p_site_id uuid,
  p_week_start date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.roster_publication_status(p_organisation_id, p_site_id, p_week_start)
$$;

revoke all on function public.roster_publication_status(uuid, uuid, date) from public, anon;
grant execute on function public.roster_publication_status(uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. my_published_shifts
-- ---------------------------------------------------------------------------

-- The signed-in worker's own shifts between two days (62 at most): assignments still assigned,
-- on a shift that isn't cancelled, that are in the latest publication of their site-week, with
-- the published times, the post's name and the site's name, address and landmark. A worker
-- whose record has ended gets nothing. Never anyone else's: rows come only from the caller's own
-- worker records (private.my_worker_ids, trusted sessions only).
create function private.my_published_shifts(p_from date, p_to date)
returns table (
  assignment_id uuid,
  organisation_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  post_name text,
  site_name text,
  site_address text,
  site_landmark text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 61 then
    raise exception 'Ask for 62 days or fewer at a time.' using errcode = '22023';
  end if;
  if private.session_uid() is null then
    return;
  end if;
  return query
  select a.id, a.organisation_id, a.shift_date,
    (e.item ->> 'from')::timestamptz, (e.item ->> 'to')::timestamptz,
    p.name, si.name, si.address, si.landmark
  from public.shift_assignments a
  join public.workers w on w.id = a.worker_id and w.organisation_id = a.organisation_id
  join public.shifts s on s.id = a.shift_id and s.organisation_id = a.organisation_id
  join public.posts p on p.id = s.post_id and p.organisation_id = a.organisation_id
  join public.sites si on si.id = a.site_id and si.organisation_id = a.organisation_id
  cross join lateral (
    select rp.snapshot
    from public.roster_publications rp
    where rp.organisation_id = a.organisation_id
      and rp.site_id = a.site_id
      and rp.week_start = a.shift_date - (extract(isodow from a.shift_date)::integer - 1)
    order by rp.version desc
    limit 1
  ) latest
  cross join lateral (
    select x as item
    from jsonb_array_elements(latest.snapshot) x
    where x ->> 'a' = a.id::text
    limit 1
  ) e
  where a.worker_id in (select private.my_worker_ids())
    and a.status = 'assigned'
    and a.shift_date between p_from and p_to
    and w.status = 'active'
    and s.status = 'open'
  order by 4, a.id;
end;
$$;

revoke all on function private.my_published_shifts(date, date) from public, anon;
grant execute on function private.my_published_shifts(date, date) to authenticated;

create function public.my_published_shifts(p_from date, p_to date)
returns table (
  assignment_id uuid,
  organisation_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  post_name text,
  site_name text,
  site_address text,
  site_landmark text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.my_published_shifts(p_from, p_to)
$$;

revoke all on function public.my_published_shifts(date, date) from public, anon;
grant execute on function public.my_published_shifts(date, date) to authenticated;
