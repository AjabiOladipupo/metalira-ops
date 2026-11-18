-- Slice 1.11: PIN lockout rules, staff ID correction, first import (owner decisions 18, 19, 20).
--
-- A. PIN lockout (decision 18, on top of decision 6: 5 wrong tries lock sign-in for 15 minutes).
--    * The 3rd lockout within 24 hours holds the login (worker_credentials.held_at) until a new
--      PIN is set from an HR invite. Lockouts are the worker_auth.locked audit rows (insert-only,
--      written since slice 1.9), counted since the later of 24 hours ago and the last PIN set.
--      A manager unlock does not reset the count. A lockout inside a 15-minute window in which
--      the company reached its cap (a worker_auth.company_throttled row) doesn't count: a flood
--      across the company must not push workers into holds.
--    * public.unlock_worker_sign_in: owner, admin, hr and the worker's line manager lift a
--      15-minute lock (never a hold, never their own login, never a leaver's), audited as
--      worker_auth.unlocked. public.worker_sign_in_status gives line managers only the lock
--      state of their reportees (no table access to worker_credentials).
--    * Caps on wrong PINs per 15 minutes (src/lib/pin-lockout.ts has the same numbers):
--        - per company code: company_wrong_pin_cap (50). At the cap, sign-ins for that company
--          are refused before any PIN check and count against no worker. Workers already
--          signed in are not affected. Keyed by a hash of the typed code, so an unknown code
--          behaves the same as a real one.
--        - per network address: ip_wrong_pin_cap (15), well below the company cap, so one
--          address can't use up a company's allowance (or hold its workers) on its own.
--      Only wrong PINs count, and a success never gives one back, so a valid login can't be
--      used to reset a counter. The network address also has a cap on all tries (ip_limit,
--      100), with no refund either. See docs/PHASE_1.md slice 1.11 for the reasoning.
--    * A company code and staff ID with no login get the same lock and hold (a sliding 24-hour
--      window of their own lockout times) from private.auth_throttle, so the answers never
--      reveal which IDs exist. Held rows survive the quiet-day purge.
-- B. Staff ID correction (decision 19): public.staff_id_corrections, the two-person pattern of
--    bank_detail_changes (slice 1.7), applied to workers.staff_id on approval. An ID is never
--    reused in a company: not one any worker has or had (workers_staff_id_key), not one a
--    correction retired, not one a pending correction reserves.
-- C. First import (decision 20): the owner's first commit_import_batch while company setup is
--    unfinished writes bank details straight to the new workers, audited per worker. Every
--    other path keeps the two-person hold of slice 1.7.

-- ===========================================================================
-- A. PIN lockout
-- ===========================================================================

alter table public.worker_credentials
  add column held_at timestamptz;

comment on column public.worker_credentials.held_at is
  'Set at the 3rd lockout within 24 hours (owner decision 18): sign-in stays locked until a new PIN is set from an HR invite. Cleared only by private.accept_worker_invite_impl.';
comment on table public.worker_credentials is
  'A worker''s phone login: the synthetic Auth user, when the PIN was set and the sign-in lock (5 wrong PINs lock for 15 minutes; the 3rd lockout in 24 hours holds until a new PIN). Written only by the security-definer sign-in, invite and unlock functions. The PIN hash is in private.worker_pins.';

alter table private.auth_throttle
  drop constraint auth_throttle_key_format,
  add constraint auth_throttle_key_format
    check (key ~ '^(ip|ipwrong|subject|company):[0-9a-f]{64}$'),
  add column lockout_times timestamptz[] not null default '{}',
  add column held_at timestamptz;

comment on table private.auth_throttle is
  'Sign-in counters. ip:<key> caps all tries per network address; ipwrong:<key> caps wrong PINs per network address; company:<sha256 of the code> caps wrong PINs per company (locked_until marks the window the cap was reached in). subject:<sha256> mirrors worker_credentials (lock, lockout times, hold) for a company code and staff ID with no login, so unknown and real IDs behave the same.';

-- Counting a worker's lockouts reads these audit rows on every 5th wrong try; capped windows
-- are read by organisation.
create index audit_log_worker_locked_idx
  on public.audit_log (entity_id, at)
  where action = 'worker_auth.locked';
create index audit_log_company_throttled_idx
  on public.audit_log (organisation_id, at)
  where action = 'worker_auth.company_throttled';

-- True when `p_at` falls in a 15-minute window in which the organisation reached its cap on
-- wrong PINs (the window ends at the audit row's `until`).
create function private.in_capped_window(p_organisation_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_organisation_id is not null and exists (
    select 1
    from public.audit_log t
    where t.organisation_id = p_organisation_id
      and t.action = 'worker_auth.company_throttled'
      and t.at > p_at - interval '1 hour'
      and t.at < p_at + interval '1 hour'
      and p_at >= (t.after ->> 'until')::timestamptz - interval '15 minutes'
      and p_at < (t.after ->> 'until')::timestamptz
  )
$$;

-- The worker's lockouts that count towards a hold: since the later of 24 hours ago and the
-- last time a PIN was set, outside windows in which the company reached its cap.
create function private.worker_recent_lockouts(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_since timestamptz
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.audit_log a
  where a.action = 'worker_auth.locked'
    and a.entity_id = p_worker_id
    and a.at > greatest(now() - interval '24 hours', p_since)
    and not private.in_capped_window(p_organisation_id, a.at)
$$;

-- Records one wrong PIN against the company code and the network address, each in its own
-- 15-minute window. Successes never reduce these counters.
create function private.count_wrong_pin(p_company_key text, p_ip_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  win constant interval := interval '15 minutes';
  k text;
begin
  foreach k in array array[p_company_key, 'ipwrong:' || p_ip_key] loop
    if k is null or k !~ '^(company|ipwrong):[0-9a-f]{64}$' then
      continue;
    end if;
    insert into private.auth_throttle as a (key, attempts, window_started_at, updated_at)
    values (k, 1, now(), now())
    on conflict on constraint auth_throttle_pkey do update
    set attempts = case when a.window_started_at <= now() - win then 1 else a.attempts + 1 end,
        locked_until = case when a.window_started_at <= now() - win then null else a.locked_until end,
        window_started_at = case
          when a.window_started_at <= now() - win then now() else a.window_started_at
        end,
        updated_at = now();
  end loop;
end;
$$;

revoke all on function private.in_capped_window(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.worker_recent_lockouts(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.count_wrong_pin(text, text) from public, anon, authenticated;

-- The outcome set and columns change, so the two begin functions are recreated.
drop function public.worker_sign_in_begin(text, text, text);
drop function private.worker_sign_in_begin_impl(text, text, text);

-- begin's outcome:
--   proceed            check the PIN. locks_on_failure: a wrong PIN now locks (the 5th in a
--                      row). holds_on_failure: that lock is the 3rd in 24 hours and holds.
--   locked             5 wrong tries: refuse without checking, until the lock ends.
--   held               3 lockouts in 24 hours: refuse until a new PIN is set.
--   ip_blocked         too many tries, or wrong PINs, from this network address.
--   company_throttled  too many wrong PINs for this company code in 15 minutes.
create function private.worker_sign_in_begin_impl(
  p_company_code text,
  p_staff_id text,
  p_ip_key text
)
returns table (
  outcome text,
  worker_id uuid,
  organisation_id uuid,
  auth_user_id uuid,
  pin_hash text,
  locks_on_failure boolean,
  holds_on_failure boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  max_attempts constant integer := 5;
  lock_for constant interval := interval '15 minutes';
  hold_after_lockouts constant integer := 3;
  hold_window constant interval := interval '24 hours';
  ip_limit constant integer := 100;
  ip_window constant interval := interval '15 minutes';
  ip_wrong_pin_cap constant integer := 15;
  company_wrong_pin_cap constant integer := 50;
  company_window constant interval := interval '15 minutes';
  v_code text := upper(btrim(coalesce(p_company_code, '')));
  v_staff text := lower(btrim(coalesce(p_staff_id, '')));
  v_ip_attempts integer;
  v_ip_wrong integer;
  v_company_key text;
  v_company_attempts integer;
  v_company_window timestamptz;
  v_first_refusal boolean;
  v_org uuid;
  v_subject text;
  v_locked boolean;
  v_times timestamptz[];
  v_count integer;
  cred public.worker_credentials%rowtype;
  t private.auth_throttle%rowtype;
begin
  if p_ip_key is null or p_ip_key !~ '^[0-9a-f]{64}$' then
    raise exception 'A network key is required.' using errcode = '22023';
  end if;
  if char_length(v_code) > 64 or char_length(v_staff) > 64 then
    raise exception 'Company code and staff ID are too long.' using errcode = '22023';
  end if;

  -- Old counters are dropped after a quiet day; a hold on an unknown ID is kept like a real
  -- one (for 90 quiet days, so the table can't grow without end).
  delete from private.auth_throttle a
  where (a.held_at is null and a.updated_at < now() - interval '1 day')
     or (a.held_at is not null and a.updated_at < now() - interval '90 days');

  insert into private.auth_throttle as a (key, attempts, window_started_at, updated_at)
  values ('ip:' || p_ip_key, 1, now(), now())
  on conflict on constraint auth_throttle_pkey do update
  set attempts = case when a.window_started_at <= now() - ip_window then 1 else a.attempts + 1 end,
      window_started_at = case
        when a.window_started_at <= now() - ip_window then now() else a.window_started_at
      end,
      updated_at = now()
  returning a.attempts into v_ip_attempts;

  select a.attempts into v_ip_wrong
  from private.auth_throttle a
  where a.key = 'ipwrong:' || p_ip_key
    and a.window_started_at > now() - ip_window;

  if v_ip_attempts > ip_limit or coalesce(v_ip_wrong, 0) >= ip_wrong_pin_cap then
    outcome := 'ip_blocked';
    locks_on_failure := false;
    holds_on_failure := false;
    return next;
    return;
  end if;

  select o.id into v_org from public.organisations o where o.company_code = v_code;

  -- The company's window: read (and row-locked until this transaction ends, so sign-ins for one
  -- company are checked one at a time) before anything is counted against a worker.
  v_company_key := 'company:' || encode(extensions.digest(v_code, 'sha256'), 'hex');
  insert into private.auth_throttle as a (key, attempts, window_started_at, updated_at)
  values (v_company_key, 0, now(), now())
  on conflict on constraint auth_throttle_pkey do update
  set attempts = case when a.window_started_at <= now() - company_window then 0 else a.attempts end,
      locked_until = case
        when a.window_started_at <= now() - company_window then null else a.locked_until
      end,
      window_started_at = case
        when a.window_started_at <= now() - company_window then now() else a.window_started_at
      end,
      updated_at = now()
  returning a.attempts, a.window_started_at into v_company_attempts, v_company_window;

  if v_company_attempts >= company_wrong_pin_cap then
    -- Audited once per window, at the first refusal, for a real company. The row's `until`
    -- also marks the window whose lockouts don't count towards a hold.
    update private.auth_throttle a
    set locked_until = v_company_window + company_window
    where a.key = v_company_key
      and a.locked_until is null
    returning true into v_first_refusal;
    if v_first_refusal and v_org is not null then
      insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
      values (
        v_org,
        null,
        'worker_auth.company_throttled',
        'organisations',
        v_org,
        jsonb_build_object(
          'wrong_pin_cap', company_wrong_pin_cap,
          'window_minutes', extract(epoch from company_window)::integer / 60,
          'until', v_company_window + company_window
        )
      );
    end if;
    outcome := 'company_throttled';
    -- Only on the first refusal of the window, for a real company: the server then emails the
    -- owner and HR once (never shown to the person signing in).
    organisation_id := case when v_first_refusal then v_org end;
    locks_on_failure := false;
    holds_on_failure := false;
    return next;
    return;
  end if;

  select c.* into cred
  from public.organisations o
  join public.workers w on w.organisation_id = o.id
  join public.worker_credentials c on c.worker_id = w.id
  where o.company_code = v_code
    and lower(w.staff_id) = v_staff
    and w.status = 'active'
  for update of c;

  if found then
    if cred.held_at is not null then
      outcome := 'held';
      locks_on_failure := false;
      holds_on_failure := false;
      return next;
      return;
    end if;
    if cred.locked_until is not null and cred.locked_until > now() then
      outcome := 'locked';
      locks_on_failure := false;
      holds_on_failure := false;
      return next;
      return;
    end if;

    update public.worker_credentials c
    set failed_attempts = case
          when cred.locked_until is not null then 1
          else least(c.failed_attempts + 1, max_attempts)
        end,
        locked_until = case
          when cred.locked_until is null and c.failed_attempts + 1 >= max_attempts
            then now() + lock_for
        end
    where c.id = cred.id
    returning c.locked_until is not null into v_locked;

    outcome := 'proceed';
    worker_id := cred.worker_id;
    organisation_id := cred.organisation_id;
    auth_user_id := cred.auth_user_id;
    locks_on_failure := v_locked;
    -- The lock this try would set is the 3rd in 24 hours when two are already counted (and
    -- this window isn't one the company capped).
    holds_on_failure := v_locked
      and not private.in_capped_window(cred.organisation_id, now())
      and private.worker_recent_lockouts(cred.organisation_id, cred.worker_id, cred.pin_set_at) + 1
        >= hold_after_lockouts;
    select p.pin_hash into pin_hash from private.worker_pins p where p.worker_id = cred.worker_id;
    return next;
    return;
  end if;

  -- No worker login for these IDs: the same counting, keyed by a hash of what was typed. A try
  -- here always fails, so the wrong PIN, the lock and the hold are recorded now.
  v_subject := 'subject:' || encode(extensions.digest(v_code || '|' || v_staff, 'sha256'), 'hex');

  select * into t from private.auth_throttle a where a.key = v_subject for update;
  if found and t.held_at is not null then
    update private.auth_throttle a set updated_at = now() where a.key = v_subject;
    outcome := 'held';
    locks_on_failure := false;
    holds_on_failure := false;
    return next;
    return;
  end if;
  if found and t.locked_until is not null and t.locked_until > now() then
    update private.auth_throttle a set updated_at = now() where a.key = v_subject;
    outcome := 'locked';
    locks_on_failure := false;
    holds_on_failure := false;
    return next;
    return;
  end if;

  insert into private.auth_throttle as a (key, attempts, window_started_at, locked_until, updated_at)
  values (v_subject, 1, now(), null, now())
  on conflict on constraint auth_throttle_pkey do update
  set attempts = case
        when a.locked_until is not null then 1
        else least(a.attempts + 1, max_attempts)
      end,
      locked_until = case
        when a.locked_until is null and a.attempts + 1 >= max_attempts then now() + lock_for
      end,
      updated_at = now()
  returning a.locked_until is not null, a.lockout_times into v_locked, v_times;

  holds_on_failure := false;
  if v_locked then
    -- Lockout times in the last 24 hours (a sliding window, like the audit rows of a real
    -- worker), this one included.
    select coalesce(array_agg(x order by x), '{}') into v_times
    from unnest(v_times || now()) as u (x)
    where x > now() - hold_window;
    select count(*)::integer into v_count
    from unnest(v_times) as u (x)
    where not private.in_capped_window(v_org, x);
    holds_on_failure := v_count >= hold_after_lockouts;
    update private.auth_throttle a
    set lockout_times = v_times,
        held_at = case when holds_on_failure then now() end
    where a.key = v_subject;
  end if;

  perform private.count_wrong_pin(v_company_key, p_ip_key);

  outcome := 'proceed';
  locks_on_failure := v_locked;
  return next;
end;
$$;

-- Records the result of the PIN check. Success clears the worker's count and lock (it gives
-- nothing back to the network or company counters). A failure is counted against the company
-- code and the network address; the 5th failure in a row is the one that locked the worker in
-- begin, written to the audit log as worker_auth.locked, and when it is the 3rd counted lockout
-- in 24 hours the login is held (worker_auth.held). Returns signed_in, failed, locked or held.
create or replace function private.worker_sign_in_finish_impl(
  p_worker_id uuid,
  p_ok boolean,
  p_ip_key text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  hold_after_lockouts constant integer := 3;
  cred public.worker_credentials%rowtype;
  v_code text;
  v_lockouts integer;
begin
  if p_ok is null then
    raise exception 'A result is required.' using errcode = '22023';
  end if;
  -- A company code and staff ID with no login: nothing to record (begin counted the try), but
  -- the server still calls this so both paths make the same round trips.
  if p_worker_id is null then
    if p_ok then
      raise exception 'A sign-in can only succeed for a worker with a login.' using errcode = '22023';
    end if;
    return 'failed';
  end if;

  select * into cred from public.worker_credentials c where c.worker_id = p_worker_id for update;
  if not found then
    raise exception 'That worker has no login.' using errcode = 'P0002';
  end if;

  if p_ok then
    update public.worker_credentials c
    set failed_attempts = 0,
        locked_until = null,
        last_sign_in_at = now()
    where c.id = cred.id;
    return 'signed_in';
  end if;

  select o.company_code into v_code
  from public.organisations o
  where o.id = cred.organisation_id;
  perform private.count_wrong_pin(
    'company:' || encode(extensions.digest(upper(coalesce(v_code, '')), 'sha256'), 'hex'),
    case when p_ip_key ~ '^[0-9a-f]{64}$' then p_ip_key end
  );

  if cred.held_at is not null then
    return 'held';
  end if;

  if cred.locked_until is not null and cred.locked_until > now() then
    -- Two tries checked in parallel can both finish after the lock was set; the lock is
    -- written (and counted towards a hold) once.
    if exists (
      select 1
      from public.audit_log a
      where a.action = 'worker_auth.locked'
        and a.entity_id = cred.worker_id
        and a.at > now() - interval '1 hour'
        and (a.after ->> 'locked_until')::timestamptz = cred.locked_until
    ) then
      return 'locked';
    end if;
    insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
    values (
      cred.organisation_id,
      null,
      'worker_auth.locked',
      'workers',
      cred.worker_id,
      jsonb_build_object(
        'failed_attempts', cred.failed_attempts,
        'locked_until', cred.locked_until
      )
    );

    v_lockouts := private.worker_recent_lockouts(cred.organisation_id, cred.worker_id, cred.pin_set_at);
    if v_lockouts >= hold_after_lockouts then
      update public.worker_credentials c
      set held_at = now()
      where c.id = cred.id;
      insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
      values (
        cred.organisation_id,
        null,
        'worker_auth.held',
        'workers',
        cred.worker_id,
        jsonb_build_object('lockouts_in_24_hours', v_lockouts)
      );
      return 'held';
    end if;
    return 'locked';
  end if;
  return 'failed';
end;
$$;

create function public.worker_sign_in_begin(p_company_code text, p_staff_id text, p_ip_key text)
returns table (
  outcome text,
  worker_id uuid,
  organisation_id uuid,
  auth_user_id uuid,
  pin_hash text,
  locks_on_failure boolean,
  holds_on_failure boolean
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.worker_sign_in_begin_impl(p_company_code, p_staff_id, p_ip_key)
$$;

revoke all on function private.worker_sign_in_begin_impl(text, text, text) from public, anon, authenticated;
revoke all on function public.worker_sign_in_begin(text, text, text) from public, anon, authenticated;
grant execute on function private.worker_sign_in_begin_impl(text, text, text) to service_role;
grant execute on function public.worker_sign_in_begin(text, text, text) to service_role;

-- As in 20261116190000, and a new PIN also lifts a hold.
create or replace function private.accept_worker_invite_impl(
  p_token text,
  p_auth_user_id uuid,
  p_pin_hash text
)
returns table (organisation_id uuid, worker_id uuid, pin_reset boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inv public.worker_invites%rowtype;
  v_existing uuid;
  v_member uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'This invite link is not valid.' using errcode = 'MLWI1';
  end if;
  if p_pin_hash is null or char_length(p_pin_hash) not between 20 and 300 then
    raise exception 'The PIN could not be saved.' using errcode = '22023';
  end if;

  select * into inv
  from public.worker_invites i
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;

  if not found then
    raise exception 'This invite link is not valid.' using errcode = 'MLWI1';
  end if;
  if inv.used_at is not null then
    raise exception 'This invite has already been used.' using errcode = 'MLWI2';
  end if;
  if inv.revoked_at is not null then
    raise exception 'This invite was replaced by a newer one.' using errcode = 'MLWI3';
  end if;
  if inv.expires_at <= now() then
    raise exception 'This invite has expired.' using errcode = 'MLWI4';
  end if;

  -- Locks the worker: two invites for one worker are used one at a time.
  perform 1
  from public.workers w
  where w.id = inv.worker_id
    and w.organisation_id = inv.organisation_id
    and w.status = 'active'
  for update;
  if not found then
    raise exception 'This invite is no longer valid.' using errcode = 'MLWI3';
  end if;

  if not exists (
    select 1
    from auth.users u
    where u.id = p_auth_user_id
      and u.raw_app_meta_data ->> 'login' = 'worker'
  ) then
    raise exception 'That login is not a worker login.' using errcode = '22023';
  end if;

  select c.auth_user_id into v_existing
  from public.worker_credentials c
  where c.worker_id = inv.worker_id;
  if v_existing is not null and v_existing <> p_auth_user_id then
    raise exception 'This employee already has a different login.' using errcode = 'MLWI5';
  end if;

  select m.user_id into v_member
  from public.memberships m
  where m.worker_id = inv.worker_id;
  if v_member is not null and v_member <> p_auth_user_id then
    raise exception 'This employee already has a different login.' using errcode = 'MLWI5';
  end if;
  if exists (
    select 1
    from public.memberships m
    where m.user_id = p_auth_user_id
      and m.worker_id is distinct from inv.worker_id
  ) then
    raise exception 'That login belongs to someone else.' using errcode = 'MLWI5';
  end if;

  -- The worker is the actor for the audit rows written below.
  perform set_config('request.jwt.claim.sub', p_auth_user_id::text, true);

  insert into public.worker_credentials as c (
    organisation_id, worker_id, auth_user_id, pin_set_at, privacy_notice_accepted_at
  )
  values (inv.organisation_id, inv.worker_id, p_auth_user_id, now(), now())
  on conflict on constraint worker_credentials_worker_key do update
  set pin_set_at = now(),
      privacy_notice_accepted_at = now(),
      failed_attempts = 0,
      locked_until = null,
      held_at = null;

  insert into private.worker_pins as p (worker_id, pin_hash, updated_at)
  values (inv.worker_id, p_pin_hash, now())
  on conflict on constraint worker_pins_pkey do update
  set pin_hash = excluded.pin_hash,
      updated_at = now();

  if v_member is null then
    insert into public.memberships (organisation_id, user_id, role, worker_id, created_by)
    values (inv.organisation_id, p_auth_user_id, 'worker', inv.worker_id, inv.created_by);
  end if;

  update public.worker_invites i
  set used_at = now()
  where i.id = inv.id;

  if v_existing is not null then
    delete from auth.sessions s where s.user_id = p_auth_user_id;
  end if;

  organisation_id := inv.organisation_id;
  worker_id := inv.worker_id;
  pin_reset := v_existing is not null;
  return next;
end;
$$;

-- "Unlock sign-in" on the worker page. Lifts a 15-minute lock early; a hold (3 lockouts in 24
-- hours) needs a new PIN from an HR invite. Owner, admin, hr, or the worker's line manager;
-- never one's own login, never a leaver's. Returns the lock that was lifted.
create function private.unlock_worker_sign_in_impl(p_organisation_id uuid, p_worker_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  w public.workers%rowtype;
  cred public.worker_credentials%rowtype;
begin
  if uid is null then
    raise exception 'Sign in to unlock sign-in.' using errcode = '42501';
  end if;

  select * into w
  from public.workers x
  where x.id = p_worker_id and x.organisation_id = p_organisation_id;
  if not found or not (
    private.has_role(p_organisation_id, array['owner', 'admin', 'hr'])
    or private.is_line_manager_for(p_organisation_id, w.line_manager_worker_id, w.line_manager_membership_id)
  ) then
    raise exception 'Only the owner, an admin, HR or the employee''s line manager can unlock sign-in.'
      using errcode = '42501';
  end if;
  if p_worker_id in (select private.my_worker_ids()) then
    raise exception 'This is your own sign-in, so someone else must unlock it.' using errcode = 'MLPN3';
  end if;
  if w.status <> 'active' then
    raise exception 'This employee has left, so there is nothing to unlock.' using errcode = 'MLPN2';
  end if;

  select * into cred from public.worker_credentials c where c.worker_id = p_worker_id for update;
  if not found then
    raise exception 'This employee hasn''t set a PIN yet.' using errcode = 'MLPN2';
  end if;
  if cred.held_at is not null then
    raise exception 'Sign-in was locked 3 times in 24 hours, so it stays locked until the employee sets a new PIN. Send them a new invite.'
      using errcode = 'MLPN1';
  end if;
  if cred.locked_until is null or cred.locked_until <= now() then
    raise exception 'Sign-in isn''t locked.' using errcode = 'MLPN2';
  end if;

  update public.worker_credentials c
  set failed_attempts = 0,
      locked_until = null
  where c.id = cred.id;

  perform private.log_audit_impl(
    p_organisation_id,
    'worker_auth.unlocked',
    'workers',
    p_worker_id,
    jsonb_build_object('locked_until', cred.locked_until, 'failed_attempts', cred.failed_attempts),
    jsonb_build_object('locked_until', null, 'failed_attempts', 0),
    null
  );
  return cred.locked_until;
end;
$$;

create function public.unlock_worker_sign_in(p_organisation_id uuid, p_worker_id uuid)
returns timestamptz
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.unlock_worker_sign_in_impl(p_organisation_id, p_worker_id)
$$;

revoke all on function private.unlock_worker_sign_in_impl(uuid, uuid) from public, anon;
revoke all on function public.unlock_worker_sign_in(uuid, uuid) from public, anon;
grant execute on function private.unlock_worker_sign_in_impl(uuid, uuid) to authenticated;
grant execute on function public.unlock_worker_sign_in(uuid, uuid) to authenticated;

-- A worker's sign-in status for their managers. Owner, admin and hr get everything they can
-- already read in worker_credentials; the worker's own line manager gets only whether there is
-- a login, the last sign-in and the lock (no table access). Anyone else: no row.
create function private.worker_sign_in_status_impl(p_organisation_id uuid, p_worker_id uuid)
returns table (
  has_login boolean,
  pin_set_at timestamptz,
  failed_attempts smallint,
  last_sign_in_at timestamptz,
  locked_until timestamptz,
  held_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  w public.workers%rowtype;
  v_full boolean;
  cred public.worker_credentials%rowtype;
begin
  if auth.uid() is null then
    return;
  end if;
  select * into w
  from public.workers x
  where x.id = p_worker_id and x.organisation_id = p_organisation_id;
  if not found then
    return;
  end if;
  v_full := private.has_role(p_organisation_id, array['owner', 'admin', 'hr']);
  if not v_full and not private.is_line_manager_for(
    p_organisation_id, w.line_manager_worker_id, w.line_manager_membership_id
  ) then
    return;
  end if;
  select * into cred from public.worker_credentials c where c.worker_id = p_worker_id;
  has_login := found;
  if found then
    pin_set_at := case when v_full then cred.pin_set_at end;
    failed_attempts := case when v_full then cred.failed_attempts end;
    last_sign_in_at := cred.last_sign_in_at;
    locked_until := cred.locked_until;
    held_at := cred.held_at;
  end if;
  return next;
end;
$$;

create function public.worker_sign_in_status(p_organisation_id uuid, p_worker_id uuid)
returns table (
  has_login boolean,
  pin_set_at timestamptz,
  failed_attempts smallint,
  last_sign_in_at timestamptz,
  locked_until timestamptz,
  held_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.worker_sign_in_status_impl(p_organisation_id, p_worker_id)
$$;

revoke all on function private.worker_sign_in_status_impl(uuid, uuid) from public, anon;
revoke all on function public.worker_sign_in_status(uuid, uuid) from public, anon;
grant execute on function private.worker_sign_in_status_impl(uuid, uuid) to authenticated;
grant execute on function public.worker_sign_in_status(uuid, uuid) to authenticated;

-- ===========================================================================
-- B. Staff ID correction
-- ===========================================================================
--
--   pending ──approve (a second person)──▶ approved (workers.staff_id changes now)
--      ├──reject (a second person)──▶ rejected
--      └──withdraw (the requester)──▶ cancelled
--
-- * Who: owner, admin and hr raise and decide. The requester never approves or rejects their
--   own request, and nobody decides a correction to their own worker record. Enforced by the
--   BEFORE UPDATE trigger (clear error), the check constraints (every writer, the secret key
--   included), and RLS and column grants for signed-in users.
-- * When: only while the worker is active and has no punches, timesheets or pay records
--   (private.worker_has_work_records), checked when raised and again when approved.
-- * Which IDs: never one used before in the company. Not one any worker has or had (ended
--   workers keep theirs, workers_staff_id_key), not one a correction retired
--   (staff_id_corrections_retired_key), not one a pending correction reserves
--   (staff_id_corrections_reserved_key). New workers can't take a retired or reserved ID
--   either (workers_staff_id_never_used).
-- * Insert-only history: a request's own columns never change after insert and rows are never
--   deleted; the row audit keeps before and after, and the workers row audit records the
--   staff ID change itself.

-- Phase 1 has no punches, timesheets or payslips. Each later phase that adds one of them MUST
-- replace this function (create or replace) with a real check of its table: Phase 3 punches,
-- Phase 4 timesheets, payroll lines and payslips. Until it does, the mere existence of such a
-- table makes this return true, so corrections fail closed instead of silently ignoring work
-- already recorded under the old ID. Pay rates are not pay records: nothing has been paid.
-- Locking: approval locks the worker row (select ... for update) before calling this, so a
-- punch, timesheet or payslip table must reference workers by a foreign key (an insert then
-- takes a key-share lock on the worker and waits for, or blocks, the approval), or take the
-- same advisory lock (hashtextextended('staff_id:' || organisation_id, 0)). Every public table
-- with a worker_id column must be listed in tests/rls/work-records-hook.test.ts as handled here
-- or as not a work record.
create function private.worker_has_work_records(p_organisation_id uuid, p_worker_id uuid)
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
  return to_regclass('public.punches') is not null
    or to_regclass('public.timesheets') is not null
    or to_regclass('public.timesheet_lines') is not null
    or to_regclass('public.payroll_lines') is not null
    or to_regclass('public.payslips') is not null;
end;
$$;

create type public.staff_id_correction_status as enum ('pending', 'approved', 'rejected', 'cancelled');

create table public.staff_id_corrections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  -- Set by the trigger from the worker, whatever is sent.
  old_staff_id text not null,
  new_staff_id text not null
    constraint staff_id_corrections_new_staff_id_text check (
      new_staff_id = btrim(new_staff_id)
      and char_length(new_staff_id) between 1 and 64
      and new_staff_id !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  reason text not null
    constraint staff_id_corrections_reason_text check (
      reason = btrim(reason)
      and char_length(reason) between 3 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  requested_by uuid not null default auth.uid(),

  status public.staff_id_correction_status not null default 'pending',
  approved_by uuid,
  rejected_by uuid,
  cancelled_by uuid,
  decided_at timestamptz,
  decision_note text
    constraint staff_id_corrections_decision_note_text check (
      decision_note = btrim(decision_note)
      and char_length(decision_note) between 1 and 500
      and decision_note !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint staff_id_corrections_organisation_id_id_key unique (organisation_id, id),
  constraint staff_id_corrections_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint staff_id_corrections_changes_id check (lower(new_staff_id) <> lower(old_staff_id)),

  -- The two-person rule, for every writer.
  constraint staff_id_corrections_second_approver check (approved_by <> requested_by),
  constraint staff_id_corrections_second_rejecter check (rejected_by <> requested_by),

  constraint staff_id_corrections_status_columns check (
    case status
      when 'pending' then num_nonnulls(approved_by, rejected_by, cancelled_by, decided_at) = 0
      when 'approved' then approved_by is not null and decided_at is not null
        and num_nonnulls(rejected_by, cancelled_by) = 0
      when 'rejected' then rejected_by is not null and decided_at is not null
        and num_nonnulls(approved_by, cancelled_by) = 0
      when 'cancelled' then cancelled_by is not null and decided_at is not null
        and num_nonnulls(approved_by, rejected_by) = 0
    end
  )
);

-- One open correction per worker.
create unique index staff_id_corrections_one_open_key
  on public.staff_id_corrections (worker_id)
  where status = 'pending';
-- A pending correction reserves its new ID in the company.
create unique index staff_id_corrections_reserved_key
  on public.staff_id_corrections (organisation_id, lower(new_staff_id))
  where status = 'pending';
-- An approved correction retires the old ID for good.
create unique index staff_id_corrections_retired_key
  on public.staff_id_corrections (organisation_id, lower(old_staff_id))
  where status = 'approved';
create index staff_id_corrections_organisation_status_idx
  on public.staff_id_corrections (organisation_id, status, created_at desc);
create index staff_id_corrections_worker_idx
  on public.staff_id_corrections (worker_id, created_at desc);

comment on table public.staff_id_corrections is
  'Staff ID corrections (owner decision 19): a reason and a second approver (owner, admin or hr), only while the worker has no punches, timesheets or pay records. On approval workers.staff_id changes in the same transaction and the old ID is retired: never used again in the company. Insert-only history; only the status moves, by trigger-checked updates.';

-- True when `p_staff_id` can't be given to anyone in the organisation: a worker has or had it,
-- a correction retired it, or a pending correction (other than p_except) reserves it.
create function private.staff_id_taken(p_organisation_id uuid, p_staff_id text, p_except uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.workers w
      where w.organisation_id = p_organisation_id and lower(w.staff_id) = lower(p_staff_id)
    )
    or exists (
      select 1 from public.staff_id_corrections s
      where s.organisation_id = p_organisation_id
        and (
          (s.status = 'approved' and lower(s.old_staff_id) = lower(p_staff_id))
          or (s.status = 'pending' and lower(s.new_staff_id) = lower(p_staff_id)
              and s.id is distinct from p_except)
        )
    )
$$;

-- BEFORE INSERT. A new correction is pending, raised by the caller (owner, admin or hr), for an
-- active worker with no work records, to an ID never used in the company. The advisory lock
-- serialises staff ID changes in one organisation, so two requests can't both pass the checks
-- for the same ID.
create function private.staff_id_corrections_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  w public.workers%rowtype;
begin
  if v_actor is not null then
    if not private.has_role(new.organisation_id, array['owner', 'admin', 'hr']) then
      raise exception 'Only the owner, an admin or HR can correct a staff ID.' using errcode = '42501';
    end if;
    new.requested_by := v_actor;
  end if;
  if new.requested_by is null then
    raise exception 'A staff ID correction needs the person who raised it.' using errcode = '23502';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('staff_id:' || new.organisation_id::text, 0));

  select * into w
  from public.workers x
  where x.id = new.worker_id and x.organisation_id = new.organisation_id;
  if not found then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  if w.status <> 'active' then
    raise exception 'This employee has left, so their staff ID can''t change.' using errcode = 'MLSI5';
  end if;
  if v_actor is not null and new.worker_id in (select private.my_worker_ids()) then
    raise exception 'This is your own staff ID, so someone else must correct it.' using errcode = 'MLSI2';
  end if;
  if private.worker_has_work_records(new.organisation_id, new.worker_id) then
    raise exception 'This employee already has clock-ins, timesheets or pay under their staff ID, so it can''t be corrected.'
      using errcode = 'MLSI6';
  end if;

  new.old_staff_id := w.staff_id;
  new.new_staff_id := btrim(new.new_staff_id);
  if lower(new.new_staff_id) = lower(w.staff_id) then
    raise exception 'That is the staff ID they already have.' using errcode = 'MLSI3';
  end if;
  if private.staff_id_taken(new.organisation_id, new.new_staff_id, null) then
    raise exception 'Staff ID % has been used before in this company. Choose one nobody has had.', new.new_staff_id
      using errcode = 'MLSI3';
  end if;

  new.status := 'pending';
  new.approved_by := null;
  new.rejected_by := null;
  new.cancelled_by := null;
  new.decided_at := null;
  new.decision_note := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

-- BEFORE UPDATE. The request itself is fixed; only the status moves, once, and this function
-- fills in who and when.
create function private.staff_id_corrections_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  w public.workers%rowtype;
begin
  if (
    new.id, new.organisation_id, new.worker_id, new.old_staff_id, new.new_staff_id, new.reason,
    new.requested_by, new.created_at
  ) is distinct from (
    old.id, old.organisation_id, old.worker_id, old.old_staff_id, old.new_staff_id, old.reason,
    old.requested_by, old.created_at
  ) then
    raise exception 'A staff ID correction can''t be edited. Reject it and raise a new one.'
      using errcode = 'MLSI4';
  end if;
  if old.status <> 'pending' or new.status = old.status then
    raise exception 'This correction has already been decided.' using errcode = 'MLSI4';
  end if;

  new.approved_by := null;
  new.rejected_by := null;
  new.cancelled_by := null;
  new.decided_at := now();

  if new.status = 'cancelled' then
    if v_actor is null or v_actor <> old.requested_by then
      raise exception 'Only the person who raised this correction can withdraw it. Reject it instead.'
        using errcode = '42501';
    end if;
    new.cancelled_by := v_actor;
    return new;
  end if;

  if new.status not in ('approved', 'rejected') then
    raise exception 'This correction has already been decided.' using errcode = 'MLSI4';
  end if;
  if v_actor is null or not private.has_role(old.organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Only the owner, an admin or HR can approve or reject a staff ID correction.'
      using errcode = '42501';
  end if;
  if v_actor = old.requested_by then
    raise exception 'You raised this correction, so someone else must approve or reject it.'
      using errcode = 'MLSI1';
  end if;
  if old.worker_id in (select private.my_worker_ids()) then
    raise exception 'This is your own staff ID, so someone else must decide.' using errcode = 'MLSI2';
  end if;

  if new.status = 'rejected' then
    new.rejected_by := v_actor;
    return new;
  end if;

  -- Approval: everything is checked again against the record as it is now.
  perform pg_advisory_xact_lock(hashtextextended('staff_id:' || old.organisation_id::text, 0));
  select * into w
  from public.workers x
  where x.id = old.worker_id and x.organisation_id = old.organisation_id
  for update;
  if w.status <> 'active' then
    raise exception 'This employee has left, so their staff ID can''t change.' using errcode = 'MLSI5';
  end if;
  if w.staff_id is distinct from old.old_staff_id then
    raise exception 'This employee''s staff ID changed after the correction was raised. Reject it and raise a new one.'
      using errcode = 'MLSI7';
  end if;
  if private.worker_has_work_records(old.organisation_id, old.worker_id) then
    raise exception 'This employee already has clock-ins, timesheets or pay under their staff ID, so it can''t be corrected.'
      using errcode = 'MLSI6';
  end if;
  if private.staff_id_taken(old.organisation_id, old.new_staff_id, old.id) then
    raise exception 'Staff ID % has been used before in this company. Reject this correction and choose another.', old.new_staff_id
      using errcode = 'MLSI3';
  end if;
  new.approved_by := v_actor;
  return new;
end;
$$;

-- AFTER UPDATE: an approved correction changes the worker's staff ID in the same transaction
-- (definer: signed-in users have no update grant on workers.staff_id). The workers row audit
-- records before and after.
create function private.staff_id_corrections_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status = 'approved' then
    update public.workers w
    set staff_id = new.new_staff_id
    where w.id = new.worker_id
      and w.organisation_id = new.organisation_id
      and w.staff_id = new.old_staff_id;
    if not found then
      raise exception 'This employee''s staff ID changed after the correction was raised.'
        using errcode = 'MLSI7';
    end if;
  end if;
  return null;
end;
$$;

create function private.staff_id_corrections_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Staff ID corrections are kept as history and can''t be deleted.'
    using errcode = 'MLSI4';
end;
$$;

-- BEFORE INSERT on workers: a new worker can't take an ID a correction retired or reserves
-- (workers_staff_id_key already covers IDs other workers have or had).
create function private.workers_staff_id_never_used()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The same lock corrections take, so a new worker and an approval can't both take one ID.
  perform pg_advisory_xact_lock(hashtextextended('staff_id:' || new.organisation_id::text, 0));
  if exists (
    select 1 from public.staff_id_corrections s
    where s.organisation_id = new.organisation_id
      and (
        (s.status = 'approved' and lower(s.old_staff_id) = lower(new.staff_id))
        or (s.status = 'pending' and lower(s.new_staff_id) = lower(new.staff_id))
      )
  ) then
    raise exception 'Staff ID % has been used before in this company. Choose one nobody has had.', new.staff_id
      using errcode = 'MLSI3';
  end if;
  return new;
end;
$$;

create trigger staff_id_corrections_before_insert
  before insert on public.staff_id_corrections
  for each row execute function private.staff_id_corrections_before_insert();
create trigger staff_id_corrections_before_update
  before update on public.staff_id_corrections
  for each row execute function private.staff_id_corrections_before_update();
create trigger staff_id_corrections_set_updated_at
  before update on public.staff_id_corrections
  for each row execute function private.set_updated_at();
create trigger staff_id_corrections_after_update
  after update on public.staff_id_corrections
  for each row execute function private.staff_id_corrections_after_update();
create trigger staff_id_corrections_no_delete
  before delete on public.staff_id_corrections
  for each row execute function private.staff_id_corrections_no_delete();
create trigger staff_id_corrections_audit
  after insert or update or delete on public.staff_id_corrections
  for each row execute function private.audit_row_change();

create trigger workers_staff_id_never_used
  before insert on public.workers
  for each row execute function private.workers_staff_id_never_used();

-- Read, raise and decide: owner, admin and hr. Update is status moves only (trigger-checked),
-- including the requester withdrawing. No delete.
alter table public.staff_id_corrections enable row level security;

create policy staff_id_corrections_select on public.staff_id_corrections for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

create policy staff_id_corrections_insert on public.staff_id_corrections for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and status = 'pending'
    and private.has_role(organisation_id, array['owner', 'admin', 'hr'])
  );

create policy staff_id_corrections_update on public.staff_id_corrections for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

revoke all on table public.staff_id_corrections from anon, authenticated;
grant select on table public.staff_id_corrections to authenticated;
grant insert (id, organisation_id, worker_id, new_staff_id, reason)
  on table public.staff_id_corrections to authenticated;
grant update (status, decision_note) on table public.staff_id_corrections to authenticated;

revoke all on function private.worker_has_work_records(uuid, uuid) from public, anon, authenticated;
revoke all on function private.staff_id_taken(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.staff_id_corrections_before_insert() from public, anon, authenticated;
revoke all on function private.staff_id_corrections_before_update() from public, anon, authenticated;
revoke all on function private.staff_id_corrections_after_update() from public, anon, authenticated;
revoke all on function private.staff_id_corrections_no_delete() from public, anon, authenticated;
revoke all on function private.workers_staff_id_never_used() from public, anon, authenticated;
grant execute on function private.worker_has_work_records(uuid, uuid) to service_role;

-- ===========================================================================
-- C. First import during unfinished setup (decision 20)
-- ===========================================================================

-- True when this import may save bank details without a second approver: the caller is the
-- owner, the company has not finished setup, and no earlier import (another batch) has already
-- used the exception: decision 20 covers the owner's first import only. Takes a share lock on the organisation row, so
-- setup can't be completed half way through the import that relies on the answer.
create function private.import_single_approver(p_organisation_id uuid, p_batch_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_completed timestamptz;
  v_found boolean;
begin
  if auth.uid() is null or not private.has_role(p_organisation_id, array['owner']) then
    return false;
  end if;
  select o.setup_completed_at, true into v_completed, v_found
  from public.organisations o
  where o.id = p_organisation_id
  for share;
  return coalesce(v_found, false)
    and v_completed is null
    and not exists (
      select 1
      from public.audit_log a
      where a.organisation_id = p_organisation_id
        and a.action = 'people.bank_details_single_approver'
        and (a.after ->> 'batch_id')::uuid is distinct from p_batch_id
    );
end;
$$;

-- Writes a new worker's bank details straight to the worker, for the owner's import while setup
-- is unfinished. Called only from public.commit_import_batch (private schema, not reachable
-- through the API). Checks everything again: the owner role and unfinished setup (under the
-- share lock above), the batch, and that the worker was created in this transaction (created_at
-- is the transaction's now(); signed-in users can't set it) with no bank details and no open
-- bank-detail change. Audited per worker as people.bank_details_single_approver; the workers
-- row and personal-data audits record the change (never the number).
create function private.import_bank_details_single_approver(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_worker_id uuid,
  p_bank_name text,
  p_account_name text,
  p_bank_account_enc bytea,
  p_bank_account_last4 text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.import_single_approver(p_organisation_id, p_batch_id) then
    raise exception 'Only the owner''s first import, before setup is finished, can skip the bank-detail approval.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.import_batches b
    where b.id = p_batch_id
      and b.organisation_id = p_organisation_id
      and b.status in ('validated', 'committed')
  ) then
    raise exception 'That import wasn''t found.' using errcode = 'P0002';
  end if;
  if num_nulls(p_bank_name, p_account_name, p_bank_account_enc, p_bank_account_last4) > 0 then
    raise exception 'Bank details are incomplete.' using errcode = '22023';
  end if;

  update public.workers w
  set bank_name = p_bank_name,
      account_name = p_account_name,
      bank_account_enc = p_bank_account_enc,
      bank_account_last4 = p_bank_account_last4
  where w.id = p_worker_id
    and w.organisation_id = p_organisation_id
    and w.created_at = now()
    and w.bank_account_enc is null
    and w.bank_name is null
    and not exists (
      select 1 from public.bank_detail_changes c
      where c.worker_id = w.id and c.status in ('pending', 'approved')
    );
  if not found then
    raise exception 'Bank details can be saved this way only for an employee this import just created.'
      using errcode = '42501';
  end if;

  perform private.log_audit_impl(
    p_organisation_id,
    'people.bank_details_single_approver',
    'workers',
    p_worker_id,
    null,
    jsonb_build_object('batch_id', p_batch_id, 'bank_name', p_bank_name),
    'First import by the owner before company setup was finished (owner decision 20): bank details saved without a second approver.'
  );
end;
$$;

revoke all on function private.import_single_approver(uuid, uuid) from public, anon;
revoke all on function private.import_bank_details_single_approver(uuid, uuid, uuid, text, text, bytea, text)
  from public, anon;
grant execute on function private.import_single_approver(uuid, uuid) to authenticated;
grant execute on function private.import_bank_details_single_approver(uuid, uuid, uuid, text, text, bytea, text)
  to authenticated;

-- As in 20261116200000, except that when private.import_single_approver says so (the owner,
-- setup unfinished), each new worker's bank details are written straight to the worker instead
-- of becoming a pending bank-detail change, and the result counts them in
-- 'bank_details_saved'. Admin and hr imports, imports after setup, Add employee and direct
-- create_worker calls keep the two-person hold.
create or replace function public.commit_import_batch(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  v_status public.import_batch_status;
  v_sent integer;
  v_found integer;
  v_done integer;
  v_held integer;
  v_item jsonb;
  v_worker jsonb;
  v_worker_id uuid;
  v_departments jsonb;
  v_clients jsonb;
  v_sites jsonb;
  v_projects jsonb;
  v_department uuid;
  v_client uuid;
  v_site uuid;
  v_project uuid;
  v_created integer := 0;
  v_new_departments integer := 0;
  v_new_clients integer := 0;
  v_new_sites integer := 0;
  v_new_projects integer := 0;
  v_single_approver boolean := false;
  v_bank public.workers;
  v_bank_saved integer := 0;
begin
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Your role can''t import employees.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Nothing to import.' using errcode = '22023';
  end if;

  -- One commit per batch at a time.
  select b.status into v_status
  from public.import_batches b
  where b.id = p_batch_id and b.organisation_id = p_organisation_id
  for update;
  if v_status is null then
    raise exception 'That import wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status = 'cancelled' then
    raise exception 'This import was cancelled. Upload the file again.' using errcode = 'MLIM2';
  end if;
  if v_status = 'uploaded' then
    raise exception 'Check the file before importing it.' using errcode = 'MLIM2';
  end if;

  -- The rows named (kept still by the batch lock above).
  select count(*)::integer into v_sent from jsonb_array_elements(p_rows);
  select count(*)::integer,
         count(*) filter (where r.status = 'imported')::integer,
         count(*) filter (where r.status = 'held')::integer
  into v_found, v_done, v_held
  from public.import_rows r
  where r.batch_id = p_batch_id
    and r.organisation_id = p_organisation_id
    and r.id in (select (e.item ->> 'row_id')::uuid from jsonb_array_elements(p_rows) as e (item));

  if v_found <> v_sent then
    raise exception 'A row of this import wasn''t found.' using errcode = 'P0002';
  end if;
  if v_sent = 0 then
    return jsonb_build_object('created', 0, 'already_imported', 0, 'departments', 0,
      'clients', 0, 'sites', 0, 'projects', 0);
  end if;
  if v_done = v_sent then
    return jsonb_build_object('created', 0, 'already_imported', v_done, 'departments', 0,
      'clients', 0, 'sites', 0, 'projects', 0);
  end if;
  if v_done > 0 then
    raise exception 'Some of these rows were imported a moment ago. Check the file again.'
      using errcode = 'MLIM1';
  end if;
  if v_held > 0 then
    raise exception 'Rows that need fixing can''t be imported yet. Check the file again.'
      using errcode = 'MLIM1';
  end if;

  -- Decision 20: the owner's import before setup is finished saves bank details directly.
  v_single_approver := private.import_single_approver(p_organisation_id, p_batch_id);

  -- New names, once each. The server sends a name only when it found no match.
  insert into public.departments (organisation_id, name)
  select distinct on (lower(n.name)) p_organisation_id, n.name
  from (
    select btrim(e.item -> 'department' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where (e.item -> 'department') ? 'name'
  ) as n
  where n.name <> ''
  on conflict (organisation_id, lower(name)) do nothing;
  get diagnostics v_new_departments = row_count;

  insert into public.clients (organisation_id, name)
  select distinct on (lower(n.name)) p_organisation_id, n.name
  from (
    select btrim(e.item -> 'client' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where jsonb_typeof(e.item -> 'client') = 'object' and (e.item -> 'client') ? 'name'
  ) as n
  where n.name <> ''
  on conflict (organisation_id, lower(name)) do nothing;
  get diagnostics v_new_clients = row_count;

  -- Lookups by id and by lower-case name, for this organisation only.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_departments
  from public.departments d
  cross join lateral (values ('id:' || d.id::text, d.id), ('name:' || lower(d.name), d.id)) as m (k, v)
  where d.organisation_id = p_organisation_id;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_clients
  from public.clients c
  cross join lateral (values ('id:' || c.id::text, c.id), ('name:' || lower(c.name), c.id)) as m (k, v)
  where c.organisation_id = p_organisation_id;

  -- Sites and projects belong to a client: new ones once each per client.
  insert into public.sites (organisation_id, client_id, name)
  select distinct on (n.client_id, lower(n.name)) p_organisation_id, n.client_id, n.name
  from (
    select (v_clients ->> case
              when (e.item -> 'client') ? 'id' then 'id:' || (e.item -> 'client' ->> 'id')
              else 'name:' || lower(btrim(e.item -> 'client' ->> 'name'))
            end)::uuid as client_id,
           btrim(e.item -> 'site' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where jsonb_typeof(e.item -> 'client') = 'object'
      and jsonb_typeof(e.item -> 'site') = 'object'
      and (e.item -> 'site') ? 'name'
  ) as n
  where n.client_id is not null and n.name <> ''
  on conflict (organisation_id, client_id, lower(name)) do nothing;
  get diagnostics v_new_sites = row_count;

  insert into public.projects (organisation_id, client_id, name)
  select distinct on (n.client_id, lower(n.name)) p_organisation_id, n.client_id, n.name
  from (
    select (v_clients ->> case
              when (e.item -> 'client') ? 'id' then 'id:' || (e.item -> 'client' ->> 'id')
              else 'name:' || lower(btrim(e.item -> 'client' ->> 'name'))
            end)::uuid as client_id,
           btrim(e.item -> 'project' ->> 'name') as name
    from jsonb_array_elements(p_rows) as e (item)
    where jsonb_typeof(e.item -> 'client') = 'object'
      and jsonb_typeof(e.item -> 'project') = 'object'
      and (e.item -> 'project') ? 'name'
  ) as n
  where n.client_id is not null and n.name <> ''
  on conflict (organisation_id, client_id, lower(name)) do nothing;
  get diagnostics v_new_projects = row_count;

  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_sites
  from public.sites s
  cross join lateral (
    values ('id:' || s.client_id::text || ':' || s.id::text, s.id),
           ('name:' || s.client_id::text || ':' || lower(s.name), s.id)
  ) as m (k, v)
  where s.organisation_id = p_organisation_id;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_projects
  from public.projects p
  cross join lateral (
    values ('id:' || p.client_id::text || ':' || p.id::text, p.id),
           ('name:' || p.client_id::text || ':' || lower(p.name), p.id)
  ) as m (k, v)
  where p.organisation_id = p_organisation_id;

  for v_item in
    select e.item from jsonb_array_elements(p_rows) with ordinality as e (item, n) order by e.n
  loop
    v_department := (v_departments ->> case
      when (v_item -> 'department') ? 'id' then 'id:' || (v_item -> 'department' ->> 'id')
      else 'name:' || lower(btrim(v_item -> 'department' ->> 'name'))
    end)::uuid;
    if v_department is null then
      raise exception 'An employee in this import has no department.' using errcode = '22023';
    end if;

    v_client := null;
    v_site := null;
    v_project := null;
    if jsonb_typeof(v_item -> 'client') = 'object' then
      v_client := (v_clients ->> case
        when (v_item -> 'client') ? 'id' then 'id:' || (v_item -> 'client' ->> 'id')
        else 'name:' || lower(btrim(v_item -> 'client' ->> 'name'))
      end)::uuid;
      if v_client is null then
        raise exception 'A client in this import wasn''t found.' using errcode = 'P0002';
      end if;
      if jsonb_typeof(v_item -> 'site') = 'object' then
        v_site := (v_sites ->> case
          when (v_item -> 'site') ? 'id' then 'id:' || v_client::text || ':' || (v_item -> 'site' ->> 'id')
          else 'name:' || v_client::text || ':' || lower(btrim(v_item -> 'site' ->> 'name'))
        end)::uuid;
        if v_site is null then
          raise exception 'A site in this import wasn''t found.' using errcode = 'P0002';
        end if;
      end if;
      if jsonb_typeof(v_item -> 'project') = 'object' then
        v_project := (v_projects ->> case
          when (v_item -> 'project') ? 'id' then 'id:' || v_client::text || ':' || (v_item -> 'project' ->> 'id')
          else 'name:' || v_client::text || ':' || lower(btrim(v_item -> 'project' ->> 'name'))
        end)::uuid;
        if v_project is null then
          raise exception 'A project in this import wasn''t found.' using errcode = 'P0002';
        end if;
      end if;
    end if;

    -- The worker, always in this organisation, with the department and line manager resolved
    -- here. create_worker runs as the caller: RLS, grants and the workers triggers apply
    -- (line-manager checks, needs_pay_details, audit).
    v_worker := coalesce(v_item -> 'worker', '{}'::jsonb)
      || jsonb_build_object(
        'organisation_id', p_organisation_id,
        'department_id', v_department,
        'line_manager_worker_id', v_item -> 'line_manager' ->> 'worker_id',
        'line_manager_membership_id', v_item -> 'line_manager' ->> 'membership_id'
      );
    v_bank := jsonb_populate_record(null::public.workers, v_worker);
    if v_single_approver
      and num_nulls(v_bank.bank_name, v_bank.account_name, v_bank.bank_account_enc, v_bank.bank_account_last4) = 0 then
      v_worker_id := public.create_worker(
        v_worker - 'bank_name' - 'account_name' - 'bank_account_enc' - 'bank_account_last4',
        null
      );
      perform private.import_bank_details_single_approver(
        p_organisation_id, p_batch_id, v_worker_id, v_bank.bank_name, v_bank.account_name,
        v_bank.bank_account_enc, v_bank.bank_account_last4
      );
      v_bank_saved := v_bank_saved + 1;
    else
      v_worker_id := public.create_worker(v_worker, null);
    end if;

    -- The first pay version from the start date. The worker is new, so there is nothing to
    -- close; private.pay_rates_guard still checks the start date.
    if jsonb_typeof(v_item -> 'pay_rate') = 'object' then
      insert into public.pay_rates (
        organisation_id, worker_id, pay_type, basic_kobo, housing_kobo, transport_kobo,
        other_allowances_kobo, daily_rate_kobo, hourly_rate_kobo, effective_from
      )
      values (
        p_organisation_id,
        v_worker_id,
        (v_item -> 'pay_rate' ->> 'pay_type')::public.pay_type,
        (v_item -> 'pay_rate' ->> 'basic_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'housing_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'transport_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'other_allowances_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'daily_rate_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'hourly_rate_kobo')::bigint,
        (v_item -> 'pay_rate' ->> 'effective_from')::date
      );
    end if;

    if v_client is not null then
      insert into public.worker_assignments (
        organisation_id, worker_id, client_id, site_id, project_id, effective_from
      )
      values (
        p_organisation_id, v_worker_id, v_client, v_site, v_project,
        (v_worker ->> 'start_date')::date
      );
    end if;

    v_created := v_created + 1;
  end loop;

  perform private.mark_import_rows_imported(p_organisation_id, p_batch_id, p_rows);

  update public.import_batches b
  set status = 'committed',
      committed_at = coalesce(b.committed_at, now()),
      committed_by = coalesce(b.committed_by, (select auth.uid())),
      rows_ready = counts.ready,
      rows_held = counts.held,
      rows_imported = counts.imported
  from (
    select
      count(*) filter (where r.status in ('ready', 'fixed'))::integer as ready,
      count(*) filter (where r.status = 'held')::integer as held,
      count(*) filter (where r.status = 'imported')::integer as imported
    from public.import_rows r
    where r.batch_id = p_batch_id
  ) as counts
  where b.id = p_batch_id and b.organisation_id = p_organisation_id;

  perform public.log_audit(
    p_organisation_id,
    'people.import_committed',
    'import_batches',
    p_batch_id,
    null,
    jsonb_build_object(
      'created', v_created,
      'departments', v_new_departments,
      'clients', v_new_clients,
      'sites', v_new_sites,
      'projects', v_new_projects,
      'bank_details_saved', v_bank_saved
    ),
    null
  );

  return jsonb_build_object(
    'created', v_created,
    'already_imported', 0,
    'departments', v_new_departments,
    'clients', v_new_clients,
    'sites', v_new_sites,
    'projects', v_new_projects,
    'bank_details_saved', v_bank_saved
  );
end;
$$;
