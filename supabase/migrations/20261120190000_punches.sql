-- Slice 3.5: clock in and out from the worker app.
--
-- 1. `punches`: one row per clock-in or clock-out. Insert-only (CLAUDE.md rule 4): never edited
--    or deleted by anyone, the secret key and the database owner included. The only changes the
--    guard allows are the selfie's: its path set once after the upload is checked, and cleared
--    once by the 90-day retention sweep (selfie_deleted_at). Corrections arrive in Phase 4 as new
--    rows with a reason and actor.
-- 2. `record_punch`: the only way a punch is written. A security definer called with the
--    worker's own session. The worker and organisation come from the caller's own worker
--    membership; the expected organisation and worker the phone sends (the offline queue's
--    owner) are only compared, so a queue that belongs to someone else is never recorded under
--    this login (MLPU9, retryable). The server works out:
--    * recorded_at, the real time of the event, from how long ago the phone says it happened by
--      its monotonic clock (received_at - elapsed), or from the phone's clock offset at send
--      time (received_at - (sent_device_time - device_time)), and only as a last resort from the
--      phone's clock (flagged time_unverified). Never in the future, never more than 7 days back.
--      clock_drift_seconds = device_time - recorded_at.
--    * the shift: the worker's assigned (not removed) assignment whose window, 2 hours before the
--      start to 4 hours after the end, holds recorded_at, a published one (slice 3.3) first.
--      None: recorded anyway, flagged no_shift.
--    * the geofence result with private.site_geofence_check, for the organisation of the session,
--      and the distance to the site.
--    * flags (private.punch_flags), fixed at insert.
--    It is idempotent on (organisation_id, worker_id, client_event_id): the same event again
--    returns the row it made; a different event under the same id is refused (MLPU2).
-- 3. Selfies in the private `punch-photos` bucket at {organisation_id}/{yyyy-mm}/{punch_id}.{webp|jpg}
--    (month of the punch's created_at in UTC), JPEG or WebP, 200 KB at most. The server uploads
--    them with the secret key after checking the bytes (src/server/workforce/punch-selfies.ts) and
--    then calls `attach_punch_selfie` (secret key only), which checks the actor is the punch's
--    worker, that the punch expects a selfie and has none, that the path is the punch's own and
--    that the object is in Storage with an allowed size and type. Signed-in users have no insert,
--    update or delete on the bucket. Managers open a selfie by a 60-second signed URL.
-- 4. Retention: `punch_selfies_due` and `clear_punch_selfie` (secret key only) let the daily sweep
--    delete selfies older than 90 days unless the punch is under review
--    (private.punch_under_review, false until Phase 4 adds attendance review), keeping the row
--    and stamping selfie_deleted_at. `punch_photo_orphans` lists uploads no punch kept.
-- 5. Who reads what (rule 9: location is personal data):
--    * the worker their own punches;
--    * owner, admin, ops_manager and hr every punch in the company;
--    * a line manager their reportees' punches;
--    * nobody reads the raw point through the table (`location` is not granted). Everyone above
--      sees the geofence result, the distance to the site and the accuracy. Owner and admin read
--      the coordinates through `punch_locations`, which writes a `punch.location_viewed` audit
--      row. The audit rows of punches leave the point out (private.punches_audit).
--    * selfies: owner, admin, ops_manager, and a line manager for their reportees.
-- 6. private.worker_has_work_records now checks punches (slice 1.11's hook). The composite
--    foreign key to workers takes a key-share lock on the worker row, so a punch and a staff ID
--    correction's approval (which locks the worker row) can't race.
--
-- Refusals (SQLSTATE), mapped to fixed codes in src/lib/punches/codes.ts:
--   MLPU0 a change the guard never allows          MLPU1 not a worker login
--   MLPU2 same client_event_id, different punch    MLPU3 the worker has left
--   MLPU4 Shifts is switched off for the company   MLPU5 the punch's values aren't valid
--   MLPU6 no location consent                      MLPU7 a site the worker can't clock in at
--   MLPU8 too many punches in the last hour        MLPU9 the phone's queue belongs to another login
--   MLPS1 the punch doesn't expect this selfie     MLPS2 the upload isn't in Storage as stated

-- ---------------------------------------------------------------------------
-- 1. Pure helpers: corrected time and flags (tests/unit/punches mirror them in
--    src/lib/punches/time.ts and flags.ts; tests/rls/punches.test.ts checks both agree)
-- ---------------------------------------------------------------------------

-- The longest gap between the event and its send that the server believes: 7 days.
create function private.punch_max_elapsed()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '7 days' $$;

-- When the event really happened, and how that was worked out:
--   'elapsed' received - elapsed (the phone's monotonic clock, same page session);
--   'offset'  received - (sent_device_time - device_time) (the phone's wall clock, at send);
--   'device'  the phone's clock, clamped to [received - 7 days, received] (flagged).
create function private.punch_corrected_time(
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_received_at timestamptz
)
returns table (recorded_at timestamptz, time_source text)
language sql
immutable
set search_path = ''
as $$
  select
    case s.src
      when 'elapsed' then p_received_at - make_interval(secs => p_elapsed_ms / 1000.0)
      when 'offset' then p_received_at - (p_sent_device_time - p_device_time)
      else least(greatest(p_device_time, p_received_at - private.punch_max_elapsed()), p_received_at)
    end,
    s.src
  from (
    select case
      when p_elapsed_ms is not null and p_elapsed_ms >= 0
        and p_elapsed_ms <= extract(epoch from private.punch_max_elapsed()) * 1000 then 'elapsed'
      when p_sent_device_time is not null and p_device_time is not null
        and p_sent_device_time >= p_device_time
        and p_sent_device_time - p_device_time <= private.punch_max_elapsed() then 'offset'
      else 'device'
    end as src
  ) s
$$;

-- Every flag a punch can carry, in the order they are listed.
create function private.punch_flag_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'outside', 'near', 'no_location', 'no_shift', 'late', 'early_out', 'no_selfie',
    'clock_drift', 'late_sync', 'time_unverified', 'double_in', 'out_without_in'
  ]
$$;

-- The flags of one punch. Pure, so the same inputs always give the same flags:
--   outside / near   the geofence said so
--   no_location      no point was sent (the phone found none)
--   no_shift         no assignment matched
--   late             clock-in after the shift start plus the company's grace minutes
--   early_out        clock-out before the shift end minus the grace minutes
--   no_selfie        clock-in that will carry no selfie
--   clock_drift      the phone's clock is more than 5 minutes off
--   late_sync        received more than 2 hours after it happened
--   time_unverified  the time is the phone's own clock (nothing to correct it with)
--   double_in        clock-in while the previous punch is a clock-in from the last 20 hours
--   out_without_in   clock-out with no clock-in in the 20 hours before it
create function private.punch_flags(
  p_kind text,
  p_geofence_result text,
  p_has_location boolean,
  p_selfie_expected boolean,
  p_shift_starts_at timestamptz,
  p_shift_ends_at timestamptz,
  p_grace_minutes integer,
  p_recorded_at timestamptz,
  p_received_at timestamptz,
  p_clock_drift_seconds integer,
  p_time_source text,
  p_previous_kind text,
  p_previous_recorded_at timestamptz
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(f.name order by f.ord), '{}'::text[])
  from (
    values
      (1, 'outside', p_geofence_result = 'outside'),
      (2, 'near', p_geofence_result = 'near'),
      (3, 'no_location', not coalesce(p_has_location, false)),
      (4, 'no_shift', p_shift_starts_at is null),
      (5, 'late', p_kind = 'in' and p_shift_starts_at is not null
        and p_recorded_at > p_shift_starts_at + make_interval(mins => coalesce(p_grace_minutes, 0))),
      (6, 'early_out', p_kind = 'out' and p_shift_ends_at is not null
        and p_recorded_at < p_shift_ends_at - make_interval(mins => coalesce(p_grace_minutes, 0))),
      (7, 'no_selfie', p_kind = 'in' and not coalesce(p_selfie_expected, false)),
      (8, 'clock_drift', abs(coalesce(p_clock_drift_seconds, 0)) > 300),
      (9, 'late_sync', p_received_at - p_recorded_at > interval '2 hours'),
      (10, 'time_unverified', p_time_source = 'device'),
      (11, 'double_in', p_kind = 'in' and coalesce(
        p_previous_kind = 'in' and p_previous_recorded_at > p_recorded_at - interval '20 hours',
        false
      )),
      (12, 'out_without_in', p_kind = 'out' and not coalesce(
        p_previous_kind = 'in' and p_previous_recorded_at > p_recorded_at - interval '20 hours',
        false
      ))
  ) as f (ord, name, hit)
  where f.hit
$$;

-- A worker's note on an outside punch: plain text, 1 to 280 characters, no web addresses and no
-- runs of 10 or more digits (no phone, account or ID numbers; rule 9).
create function private.punch_note_ok(p_note text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_note = btrim(p_note)
    and char_length(p_note) between 1 and 280
    and p_note !~ '[\x01-\x1f\x7f-\x9f<>]'
    and p_note !~* '(://|www\.)'
    and p_note !~ '[0-9]([ -]*[0-9]){9,}'
$$;

revoke all on function private.punch_max_elapsed() from public, anon, authenticated;
revoke all on function private.punch_corrected_time(timestamptz, timestamptz, bigint, timestamptz)
  from public, anon, authenticated;
revoke all on function private.punch_flag_names() from public, anon, authenticated;
revoke all on function private.punch_flags(
  text, text, boolean, boolean, timestamptz, timestamptz, integer, timestamptz, timestamptz,
  integer, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function private.punch_note_ok(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. punches
-- ---------------------------------------------------------------------------

create table public.punches (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  kind text not null
    constraint punches_kind_value check (kind in ('in', 'out')),
  -- 'self' from the worker app; 'supervisor' is for slice 3.6's crew clock-in.
  source text not null default 'self'
    constraint punches_source_value check (source in ('self', 'supervisor')),
  -- The login that sent it (the worker's own for 'self').
  recorded_by_user uuid not null,
  -- Made on the phone; the idempotency key of the offline queue.
  client_event_id uuid not null,
  shift_assignment_id uuid,
  shift_id uuid,
  site_id uuid,
  -- The phone's clock at the event, as reported.
  device_time timestamptz not null,
  received_at timestamptz not null default now(),
  -- The server-corrected time of the event (see the header).
  recorded_at timestamptz not null,
  time_source text not null
    constraint punches_time_source_value check (time_source in ('elapsed', 'offset', 'device')),
  -- device_time - recorded_at: positive when the phone's clock is ahead.
  clock_drift_seconds integer not null,
  -- Personal data (rule 9): not granted to anyone; owner and admin use punch_locations.
  location extensions.geography(Point, 4326),
  accuracy_m integer
    constraint punches_accuracy_range check (accuracy_m between 0 and 100000),
  -- Metres from the site's centre (or its outline when it has no centre).
  distance_m integer
    constraint punches_distance_range check (distance_m >= 0),
  geofence_result text not null
    constraint punches_geofence_result_value check (
      geofence_result in ('inside', 'near', 'outside', 'unknown')
    ),
  outside_reason text
    constraint punches_outside_reason_value check (
      outside_reason in ('gate_locked', 'errand', 'location_wrong', 'other')
    ),
  outside_note text
    constraint punches_outside_note_text check (private.punch_note_ok(outside_note)),
  -- A clock-in whose selfie is on its way (the worker agreed to selfies and the phone took one).
  selfie_expected boolean not null default false,
  selfie_path text,
  selfie_uploaded_at timestamptz,
  selfie_deleted_at timestamptz,
  flags text[] not null default '{}'
    constraint punches_flags_known check (flags <@ private.punch_flag_names()),
  -- md5 of the punch's own inputs, so a resend can be told from a different punch under the same
  -- client_event_id. Not a security control.
  payload_hash text not null
    constraint punches_payload_hash_format check (payload_hash ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  constraint punches_organisation_id_id_key unique (organisation_id, id),
  constraint punches_client_event_key unique (organisation_id, worker_id, client_event_id),
  constraint punches_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint punches_assignment_fkey foreign key (organisation_id, shift_assignment_id)
    references public.shift_assignments (organisation_id, id),
  constraint punches_shift_fkey foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id),
  constraint punches_site_fkey foreign key (organisation_id, site_id)
    references public.sites (organisation_id, id),
  constraint punches_selfie_only_in check (kind = 'in' or not selfie_expected),
  constraint punches_selfie_path_shape check (
    selfie_path is null or selfie_path ~ (
      '^' || organisation_id::text || '/[0-9]{4}-[0-9]{2}/' || id::text || '\.(webp|jpg)$'
    )
  ),
  constraint punches_selfie_state check (
    (selfie_path is null or (selfie_expected and selfie_uploaded_at is not null and selfie_deleted_at is null))
    and (selfie_deleted_at is null or selfie_path is null)
  ),
  constraint punches_reason_when_away check (
    outside_reason is null or geofence_result in ('outside', 'near')
  ),
  constraint punches_note_needs_reason check (outside_note is null or outside_reason is not null),
  constraint punches_recorded_not_future check (recorded_at <= received_at)
);

create index punches_worker_recorded_idx on public.punches (worker_id, recorded_at desc);
create index punches_worker_received_idx on public.punches (worker_id, received_at);
create index punches_org_recorded_idx on public.punches (organisation_id, recorded_at);
create index punches_selfie_sweep_idx on public.punches (created_at)
  where selfie_path is not null;
create index punches_selfie_path_idx on public.punches (selfie_path) where selfie_path is not null;

comment on table public.punches is
  'Clock-ins and clock-outs (slice 3.5). Insert-only: written by record_punch, never edited or deleted; only the selfie path is set once and cleared once by the retention sweep. The point is personal data: not granted, read by owner and admin through punch_locations.';
comment on column public.punches.recorded_at is
  'Server-corrected event time: received_at minus the phone''s elapsed time since the event (see time_source). Never after received_at.';
comment on column public.punches.location is
  'Where the phone was (rule 9: personal data). Not granted to signed-in users; owner and admin read it through public.punch_locations, which is audited.';

-- Is the punch under review, so its selfie is kept past 90 days (owner decision, 20 Nov 2026)?
-- Phase 3 has no review workflow: Phase 4's attendance review MUST replace this function with a
-- real check of its table. Until then nothing is under review.
create function private.punch_under_review(p_organisation_id uuid, p_punch_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select false
$$;

revoke all on function private.punch_under_review(uuid, uuid) from public, anon, authenticated;

-- BEFORE UPDATE/DELETE on punches: the selfie's two moves only.
create function private.punches_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_selfie constant text[] := array['selfie_path', 'selfie_uploaded_at', 'selfie_deleted_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Punches are never deleted.' using errcode = 'MLPU0';
  end if;
  if (to_jsonb(new) - v_selfie) is distinct from (to_jsonb(old) - v_selfie) then
    raise exception 'A punch never changes. Corrections are new records.' using errcode = 'MLPU0';
  end if;
  -- The checked upload: no selfie yet -> a selfie.
  if old.selfie_path is null and old.selfie_deleted_at is null
    and new.selfie_path is not null and new.selfie_uploaded_at is not null
    and new.selfie_deleted_at is null and old.selfie_uploaded_at is null then
    return new;
  end if;
  -- The retention sweep: a selfie -> deleted, once.
  if old.selfie_path is not null and new.selfie_path is null
    and new.selfie_deleted_at is not null
    and new.selfie_uploaded_at is not distinct from old.selfie_uploaded_at then
    return new;
  end if;
  raise exception 'A punch never changes. Corrections are new records.' using errcode = 'MLPU0';
end;
$$;

create function private.punches_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Punches are never deleted.' using errcode = 'MLPU0';
end;
$$;

-- AFTER INSERT/UPDATE: the row audit (private.audit_row_change) without the point, which is
-- personal data the audit log's readers need not hold.
create function private.punches_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_doc jsonb;
  new_doc jsonb;
begin
  if tg_op = 'UPDATE' then
    old_doc := private.audit_redact(to_jsonb(old) - 'location');
  end if;
  new_doc := private.audit_redact(to_jsonb(new) - 'location');
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (new.organisation_id, auth.uid(), 'punches.' || lower(tg_op), 'punches', new.id, old_doc, new_doc);
  return null;
end;
$$;

revoke all on function private.punches_guard() from public, anon, authenticated;
revoke all on function private.punches_no_truncate() from public, anon, authenticated;
revoke all on function private.punches_audit() from public, anon, authenticated;

create trigger punches_guard before update or delete on public.punches
  for each row execute function private.punches_guard();
create trigger punches_no_truncate before truncate on public.punches
  for each statement execute function private.punches_no_truncate();
create trigger punches_audit after insert or update on public.punches
  for each row execute function private.punches_audit();

-- ---------------------------------------------------------------------------
-- 3. Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.punches enable row level security;

create policy punches_select on public.punches for select to authenticated
  using (
    worker_id in (select private.my_worker_ids())
    or organisation_id in (select private.role_org_ids(array['owner', 'admin', 'ops_manager', 'hr']))
    or worker_id in (select private.my_reportee_ids())
  );

revoke all on table public.punches from anon, authenticated;
-- No writes for anyone through the Data API, the secret key included: record_punch and the
-- selfie functions below are the only writers.
revoke insert, update, delete, truncate on table public.punches from service_role;
-- Everything but the point, the payload hash and the sending login.
grant select (
  id, organisation_id, worker_id, kind, source, client_event_id, shift_assignment_id, shift_id,
  site_id, device_time, received_at, recorded_at, time_source, clock_drift_seconds, accuracy_m,
  distance_m, geofence_result, outside_reason, outside_note, selfie_expected, selfie_path,
  selfie_uploaded_at, selfie_deleted_at, flags, created_at
) on table public.punches to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Module switch (slice 3.0's organisations.shifts_enabled)
-- ---------------------------------------------------------------------------

-- Whether the company has Shifts on (slice 3.0's switch). Off: punches are refused (MLPU4), a
-- queued backlog included (3.0 review L2).
create function private.org_shifts_enabled(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select o.shifts_enabled from public.organisations o where o.id = p_organisation_id),
    false
  )
$$;

revoke all on function private.org_shifts_enabled(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. record_punch
-- ---------------------------------------------------------------------------

create function private.record_punch(
  p_expected_organisation_id uuid,
  p_expected_worker_id uuid,
  p_client_event_id uuid,
  p_kind text,
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_site_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_outside_reason text,
  p_outside_note text,
  p_has_selfie boolean
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
  v_worker uuid;
  v_status public.worker_status;
  v_existing public.punches;
  v_hash text;
  v_note text := nullif(btrim(p_outside_note), '');
  v_received timestamptz := now();
  v_recorded timestamptz;
  v_time_source text;
  v_drift integer;
  v_has_point boolean;
  v_point extensions.geography;
  v_accuracy integer;
  v_prev public.punches;
  v_asg_id uuid;
  v_asg_shift uuid;
  v_asg_site uuid;
  v_asg_start timestamptz;
  v_asg_end timestamptz;
  v_site uuid;
  v_result text := 'unknown';
  v_distance integer;
  v_selfie boolean := false;
  v_grace integer;
  v_flags text[];
  v_reason text;
  v_today date;
  v_row public.punches;
begin
  if v_uid is null then
    raise exception 'Sign in to the worker app to clock in.' using errcode = '42501';
  end if;

  -- The caller's own worker login, in the company the phone's queue belongs to.
  select m.organisation_id, m.worker_id, w.status into v_org, v_worker, v_status
  from public.memberships m
  join public.workers w on w.organisation_id = m.organisation_id and w.id = m.worker_id
  where m.user_id = v_uid
    and m.role = 'worker'
    and m.worker_id is not null
    and m.organisation_id = p_expected_organisation_id
    and m.worker_id = p_expected_worker_id;
  if v_worker is null then
    if exists (
      select 1 from public.memberships m
      where m.user_id = v_uid and m.role = 'worker' and m.worker_id is not null
    ) then
      raise exception 'This punch was saved by someone else on this phone.' using errcode = 'MLPU9';
    end if;
    raise exception 'Only a worker can clock in, signed in to the worker app.' using errcode = 'MLPU1';
  end if;

  if p_client_event_id is null or p_kind is null or p_kind not in ('in', 'out')
    or p_device_time is null then
    raise exception 'This punch is incomplete.' using errcode = 'MLPU5';
  end if;

  perform set_config('metalira.audit_channel', 'worker_app', true);
  -- One punch at a time per worker: sequencing, the rate limit and idempotency see each other.
  perform pg_advisory_xact_lock(hashtextextended('punches:' || v_worker::text, 0));

  v_hash := md5(concat_ws('|',
    p_kind,
    (extract(epoch from p_device_time) * 1000)::bigint,
    coalesce(p_site_id::text, '-'),
    coalesce(round(p_latitude::numeric, 6)::text, '-'),
    coalesce(round(p_longitude::numeric, 6)::text, '-'),
    coalesce(round(p_accuracy_m::numeric)::text, '-'),
    coalesce(p_outside_reason, '-'),
    coalesce(v_note, '-'),
    coalesce(p_has_selfie, false)::text
  ));

  -- Idempotency: the same event sent again gets the row it made.
  select p.* into v_existing
  from public.punches p
  where p.organisation_id = v_org and p.worker_id = v_worker
    and p.client_event_id = p_client_event_id;
  if found then
    if v_existing.payload_hash <> v_hash then
      raise exception 'A different punch was already sent under this id.' using errcode = 'MLPU2';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'duplicate', true,
      'kind', v_existing.kind,
      'recorded_at', v_existing.recorded_at,
      'geofence_result', v_existing.geofence_result,
      'distance_m', v_existing.distance_m,
      'flags', to_jsonb(v_existing.flags),
      'selfie_wanted', v_existing.selfie_expected and v_existing.selfie_path is null
        and v_existing.selfie_deleted_at is null
    );
  end if;

  if v_status = 'ended' then
    raise exception 'You have left this company, so you can''t clock in.' using errcode = 'MLPU3';
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
    or (p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m = 'NaN'::double precision))
    or (p_outside_reason is not null
      and p_outside_reason not in ('gate_locked', 'errand', 'location_wrong', 'other'))
    or (v_note is not null and not private.punch_note_ok(v_note))
    or (v_note is not null and p_outside_reason is null) then
    raise exception 'This punch has values that aren''t valid.' using errcode = 'MLPU5';
  end if;

  if not private.worker_has_consent(v_org, v_worker, 'location') then
    raise exception 'Agree to share your location first, or ask your supervisor to clock you in.'
      using errcode = 'MLPU6';
  end if;

  -- At most 20 punches an hour per worker.
  if (
    select count(*) from public.punches p
    where p.worker_id = v_worker and p.received_at > v_received - interval '1 hour'
  ) >= 20 then
    raise exception 'Too many punches in the last hour. Try again later.' using errcode = 'MLPU8';
  end if;

  -- Time.
  select t.recorded_at, t.time_source into v_recorded, v_time_source
  from private.punch_corrected_time(p_device_time, p_sent_device_time, p_elapsed_ms, v_received) t;
  v_drift := round(extract(epoch from (p_device_time - v_recorded)))::integer;

  -- The punch before this one, by the time it happened.
  select p.* into v_prev
  from public.punches p
  where p.worker_id = v_worker and p.organisation_id = v_org and p.recorded_at <= v_recorded
  order by p.recorded_at desc, p.created_at desc
  limit 1;

  -- The shift. A clock-out belongs to its open clock-in's shift when it has one.
  if p_kind = 'out' and v_prev.kind = 'in' and v_prev.shift_assignment_id is not null
    and v_prev.recorded_at > v_recorded - interval '20 hours' then
    select a.id, a.shift_id, a.site_id, a.starts_at, a.ends_at
    into v_asg_id, v_asg_shift, v_asg_site, v_asg_start, v_asg_end
    from public.shift_assignments a
    where a.organisation_id = v_org and a.id = v_prev.shift_assignment_id;
  end if;
  if v_asg_id is null then
    select a.id, a.shift_id, a.site_id, a.starts_at, a.ends_at
    into v_asg_id, v_asg_shift, v_asg_site, v_asg_start, v_asg_end
    from public.shift_assignments a
    where a.organisation_id = v_org
      and a.worker_id = v_worker
      and a.status = 'assigned'
      and v_recorded >= a.starts_at - interval '2 hours'
      and v_recorded <= a.ends_at + interval '4 hours'
    -- A published assignment (slice 3.3) before an unpublished one, then the nearest start.
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

  -- The site: the shift's; else one the worker is mapped to or rostered at (never another
  -- company's); else, for a clock-out, the clock-in's.
  v_today := private.org_today(v_org);
  if v_asg_id is not null then
    v_site := v_asg_site;
  elsif p_site_id is not null then
    if not exists (
      select 1 from public.worker_assignments wa
      where wa.organisation_id = v_org and wa.worker_id = v_worker and wa.site_id = p_site_id
        and wa.effective_from <= v_today + 1
        and (wa.effective_to is null or wa.effective_to >= v_today - 1)
    ) and not exists (
      select 1 from public.shift_assignments a
      where a.organisation_id = v_org and a.worker_id = v_worker and a.site_id = p_site_id
        and a.shift_date between v_today - 2 and v_today + 1
    ) then
      raise exception 'You aren''t working at that site.' using errcode = 'MLPU7';
    end if;
    v_site := p_site_id;
  elsif p_kind = 'out' and v_prev.kind = 'in' then
    v_site := v_prev.site_id;
  end if;

  -- Where.
  if v_has_point then
    v_point := extensions.st_setsrid(
      extensions.st_makepoint(p_longitude, p_latitude), 4326
    )::extensions.geography;
    v_accuracy := least(round(coalesce(p_accuracy_m, 0)), 100000)::integer;
    if v_site is not null then
      v_result := coalesce(private.site_geofence_check(v_org, v_site, v_point, v_accuracy), 'unknown');
      select round(extensions.st_distance(coalesce(s.centre, s.geofence), v_point))::integer
      into v_distance
      from public.sites s
      where s.organisation_id = v_org and s.id = v_site
        and coalesce(s.centre, s.geofence) is not null;
    end if;
  end if;
  if v_result in ('outside', 'near') then
    v_reason := p_outside_reason;
  else
    v_reason := null;
    v_note := null;
  end if;

  -- The selfie: clock-ins only, and only with the worker's consent.
  v_selfie := p_kind = 'in' and coalesce(p_has_selfie, false)
    and private.worker_has_consent(v_org, v_worker, 'selfie');

  select o.late_grace_minutes into v_grace from public.organisations o where o.id = v_org;
  v_flags := private.punch_flags(
    p_kind, v_result, v_has_point, v_selfie, v_asg_start, v_asg_end, v_grace,
    v_recorded, v_received, v_drift, v_time_source, v_prev.kind, v_prev.recorded_at
  );

  insert into public.punches (
    organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
    shift_assignment_id, shift_id, site_id, device_time, received_at, recorded_at, time_source,
    clock_drift_seconds, location, accuracy_m, distance_m, geofence_result, outside_reason,
    outside_note, selfie_expected, flags, payload_hash
  ) values (
    v_org, v_worker, p_kind, 'self', v_uid, p_client_event_id,
    v_asg_id, v_asg_shift, v_site, p_device_time, v_received, v_recorded, v_time_source,
    v_drift, v_point, case when v_has_point then v_accuracy end, v_distance, v_result, v_reason,
    v_note, v_selfie, v_flags, v_hash
  )
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'duplicate', false,
    'kind', v_row.kind,
    'recorded_at', v_row.recorded_at,
    'geofence_result', v_row.geofence_result,
    'distance_m', v_row.distance_m,
    'flags', to_jsonb(v_row.flags),
    'selfie_wanted', v_row.selfie_expected
  );
end;
$$;

revoke all on function private.record_punch(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, uuid, double precision,
  double precision, double precision, text, text, boolean
) from public, anon;
grant execute on function private.record_punch(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, uuid, double precision,
  double precision, double precision, text, text, boolean
) to authenticated;

create function public.record_punch(
  p_expected_organisation_id uuid,
  p_expected_worker_id uuid,
  p_client_event_id uuid,
  p_kind text,
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_site_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_outside_reason text,
  p_outside_note text,
  p_has_selfie boolean
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_punch(
    p_expected_organisation_id, p_expected_worker_id, p_client_event_id, p_kind, p_device_time,
    p_sent_device_time, p_elapsed_ms, p_site_id, p_latitude, p_longitude, p_accuracy_m,
    p_outside_reason, p_outside_note, p_has_selfie
  )
$$;

revoke all on function public.record_punch(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, uuid, double precision,
  double precision, double precision, text, text, boolean
) from public, anon;
grant execute on function public.record_punch(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, uuid, double precision,
  double precision, double precision, text, text, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. What the clock screen needs (the worker's own, read with their session)
-- ---------------------------------------------------------------------------

-- For the signed-in worker in `p_organisation_id` (their own worker membership only): whether
-- Shifts is on, the grace minutes, their consents, their last punch, their assigned shifts from
-- 20 hours ago to 24 hours ahead with the post's name, and the sites they can clock in at with
-- each geofence (for the screen's distance preview; the server decides). A definer because a
-- worker rostered at a site they aren't mapped to can't read that site, and workers can't read
-- posts.
create function private.my_clock_context(p_organisation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_today date;
  v_result jsonb;
begin
  select m.worker_id into v_worker
  from public.memberships m
  where m.organisation_id = p_organisation_id
    and m.user_id = (select private.session_uid())
    and m.role = 'worker'
    and m.worker_id is not null;
  if v_worker is null then
    raise exception 'Only the worker can do this, signed in to the worker app.' using errcode = 'MLPU1';
  end if;
  v_today := private.org_today(p_organisation_id);

  with asg as (
    select a.id, a.shift_id, a.site_id, a.starts_at, a.ends_at, p.name as post_name
    from public.shift_assignments a
    join public.shifts s on s.organisation_id = a.organisation_id and s.id = a.shift_id
    join public.posts p on p.organisation_id = s.organisation_id and p.id = s.post_id
    where a.organisation_id = p_organisation_id and a.worker_id = v_worker
      and a.status = 'assigned'
      and a.ends_at > now() - interval '20 hours'
      and a.starts_at < now() + interval '24 hours'
    order by a.starts_at
    limit 6
  ),
  site_ids as (
    select asg.site_id as id from asg
    union
    select wa.site_id from public.worker_assignments wa
    where wa.organisation_id = p_organisation_id and wa.worker_id = v_worker
      and wa.site_id is not null
      and wa.effective_from <= v_today
      and (wa.effective_to is null or wa.effective_to >= v_today)
  ),
  last_punch as (
    select p.kind, p.recorded_at, p.site_id
    from public.punches p
    where p.organisation_id = p_organisation_id and p.worker_id = v_worker
    order by p.recorded_at desc, p.created_at desc
    limit 1
  )
  select jsonb_build_object(
    'worker_id', v_worker,
    'worker_status', (select w.status from public.workers w where w.id = v_worker),
    'shifts_enabled', private.org_shifts_enabled(p_organisation_id),
    'late_grace_minutes', (select o.late_grace_minutes from public.organisations o where o.id = p_organisation_id),
    'location_consent', private.worker_has_consent(p_organisation_id, v_worker, 'location'),
    'selfie_consent', private.worker_has_consent(p_organisation_id, v_worker, 'selfie'),
    'last_punch', (select to_jsonb(lp) from last_punch lp),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', asg.id, 'shift_id', asg.shift_id, 'site_id', asg.site_id,
        'starts_at', asg.starts_at, 'ends_at', asg.ends_at, 'post_name', asg.post_name
      ) order by asg.starts_at)
      from asg
    ), '[]'::jsonb),
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'centre_lat', extensions.st_y(extensions.geometry(s.centre)),
        'centre_lng', extensions.st_x(extensions.geometry(s.centre)),
        'radius_m', s.radius_m,
        'boundary', extensions.st_asgeojson(s.boundary, 7)::jsonb,
        'has_geofence', s.geofence is not null
      ) order by s.name)
      from public.sites s
      where s.organisation_id = p_organisation_id
        and s.id in (select site_ids.id from site_ids)
        and s.status = 'active'
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function private.my_clock_context(uuid) from public, anon;
grant execute on function private.my_clock_context(uuid) to authenticated;

create function public.my_clock_context(p_organisation_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.my_clock_context(p_organisation_id)
$$;

revoke all on function public.my_clock_context(uuid) from public, anon;
grant execute on function public.my_clock_context(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Raw coordinates: owner and admin only, audited
-- ---------------------------------------------------------------------------

create function private.punch_locations(p_organisation_id uuid, p_punch_ids uuid[])
returns table (punch_id uuid, latitude double precision, longitude double precision, accuracy_m integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin']) then
    raise exception 'Only an owner or admin sees where a punch was made.' using errcode = '42501';
  end if;
  if p_punch_ids is null or cardinality(p_punch_ids) = 0 then
    return;
  end if;
  if cardinality(p_punch_ids) > 200 then
    raise exception 'At most 200 punches at a time.' using errcode = '22023';
  end if;
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, auth.uid(), 'punch.location_viewed', 'punches',
    case when cardinality(p_punch_ids) = 1 then p_punch_ids[1] end,
    null,
    jsonb_build_object('count', cardinality(p_punch_ids))
  );
  return query
    select p.id,
      extensions.st_y(extensions.geometry(p.location)),
      extensions.st_x(extensions.geometry(p.location)),
      p.accuracy_m
    from public.punches p
    where p.organisation_id = p_organisation_id
      and p.id = any (p_punch_ids)
      and p.location is not null;
end;
$$;

revoke all on function private.punch_locations(uuid, uuid[]) from public, anon;
grant execute on function private.punch_locations(uuid, uuid[]) to authenticated;

create function public.punch_locations(p_organisation_id uuid, p_punch_ids uuid[])
returns table (punch_id uuid, latitude double precision, longitude double precision, accuracy_m integer)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.punch_locations(p_organisation_id, p_punch_ids)
$$;

revoke all on function public.punch_locations(uuid, uuid[]) from public, anon;
grant execute on function public.punch_locations(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Selfies: bucket, reads, attach, retention
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('punch-photos', 'punch-photos', false, 204800, array['image/jpeg', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Read: owner, admin and ops_manager of the punch's company, and a line manager for their
-- reportees' punches; only for a path a punch holds now (a deleted selfie stops opening). No
-- insert, update or delete policies: the server uploads with the secret key after checking the
-- bytes, and only the sweep deletes.
create policy punch_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'punch-photos'
    and exists (
      select 1
      from public.punches p
      where p.selfie_path = objects.name
        and (
          p.organisation_id in (select private.role_org_ids(array['owner', 'admin', 'ops_manager']))
          or p.worker_id in (select private.my_reportee_ids())
        )
    )
  );

-- The path a punch's selfie must have.
create function private.punch_selfie_path(p_punch public.punches, p_ext text)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_punch.organisation_id::text || '/'
    || to_char(p_punch.created_at at time zone 'UTC', 'YYYY-MM') || '/'
    || p_punch.id::text || '.' || p_ext
$$;

revoke all on function private.punch_selfie_path(public.punches, text) from public, anon, authenticated;

-- Secret key only: records the checked upload on the actor's own punch. The server names the
-- worker login it verified (p_actor), checked here as if they had called.
create function private.attach_punch_selfie(p_punch_id uuid, p_actor uuid, p_path text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_punch public.punches;
  v_ext text;
  v_size bigint;
  v_mime text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server attaches selfies.' using errcode = '42501';
  end if;
  select p.* into v_punch from public.punches p where p.id = p_punch_id for update;
  if not found or p_actor is null or not exists (
    select 1 from public.memberships m
    where m.user_id = p_actor and m.role = 'worker'
      and m.organisation_id = v_punch.organisation_id and m.worker_id = v_punch.worker_id
  ) then
    raise exception 'That punch wasn''t found.' using errcode = 'MLPS1';
  end if;
  if v_punch.kind <> 'in' or not v_punch.selfie_expected or v_punch.selfie_path is not null
    or v_punch.selfie_deleted_at is not null or v_punch.created_at < now() - interval '24 hours' then
    raise exception 'This punch doesn''t take a selfie now.' using errcode = 'MLPS1';
  end if;
  v_ext := substring(p_path from '\.(webp|jpg)$');
  if v_ext is null or p_path <> private.punch_selfie_path(v_punch, v_ext) then
    raise exception 'That isn''t this punch''s selfie.' using errcode = 'MLPS1';
  end if;
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_size, v_mime
  from storage.objects o
  where o.bucket_id = 'punch-photos' and o.name = p_path;
  if v_size is null or v_size < 1 or v_size > 204800
    or v_mime is distinct from (case v_ext when 'webp' then 'image/webp' else 'image/jpeg' end) then
    raise exception 'The selfie isn''t in storage as stated.' using errcode = 'MLPS2';
  end if;
  perform set_config('metalira.audit_channel', 'worker_app', true);
  update public.punches
  set selfie_path = p_path, selfie_uploaded_at = now()
  where id = v_punch.id;
end;
$$;

-- Secret key only: selfies past 90 days whose punch is not under review, oldest first.
create function private.punch_selfies_due(p_limit integer default 500)
returns table (punch_id uuid, selfie_path text)
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
    select p.id, p.selfie_path
    from public.punches p
    where p.selfie_path is not null
      and p.created_at < now() - interval '90 days'
      and not private.punch_under_review(p.organisation_id, p.id)
    order by p.created_at
    limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;

-- Secret key only: records that a selfie's file was deleted (the row stays).
create function private.clear_punch_selfie(p_punch_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server sweeps selfies.' using errcode = '42501';
  end if;
  perform set_config('metalira.audit_channel', 'system', true);
  update public.punches p
  set selfie_path = null, selfie_deleted_at = now()
  where p.id = p_punch_id
    and p.selfie_path is not null
    and p.created_at < now() - interval '90 days'
    and not private.punch_under_review(p.organisation_id, p.id);
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- Secret key only: uploads older than a day that no punch holds (an attach that failed).
create function private.punch_photo_orphans(p_limit integer default 500)
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
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;

revoke all on function private.attach_punch_selfie(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.punch_selfies_due(integer) from public, anon, authenticated;
revoke all on function private.clear_punch_selfie(uuid) from public, anon, authenticated;
revoke all on function private.punch_photo_orphans(integer) from public, anon, authenticated;
grant execute on function private.attach_punch_selfie(uuid, uuid, text) to service_role;
grant execute on function private.punch_selfies_due(integer) to service_role;
grant execute on function private.clear_punch_selfie(uuid) to service_role;
grant execute on function private.punch_photo_orphans(integer) to service_role;

-- The Data API names (invoker wrappers; the secret key only).
create function public.attach_punch_selfie(p_punch_id uuid, p_actor uuid, p_path text)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$ select private.attach_punch_selfie(p_punch_id, p_actor, p_path) $$;

create function public.punch_selfies_due(p_limit integer default 500)
returns table (punch_id uuid, selfie_path text)
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.punch_selfies_due(p_limit) $$;

create function public.clear_punch_selfie(p_punch_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$ select private.clear_punch_selfie(p_punch_id) $$;

create function public.punch_photo_orphans(p_limit integer default 500)
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$ select * from private.punch_photo_orphans(p_limit) $$;

revoke all on function public.attach_punch_selfie(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.punch_selfies_due(integer) from public, anon, authenticated;
revoke all on function public.clear_punch_selfie(uuid) from public, anon, authenticated;
revoke all on function public.punch_photo_orphans(integer) from public, anon, authenticated;
grant execute on function public.attach_punch_selfie(uuid, uuid, text) to service_role;
grant execute on function public.punch_selfies_due(integer) to service_role;
grant execute on function public.clear_punch_selfie(uuid) to service_role;
grant execute on function public.punch_photo_orphans(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Staff ID corrections: punches are work records (slice 1.11 hook)
-- ---------------------------------------------------------------------------

-- True when the worker has punches, or when a timesheet or pay table exists (Phase 4 MUST
-- replace those checks with real ones; until then they fail closed, as before).
create or replace function private.worker_has_work_records(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_organisation_id is null or p_worker_id is null then
    return true;
  end if;
  return exists (
      select 1 from public.punches p
      where p.organisation_id = p_organisation_id and p.worker_id = p_worker_id
    )
    or to_regclass('public.timesheets') is not null
    or to_regclass('public.timesheet_lines') is not null
    or to_regclass('public.payroll_lines') is not null
    or to_regclass('public.payslips') is not null;
end;
$$;
