-- Slice 2.2: sites with a geofence and QR checkpoints.
--
-- 1. `sites` (name-only since 1.3) gains an address, state, landmark, a geofence and a status.
--    The geofence is a circle by default (`centre` plus `radius_m`, 25-2000 m, default 100) or an
--    optional drawn outline (`boundary`). A trigger keeps `geofence = coalesce(boundary,
--    ST_Buffer(centre, radius_m))` and refuses outlines that cross themselves, have more than 200
--    corners, cover more than 4 km2, or lie outside Nigeria. Sites are archived, never deleted.
-- 2. `site_checkpoints`: named QR checkpoints at a site, in order. Each has a random token made
--    by the database (32 bytes, hex). The token is never granted to signed-in users: owner,
--    admin and ops_manager read it through `public.site_checkpoint_tokens`, and
--    `public.rotate_checkpoint_qr` swaps it so a leaked printout stops working. Retired, never
--    deleted, because Phase 3 patrol scans point at them.
-- 3. `private.site_geofence_check(site, point, accuracy_m)`: inside, near or outside, for
--    Phase 3 clock-in. It reports; Phase 3 decides how much tolerance to allow.
-- 4. `public.site_geofences(org, site?)`: the geofence as numbers and GeoJSON for the screens
--    (PostgREST returns geography columns as hex).
--
-- Roles (docs/PHASE_2.md "Roles"): sites and checkpoints are read by owner, admin, hr, finance,
-- ops_manager and line_manager, and by a worker for the sites they are (or were) assigned to;
-- written by owner, admin and ops_manager. hr keeps INSERT of name-only sites (the people
-- import). Checkpoint tokens: owner, admin and ops_manager only.

-- ---------------------------------------------------------------------------
-- 1. sites: address, geofence and status
-- ---------------------------------------------------------------------------

alter table public.sites
  add column address text
    constraint sites_address_text check (
      address = btrim(address)
      and char_length(address) between 1 and 300
      and address !~ '[\x01-\x08\x0b-\x1f\x7f-\x9f<>]'
      and address !~* '(://|www\.)'
    ),
  add column state text
    constraint sites_state_text check (
      state = btrim(state)
      and char_length(state) between 1 and 60
      and state !~ '[\x01-\x1f\x7f-\x9f<>]'
      and state !~* '(://|www\.)'
    ),
  add column landmark text
    constraint sites_landmark_text check (
      landmark = btrim(landmark)
      and char_length(landmark) between 1 and 200
      and landmark !~ '[\x01-\x1f\x7f-\x9f<>]'
      and landmark !~* '(://|www\.)'
    ),
  add column centre extensions.geography(Point, 4326),
  add column radius_m integer not null default 100
    constraint sites_radius_m_range check (radius_m between 25 and 2000),
  add column boundary extensions.geography(Polygon, 4326),
  -- Kept by private.sites_before_write; never written by signed-in users.
  add column geofence extensions.geography(Polygon, 4326),
  add column geofence_set_at timestamptz,
  add column geofence_set_by uuid,
  add column status text not null default 'active'
    constraint sites_status_value check (status in ('active', 'archived')),
  add constraint sites_geofence_set_at_known check ((geofence is null) = (geofence_set_at is null));

create index sites_geofence_idx on public.sites using gist (geofence);

comment on table public.sites is
  'A place a client has people work. Created by hand, by Setup quick add or create_client, or name-only by the people import. Archived, never deleted.';
comment on column public.sites.geofence is
  'The area clock-in is checked against: boundary when drawn, else a radius_m circle around centre. Kept by private.sites_before_write.';
comment on column public.sites.boundary is
  'An optional drawn outline. Valid, 200 corners or fewer, 4 km2 or less, inside Nigeria.';

-- Nigeria's bounding box, with a little margin (lon 2.67-14.68, lat 4.27-13.89).
create function private.inside_nigeria(g extensions.geometry)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select extensions.st_covers(extensions.st_makeenvelope(2.5, 4.0, 14.8, 14.0, 4326), g)
$$;

-- Pure; the site and checkpoint triggers run as the caller, so writers need it.
revoke all on function private.inside_nigeria(extensions.geometry) from public, anon;
grant execute on function private.inside_nigeria(extensions.geometry) to authenticated, service_role;

-- BEFORE INSERT/UPDATE on sites:
-- * the client and organisation never change (neither is granted; this stops the secret key);
-- * a drawn outline must be valid, 200 corners or fewer, 4 km2 or less and inside Nigeria, and
--   gives the site its centre when none is set;
-- * the pin must be inside Nigeria;
-- * geofence follows boundary, centre and radius, with who set it and when.
-- Refusals: MLST1 (outline crosses itself), MLST2 (too many corners), MLST3 (too large),
-- MLST4 (outside Nigeria), MLST5 (client changed).
create function private.sites_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_shape extensions.geometry;
begin
  if tg_op = 'UPDATE'
    and (new.organisation_id <> old.organisation_id or new.client_id <> old.client_id) then
    raise exception 'A site can''t move to another client.' using errcode = 'MLST5';
  end if;

  if new.boundary is not null then
    -- Cheap checks first, so an oversized outline costs nothing before it is refused: only the
    -- writers may send one (RLS would refuse anyone else, but only after this trigger ran), and
    -- the corner count and ring count are read before any geometry work.
    if auth.uid() is not null
      and not private.has_role(new.organisation_id, array['owner', 'admin', 'ops_manager']) then
      raise exception 'Your role can''t change geofences.' using errcode = '42501';
    end if;
    v_shape := extensions.geometry(new.boundary);
    -- A closed ring repeats its first point.
    if extensions.st_npoints(v_shape) > 201 then
      raise exception 'An outline can have 200 corners or fewer.' using errcode = 'MLST2';
    end if;
    if extensions.st_nrings(v_shape) <> 1 then
      raise exception 'An outline is one line around the site, with no holes.' using errcode = 'MLST1';
    end if;
    if not extensions.st_isvalid(v_shape) then
      raise exception 'The outline crosses itself. Draw it again around the site.'
        using errcode = 'MLST1';
    end if;
    if extensions.st_area(new.boundary) > 4000000 then
      raise exception 'An outline can cover 4 square kilometres or less.' using errcode = 'MLST3';
    end if;
    if not private.inside_nigeria(v_shape) then
      raise exception 'The outline must be in Nigeria.' using errcode = 'MLST4';
    end if;
    if new.centre is null then
      new.centre := extensions.geography(extensions.st_pointonsurface(v_shape));
    end if;
  end if;

  if new.centre is not null and not private.inside_nigeria(extensions.geometry(new.centre)) then
    raise exception 'The pin must be in Nigeria.' using errcode = 'MLST4';
  end if;

  if tg_op = 'INSERT'
    or extensions.st_asbinary(new.centre) is distinct from extensions.st_asbinary(old.centre)
    or extensions.st_asbinary(new.boundary) is distinct from extensions.st_asbinary(old.boundary)
    or new.radius_m <> old.radius_m then
    if new.boundary is not null then
      new.geofence := new.boundary;
    elsif new.centre is not null then
      new.geofence := extensions.st_buffer(new.centre, new.radius_m::double precision);
    else
      new.geofence := null;
    end if;
    if new.geofence is null then
      new.geofence_set_at := null;
      new.geofence_set_by := null;
    else
      new.geofence_set_at := now();
      new.geofence_set_by := (select private.session_uid());
    end if;
  else
    new.geofence := old.geofence;
    new.geofence_set_at := old.geofence_set_at;
    new.geofence_set_by := old.geofence_set_by;
  end if;

  return new;
end;
$$;

revoke all on function private.sites_before_write() from public, anon, authenticated;

create trigger sites_before_write before insert or update on public.sites
  for each row execute function private.sites_before_write();

-- Rows: hr inserts name-only sites (the people import); owner, admin and ops_manager insert and
-- update. Reads are unchanged from 1.3 (managers, and a worker for their assigned sites).
drop policy sites_insert on public.sites;
create policy sites_insert on public.sites for insert to authenticated
  with check (
    private.has_role(organisation_id, array['owner', 'admin', 'ops_manager'])
    or (
      private.has_role(organisation_id, array['hr'])
      and address is null and state is null and landmark is null
      and centre is null and boundary is null
    )
  );

revoke all on table public.sites from anon, authenticated;
grant select on table public.sites to authenticated;
grant insert (
  id, organisation_id, client_id, name, address, state, landmark, centre, radius_m, boundary
) on table public.sites to authenticated;
grant update (name, address, state, landmark, centre, radius_m, boundary, status)
  on table public.sites to authenticated;

-- The geofence as numbers and GeoJSON for the screens, as the caller (RLS applies).
create function public.site_geofences(p_organisation_id uuid, p_site_id uuid default null)
returns table (
  site_id uuid,
  centre_lat double precision,
  centre_lng double precision,
  radius_m integer,
  boundary jsonb,
  area_m2 double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id,
    extensions.st_y(extensions.geometry(s.centre)),
    extensions.st_x(extensions.geometry(s.centre)),
    s.radius_m,
    extensions.st_asgeojson(s.boundary, 7)::jsonb,
    extensions.st_area(s.geofence)
  from public.sites s
  where s.organisation_id = p_organisation_id
    and (p_site_id is null or s.id = p_site_id)
    and s.geofence is not null
$$;

revoke all on function public.site_geofences(uuid, uuid) from public, anon;
grant execute on function public.site_geofences(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. site_checkpoints
-- ---------------------------------------------------------------------------

create table public.site_checkpoints (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  site_id uuid not null,
  name text not null
    constraint site_checkpoints_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 100
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  qr_token text not null default encode(extensions.gen_random_bytes(32), 'hex')
    constraint site_checkpoints_qr_token_format check (qr_token ~ '^[0-9a-f]{64}$')
    constraint site_checkpoints_qr_token_key unique,
  qr_rotated_at timestamptz,
  location extensions.geography(Point, 4326),
  -- -1 (the default) means "last": the insert trigger puts the checkpoint at the end.
  sort_order integer not null default -1
    constraint site_checkpoints_sort_order_range check (sort_order between 0 and 10000),
  status text not null default 'active'
    constraint site_checkpoints_status_value check (status in ('active', 'retired')),
  retired_at timestamptz,
  retired_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint site_checkpoints_organisation_id_id_key unique (organisation_id, id),
  constraint site_checkpoints_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id),
  constraint site_checkpoints_retired_known check ((status = 'retired') = (retired_at is not null))
);

-- One active checkpoint of a name per site.
create unique index site_checkpoints_active_name_idx
  on public.site_checkpoints (organisation_id, site_id, lower(name))
  where status = 'active';

create index site_checkpoints_site_idx on public.site_checkpoints (organisation_id, site_id, sort_order);

comment on table public.site_checkpoints is
  'Named QR checkpoints at a site, in sort_order. qr_token is read only through site_checkpoint_tokens (owner, admin, ops_manager) and changed only by rotate_checkpoint_qr. Retired, never deleted.';

-- BEFORE INSERT/UPDATE on site_checkpoints:
-- * a new checkpoint goes on an active site, last in order unless given one;
-- * a checkpoint never moves site; a retired one never changes again;
-- * retiring records when and by whom.
-- Refusals: MLCP1 (retired), MLCP2 (archived site), MLCP3 (moved), MLCP4 (location outside
-- Nigeria), MLCP5 (more than 200 active checkpoints at a site).
create function private.site_checkpoints_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.organisation_id <> old.organisation_id or new.site_id <> old.site_id then
      raise exception 'A checkpoint can''t move to another site.' using errcode = 'MLCP3';
    end if;
    if old.status = 'retired' then
      raise exception 'A retired checkpoint can''t be changed. Add a new one.' using errcode = 'MLCP1';
    end if;
    if new.status = 'retired' then
      new.retired_at := now();
      new.retired_by := (select private.session_uid());
    end if;
  else
    if exists (
      select 1 from public.sites s
      where s.organisation_id = new.organisation_id and s.id = new.site_id and s.status = 'archived'
    ) then
      raise exception 'This site is archived. Restore it to add checkpoints.' using errcode = 'MLCP2';
    end if;
    if (
      select count(*) from public.site_checkpoints c
      where c.organisation_id = new.organisation_id and c.site_id = new.site_id and c.status = 'active'
    ) >= 200 then
      raise exception 'A site can have 200 checkpoints or fewer. Retire some first.'
        using errcode = 'MLCP5';
    end if;
    new.status := 'active';
    new.retired_at := null;
    new.retired_by := null;
    new.qr_rotated_at := null;
    if new.sort_order < 0 then
      -- One writer at a time per site, so two adds can't take the same place.
      perform pg_advisory_xact_lock(hashtextextended('site_checkpoints:' || new.site_id::text, 0));
      select coalesce(max(c.sort_order) + 1, 0) into new.sort_order
      from public.site_checkpoints c
      where c.organisation_id = new.organisation_id and c.site_id = new.site_id;
      new.sort_order := least(new.sort_order, 10000);
    end if;
  end if;

  if new.location is not null and not private.inside_nigeria(extensions.geometry(new.location)) then
    raise exception 'The checkpoint must be in Nigeria.' using errcode = 'MLCP4';
  end if;

  return new;
end;
$$;

revoke all on function private.site_checkpoints_before_write() from public, anon, authenticated;

create trigger site_checkpoints_before_write before insert or update on public.site_checkpoints
  for each row execute function private.site_checkpoints_before_write();
create trigger site_checkpoints_set_updated_at before update on public.site_checkpoints
  for each row execute function private.set_updated_at();
-- qr_token is left out of the audit rows by private.audit_secret_key (its `token` part).
create trigger site_checkpoints_audit after insert or update or delete on public.site_checkpoints
  for each row execute function private.audit_row_change();

alter table public.site_checkpoints enable row level security;

create policy site_checkpoints_select on public.site_checkpoints for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager'])
    or site_id in (select private.my_assignment_target_ids())
  );
create policy site_checkpoints_insert on public.site_checkpoints for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));
create policy site_checkpoints_update on public.site_checkpoints for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));

-- Every column but the token. No delete.
revoke all on table public.site_checkpoints from anon, authenticated;
grant select (
  id, organisation_id, site_id, name, qr_rotated_at, location, sort_order, status, retired_at,
  retired_by, created_at, created_by, updated_at
) on table public.site_checkpoints to authenticated;
grant insert (id, organisation_id, site_id, name, location, sort_order)
  on table public.site_checkpoints to authenticated;
grant update (name, location, sort_order, status) on table public.site_checkpoints to authenticated;

-- The tokens of a site's active checkpoints, for the print sheet. Security definer because the
-- column is not granted; it checks the role itself and returns nothing to anyone else.
create function private.site_checkpoint_tokens(p_organisation_id uuid, p_site_id uuid)
returns table (checkpoint_id uuid, name text, sort_order integer, qr_token text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name, c.sort_order, c.qr_token
  from public.site_checkpoints c
  where c.organisation_id = p_organisation_id
    and c.site_id = p_site_id
    and c.status = 'active'
    and private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager'])
  order by c.sort_order, c.created_at, c.id
$$;

revoke all on function private.site_checkpoint_tokens(uuid, uuid) from public, anon;
grant execute on function private.site_checkpoint_tokens(uuid, uuid) to authenticated;

create function public.site_checkpoint_tokens(p_organisation_id uuid, p_site_id uuid)
returns table (checkpoint_id uuid, name text, sort_order integer, qr_token text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.site_checkpoint_tokens(p_organisation_id, p_site_id)
$$;

revoke all on function public.site_checkpoint_tokens(uuid, uuid) from public, anon;
grant execute on function public.site_checkpoint_tokens(uuid, uuid) to authenticated;

-- Swaps a checkpoint's token, so the old printout stops working. Owner, admin and ops_manager,
-- active checkpoints only. Logs `checkpoint.qr_rotated` (the row trigger logs the time too);
-- the token itself is never logged or returned: the print sheet reads the new one.
create function private.rotate_checkpoint_qr(p_organisation_id uuid, p_checkpoint_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.site_checkpoints;
begin
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t change checkpoints.' using errcode = '42501';
  end if;

  select * into v_row
  from public.site_checkpoints c
  where c.organisation_id = p_organisation_id and c.id = p_checkpoint_id
  for update;
  if not found then
    raise exception 'That checkpoint wasn''t found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'active' then
    raise exception 'A retired checkpoint can''t be changed. Add a new one.' using errcode = 'MLCP1';
  end if;

  update public.site_checkpoints c
  set qr_token = encode(extensions.gen_random_bytes(32), 'hex'),
    qr_rotated_at = now()
  where c.id = v_row.id;

  perform private.log_audit_impl(
    p_organisation_id, 'checkpoint.qr_rotated', 'site_checkpoints', v_row.id,
    null, jsonb_build_object('site_id', v_row.site_id, 'name', v_row.name), null
  );
end;
$$;

revoke all on function private.rotate_checkpoint_qr(uuid, uuid) from public, anon;
grant execute on function private.rotate_checkpoint_qr(uuid, uuid) to authenticated;

create function public.rotate_checkpoint_qr(p_organisation_id uuid, p_checkpoint_id uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.rotate_checkpoint_qr(p_organisation_id, p_checkpoint_id)
$$;

revoke all on function public.rotate_checkpoint_qr(uuid, uuid) from public, anon;
grant execute on function public.rotate_checkpoint_qr(uuid, uuid) to authenticated;

-- Moves an active checkpoint one place up or down the site's round and numbers the round 0, 1,
-- 2... again, in one transaction. Security invoker: RLS and the update grant apply, so only
-- owner, admin and ops_manager can. Returns how many checkpoints changed place (0 at either end).
create function public.move_site_checkpoint(
  p_organisation_id uuid,
  p_checkpoint_id uuid,
  p_direction text
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_site uuid;
  v_ids uuid[];
  v_at integer;
  v_to integer;
  v_changed integer := 0;
  v_tmp uuid;
begin
  if p_direction not in ('up', 'down') then
    raise exception 'Choose up or down.' using errcode = '22023';
  end if;
  select c.site_id into v_site
  from public.site_checkpoints c
  where c.organisation_id = p_organisation_id and c.id = p_checkpoint_id and c.status = 'active';
  if v_site is null then
    raise exception 'That checkpoint wasn''t found.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('site_checkpoints:' || v_site::text, 0));
  select array_agg(c.id order by c.sort_order, c.created_at, c.id) into v_ids
  from public.site_checkpoints c
  where c.organisation_id = p_organisation_id and c.site_id = v_site and c.status = 'active';

  v_at := array_position(v_ids, p_checkpoint_id);
  v_to := case when p_direction = 'up' then v_at - 1 else v_at + 1 end;
  if v_to >= 1 and v_to <= cardinality(v_ids) then
    v_tmp := v_ids[v_to];
    v_ids[v_to] := v_ids[v_at];
    v_ids[v_at] := v_tmp;
  end if;

  update public.site_checkpoints c
  set sort_order = t.ord - 1
  from unnest(v_ids) with ordinality as t (id, ord)
  where c.id = t.id and c.sort_order <> t.ord - 1;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke all on function public.move_site_checkpoint(uuid, uuid, text) from public, anon;
grant execute on function public.move_site_checkpoint(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The geofence check for Phase 3
-- ---------------------------------------------------------------------------
-- 'inside' when the site's geofence covers the point; 'near' when the point is within
-- `p_accuracy_m` metres of it (the phone's reported accuracy, capped at 5,000 m); else 'outside'.
-- Null when the site has no geofence, isn't in `p_organisation_id`, or the caller can't see it
-- (security invoker: RLS applies), or no point was given. It only reports: Phase 3 decides what
-- each answer means for a clock-in.
-- Phase 3: `p_organisation_id` must come from the verified session (the active membership on
-- the server, or the worker's own membership), never from client input. With the secret key RLS
-- does not apply, and this filter is the only thing keeping the answer to one company.
create function private.site_geofence_check(
  p_organisation_id uuid,
  p_site_id uuid,
  p_point extensions.geography(Point, 4326),
  p_accuracy_m integer default 0
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when s.geofence is null or p_point is null then null
    -- Postgres drops the typmod on an argument, so the point type is checked here too.
    when extensions.st_geometrytype(extensions.geometry(p_point)) <> 'ST_Point'
      or extensions.st_srid(p_point) <> 4326 then null
    when extensions.st_covers(s.geofence, p_point) then 'inside'
    when extensions.st_dwithin(
      s.geofence, p_point, least(greatest(coalesce(p_accuracy_m, 0), 0), 5000)::double precision
    ) then 'near'
    else 'outside'
  end
  from public.sites s
  where s.organisation_id = p_organisation_id and s.id = p_site_id
$$;

revoke all on function private.site_geofence_check(uuid, uuid, extensions.geography, integer)
  from public, anon;
grant execute on function private.site_geofence_check(uuid, uuid, extensions.geography, integer)
  to authenticated, service_role;
