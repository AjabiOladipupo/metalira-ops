-- Slice 3.6: supervisor crew clock-in from the worker app.
--
-- Owner decisions 4 and 8 (20 Nov 2026): a crew without phones, or a worker who declined
-- consent, is clocked in by their supervisor in the worker app. A supervisor is
--   * a worker-supervisor: a worker login whose worker record is the line manager of the crew
--     (workers.line_manager_worker_id), on shift at the site; or
--   * a line_manager login (memberships.role = 'line_manager'): their reportees, as
--     private.my_reportee_ids() has them. When the login is linked to a worker record it must be
--     on shift at the site too; a line manager with no worker record can't be rostered, so only
--     the crew's shifts are checked.
--
-- 1. private.my_crew_ids(): the workers the caller supervises, a set computed once per statement
--    (worker-supervisor crews plus private.my_reportee_ids()). Trusted sessions only.
-- 2. `crew_punch_batches`: one row per "Mark N present" (or clocked out). Who sent it, the site,
--    the server-corrected time, the supervisor's geofence result (their phone, with their own
--    location consent; the point itself is never stored) and the optional group photo.
--    Insert-only like punches: only the photo's path is set once and cleared once by the
--    90-day sweep.
-- 3. punches.crew_batch_id: each crew punch is an ordinary punch with source 'supervisor'
--    (by_supervisor), recorded_by_user = the supervisor's login, and its batch.
-- 4. `record_crew_punch`: the only writer. A security definer run as the caller, search_path ''.
--    The organisation and the supervisor come from the session; the queue owner the phone sends
--    (organisation, actor) is only compared (MLPU9, the item stays queued). Each worker must be
--    in the caller's crew, not ended, and assigned to a shift at that site whose window (start
--    - 2 h to end + 4 h) holds the corrected time. Shifts off, an ended supervisor and untrusted
--    sessions are refused. All or nothing, one transaction. Idempotent on the batch
--    (organisation, supervisor login, client_batch_id); client_event_id stays unique per worker
--    (punches_client_event_key), so the same id for another worker is a new punch.
-- 5. `my_crew_context`: what the crew screen needs, read with the supervisor's session.
-- 6. Group photo: the private `punch-photos` bucket at {organisation_id}/{yyyy-mm}/{batch_id}.ext
--    under 3.5's rules (server checks the bytes, calls begin_punch_selfie_upload with a punch of
--    the batch, so Shifts and the login's 30-an-hour cap apply, uploads with the secret key, and
--    attach_crew_photo checks again, consent included; read by owner, admin, ops_manager and hr
--    by 60-second signed URLs; 90-day sweep unless a punch of the batch is under review). Rule 9: a group photo shows every face in it, so the server takes one only when
--    every worker in the batch has agreed to photos; otherwise the punches are recorded with
--    no_selfie ("no photo"), as when the supervisor takes none.
--    punch_photo_orphans is replaced so a crew photo is never swept as an orphan.
--
-- Refusals (SQLSTATE), mapped to fixed codes in src/lib/punches/codes.ts:
--   42501 untrusted or no session                  MLPU2 same id, different punch
--   MLPU3 the supervisor or a worker has left      MLPU4 Shifts is off
--   MLPU5 bad values                               MLPU6 a location without consent
--   MLPU7 a site that isn't the company's          MLPU8 too many in the last hour
--   MLPU9 the phone's queue belongs to another login
--   MLCR1 not a crew supervisor, or a worker not in their crew
--   MLCR2 the supervisor isn't on shift at the site
--   MLCR3 a worker isn't on a shift at the site now
--   MLPS1 / MLPS2 the group photo (as for selfies)

-- ---------------------------------------------------------------------------
-- 1. The caller's crew, as a set
-- ---------------------------------------------------------------------------

create function private.my_crew_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id
  from public.memberships m
  join public.workers w
    on w.organisation_id = m.organisation_id
   and w.line_manager_worker_id = m.worker_id
  where m.user_id = (select private.session_uid())
    and m.role = 'worker'
    and m.worker_id is not null
  union
  select r.id from private.my_reportee_ids() as r (id)
$$;

revoke all on function private.my_crew_ids() from public, anon;
grant execute on function private.my_crew_ids() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. crew_punch_batches
-- ---------------------------------------------------------------------------

create table public.crew_punch_batches (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  kind text not null
    constraint crew_punch_batches_kind_value check (kind in ('in', 'out')),
  site_id uuid not null,
  -- The supervisor's login, and their worker record when they have one.
  recorded_by_user uuid not null,
  supervisor_worker_id uuid,
  -- Made on the phone; the queue item's id.
  client_batch_id uuid not null,
  device_time timestamptz not null,
  received_at timestamptz not null default now(),
  recorded_at timestamptz not null,
  time_source text not null
    constraint crew_punch_batches_time_source_value check (
      time_source in ('elapsed', 'offset', 'device')
    ),
  worker_count integer not null
    constraint crew_punch_batches_worker_count_range check (worker_count between 1 and 50),
  -- The supervisor's phone against the site. The point is never stored.
  accuracy_m integer
    constraint crew_punch_batches_accuracy_range check (accuracy_m between 0 and 100000),
  distance_m integer
    constraint crew_punch_batches_distance_range check (distance_m >= 0),
  geofence_result text not null
    constraint crew_punch_batches_geofence_value check (
      geofence_result in ('inside', 'near', 'outside', 'unknown')
    ),
  photo_expected boolean not null default false,
  photo_path text,
  photo_uploaded_at timestamptz,
  photo_deleted_at timestamptz,
  payload_hash text not null
    constraint crew_punch_batches_payload_hash_format check (payload_hash ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  constraint crew_punch_batches_organisation_id_id_key unique (organisation_id, id),
  constraint crew_punch_batches_client_key unique (organisation_id, recorded_by_user, client_batch_id),
  constraint crew_punch_batches_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id),
  constraint crew_punch_batches_supervisor_fkey foreign key (organisation_id, supervisor_worker_id)
    references public.workers (organisation_id, id),
  constraint crew_punch_batches_photo_only_in check (kind = 'in' or not photo_expected),
  constraint crew_punch_batches_photo_path_shape check (
    photo_path is null or photo_path ~ (
      '^' || organisation_id::text || '/[0-9]{4}-[0-9]{2}/' || id::text || '\.(webp|jpg)$'
    )
  ),
  constraint crew_punch_batches_photo_state check (
    (photo_path is null or (photo_expected and photo_uploaded_at is not null and photo_deleted_at is null))
    and (photo_deleted_at is null or photo_path is null)
  ),
  constraint crew_punch_batches_recorded_not_future check (recorded_at <= received_at)
);

create index crew_punch_batches_user_received_idx
  on public.crew_punch_batches (recorded_by_user, received_at);
create index crew_punch_batches_org_recorded_idx
  on public.crew_punch_batches (organisation_id, recorded_at);
create index crew_punch_batches_photo_sweep_idx on public.crew_punch_batches (created_at)
  where photo_path is not null;
create index crew_punch_batches_photo_path_idx on public.crew_punch_batches (photo_path)
  where photo_path is not null;

comment on table public.crew_punch_batches is
  'Crew clock-ins and clock-outs by a supervisor (slice 3.6): one row per batch, its punches carry crew_batch_id. Insert-only: written by record_crew_punch; only the group photo path is set once and cleared once by the retention sweep.';

-- ---------------------------------------------------------------------------
-- 3. punches.crew_batch_id
-- ---------------------------------------------------------------------------

alter table public.punches
  add column crew_batch_id uuid,
  add constraint punches_crew_batch_fkey foreign key (organisation_id, crew_batch_id)
    references public.crew_punch_batches (organisation_id, id),
  add constraint punches_crew_batch_source check ((crew_batch_id is null) = (source = 'self'));

create index punches_crew_batch_idx on public.punches (crew_batch_id) where crew_batch_id is not null;

comment on column public.punches.crew_batch_id is
  'The crew batch of a supervisor punch (slice 3.6); null exactly when source is self.';

grant select (crew_batch_id) on table public.punches to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Guards, audit, row-level security
-- ---------------------------------------------------------------------------

-- BEFORE UPDATE/DELETE: the group photo's two moves only.
create function private.crew_punch_batches_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_photo constant text[] := array['photo_path', 'photo_uploaded_at', 'photo_deleted_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Crew punches are never deleted.' using errcode = 'MLPU0';
  end if;
  if (to_jsonb(new) - v_photo) is distinct from (to_jsonb(old) - v_photo) then
    raise exception 'A crew punch never changes. Corrections are new records.' using errcode = 'MLPU0';
  end if;
  if old.photo_path is null and old.photo_deleted_at is null and old.photo_uploaded_at is null
    and new.photo_path is not null and new.photo_uploaded_at is not null
    and new.photo_deleted_at is null then
    return new;
  end if;
  if old.photo_path is not null and new.photo_path is null
    and new.photo_deleted_at is not null
    and new.photo_uploaded_at is not distinct from old.photo_uploaded_at then
    return new;
  end if;
  raise exception 'A crew punch never changes. Corrections are new records.' using errcode = 'MLPU0';
end;
$$;

create function private.crew_punch_batches_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Crew punches are never deleted.' using errcode = 'MLPU0';
end;
$$;

revoke all on function private.crew_punch_batches_guard() from public, anon, authenticated;
revoke all on function private.crew_punch_batches_no_truncate() from public, anon, authenticated;

create trigger crew_punch_batches_guard before update or delete on public.crew_punch_batches
  for each row execute function private.crew_punch_batches_guard();
create trigger crew_punch_batches_no_truncate before truncate on public.crew_punch_batches
  for each statement execute function private.crew_punch_batches_no_truncate();
create trigger crew_punch_batches_audit after insert or update on public.crew_punch_batches
  for each row execute function private.audit_row_change();

alter table public.crew_punch_batches enable row level security;

-- Read: owner, admin, ops_manager and hr every batch in the company (as punches); the supervisor
-- their own batches.
create policy crew_punch_batches_select on public.crew_punch_batches for select to authenticated
  using (
    organisation_id in (select private.role_org_ids(array['owner', 'admin', 'ops_manager', 'hr']))
    or recorded_by_user = (select private.session_uid())
  );

revoke all on table public.crew_punch_batches from anon, authenticated;
revoke insert, update, delete, truncate on table public.crew_punch_batches from service_role;
grant select (
  id, organisation_id, kind, site_id, recorded_by_user, supervisor_worker_id, client_batch_id,
  device_time, received_at, recorded_at, time_source, worker_count, accuracy_m, distance_m,
  geofence_result, photo_expected, photo_path, photo_uploaded_at, photo_deleted_at, created_at
) on table public.crew_punch_batches to authenticated;

-- ---------------------------------------------------------------------------
-- 5. record_crew_punch
-- ---------------------------------------------------------------------------

create function private.record_crew_punch(
  p_expected_organisation_id uuid,
  p_expected_actor_id uuid,
  p_client_batch_id uuid,
  p_kind text,
  p_site_id uuid,
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_worker_ids uuid[],
  p_client_event_ids uuid[],
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_has_photo boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_org uuid;
  v_role text;
  v_sup_worker uuid;
  v_sup_status public.worker_status;
  v_n integer;
  v_i integer;
  v_worker uuid;
  v_event uuid;
  v_hash text;
  v_existing public.crew_punch_batches;
  v_received timestamptz := now();
  v_recorded timestamptz;
  v_time_source text;
  v_drift integer;
  v_has_point boolean;
  v_point extensions.geography;
  v_accuracy integer;
  v_result text := 'unknown';
  v_distance integer;
  v_photo boolean;
  v_grace integer;
  v_batch public.crew_punch_batches;
  v_prev public.punches;
  v_asg_id uuid;
  v_asg_shift uuid;
  v_asg_start timestamptz;
  v_asg_end timestamptz;
  v_flags text[];
  v_row public.punches;
  v_out jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'Sign in again to clock in your crew.' using errcode = '42501';
  end if;

  -- The caller: a worker login (actor = their worker record) or a line_manager login (actor =
  -- their membership), in the company the phone's queue belongs to.
  select m.organisation_id, m.role::text, m.worker_id into v_org, v_role, v_sup_worker
  from public.memberships m
  where m.user_id = v_uid
    and m.organisation_id = p_expected_organisation_id
    and m.role in ('worker', 'line_manager')
    and p_expected_actor_id = case when m.role = 'worker' then m.worker_id else m.id end;
  if v_org is null then
    if exists (
      select 1 from public.memberships m
      where m.user_id = v_uid and m.role in ('worker', 'line_manager')
    ) then
      raise exception 'This crew punch was saved by someone else on this phone.' using errcode = 'MLPU9';
    end if;
    raise exception 'Only a crew supervisor can clock in a crew.' using errcode = 'MLCR1';
  end if;

  v_n := coalesce(cardinality(p_worker_ids), 0);
  if p_client_batch_id is null or p_kind is null or p_kind not in ('in', 'out')
    or p_device_time is null or p_site_id is null
    or p_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00'
    or (p_sent_device_time is not null
      and p_sent_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00')
    or (p_elapsed_ms is not null and abs(p_elapsed_ms) > 1000000000000)
    or v_n < 1 or v_n > 50
    or coalesce(cardinality(p_client_event_ids), 0) <> v_n
    or array_position(p_worker_ids, null) is not null
    or array_position(p_client_event_ids, null) is not null
    or (select count(distinct w) from unnest(p_worker_ids) as w) <> v_n then
    raise exception 'This crew punch is incomplete.' using errcode = 'MLPU5';
  end if;

  perform set_config('metalira.audit_channel', 'worker_app', true);
  -- One batch at a time per supervisor, then one punch at a time per worker (in id order, so two
  -- batches never wait on each other): sequencing, limits and idempotency see each other.
  perform pg_advisory_xact_lock(hashtextextended('crew:' || v_uid::text, 0));
  for v_worker in select w from unnest(p_worker_ids) as w order by w loop
    perform pg_advisory_xact_lock(hashtextextended('punches:' || v_worker::text, 0));
  end loop;

  v_hash := md5(concat_ws('|',
    p_kind,
    p_site_id::text,
    (extract(epoch from p_device_time) * 1000)::bigint,
    coalesce(round(p_latitude::numeric, 6)::text, '-'),
    coalesce(round(p_longitude::numeric, 6)::text, '-'),
    coalesce(round(p_accuracy_m::numeric)::text, '-'),
    coalesce(p_has_photo, false)::text,
    (
      select string_agg(e.w::text || ':' || e.c::text, ',' order by e.w)
      from unnest(p_worker_ids, p_client_event_ids) as e (w, c)
    )
  ));

  -- Idempotency: the same batch sent again gets what it made.
  select b.* into v_existing
  from public.crew_punch_batches b
  where b.organisation_id = v_org and b.recorded_by_user = v_uid
    and b.client_batch_id = p_client_batch_id;
  if found then
    if v_existing.payload_hash <> v_hash then
      raise exception 'A different crew punch was already sent under this id.' using errcode = 'MLPU2';
    end if;
    return jsonb_build_object(
      'batch_id', v_existing.id,
      'duplicate', true,
      'kind', v_existing.kind,
      'recorded_at', v_existing.recorded_at,
      'geofence_result', v_existing.geofence_result,
      'count', v_existing.worker_count,
      'photo_wanted', v_existing.photo_expected and v_existing.photo_path is null
        and v_existing.photo_deleted_at is null,
      'punches', coalesce((
        select jsonb_agg(jsonb_build_object('worker_id', p.worker_id, 'id', p.id, 'flags', to_jsonb(p.flags))
          order by p.worker_id)
        from public.punches p
        where p.organisation_id = v_org and p.crew_batch_id = v_existing.id
      ), '[]'::jsonb)
    );
  end if;

  if v_sup_worker is not null then
    select w.status into v_sup_status
    from public.workers w where w.organisation_id = v_org and w.id = v_sup_worker;
    if v_sup_status = 'ended' then
      raise exception 'You have left this company, so you can''t clock in a crew.' using errcode = 'MLPU3';
    end if;
  end if;
  if not private.org_shifts_enabled(v_org) then
    raise exception 'Clock-in is switched off for your company.' using errcode = 'MLPU4';
  end if;

  -- Values.
  v_has_point := p_latitude is not null and p_longitude is not null;
  if (p_latitude is null) <> (p_longitude is null)
    or (v_has_point and (
      p_latitude not between -90 and 90 or p_longitude not between -180 and 180
      or p_latitude = 'NaN'::double precision or p_longitude = 'NaN'::double precision
    ))
    or (p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m = 'NaN'::double precision)) then
    raise exception 'This crew punch has values that aren''t valid.' using errcode = 'MLPU5';
  end if;
  -- The supervisor's own location, only with their own consent (rule 9).
  if v_has_point and (
    v_sup_worker is null or not private.worker_has_consent(v_org, v_sup_worker, 'location')
  ) then
    raise exception 'Agree to share your location first, or clock in the crew without it.'
      using errcode = 'MLPU6';
  end if;

  if not exists (
    select 1 from public.sites s where s.organisation_id = v_org and s.id = p_site_id
  ) then
    raise exception 'That site isn''t one of your company''s.' using errcode = 'MLPU7';
  end if;

  -- Everyone in the batch is in the caller's crew, in this company.
  if (
    select count(*) from public.workers w
    where w.organisation_id = v_org
      and w.id = any (p_worker_ids)
      and w.id in (select private.my_crew_ids())
  ) <> v_n then
    raise exception 'You can only clock in people in your crew.' using errcode = 'MLCR1';
  end if;
  if exists (
    select 1 from public.workers w
    where w.organisation_id = v_org and w.id = any (p_worker_ids) and w.status = 'ended'
  ) then
    raise exception 'Someone in this crew has left the company.' using errcode = 'MLPU3';
  end if;

  -- At most 30 crew batches an hour per supervisor, and 20 punches an hour per worker.
  if (
    select count(*) from public.crew_punch_batches b
    where b.recorded_by_user = v_uid and b.received_at > v_received - interval '1 hour'
  ) >= 30 or exists (
    select 1 from public.punches p
    where p.worker_id = any (p_worker_ids) and p.received_at > v_received - interval '1 hour'
    group by p.worker_id
    having count(*) >= 20
  ) then
    raise exception 'Too many punches in the last hour. Try again later.' using errcode = 'MLPU8';
  end if;

  -- A client_event_id already used by the same worker is a different punch.
  if exists (
    select 1 from public.punches p
    join unnest(p_worker_ids, p_client_event_ids) as e (w, c)
      on p.worker_id = e.w and p.client_event_id = e.c
    where p.organisation_id = v_org
  ) then
    raise exception 'A different punch was already sent under this id.' using errcode = 'MLPU2';
  end if;

  -- Time.
  select t.recorded_at, t.time_source into v_recorded, v_time_source
  from private.punch_corrected_time(p_device_time, p_sent_device_time, p_elapsed_ms, v_received) t;
  v_drift := round(extract(epoch from (p_device_time - v_recorded)))::integer;

  -- A supervisor with a worker record is on shift at the site.
  if v_sup_worker is not null and not exists (
    select 1 from public.shift_assignments a
    where a.organisation_id = v_org and a.worker_id = v_sup_worker
      and a.site_id = p_site_id and a.status = 'assigned'
      and v_recorded >= a.starts_at - interval '2 hours'
      and v_recorded <= a.ends_at + interval '4 hours'
  ) then
    raise exception 'You aren''t on shift at this site now.' using errcode = 'MLCR2';
  end if;

  -- Where the supervisor's phone is.
  if v_has_point then
    v_point := extensions.st_setsrid(
      extensions.st_makepoint(p_longitude, p_latitude), 4326
    )::extensions.geography;
    v_accuracy := least(round(coalesce(p_accuracy_m, 0)), 100000)::integer;
    v_result := coalesce(private.site_geofence_check(v_org, p_site_id, v_point, v_accuracy), 'unknown');
    select round(extensions.st_distance(coalesce(s.centre, s.geofence), v_point))::integer
    into v_distance
    from public.sites s
    where s.organisation_id = v_org and s.id = p_site_id
      and coalesce(s.centre, s.geofence) is not null;
  end if;

  -- The group photo: clock-ins only, and only when everyone in it agreed to photos.
  v_photo := p_kind = 'in' and coalesce(p_has_photo, false) and not exists (
    select 1 from unnest(p_worker_ids) as w
    where not private.worker_has_consent(v_org, w, 'selfie')
  );

  select o.late_grace_minutes into v_grace from public.organisations o where o.id = v_org;

  insert into public.crew_punch_batches (
    organisation_id, kind, site_id, recorded_by_user, supervisor_worker_id, client_batch_id,
    device_time, received_at, recorded_at, time_source, worker_count, accuracy_m, distance_m,
    geofence_result, photo_expected, payload_hash
  ) values (
    v_org, p_kind, p_site_id, v_uid, v_sup_worker, p_client_batch_id,
    p_device_time, v_received, v_recorded, v_time_source, v_n,
    case when v_has_point then v_accuracy end, v_distance, v_result, v_photo, v_hash
  )
  returning * into v_batch;

  for v_i in 1 .. v_n loop
    v_worker := p_worker_ids[v_i];
    v_event := p_client_event_ids[v_i];
    v_asg_id := null;
    v_asg_shift := null;
    v_asg_start := null;
    v_asg_end := null;

    select p.* into v_prev
    from public.punches p
    where p.worker_id = v_worker and p.organisation_id = v_org and p.recorded_at <= v_recorded
    order by p.recorded_at desc, p.created_at desc
    limit 1;

    -- A clock-out belongs to its open clock-in's shift at this site.
    if p_kind = 'out' and v_prev.kind = 'in' and v_prev.shift_assignment_id is not null
      and v_prev.recorded_at > v_recorded - interval '20 hours' then
      select a.id, a.shift_id, a.starts_at, a.ends_at
      into v_asg_id, v_asg_shift, v_asg_start, v_asg_end
      from public.shift_assignments a
      where a.organisation_id = v_org and a.id = v_prev.shift_assignment_id
        and a.site_id = p_site_id;
    end if;
    if v_asg_id is null then
      select a.id, a.shift_id, a.starts_at, a.ends_at
      into v_asg_id, v_asg_shift, v_asg_start, v_asg_end
      from public.shift_assignments a
      where a.organisation_id = v_org
        and a.worker_id = v_worker
        and a.site_id = p_site_id
        and a.status = 'assigned'
        and v_recorded >= a.starts_at - interval '2 hours'
        and v_recorded <= a.ends_at + interval '4 hours'
      order by exists (
          select 1 from public.roster_publications rp
          where rp.organisation_id = a.organisation_id
            and rp.site_id = a.site_id
            and rp.week_start = a.shift_date - (extract(isodow from a.shift_date)::integer - 1)
            and rp.snapshot @> jsonb_build_array(jsonb_build_object('a', a.id::text))
        ) desc,
        abs(extract(epoch from (v_recorded - a.starts_at))), a.starts_at
      limit 1;
    end if;
    if v_asg_id is null then
      raise exception 'Someone in this crew isn''t on a shift at this site now.' using errcode = 'MLCR3';
    end if;

    v_flags := private.punch_flags(
      p_kind, v_result, v_has_point, v_photo, v_asg_start, v_asg_end, v_grace,
      v_recorded, v_received, v_drift, v_time_source, v_prev.kind, v_prev.recorded_at
    );

    insert into public.punches (
      organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
      shift_assignment_id, shift_id, site_id, device_time, received_at, recorded_at, time_source,
      clock_drift_seconds, accuracy_m, distance_m, geofence_result, selfie_expected, flags,
      payload_hash, crew_batch_id
    ) values (
      v_org, v_worker, p_kind, 'supervisor', v_uid, v_event,
      v_asg_id, v_asg_shift, p_site_id, p_device_time, v_received, v_recorded, v_time_source,
      v_drift, case when v_has_point then v_accuracy end, v_distance, v_result, false, v_flags,
      md5(v_hash || '|' || v_worker::text), v_batch.id
    )
    returning * into v_row;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'worker_id', v_row.worker_id, 'id', v_row.id, 'flags', to_jsonb(v_row.flags)
    ));
  end loop;

  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    v_org, auth.uid(),
    case p_kind when 'in' then 'crew.clocked_in' else 'crew.clocked_out' end,
    'crew_punch_batches', v_batch.id, null,
    jsonb_build_object(
      'site_id', p_site_id, 'count', v_n, 'photo_expected', v_photo,
      'geofence_result', v_result, 'worker_ids', to_jsonb(p_worker_ids)
    )
  );

  return jsonb_build_object(
    'batch_id', v_batch.id,
    'duplicate', false,
    'kind', v_batch.kind,
    'recorded_at', v_batch.recorded_at,
    'geofence_result', v_batch.geofence_result,
    'count', v_n,
    'photo_wanted', v_photo,
    'punches', v_out
  );
end;
$$;

revoke all on function private.record_crew_punch(
  uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, bigint, uuid[], uuid[],
  double precision, double precision, double precision, boolean
) from public, anon;
grant execute on function private.record_crew_punch(
  uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, bigint, uuid[], uuid[],
  double precision, double precision, double precision, boolean
) to authenticated;

create function public.record_crew_punch(
  p_expected_organisation_id uuid,
  p_expected_actor_id uuid,
  p_client_batch_id uuid,
  p_kind text,
  p_site_id uuid,
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_worker_ids uuid[],
  p_client_event_ids uuid[],
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_has_photo boolean
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_crew_punch(
    p_expected_organisation_id, p_expected_actor_id, p_client_batch_id, p_kind, p_site_id,
    p_device_time, p_sent_device_time, p_elapsed_ms, p_worker_ids, p_client_event_ids,
    p_latitude, p_longitude, p_accuracy_m, p_has_photo
  )
$$;

revoke all on function public.record_crew_punch(
  uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, bigint, uuid[], uuid[],
  double precision, double precision, double precision, boolean
) from public, anon;
grant execute on function public.record_crew_punch(
  uuid, uuid, uuid, text, uuid, timestamptz, timestamptz, bigint, uuid[], uuid[],
  double precision, double precision, double precision, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. What the crew screen needs (the supervisor's own, read with their session)
-- ---------------------------------------------------------------------------

-- For the signed-in supervisor in `p_organisation_id`: who they are (actor kind and id, the
-- queue owner), whether Shifts is on, their location consent, the size of their crew, and the
-- sites where they can clock in a crew now, each with its geofence (for the distance preview),
-- the supervisor's own shift there and the crew members on a shift there now (name, staff ID,
-- shift, last punch, whether they agreed to photos). A worker-supervisor's sites are the ones
-- they are on shift at; a line manager with no worker record sees the sites their crew are on
-- shift at. A login that is neither a worker nor a line manager is refused (MLCR1).
create function private.my_crew_context(p_organisation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_role text;
  v_actor uuid;
  v_sup_worker uuid;
  v_status public.worker_status;
  v_crew uuid[];
  v_result jsonb;
begin
  select m.role::text, case when m.role = 'worker' then m.worker_id else m.id end, m.worker_id
  into v_role, v_actor, v_sup_worker
  from public.memberships m
  where m.organisation_id = p_organisation_id
    and m.user_id = v_uid
    and m.role in ('worker', 'line_manager');
  if v_uid is null or v_actor is null then
    raise exception 'Only a crew supervisor can open crew clock-in.' using errcode = 'MLCR1';
  end if;
  if v_sup_worker is not null then
    select w.status into v_status from public.workers w
    where w.organisation_id = p_organisation_id and w.id = v_sup_worker;
  end if;

  select coalesce(array_agg(w.id), '{}') into v_crew
  from public.workers w
  where w.organisation_id = p_organisation_id
    and w.status <> 'ended'
    and w.id in (select private.my_crew_ids());

  with crew_asg as (
    select a.id, a.worker_id, a.site_id, a.starts_at, a.ends_at, p.name as post_name
    from public.shift_assignments a
    join public.shifts s on s.organisation_id = a.organisation_id and s.id = a.shift_id
    join public.posts p on p.organisation_id = s.organisation_id and p.id = s.post_id
    where a.organisation_id = p_organisation_id
      and a.worker_id = any (v_crew)
      and a.status = 'assigned'
      and now() >= a.starts_at - interval '2 hours'
      and now() <= a.ends_at + interval '4 hours'
  ),
  own_asg as (
    select a.site_id, min(a.starts_at) as starts_at, max(a.ends_at) as ends_at,
      min(p.name) as post_name
    from public.shift_assignments a
    join public.shifts s on s.organisation_id = a.organisation_id and s.id = a.shift_id
    join public.posts p on p.organisation_id = s.organisation_id and p.id = s.post_id
    where v_sup_worker is not null
      and a.organisation_id = p_organisation_id
      and a.worker_id = v_sup_worker
      and a.status = 'assigned'
      and now() >= a.starts_at - interval '2 hours'
      and now() <= a.ends_at + interval '4 hours'
    group by a.site_id
  ),
  site_ids as (
    select o.site_id as id from own_asg o
    union
    select c.site_id from crew_asg c where v_sup_worker is null
  ),
  last_punch as (
    select distinct on (p.worker_id) p.worker_id, p.kind, p.recorded_at, p.source
    from public.punches p
    where p.organisation_id = p_organisation_id
      and p.worker_id = any (v_crew)
      and p.recorded_at > now() - interval '20 hours'
    order by p.worker_id, p.recorded_at desc, p.created_at desc
  )
  select jsonb_build_object(
    'actor_kind', v_role,
    'actor_id', v_actor,
    'supervisor_status', v_status,
    'shifts_enabled', private.org_shifts_enabled(p_organisation_id),
    'location_consent', v_sup_worker is not null
      and private.worker_has_consent(p_organisation_id, v_sup_worker, 'location'),
    'crew_size', cardinality(v_crew),
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'centre_lat', extensions.st_y(extensions.geometry(s.centre)),
        'centre_lng', extensions.st_x(extensions.geometry(s.centre)),
        'radius_m', s.radius_m,
        'boundary', extensions.st_asgeojson(s.boundary, 7)::jsonb,
        'has_geofence', s.geofence is not null,
        'shift', (
          select jsonb_build_object('starts_at', o.starts_at, 'ends_at', o.ends_at, 'post_name', o.post_name)
          from own_asg o where o.site_id = s.id
        ),
        'crew', coalesce((
          select jsonb_agg(jsonb_build_object(
            'worker_id', w.id,
            'first_name', w.first_name,
            'last_name', w.last_name,
            'staff_id', w.staff_id,
            'no_phone', w.supervisor_clock_in,
            'starts_at', c.starts_at,
            'ends_at', c.ends_at,
            'post_name', c.post_name,
            'selfie_consent', private.worker_has_consent(p_organisation_id, w.id, 'selfie'),
            'last_kind', lp.kind,
            'last_at', lp.recorded_at,
            'last_by_supervisor', lp.source = 'supervisor'
          ) order by w.first_name, w.last_name, w.id)
          from (
            select distinct on (ca.worker_id) ca.*
            from crew_asg ca
            where ca.site_id = s.id
            order by ca.worker_id, abs(extract(epoch from (now() - ca.starts_at)))
          ) c
          join public.workers w on w.organisation_id = p_organisation_id and w.id = c.worker_id
          left join last_punch lp on lp.worker_id = w.id
        ), '[]'::jsonb)
      ) order by s.name)
      from public.sites s
      where s.organisation_id = p_organisation_id
        and s.id in (select site_ids.id from site_ids)
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function private.my_crew_context(uuid) from public, anon;
grant execute on function private.my_crew_context(uuid) to authenticated;

create function public.my_crew_context(p_organisation_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.my_crew_context(p_organisation_id)
$$;

revoke all on function public.my_crew_context(uuid) from public, anon;
grant execute on function public.my_crew_context(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Group photos: reads, attach, retention
-- ---------------------------------------------------------------------------

-- Read: owner, admin, ops_manager and hr of the batch's company (as selfies, slice 3.5), only for
-- a path a batch holds now.
-- No insert, update or delete policies: the server uploads with the secret key after checking
-- the bytes, and only the sweep deletes.
create policy crew_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'punch-photos'
    and exists (
      select 1
      from public.crew_punch_batches b
      where b.photo_path = objects.name
        and b.organisation_id in (select private.role_org_ids(array['owner', 'admin', 'ops_manager', 'hr']))
    )
  );

create function private.crew_photo_path(p_batch public.crew_punch_batches, p_ext text)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_batch.organisation_id::text || '/'
    || to_char(p_batch.created_at at time zone 'UTC', 'YYYY-MM') || '/'
    || p_batch.id::text || '.' || p_ext
$$;

revoke all on function private.crew_photo_path(public.crew_punch_batches, text)
  from public, anon, authenticated;

-- Is any punch of the batch under review (its photo is kept past 90 days)?
create function private.crew_batch_under_review(p_organisation_id uuid, p_batch_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.punches p
    where p.organisation_id = p_organisation_id and p.crew_batch_id = p_batch_id
      and private.punch_under_review(p.organisation_id, p.id)
  )
$$;

revoke all on function private.crew_batch_under_review(uuid, uuid) from public, anon, authenticated;

-- Secret key only: records the checked upload on the actor's own batch.
create function private.attach_crew_photo(p_batch_id uuid, p_actor uuid, p_path text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch public.crew_punch_batches;
  v_ext text;
  v_size bigint;
  v_mime text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server attaches crew photos.' using errcode = '42501';
  end if;
  select b.* into v_batch from public.crew_punch_batches b where b.id = p_batch_id for update;
  if not found or p_actor is null or v_batch.recorded_by_user <> p_actor then
    raise exception 'That crew punch wasn''t found.' using errcode = 'MLPS1';
  end if;
  if v_batch.kind <> 'in' or not v_batch.photo_expected or v_batch.photo_path is not null
    or v_batch.photo_deleted_at is not null or v_batch.created_at < now() - interval '24 hours' then
    raise exception 'This crew punch doesn''t take a photo now.' using errcode = 'MLPS1';
  end if;
  -- Everyone in it still agrees to photos (a consent may have been withdrawn since).
  if exists (
    select 1 from public.punches p
    where p.organisation_id = v_batch.organisation_id and p.crew_batch_id = v_batch.id
      and not private.worker_has_consent(p.organisation_id, p.worker_id, 'selfie')
  ) then
    raise exception 'Someone in this crew no longer agrees to photos.' using errcode = 'MLPS1';
  end if;
  v_ext := substring(p_path from '\.(webp|jpg)$');
  if v_ext is null or p_path <> private.crew_photo_path(v_batch, v_ext) then
    raise exception 'That isn''t this crew punch''s photo.' using errcode = 'MLPS1';
  end if;
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_size, v_mime
  from storage.objects o
  where o.bucket_id = 'punch-photos' and o.name = p_path;
  if v_size is null or v_size < 1 or v_size > 204800
    or v_mime is distinct from (case v_ext when 'webp' then 'image/webp' else 'image/jpeg' end) then
    raise exception 'The photo isn''t in storage as stated.' using errcode = 'MLPS2';
  end if;
  perform set_config('metalira.audit_channel', 'worker_app', true);
  update public.crew_punch_batches
  set photo_path = p_path, photo_uploaded_at = now()
  where id = v_batch.id;
end;
$$;

-- Secret key only: group photos past 90 days whose batch is not under review, oldest first.
create function private.crew_photos_due(p_limit integer default 500)
returns table (batch_id uuid, photo_path text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server sweeps crew photos.' using errcode = '42501';
  end if;
  return query
    select b.id, b.photo_path
    from public.crew_punch_batches b
    where b.photo_path is not null
      and b.created_at < now() - interval '90 days'
      and not private.crew_batch_under_review(b.organisation_id, b.id)
    order by b.created_at
    limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;

-- Secret key only: records that these group photos' files were deleted (the rows stay), one call
-- per chunk of the sweep (500 at most), each checked again. Returns how many were cleared.
create function private.clear_crew_photos(p_batch_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server sweeps crew photos.' using errcode = '42501';
  end if;
  if p_batch_ids is null or cardinality(p_batch_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_batch_ids) > 500 then
    raise exception 'At most 500 photos at a time.' using errcode = '22023';
  end if;
  perform set_config('metalira.audit_channel', 'system', true);
  update public.crew_punch_batches b
  set photo_path = null, photo_deleted_at = now()
  where b.id = any (p_batch_ids)
    and b.photo_path is not null
    and b.created_at < now() - interval '90 days'
    and not private.crew_batch_under_review(b.organisation_id, b.id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Uploads older than a day that neither a punch nor a crew batch holds (an attach that failed).
create or replace function private.punch_photo_orphans(p_limit integer default 500)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server sweeps selfies.' using errcode = '42501';
  end if;
  return query
    select o.name
    from storage.objects o
    where o.bucket_id = 'punch-photos'
      and o.created_at < now() - interval '1 day'
      and not exists (select 1 from public.punches p where p.selfie_path = o.name)
      and not exists (select 1 from public.crew_punch_batches b where b.photo_path = o.name)
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;

revoke all on function private.attach_crew_photo(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.crew_photos_due(integer) from public, anon, authenticated;
revoke all on function private.clear_crew_photos(uuid[]) from public, anon, authenticated;
grant execute on function private.attach_crew_photo(uuid, uuid, text) to service_role;
grant execute on function private.crew_photos_due(integer) to service_role;
grant execute on function private.clear_crew_photos(uuid[]) to service_role;

create function public.attach_crew_photo(p_batch_id uuid, p_actor uuid, p_path text)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$ select private.attach_crew_photo(p_batch_id, p_actor, p_path) $$;

create function public.crew_photos_due(p_limit integer default 500)
returns table (batch_id uuid, photo_path text)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.crew_photos_due(p_limit) $$;

create function public.clear_crew_photos(p_batch_ids uuid[])
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$ select private.clear_crew_photos(p_batch_ids) $$;

revoke all on function public.attach_crew_photo(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.crew_photos_due(integer) from public, anon, authenticated;
revoke all on function public.clear_crew_photos(uuid[]) from public, anon, authenticated;
grant execute on function public.attach_crew_photo(uuid, uuid, text) to service_role;
grant execute on function public.crew_photos_due(integer) to service_role;
grant execute on function public.clear_crew_photos(uuid[]) to service_role;
