-- Slice 1.9: worker invites and PIN sign-in.
--
-- Owner decisions 4, 5 and 6 (docs/PHASE_1.md): one Supabase Auth user per worker with a
-- synthetic, non-deliverable login identity; the server opens the session only after checking
-- the PIN. Invites go by email where the worker has one, otherwise on a printed QR and link
-- sheet. PINs are 6 digits; 5 wrong tries lock sign-in for 15 minutes.
--
-- 1. public.worker_invites: single-use invite links. Only the SHA-256 of the token is stored;
--    the raw token is returned once by public.create_worker_invites and lives only in the email
--    or on the printed sheet. Links expire after 7 days. A new invite for a worker revokes the
--    open one, so a reprinted sheet or a PIN reset makes earlier links stop working.
-- 2. public.worker_credentials: who has a login, when the PIN was set, failed attempts and the
--    lock. Owners, admins and HR read it (invite status); the worker reads their own row.
--    Nobody signed in can write it.
-- 3. private.worker_pins: the PIN hash (scrypt with a server-side pepper, written by
--    src/server/identity/pin.ts). It lives outside the API schema so no role but the
--    security-definer functions below can read it, not even HR.
-- 4. private.auth_throttle: attempt counters for sign-in keys that are not a worker with a login
--    (an unknown company code or staff ID behaves exactly like a real one, so sign-in never
--    reveals which exist) and per network address.
-- 5. Functions. create_worker_invites runs as the signed-in manager (owner, admin, hr). The
--    invite lookup, acceptance and the two sign-in steps are for the server's secret-key client
--    only: no signed-in or anonymous role may call them.
--
-- memberships.worker_id is set here, in private.accept_worker_invite_impl, as 20261116103000
-- promised: a worker's own login links to their worker row, so RLS shows them only that row.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.worker_invites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  token_hash text not null
    constraint worker_invites_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  sent_via text not null
    constraint worker_invites_sent_via_value check (sent_via in ('email', 'print')),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint worker_invites_token_hash_key unique (token_hash),
  constraint worker_invites_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint worker_invites_used_or_revoked check (num_nonnulls(used_at, revoked_at) <= 1),
  constraint worker_invites_expiry_after_creation check (expires_at > created_at)
);

-- At most one open invite per worker.
create unique index worker_invites_one_open_key
  on public.worker_invites (worker_id)
  where used_at is null and revoked_at is null;
create index worker_invites_organisation_idx
  on public.worker_invites (organisation_id, created_at desc);

comment on table public.worker_invites is
  'Single-use invite links for a worker to set their PIN. token_hash is SHA-256 (hex) of the token. Created by public.create_worker_invites; used by private.accept_worker_invite_impl. Never deleted: a newer invite revokes the open one.';

create table public.worker_credentials (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  failed_attempts smallint not null default 0
    constraint worker_credentials_failed_attempts_range check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  pin_set_at timestamptz not null default now(),
  privacy_notice_accepted_at timestamptz not null,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_credentials_worker_key unique (worker_id),
  constraint worker_credentials_auth_user_key unique (auth_user_id),
  constraint worker_credentials_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id)
);

create index worker_credentials_organisation_idx on public.worker_credentials (organisation_id);

comment on table public.worker_credentials is
  'A worker''s phone login: the synthetic Auth user, when the PIN was set and the sign-in lock (5 wrong PINs lock for 15 minutes). Written only by the security-definer sign-in functions. The PIN hash is in private.worker_pins.';
comment on column public.worker_credentials.failed_attempts is
  'Sign-in attempts since the last success, counted before the PIN is checked so parallel guesses cannot get past 5. Reset on success and when a lock expires.';

create table private.worker_pins (
  worker_id uuid
    constraint worker_pins_pkey primary key
    references public.worker_credentials (worker_id) on delete cascade,
  pin_hash text not null
    constraint worker_pins_pin_hash_length check (char_length(pin_hash) between 20 and 300),
  updated_at timestamptz not null default now()
);

comment on table private.worker_pins is
  'PIN hashes (scrypt with a server-side pepper; src/server/identity/pin.ts). Not in the API schema; read and written only by the private sign-in functions.';

create table private.auth_throttle (
  key text
    constraint auth_throttle_pkey primary key
    constraint auth_throttle_key_format check (key ~ '^(ip|subject):[0-9a-f]{64}$'),
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index auth_throttle_updated_at_idx on private.auth_throttle (updated_at);

comment on table private.auth_throttle is
  'Sign-in attempt counters. subject:<sha256> mirrors worker_credentials for a company code and staff ID with no login, so unknown and real IDs behave the same. ip:<sha256> caps attempts per network address.';

revoke all on table private.worker_pins from public, anon, authenticated, service_role;
revoke all on table private.auth_throttle from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Triggers
-- ---------------------------------------------------------------------------

create trigger worker_credentials_set_updated_at before update on public.worker_credentials
  for each row execute function private.set_updated_at();

create trigger worker_invites_audit after insert or update or delete on public.worker_invites
  for each row execute function private.audit_row_change();
create trigger worker_credentials_audit after insert or update or delete on public.worker_credentials
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 3. Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.worker_invites enable row level security;
alter table public.worker_credentials enable row level security;

create policy worker_invites_select on public.worker_invites for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

create policy worker_credentials_select on public.worker_credentials for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr'])
    or worker_id in (select private.my_worker_ids())
  );

-- Read only. Rows come from the functions below.
revoke all on table public.worker_invites from anon, authenticated;
grant select on table public.worker_invites to authenticated;

revoke all on table public.worker_credentials from anon, authenticated;
grant select on table public.worker_credentials to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Invites (signed-in owner, admin or hr)
-- ---------------------------------------------------------------------------

-- Creates one invite per worker and returns the raw tokens, which exist nowhere else: the
-- caller's server code emails the links or prints them. The workers must be active employees
-- of p_organisation_id; any open invite for them is revoked first. 'email' needs every worker
-- to have an email address.
create function private.create_worker_invites_impl(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_sent_via text
)
returns table (invite_id uuid, invite_worker_id uuid, token text, invite_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_ids uuid[];
  v_id uuid;
  v_token text;
begin
  if uid is null then
    raise exception 'Sign in to invite workers.' using errcode = '42501';
  end if;
  if p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Only the owner, an admin or HR can invite workers.' using errcode = '42501';
  end if;
  if p_sent_via is null or p_sent_via not in ('email', 'print') then
    raise exception 'Choose email or a printed sheet.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct x.id), '{}') into v_ids
  from unnest(p_worker_ids) as x (id)
  where x.id is not null;
  if cardinality(v_ids) = 0 or cardinality(v_ids) > 1000 then
    raise exception 'Choose between 1 and 1,000 employees.' using errcode = '22023';
  end if;

  if (
    select count(*)
    from public.workers w
    where w.id = any (v_ids)
      and w.organisation_id = p_organisation_id
      and w.status = 'active'
  ) <> cardinality(v_ids) then
    raise exception 'One or more of those employees wasn''t found or has left.' using errcode = 'P0002';
  end if;

  if p_sent_via = 'email' and exists (
    select 1 from public.workers w where w.id = any (v_ids) and w.email is null
  ) then
    raise exception 'Every employee invited by email needs an email address.' using errcode = '22023';
  end if;

  update public.worker_invites i
  set revoked_at = now()
  where i.organisation_id = p_organisation_id
    and i.worker_id = any (v_ids)
    and i.used_at is null
    and i.revoked_at is null;

  foreach v_id in array v_ids loop
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.worker_invites (organisation_id, worker_id, token_hash, sent_via, created_by)
    values (
      p_organisation_id,
      v_id,
      encode(extensions.digest(v_token, 'sha256'), 'hex'),
      p_sent_via,
      uid
    )
    returning id, expires_at into invite_id, invite_expires_at;
    invite_worker_id := v_id;
    token := v_token;
    return next;
  end loop;
end;
$$;

create function public.create_worker_invites(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_sent_via text
)
returns table (invite_id uuid, invite_worker_id uuid, token text, invite_expires_at timestamptz)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.create_worker_invites_impl(p_organisation_id, p_worker_ids, p_sent_via)
$$;

-- ---------------------------------------------------------------------------
-- 5. Invite lookup and acceptance (server secret key only)
-- ---------------------------------------------------------------------------

-- What the invite page shows before the worker sets a PIN. No row for an unknown token.
-- state: valid, used, revoked, expired, or ended (the worker has left).
create function private.worker_invite_lookup_impl(p_token text)
returns table (
  invite_id uuid,
  organisation_id uuid,
  organisation_name text,
  company_code text,
  worker_id uuid,
  first_name text,
  last_name text,
  staff_id text,
  auth_user_id uuid,
  state text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id,
    i.organisation_id,
    o.name,
    o.company_code,
    w.id,
    w.first_name,
    w.last_name,
    w.staff_id,
    c.auth_user_id,
    case
      when i.used_at is not null then 'used'
      when i.revoked_at is not null then 'revoked'
      when w.status <> 'active' then 'ended'
      when i.expires_at <= now() then 'expired'
      else 'valid'
    end
  from public.worker_invites i
  join public.organisations o on o.id = i.organisation_id
  join public.workers w on w.id = i.worker_id and w.organisation_id = i.organisation_id
  left join public.worker_credentials c on c.worker_id = w.id
  where p_token ~ '^[0-9a-f]{64}$'
    and i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

-- Uses an invite: stores the PIN hash, links the worker's Auth user to the worker with a
-- `worker` membership, and marks the invite used, in one transaction. p_auth_user_id is the
-- worker's synthetic login (created by the server with app_metadata.login = 'worker'); when
-- the worker already has a login (a PIN reset) it must be that one. A reset also ends every
-- session of that login, so a lost phone stays signed out. The rows are audited with the
-- worker as actor.
create function private.accept_worker_invite_impl(
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
      locked_until = null;

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

create function public.worker_invite_lookup(p_token text)
returns table (
  invite_id uuid,
  organisation_id uuid,
  organisation_name text,
  company_code text,
  worker_id uuid,
  first_name text,
  last_name text,
  staff_id text,
  auth_user_id uuid,
  state text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.worker_invite_lookup_impl(p_token)
$$;

create function public.accept_worker_invite(p_token text, p_auth_user_id uuid, p_pin_hash text)
returns table (organisation_id uuid, worker_id uuid, pin_reset boolean)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.accept_worker_invite_impl(p_token, p_auth_user_id, p_pin_hash)
$$;

-- ---------------------------------------------------------------------------
-- 6. PIN sign-in (server secret key only)
-- ---------------------------------------------------------------------------
-- The server calls worker_sign_in_begin, checks the PIN against the returned hash (or against
-- a dummy hash when there is none, so the time taken is the same), then calls
-- worker_sign_in_finish with the result. Attempts are counted in begin, before the PIN is
-- checked, so a burst of parallel guesses cannot get past 5 for one worker.
--
-- begin's outcome:
--   proceed     check the PIN. locks_on_failure is true when this is the 5th try in a row.
--   locked      5 wrong tries: refuse without checking, until the lock ends.
--   ip_blocked  too many tries from this network address in 15 minutes.
-- A company code and staff ID with no active worker login gets the same outcomes from a
-- counter in private.auth_throttle, so the answers never reveal which IDs exist.

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
  locks_on_failure boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  max_attempts constant integer := 5;
  lock_for constant interval := interval '15 minutes';
  ip_limit constant integer := 100;
  ip_window constant interval := interval '15 minutes';
  v_code text := upper(btrim(coalesce(p_company_code, '')));
  v_staff text := lower(btrim(coalesce(p_staff_id, '')));
  v_ip_attempts integer;
  v_subject text;
  v_locked boolean;
  cred public.worker_credentials%rowtype;
  t private.auth_throttle%rowtype;
begin
  if p_ip_key is null or p_ip_key !~ '^[0-9a-f]{64}$' then
    raise exception 'A network key is required.' using errcode = '22023';
  end if;
  if char_length(v_code) > 64 or char_length(v_staff) > 64 then
    raise exception 'Company code and staff ID are too long.' using errcode = '22023';
  end if;

  -- Old counters are dropped after a quiet day.
  delete from private.auth_throttle a where a.updated_at < now() - interval '1 day';

  insert into private.auth_throttle as a (key, attempts, window_started_at, updated_at)
  values ('ip:' || p_ip_key, 1, now(), now())
  on conflict on constraint auth_throttle_pkey do update
  set attempts = case when a.window_started_at <= now() - ip_window then 1 else a.attempts + 1 end,
      window_started_at = case
        when a.window_started_at <= now() - ip_window then now() else a.window_started_at
      end,
      updated_at = now()
  returning a.attempts into v_ip_attempts;

  if v_ip_attempts > ip_limit then
    outcome := 'ip_blocked';
    locks_on_failure := false;
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
    if cred.locked_until is not null and cred.locked_until > now() then
      outcome := 'locked';
      locks_on_failure := false;
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
    select p.pin_hash into pin_hash from private.worker_pins p where p.worker_id = cred.worker_id;
    return next;
    return;
  end if;

  -- No worker login for these IDs: the same counting, keyed by a hash of what was typed.
  v_subject := 'subject:' || encode(extensions.digest(v_code || '|' || v_staff, 'sha256'), 'hex');

  select * into t from private.auth_throttle a where a.key = v_subject for update;
  if found and t.locked_until is not null and t.locked_until > now() then
    update private.auth_throttle a set updated_at = now() where a.key = v_subject;
    outcome := 'locked';
    locks_on_failure := false;
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
  returning a.locked_until is not null into v_locked;

  outcome := 'proceed';
  locks_on_failure := v_locked;
  return next;
end;
$$;

-- Records the result of the PIN check. For a worker with a login, success clears the count and
-- the lock and gives back the network attempt; the 5th failure in a row is the one that locked
-- the worker in begin, and is written to the audit log as worker_auth.locked.
-- Returns signed_in, failed or locked.
create function private.worker_sign_in_finish_impl(
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
  cred public.worker_credentials%rowtype;
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

    if p_ip_key ~ '^[0-9a-f]{64}$' then
      update private.auth_throttle a
      set attempts = greatest(a.attempts - 1, 0),
          updated_at = now()
      where a.key = 'ip:' || p_ip_key;
    end if;
    return 'signed_in';
  end if;

  if cred.locked_until is not null and cred.locked_until > now() then
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
  locks_on_failure boolean
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.worker_sign_in_begin_impl(p_company_code, p_staff_id, p_ip_key)
$$;

create function public.worker_sign_in_finish(p_worker_id uuid, p_ok boolean, p_ip_key text)
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.worker_sign_in_finish_impl(p_worker_id, p_ok, p_ip_key)
$$;

-- ---------------------------------------------------------------------------
-- 7. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.create_worker_invites_impl(uuid, uuid[], text) from public, anon;
revoke all on function public.create_worker_invites(uuid, uuid[], text) from public, anon;
grant execute on function private.create_worker_invites_impl(uuid, uuid[], text) to authenticated;
grant execute on function public.create_worker_invites(uuid, uuid[], text) to authenticated;

-- Secret-key server code only.
revoke all on function private.worker_invite_lookup_impl(text) from public, anon, authenticated;
revoke all on function private.accept_worker_invite_impl(text, uuid, text) from public, anon, authenticated;
revoke all on function private.worker_sign_in_begin_impl(text, text, text) from public, anon, authenticated;
revoke all on function private.worker_sign_in_finish_impl(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.worker_invite_lookup(text) from public, anon, authenticated;
revoke all on function public.accept_worker_invite(text, uuid, text) from public, anon, authenticated;
revoke all on function public.worker_sign_in_begin(text, text, text) from public, anon, authenticated;
revoke all on function public.worker_sign_in_finish(uuid, boolean, text) from public, anon, authenticated;

grant execute on function private.worker_invite_lookup_impl(text) to service_role;
grant execute on function private.accept_worker_invite_impl(text, uuid, text) to service_role;
grant execute on function private.worker_sign_in_begin_impl(text, text, text) to service_role;
grant execute on function private.worker_sign_in_finish_impl(uuid, boolean, text) to service_role;
grant execute on function public.worker_invite_lookup(text) to service_role;
grant execute on function public.accept_worker_invite(text, uuid, text) to service_role;
grant execute on function public.worker_sign_in_begin(text, text, text) to service_role;
grant execute on function public.worker_sign_in_finish(uuid, boolean, text) to service_role;
