-- Slice 3.8: QR checkpoint scans for patrols.
--
-- A patrol guard scans the QR code printed for a checkpoint (slice 2.2, `site_checkpoints`).
-- The code opens /m/checkpoint#<token>: the token is in the URL fragment, so the browser never
-- sends it to the server and it never reaches a request log (Phase 3 "Carried forward"). The
-- phone saves the scan in the offline queue (slice 3.4) and sends it with the worker's own
-- session, like a clock-in.
--
-- 1. `punches` gains kind 'checkpoint' and `checkpoint_id` (composite foreign key to
--    site_checkpoints, so a scan always points at a checkpoint of its own company). A checkpoint
--    punch has a checkpoint and nothing else does. Still insert-only: the 3.5 guard refuses
--    every change but the selfie's, and a checkpoint punch never has a selfie.
-- 2. `record_checkpoint_scan`: the only way a scan is written. A security definer called with
--    the worker's own session (search_path ''), like record_punch:
--    * the worker and organisation come from the caller's own worker membership (the queue owner
--      the phone sends is only compared: MLPU9, retryable); an untrusted session is refused
--      (42501, private.session_uid() is null);
--    * refused for a leaver (MLPU3), with Shifts off (MLPU4) and without location consent
--      (MLPU6), checked before the token is looked at;
--    * the token is looked up among the active checkpoints of the session's organisation only.
--      Tokens are stored as they are printed (slice 2.2 design: 32 random bytes, hex, unique), so
--      it is an equality match. An unknown token, another company's token, a retired checkpoint
--      and a malformed token all get the same refusal (MLCK1, same message): the answer never
--      says whether a code exists elsewhere;
--    * the worker must be on an assigned (not removed) shift at the checkpoint's site at the
--      scan's server-corrected time, 30 minutes either side (MLCK2). Offline scans are judged
--      by when they happened, not when they arrived;
--    * the time is corrected as for punches (private.punch_corrected_time) and flagged the same
--      way (clock_drift, delayed, late_sync, time_unverified); device times outside 2020-2100
--      are refused (MLPU5), as for punches;
--    * the geofence is worked out here with private.site_geofence_check for the session's
--      organisation (never from client input); distance_m is from the checkpoint's own pin when
--      it has one, else from the site's centre;
--    * idempotent per worker on client_event_id (the same scan again returns its row; a
--      different event under the same id is MLPU2; another worker's id is theirs alone);
--    * at most 120 scans an hour per worker (MLPU8);
--    * a scan more than 24 hours old (by its corrected time) is refused (MLPU5);
--    * a scan the phone saved with no live session (offline, under the last signed-in worker)
--      carries `queued_offline` (p_queued_offline), so the history marks it for review.
--    The answer carries the checkpoint's and site's names for the done screen, never the token.
-- 3. record_punch, my_clock_context and attendance_board (3.7) look only at clock-ins and
--    clock-outs: a scan is not the
--    "punch before" a clock-out, does not count toward the 20 clock punches an hour, and is never
--    the worker's last punch on the clock screen. (Slices 3.6 and 3.7: if you replace either
--    function, keep the `p.kind in ('in', 'out')` filters.)
--
-- Who reads scans: as for punches (3.5 policy, unchanged): the worker their own; owner, admin,
-- ops_manager and hr every one in the company; a line manager their reportees'. The patrol
-- history page (/app/attendance/patrols) reads them under RLS. The point stays ungranted.
--
-- Logs: the server and the phone never log a token, a location or a photo path; the audit rows
-- of punches leave the point out (private.punches_audit) and the token is never stored on a
-- punch (payload_hash takes its sha256 inside an md5, not the token).
--
-- Refusals (SQLSTATE), mapped to fixed codes in src/lib/punches/codes.ts:
--   MLCK1 not a checkpoint this worker can scan (unknown, another company's, retired, malformed)
--   MLCK2 not on a shift at the checkpoint's site at the time of the scan
--   and from 3.5: 42501, MLPU1, MLPU2, MLPU3, MLPU4, MLPU5, MLPU6, MLPU8, MLPU9.

-- ---------------------------------------------------------------------------
-- 1. punches: kind 'checkpoint' and the checkpoint
-- ---------------------------------------------------------------------------

alter table public.punches
  drop constraint punches_kind_value,
  add constraint punches_kind_value check (kind in ('in', 'out', 'checkpoint')),
  add column checkpoint_id uuid,
  add constraint punches_checkpoint_fkey foreign key (organisation_id, checkpoint_id)
    references public.site_checkpoints (organisation_id, id),
  add constraint punches_checkpoint_only_scans check ((kind = 'checkpoint') = (checkpoint_id is not null)),
  -- A scan always has its site (the checkpoint's) and never a reason, note or selfie.
  add constraint punches_checkpoint_shape check (
    kind <> 'checkpoint'
    or (site_id is not null and outside_reason is null and not selfie_expected)
  );

-- The patrol history: a site's scans on a day.
create index punches_checkpoint_site_idx on public.punches (organisation_id, site_id, recorded_at)
  where kind = 'checkpoint';

comment on column public.punches.checkpoint_id is
  'The checkpoint a patrol scan (kind checkpoint, slice 3.8) was made at. Null for clock-ins and clock-outs.';
comment on column public.punches.distance_m is
  'Metres from the site''s centre (or its outline when it has no centre). For a checkpoint scan, from the checkpoint''s pin when it has one.';

grant select (checkpoint_id) on table public.punches to authenticated;

-- ---------------------------------------------------------------------------
-- 2. record_checkpoint_scan
-- ---------------------------------------------------------------------------

-- How far before a shift's start and after its end a scan still counts as on that shift.
create function private.checkpoint_scan_slack()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 minutes' $$;

revoke all on function private.checkpoint_scan_slack() from public, anon, authenticated;

-- The oldest scan the server records: 24 hours (clock punches: private.punch_max_elapsed, 7 days).
create function private.checkpoint_scan_max_age()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '24 hours' $$;

revoke all on function private.checkpoint_scan_max_age() from public, anon, authenticated;

-- Every flag a punch can carry: the 3.5 list plus `queued_offline`, a checkpoint scan the phone
-- saved with no live session (static QR codes can be scanned offline; security review L2).
create or replace function private.punch_flag_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'outside', 'near', 'no_location', 'no_shift', 'late', 'early_out', 'no_selfie',
    'clock_drift', 'delayed', 'late_sync', 'time_unverified', 'double_in', 'out_without_in',
    'queued_offline'
  ]
$$;

create function private.record_checkpoint_scan(
  p_expected_organisation_id uuid,
  p_expected_worker_id uuid,
  p_client_event_id uuid,
  p_token text,
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_queued_offline boolean default false
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
  v_received timestamptz := now();
  v_recorded timestamptz;
  v_time_source text;
  v_drift integer;
  v_has_point boolean;
  v_point extensions.geography;
  v_accuracy integer;
  v_checkpoint public.site_checkpoints;
  v_asg_id uuid;
  v_asg_shift uuid;
  v_asg_start timestamptz;
  v_asg_end timestamptz;
  v_result text := 'unknown';
  v_distance integer;
  v_flags text[];
  v_row public.punches;
begin
  if v_uid is null then
    raise exception 'Sign in to the worker app to scan checkpoints.' using errcode = '42501';
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
      raise exception 'This scan was saved by someone else on this phone.' using errcode = 'MLPU9';
    end if;
    raise exception 'Only a worker can scan checkpoints, signed in to the worker app.'
      using errcode = 'MLPU1';
  end if;

  if p_client_event_id is null or p_device_time is null
    or p_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00'
    or (p_sent_device_time is not null
      and p_sent_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00')
    or (p_elapsed_ms is not null and abs(p_elapsed_ms) > 1000000000000) then
    raise exception 'This scan is incomplete.' using errcode = 'MLPU5';
  end if;

  perform set_config('metalira.audit_channel', 'worker_app', true);
  -- One punch at a time per worker (shared with record_punch).
  perform pg_advisory_xact_lock(hashtextextended('punches:' || v_worker::text, 0));

  -- The token itself is never stored: only its sha256, inside the md5.
  v_hash := md5(concat_ws('|',
    'checkpoint',
    (extract(epoch from p_device_time) * 1000)::bigint,
    encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex'),
    coalesce(round(p_latitude::numeric, 6)::text, '-'),
    coalesce(round(p_longitude::numeric, 6)::text, '-'),
    coalesce(round(p_accuracy_m::numeric)::text, '-'),
    coalesce(p_queued_offline, false)::text
  ));

  -- Idempotency: the same scan sent again gets the row it made.
  select p.* into v_existing
  from public.punches p
  where p.organisation_id = v_org and p.worker_id = v_worker
    and p.client_event_id = p_client_event_id;
  if found then
    if v_existing.payload_hash <> v_hash or v_existing.kind <> 'checkpoint' then
      raise exception 'A different punch was already sent under this id.' using errcode = 'MLPU2';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'duplicate', true,
      'recorded_at', v_existing.recorded_at,
      'geofence_result', v_existing.geofence_result,
      'distance_m', v_existing.distance_m,
      'flags', to_jsonb(v_existing.flags),
      'checkpoint_name', (
        select c.name from public.site_checkpoints c
        where c.organisation_id = v_org and c.id = v_existing.checkpoint_id
      ),
      'site_name', (
        select s.name from public.sites s
        where s.organisation_id = v_org and s.id = v_existing.site_id
      )
    );
  end if;

  -- The worker, before the token is looked at (these answers say nothing about the code).
  if v_status = 'ended' then
    raise exception 'You have left this company, so you can''t scan checkpoints.'
      using errcode = 'MLPU3';
  end if;
  if not private.org_shifts_enabled(v_org) then
    raise exception 'Patrol scans are switched off for your company.' using errcode = 'MLPU4';
  end if;

  v_has_point := p_latitude is not null and p_longitude is not null;
  if (p_latitude is null) <> (p_longitude is null)
    or (v_has_point and (
      p_latitude not between -90 and 90 or p_longitude not between -180 and 180
      or p_latitude = 'NaN'::double precision or p_longitude = 'NaN'::double precision
    ))
    or (p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m = 'NaN'::double precision)) then
    raise exception 'This scan has values that aren''t valid.' using errcode = 'MLPU5';
  end if;

  if not private.worker_has_consent(v_org, v_worker, 'location') then
    raise exception 'Agree to share your location first.' using errcode = 'MLPU6';
  end if;

  if (
    select count(*) from public.punches p
    where p.worker_id = v_worker and p.kind = 'checkpoint'
      and p.received_at > v_received - interval '1 hour'
  ) >= 120 then
    raise exception 'Too many scans in the last hour. Try again later.' using errcode = 'MLPU8';
  end if;

  -- Time. A scan more than 24 hours old is refused (a patrol scan is only worth having fresh;
  -- clock punches allow 7 days). Checked before the token, so it says nothing about the code.
  select t.recorded_at, t.time_source into v_recorded, v_time_source
  from private.punch_corrected_time(p_device_time, p_sent_device_time, p_elapsed_ms, v_received) t;
  if v_recorded < v_received - private.checkpoint_scan_max_age() then
    raise exception 'This scan is more than 24 hours old.' using errcode = 'MLPU5';
  end if;
  v_drift := round(extract(epoch from (p_device_time - v_recorded)))::integer;

  -- The checkpoint: active, in the session's organisation only. One refusal for every miss.
  if p_token is not null and p_token ~ '^[0-9a-f]{64}$' then
    select c.* into v_checkpoint
    from public.site_checkpoints c
    where c.organisation_id = v_org
      and c.qr_token = p_token
      and c.status = 'active';
  end if;
  if v_checkpoint.id is null then
    raise exception 'This code isn''t a checkpoint you can scan.' using errcode = 'MLCK1';
  end if;

  -- The shift at the checkpoint's site that holds the scan, a published one (slice 3.3) first.
  select a.id, a.shift_id, a.starts_at, a.ends_at
  into v_asg_id, v_asg_shift, v_asg_start, v_asg_end
  from public.shift_assignments a
  where a.organisation_id = v_org
    and a.worker_id = v_worker
    and a.site_id = v_checkpoint.site_id
    and a.status = 'assigned'
    and v_recorded >= a.starts_at - private.checkpoint_scan_slack()
    and v_recorded <= a.ends_at + private.checkpoint_scan_slack()
  order by exists (
      select 1 from public.roster_publications rp
      where rp.organisation_id = a.organisation_id
        and rp.site_id = a.site_id
        and rp.week_start = a.shift_date - (extract(isodow from a.shift_date)::integer - 1)
        and rp.snapshot @> jsonb_build_array(jsonb_build_object('a', a.id::text))
    ) desc,
    abs(extract(epoch from (v_recorded - a.starts_at))), a.starts_at
  limit 1;
  if v_asg_id is null then
    raise exception 'You aren''t on a shift at this site now.' using errcode = 'MLCK2';
  end if;

  -- Where: the geofence for the session's organisation, worked out here.
  if v_has_point then
    v_point := extensions.st_setsrid(
      extensions.st_makepoint(p_longitude, p_latitude), 4326
    )::extensions.geography;
    v_accuracy := least(round(coalesce(p_accuracy_m, 0)), 100000)::integer;
    v_result := coalesce(
      private.site_geofence_check(v_org, v_checkpoint.site_id, v_point, v_accuracy), 'unknown'
    );
    if v_checkpoint.location is not null then
      v_distance := round(extensions.st_distance(v_checkpoint.location, v_point))::integer;
    else
      select round(extensions.st_distance(coalesce(s.centre, s.geofence), v_point))::integer
      into v_distance
      from public.sites s
      where s.organisation_id = v_org and s.id = v_checkpoint.site_id
        and coalesce(s.centre, s.geofence) is not null;
    end if;
  end if;

  v_flags := private.punch_flags(
    'checkpoint', v_result, v_has_point, false, v_asg_start, v_asg_end, 0,
    v_recorded, v_received, v_drift, v_time_source, null, null
  );
  -- Saved on the phone with no live session (the last signed-in worker, offline): reviewed.
  if coalesce(p_queued_offline, false) then
    v_flags := array_append(v_flags, 'queued_offline'::text);
  end if;

  insert into public.punches (
    organisation_id, worker_id, kind, source, recorded_by_user, client_event_id,
    shift_assignment_id, shift_id, site_id, checkpoint_id, device_time, received_at, recorded_at,
    time_source, clock_drift_seconds, location, accuracy_m, distance_m, geofence_result,
    selfie_expected, flags, payload_hash
  ) values (
    v_org, v_worker, 'checkpoint', 'self', v_uid, p_client_event_id,
    v_asg_id, v_asg_shift, v_checkpoint.site_id, v_checkpoint.id, p_device_time, v_received,
    v_recorded, v_time_source, v_drift, v_point, case when v_has_point then v_accuracy end,
    v_distance, v_result, false, v_flags, v_hash
  )
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'duplicate', false,
    'recorded_at', v_row.recorded_at,
    'geofence_result', v_row.geofence_result,
    'distance_m', v_row.distance_m,
    'flags', to_jsonb(v_row.flags),
    'checkpoint_name', v_checkpoint.name,
    'site_name', (
      select s.name from public.sites s
      where s.organisation_id = v_org and s.id = v_checkpoint.site_id
    )
  );
end;
$$;

revoke all on function private.record_checkpoint_scan(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, double precision, double precision,
  double precision, boolean
) from public, anon;
grant execute on function private.record_checkpoint_scan(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, double precision, double precision,
  double precision, boolean
) to authenticated;

create function public.record_checkpoint_scan(
  p_expected_organisation_id uuid,
  p_expected_worker_id uuid,
  p_client_event_id uuid,
  p_token text,
  p_device_time timestamptz,
  p_sent_device_time timestamptz,
  p_elapsed_ms bigint,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision,
  p_queued_offline boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_checkpoint_scan(
    p_expected_organisation_id, p_expected_worker_id, p_client_event_id, p_token, p_device_time,
    p_sent_device_time, p_elapsed_ms, p_latitude, p_longitude, p_accuracy_m,
    coalesce(p_queued_offline, false)
  )
$$;

revoke all on function public.record_checkpoint_scan(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, double precision, double precision,
  double precision, boolean
) from public, anon;
grant execute on function public.record_checkpoint_scan(
  uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, double precision, double precision,
  double precision, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Clock-ins and clock-outs ignore scans (3.5 functions, two filters added)
-- ---------------------------------------------------------------------------

-- record_punch: the punch before this one and the hourly limit count clock punches only.
create or replace function private.record_punch(
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
    or p_device_time is null
    or p_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00'
    or (p_sent_device_time is not null
      and p_sent_device_time not between '2020-01-01 00:00:00+00' and '2100-01-01 00:00:00+00')
    or (p_elapsed_ms is not null and abs(p_elapsed_ms) > 1000000000000) then
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
      and p.kind in ('in', 'out')
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
    and p.kind in ('in', 'out')
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

-- my_clock_context: the worker's last clock punch, never a scan.
create or replace function private.my_clock_context(p_organisation_id uuid)
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
      and p.kind in ('in', 'out')
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

-- attendance_board (slice 3.7): a shift's punches are its clock-ins and clock-outs; scans carry the
-- shift too, but never decide on site, clocked out or the flags. Only the filter is new.
create or replace function private.attendance_board(p_organisation_id uuid)
returns table (
  assignment_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_id uuid,
  site_name text,
  post_id uuid,
  post_name text,
  worker_id uuid,
  worker_name text,
  staff_id text,
  phone text,
  phone_last4 text,
  published boolean,
  first_in_at timestamptz,
  last_punch_kind text,
  last_punch_at timestamptz,
  punch_flags text[],
  by_supervisor boolean,
  status text,
  late_minutes integer,
  site_last_sync_at timestamptz,
  site_late_syncs integer,
  board_at timestamptz,
  late_grace_minutes integer,
  no_show_after_minutes integer,
  time_zone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_all boolean;
  v_crew boolean;
  v_phone boolean;
  v_zone text;
  v_grace integer;
  v_no_show integer;
  v_enabled boolean;
  v_day_start timestamptz;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Your role can''t see live attendance.' using errcode = '42501';
  end if;
  v_all := private.has_role(p_organisation_id, array['owner', 'admin', 'hr', 'ops_manager']);
  v_crew := not v_all and private.has_role(p_organisation_id, array['line_manager']);
  if not (v_all or v_crew) then
    raise exception 'Your role can''t see live attendance.' using errcode = '42501';
  end if;
  -- workers_select: these roles read the phone on the people record; a line manager reads their
  -- reportees', and a line manager's rows are only their reportees.
  v_phone := v_crew or private.has_role(
    p_organisation_id, array['owner', 'admin', 'hr', 'finance', 'ops_manager']
  );

  select coalesce(o.timezone, 'Africa/Lagos'), o.late_grace_minutes, o.no_show_after_minutes,
    o.shifts_enabled
  into v_zone, v_grace, v_no_show, v_enabled
  from public.organisations o
  where o.id = p_organisation_id;
  if not coalesce(v_enabled, false) then
    return;
  end if;
  -- Midnight today on the company's clock.
  v_day_start := ((v_now at time zone v_zone)::date)::timestamp at time zone v_zone;

  return query
  with a as (
    select sa.id, sa.shift_date, sa.starts_at, sa.ends_at, sa.site_id, sa.worker_id, s.post_id
    from public.shift_assignments sa
    join public.shifts s on s.organisation_id = sa.organisation_id and s.id = sa.shift_id
    where sa.organisation_id = p_organisation_id
      and sa.status = 'assigned'
      and s.status = 'open'
      -- A shift is at most 24 hours long, so this bounds the index range on starts_at.
      and sa.starts_at >= v_day_start - interval '24 hours'
      and sa.starts_at <= v_now + interval '2 hours'
      and sa.ends_at > v_day_start
      and (v_all or sa.worker_id in (select private.my_reportee_ids()))
  ),
  p as (
    select pu.shift_assignment_id as assignment_id,
      min(pu.recorded_at) filter (where pu.kind = 'in') as first_in_at,
      (array_agg(pu.kind order by pu.recorded_at desc, pu.created_at desc))[1] as last_kind,
      max(pu.recorded_at) as last_at,
      coalesce(array_agg(distinct f.flag) filter (where f.flag is not null), '{}'::text[]) as flags,
      bool_or(pu.source = 'supervisor') as by_supervisor
    from public.punches pu
    left join lateral unnest(pu.flags) as f (flag) on true
    where pu.organisation_id = p_organisation_id
      and pu.shift_assignment_id in (select a.id from a)
      and pu.kind in ('in', 'out')
    group by pu.shift_assignment_id
  ),
  sy as (
    select pu.site_id,
      max(pu.received_at) as last_sync_at,
      (count(*) filter (where 'late_sync' = any (pu.flags) and pu.received_at >= v_day_start))::integer
        as late_syncs
    from public.punches pu
    where pu.organisation_id = p_organisation_id
      and pu.recorded_at >= v_day_start - interval '24 hours'
      and pu.site_id in (select a.site_id from a)
      and (v_all or pu.worker_id in (select private.my_reportee_ids()))
    group by pu.site_id
  ),
  b as (
    select a.*, p.first_in_at, p.last_kind, p.last_at, p.flags, p.by_supervisor,
      private.attendance_status(v_now, a.starts_at, a.ends_at, v_grace, v_no_show, p.last_kind)
        as status
    from a
    left join p on p.assignment_id = a.id
  )
  select r.id, r.shift_date, r.starts_at, r.ends_at, r.site_id, si.name, r.post_id, po.name,
    r.worker_id, btrim(w.first_name || ' ' || w.last_name), w.staff_id,
    case when v_phone then w.phone end,
    case when w.phone is not null then right(w.phone, 4) end,
    coalesce(pub.published, false),
    r.first_in_at, r.last_kind, r.last_at, coalesce(r.flags, '{}'::text[]),
    coalesce(r.by_supervisor, false),
    r.status,
    case
      when r.status in ('late', 'no_show') and r.first_in_at is null and v_now > r.starts_at then
        floor(extract(epoch from (least(v_now, r.ends_at) - r.starts_at)) / 60)::integer
      when r.first_in_at is not null
        and r.first_in_at > r.starts_at + make_interval(mins => v_grace) then
        floor(extract(epoch from (r.first_in_at - r.starts_at)) / 60)::integer
    end,
    sy.last_sync_at, coalesce(sy.late_syncs, 0),
    v_now, v_grace, v_no_show, v_zone
  from b r
  join public.workers w on w.organisation_id = p_organisation_id and w.id = r.worker_id
  join public.sites si on si.organisation_id = p_organisation_id and si.id = r.site_id
  join public.posts po on po.organisation_id = p_organisation_id and po.id = r.post_id
  left join sy on sy.site_id = r.site_id
  left join lateral (
    select rp.snapshot @> jsonb_build_array(jsonb_build_object('a', r.id::text)) as published
    from public.roster_publications rp
    where rp.organisation_id = p_organisation_id
      and rp.site_id = r.site_id
      and rp.week_start = r.shift_date - (extract(isodow from r.shift_date)::integer - 1)
    order by rp.version desc
    limit 1
  ) pub on true
  where w.end_date is null or w.end_date >= r.shift_date
  order by
    case r.status
      when 'no_show' then 1 when 'late' then 2 when 'starting' then 3 when 'on_site' then 4
      else 5
    end,
    r.starts_at, si.name, po.name, btrim(w.first_name || ' ' || w.last_name), r.id;
end;
$$;
