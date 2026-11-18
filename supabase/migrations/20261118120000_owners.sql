-- Slice 1.13: multiple owners and hand-over (owner request, 18 Nov 2026, after the Phase 1
-- sign-off).
--
-- A company can have more than one owner. Owner changes go only through the functions below,
-- for every client:
-- * With exactly one owner, that owner alone can make an existing manager an owner, or invite
--   someone as owner.
-- * With two or more owners, adding an owner, removing an owner or demoting one (stepping down
--   included) is a request that a different owner approves or rejects: the two-person rule of
--   bank-detail changes. public.owner_changes keeps every request as insert-only history (only
--   the status moves, checked by trigger), with check constraints approved_by <> requested_by
--   and rejected_by <> requested_by, and the audit triggers log every row.
-- * The last owner can never be removed or demoted (memberships_keep_owner from 0.3 still backs
--   this up for every writer). Nobody removes themselves; an owner steps down (demotes
--   themselves to another manager role) only while another owner remains. Hand-over = make
--   someone an owner, then step down.
-- * Workers (a worker membership, a worker's login) and client approvers never become owners.
-- * "The owner" in the 1.12 rules now means "an owner": owners grant admin, and change, remove,
--   resend and cancel for admins and owners. private.has_role(org, array['owner']) already
--   answered "is the caller one of the owners", so the role checks elsewhere stay as they are.
--
-- Owner invites: a membership_invites row with role 'owner' carries owner_change_id, the
-- approved request it came from. Accepting it is refused when that request was approved by a
-- single owner and the company has two or more owners by then (MLOW6): the rule for "two or
-- more owners" then applies, so someone asks again.
--
-- Refusals (SQLSTATE):
--   MLOW1 the last owner can't be removed or demoted
--   MLOW2 the requester can't approve or reject their own request
--   MLOW3 not eligible (not a manager on the team, a worker, not an owner, already an owner)
--   MLOW4 the request has already been decided
--   MLOW5 the request is out of date (the requester is no longer an owner)
--   MLOW6 the owner invite needs a second owner's approval now
--   MLOW7 a request for this person is already waiting
--   MLPW1 the account's password was not chosen after its address was confirmed: choose one
--         from an email link before accepting (any invite; see private.password_trusted)
--   MLTM1, MLTM2, MLTM6, MLTM9 as in slice 1.12; 42501 not an owner; 22023 bad input;
--   P0002 not found in this organisation.

-- ---------------------------------------------------------------------------
-- 1. owner_changes
-- ---------------------------------------------------------------------------

create type public.owner_change_kind as enum ('add', 'invite', 'remove', 'demote');
create type public.owner_change_status as enum ('pending', 'approved', 'rejected', 'cancelled');

create table public.owner_changes (
  id uuid primary key default gen_random_uuid(),
  -- No cascade: organisations are never deleted (audit_log restricts it too).
  organisation_id uuid not null references public.organisations (id),
  kind public.owner_change_kind not null,
  -- The membership acted on (add, remove, demote). No foreign key: a removal deletes the
  -- membership, and this row is history that never changes.
  target_membership_id uuid,
  target_user_id uuid,
  -- The address invited as owner (invite).
  invite_email text
    constraint owner_changes_invite_email_format check (
      char_length(invite_email) between 3 and 320
      and invite_email = lower(btrim(invite_email))
      and invite_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    ),
  -- The manager role a demoted owner gets (demote, stepping down included).
  new_role public.membership_role,
  reason text
    constraint owner_changes_reason_text check (
      reason = btrim(reason)
      and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  requested_by uuid not null default auth.uid(),
  -- How many owners the company had when it was asked, and whether that one owner decided
  -- alone (adding an owner while there was exactly one).
  owners_at_request integer not null constraint owner_changes_owners_positive check (owners_at_request >= 1),
  single_owner boolean not null default false,

  status public.owner_change_status not null default 'pending',
  approved_by uuid,
  rejected_by uuid,
  cancelled_by uuid,
  decided_at timestamptz,
  -- Set only when the database withdrew a request because its owner, or the owner it was
  -- about, stopped being an owner (cancelled_by is then whoever made that change).
  cancel_reason text
    constraint owner_changes_cancel_reason_text check (char_length(cancel_reason) between 1 and 300),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint owner_changes_kind_columns check (
    case kind
      when 'add' then num_nonnulls(target_membership_id, target_user_id) = 2
        and num_nonnulls(invite_email, new_role) = 0
      when 'invite' then invite_email is not null
        and num_nonnulls(target_membership_id, target_user_id, new_role) = 0
      when 'remove' then num_nonnulls(target_membership_id, target_user_id) = 2
        and num_nonnulls(invite_email, new_role) = 0
      when 'demote' then num_nonnulls(target_membership_id, target_user_id) = 2
        and invite_email is null
        and new_role in ('admin', 'hr', 'finance', 'ops_manager', 'line_manager')
    end
  ),

  -- One owner decides alone only when adding an owner while they are the only one.
  constraint owner_changes_single_owner check (
    not single_owner or (kind in ('add', 'invite') and owners_at_request = 1)
  ),

  -- The two-person rule, for every writer.
  constraint owner_changes_second_approver check (approved_by <> requested_by),
  constraint owner_changes_second_rejecter check (rejected_by <> requested_by),

  constraint owner_changes_status_columns check (
    case status
      when 'pending' then num_nonnulls(approved_by, rejected_by, cancelled_by, decided_at) = 0
        and not single_owner
      when 'approved' then decided_at is not null
        and num_nonnulls(rejected_by, cancelled_by) = 0
        and (approved_by is not null) <> single_owner
      when 'rejected' then rejected_by is not null and decided_at is not null
        and num_nonnulls(approved_by, cancelled_by) = 0 and not single_owner
      when 'cancelled' then cancelled_by is not null and decided_at is not null
        and num_nonnulls(approved_by, rejected_by) = 0 and not single_owner
    end
    and (cancel_reason is null or status = 'cancelled')
  )
);

-- One waiting request per member, and per invited address.
create unique index owner_changes_one_pending_target_key
  on public.owner_changes (target_membership_id)
  where status = 'pending';
create unique index owner_changes_one_pending_invite_key
  on public.owner_changes (organisation_id, invite_email)
  where status = 'pending';
create index owner_changes_organisation_status_idx
  on public.owner_changes (organisation_id, status, created_at desc);

comment on table public.owner_changes is
  'Owner changes (slice 1.13): add an owner (existing manager or invite), remove an owner, demote one (stepping down included). With one owner, that owner adds an owner alone (single_owner); with two or more, a different owner approves. The last owner is never removed or demoted. Insert-only history: only the status moves, by trigger-checked updates. Written only by public.request_owner_change and public.decide_owner_change.';

-- Owner invites point at the approved request they came from.
alter table public.membership_invites
  add column owner_change_id uuid references public.owner_changes (id);

alter table public.membership_invites
  drop constraint membership_invites_manager_role;
alter table public.membership_invites
  add constraint membership_invites_manager_role
    check (
      accepted_at is not null
      or revoked_at is not null
      or (role in ('admin', 'hr', 'finance', 'ops_manager', 'line_manager') and owner_change_id is null)
      or (role = 'owner' and owner_change_id is not null)
    );

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- How many owners the organisation has.
create function private.owner_count(org uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.memberships m
  where m.organisation_id = org
    and m.role = 'owner'
$$;

-- Serialises owner changes in one organisation. The same lock memberships_keep_owner takes, so
-- a request, an approval, an owner invite being accepted and the last-owner guard queue up.
create function private.lock_owners(org uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select null::void
  from public.organisations o
  where o.id = org
  for no key update
$$;

-- Raises unless the caller is an owner of `org`. Locks the caller's own membership row (FOR
-- SHARE) so their role can't change underneath the rest of the transaction.
create function private.assert_owner(org uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to change the owners' using errcode = '42501';
  end if;
  perform 1
  from public.memberships m
  where m.organisation_id = org
    and m.user_id = auth.uid()
  for share;
  if org is null or not private.has_role(org, array['owner']) then
    raise exception 'only an owner can change who owns the company' using errcode = '42501';
  end if;
end;
$$;

-- True when `uid` is a worker's login (synthetic, PIN-protected; set only with the secret key).
create function private.is_worker_login(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = uid
      and (u.raw_app_meta_data ->> 'login' = 'worker' or lower(u.email) like '%.invalid')
  )
$$;

-- Checks that an owner change can happen now, against the company as it is, and returns the
-- membership it acts on (locked FOR UPDATE), or null for an invite. Used when a change is asked
-- for and again when it is approved. Expects private.lock_owners(org) already held.
create function private.owner_change_check(
  p_organisation_id uuid,
  p_kind public.owner_change_kind,
  p_membership_id uuid,
  p_target_user_id uuid,
  p_email text,
  p_new_role public.membership_role
)
returns public.memberships
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target public.memberships%rowtype;
  v_existing public.membership_role;
begin
  if p_kind = 'invite' then
    if p_email is null
      or char_length(p_email) not between 3 and 320
      or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
      raise exception 'enter a valid email address' using errcode = '22023';
    end if;
    if p_email like '%.invalid' or exists (
      select 1 from auth.users u
      where lower(u.email) = p_email
        and u.raw_app_meta_data ->> 'login' = 'worker'
    ) then
      raise exception 'this address can''t be invited as an owner' using errcode = 'MLTM2';
    end if;
    select m.role into v_existing
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organisation_id = p_organisation_id
      and lower(u.email) = p_email
    limit 1;
    if v_existing = 'worker' then
      raise exception 'this address can''t be invited as an owner' using errcode = 'MLTM2';
    elsif v_existing is not null then
      raise exception 'this person is already a member: make them an owner from their row instead'
        using errcode = 'MLTM1';
    end if;
    return null;
  end if;

  select * into target
  from public.memberships m
  where m.id = p_membership_id
    and m.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if p_target_user_id is not null and target.user_id <> p_target_user_id then
    raise exception 'member not found' using errcode = 'P0002';
  end if;

  if p_kind = 'add' then
    if target.role = 'owner' then
      raise exception 'they are already an owner' using errcode = 'MLOW3';
    end if;
    if not (target.role = any (private.team_roles()))
      or target.worker_id is not null
      or private.is_worker_login(target.user_id) then
      raise exception 'only a manager on the team can become an owner; workers and client approvers can''t'
        using errcode = 'MLOW3';
    end if;
    return target;
  end if;

  -- remove, demote
  if target.role <> 'owner' then
    raise exception 'they are not an owner' using errcode = 'MLOW3';
  end if;
  if p_kind = 'demote'
    and (p_new_role is null or not (p_new_role = any (private.team_roles()))) then
    raise exception 'choose admin, HR, finance, operations manager or line manager'
      using errcode = '22023';
  end if;
  if private.owner_count(p_organisation_id) < 2 then
    raise exception 'a company always keeps at least one owner: make someone else an owner first'
      using errcode = 'MLOW1';
  end if;
  return target;
end;
$$;

-- Makes an owner change happen. For an invite, cancels any pending invite for the address,
-- counts the send against the 1.12 caps and returns the raw token (it exists nowhere else; the
-- caller's server code emails the link). The membership audit triggers log the change.
create function private.owner_change_apply(c public.owner_changes)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_token text;
begin
  case c.kind
    when 'add' then
      update public.memberships m
      set role = 'owner'
      where m.id = c.target_membership_id
        and m.organisation_id = c.organisation_id;
    when 'remove' then
      delete from public.memberships m
      where m.id = c.target_membership_id
        and m.organisation_id = c.organisation_id
        and m.role = 'owner';
    when 'demote' then
      update public.memberships m
      set role = c.new_role
      where m.id = c.target_membership_id
        and m.organisation_id = c.organisation_id
        and m.role = 'owner';
    when 'invite' then
      perform private.record_team_invite_send(c.organisation_id);
      update public.membership_invites i
      set revoked_at = now(),
          revoked_by = uid
      where i.organisation_id = c.organisation_id
        and i.email = c.invite_email
        and i.accepted_at is null
        and i.revoked_at is null;
      v_token := encode(extensions.gen_random_bytes(32), 'hex');
      insert into public.membership_invites (
        organisation_id, email, role, token_hash, created_by, owner_change_id
      )
      values (
        c.organisation_id,
        c.invite_email,
        'owner',
        encode(extensions.digest(v_token, 'sha256'), 'hex'),
        -- The owner who asked is the inviter; acceptance checks they are still an owner.
        c.requested_by,
        c.id
      );
  end case;
  if c.kind <> 'invite' and not found then
    raise exception 'that member changed meanwhile: refresh and try again' using errcode = 'MLOW5';
  end if;
  -- A removed or demoted owner's own pending requests, and pending requests about them, are
  -- withdrawn in the same transaction (owner confirmed 19 Nov 2026).
  if c.kind in ('remove', 'demote') then
    update public.owner_changes x
    set status = 'cancelled',
        cancelled_by = uid,
        cancel_reason = 'Withdrawn automatically: the owner who asked, or the owner it was about, is no longer an owner.'
    where x.organisation_id = c.organisation_id
      and x.status = 'pending'
      and x.id <> c.id
      and (x.requested_by = c.target_user_id or x.target_membership_id = c.target_membership_id);
  end if;
  return v_token;
end;
$$;

-- True when `p_password_set_at` (app_metadata.password_set_at, ISO 8601 text) is at or after
-- the address confirmation: the account's password was chosen by whoever holds the mailbox.
create function private.password_trusted(p_password_set_at text, p_confirmed_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_confirmed_at is not null
    and coalesce(p_password_set_at, '') ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:?\d{2})$'
    and p_password_set_at::timestamptz >= p_confirmed_at
$$;

-- Ends every other session of the caller (deletes them from auth.sessions, so their refresh
-- tokens stop working; an access token already issued lasts until it expires, at most
-- jwt_expiry). Used after a password is chosen from an email link. Returns how many ended.
create function private.end_other_sessions_impl()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session uuid;
  v_count integer;
begin
  if auth.uid() is null or not private.session_trusted() then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  begin
    v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    v_session := null;
  end;
  delete from auth.sessions s
  where s.user_id = auth.uid()
    and s.id is distinct from v_session;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.end_other_sessions()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.end_other_sessions_impl()
$$;

-- Email-link sends started from the app (join page, owner sign-up), so the link can't be used to
-- send mail at scale: Supabase counts the server's address, not the visitor's. Keys are hashes
-- the server computes (the invite token, the visitor's address, the typed email).
create table private.email_link_sends (
  id bigint generated always as identity primary key,
  key text not null constraint email_link_sends_key_length check (char_length(key) between 8 and 200),
  sent_at timestamptz not null default now()
);
create index email_link_sends_key_idx on private.email_link_sends (key, sent_at);
revoke all on table private.email_link_sends from public, anon, authenticated, service_role;

-- Records one send under each key unless one of them reached its cap in the last hour; returns
-- whether the send may go. Server secret key only. Keys look like 'token:<hash>' (5 an hour),
-- 'ip:<hash>' (20 an hour) or 'email:<hash>' (5 an hour).
create function private.email_link_allowed_impl(p_keys text[])
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k text;
  v_cap integer;
begin
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 5 then
    raise exception 'give one to five keys' using errcode = '22023';
  end if;
  foreach k in array p_keys loop
    perform pg_advisory_xact_lock(hashtextextended('email_link:' || k, 0));
  end loop;
  foreach k in array p_keys loop
    v_cap := case split_part(k, ':', 1) when 'ip' then 20 else 5 end;
    if (
      select count(*) from private.email_link_sends e
      where e.key = k and e.sent_at > now() - interval '1 hour'
    ) >= v_cap then
      return false;
    end if;
  end loop;
  insert into private.email_link_sends (key) select unnest(p_keys);
  delete from private.email_link_sends e where e.sent_at < now() - interval '1 day';
  return true;
end;
$$;

create function public.email_link_allowed(p_keys text[])
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.email_link_allowed_impl(p_keys)
$$;

-- The definer functions here delete from auth.sessions and this migration updates auth.users:
-- fail loudly rather than silently if the migration role can't.
do $$
begin
  if not has_table_privilege(current_user, 'auth.sessions', 'DELETE') then
    raise exception 'slice 1.13 needs DELETE on auth.sessions for %', current_user;
  end if;
  if not has_table_privilege(current_user, 'auth.users', 'UPDATE') then
    raise exception 'slice 1.13 needs UPDATE on auth.users for %', current_user;
  end if;
end;
$$;

-- Accounts already confirmed when this migration runs keep signing in with their password:
-- their password counts as chosen now. Worker logins (PIN, synthetic address) are left alone.
update auth.users u
set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object(
    'password_set_at',
    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
where u.email_confirmed_at is not null
  and coalesce(u.raw_app_meta_data ->> 'login', '') <> 'worker'
  and lower(coalesce(u.email, '')) not like '%.invalid';

-- ---------------------------------------------------------------------------
-- 3. Triggers: insert-only history, two-person rule, workers never owners
-- ---------------------------------------------------------------------------

-- BEFORE INSERT. The requester is an owner of the company; a request is pending, except the
-- one owner adding an owner alone.
create function private.owner_changes_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and new.requested_by is distinct from auth.uid() then
    raise exception 'a request is recorded under the name of whoever makes it' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = new.organisation_id
      and m.user_id = new.requested_by
      and m.role = 'owner'
  ) then
    raise exception 'only an owner can ask for an owner change' using errcode = '42501';
  end if;
  new.owners_at_request := private.owner_count(new.organisation_id);
  if new.single_owner then
    if new.owners_at_request <> 1 or new.kind not in ('add', 'invite') then
      raise exception 'with two or more owners, another owner must approve' using errcode = 'MLOW2';
    end if;
    new.status := 'approved';
    new.approved_by := null;
    new.decided_at := now();
  else
    if new.kind in ('add', 'invite') and new.owners_at_request = 1 then
      raise exception 'with one owner, that owner decides alone' using errcode = '22023';
    end if;
    new.status := 'pending';
    new.approved_by := null;
    new.decided_at := null;
  end if;
  new.rejected_by := null;
  new.cancelled_by := null;
  new.cancel_reason := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

-- BEFORE UPDATE. Only a pending request moves, once, and only its status and decision columns.
-- An approver is an owner of the company other than the requester (also check constraints).
create function private.owner_changes_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_decision constant text[] := array[
    'status', 'approved_by', 'rejected_by', 'cancelled_by', 'cancel_reason', 'decided_at',
    'updated_at'
  ];
begin
  if old.status <> 'pending' or new.status = old.status then
    raise exception 'this request has already been decided' using errcode = 'MLOW4';
  end if;
  if (to_jsonb(new) - c_decision) <> (to_jsonb(old) - c_decision) then
    raise exception 'an owner change request can''t be edited' using errcode = 'MLOW4';
  end if;
  if new.status <> 'cancelled' and new.cancel_reason is not null then
    raise exception 'only a withdrawal has a reason' using errcode = '42501';
  end if;
  -- A withdrawal is the requester's, unless the database withdraws it (cancel_reason set) while
  -- applying a removal or demotion, under the name of whoever made that change.
  if new.status = 'cancelled' and new.cancel_reason is null
    and new.cancelled_by is distinct from old.requested_by then
    raise exception 'only the owner who asked can withdraw this' using errcode = '42501';
  end if;
  if new.status = 'cancelled' and new.cancel_reason is not null and auth.uid() is null then
    raise exception 'an automatic withdrawal needs the owner who made the change' using errcode = '42501';
  end if;
  -- A signed-in decider is always named as themselves (the secret key has no user).
  if auth.uid() is not null
    and coalesce(new.approved_by, new.rejected_by, new.cancelled_by) is distinct from auth.uid() then
    raise exception 'a decision is recorded under the name of whoever makes it' using errcode = '42501';
  end if;
  if new.status = 'approved' and not exists (
    select 1 from public.memberships m
    where m.organisation_id = old.organisation_id
      and m.user_id = new.approved_by
      and m.role = 'owner'
  ) then
    raise exception 'only another owner can approve' using errcode = '42501';
  end if;
  if new.status = 'rejected' and not exists (
    select 1 from public.memberships m
    where m.organisation_id = old.organisation_id
      and m.user_id = new.rejected_by
      and m.role = 'owner'
  ) then
    raise exception 'only another owner can reject' using errcode = '42501';
  end if;
  new.decided_at := now();
  new.updated_at := now();
  return new;
end;
$$;

-- BEFORE DELETE (row) and BEFORE TRUNCATE (statement): history is never removed, by anyone.
create function private.owner_changes_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'owner changes are kept as history and can''t be deleted' using errcode = 'MLOW4';
end;
$$;

-- BEFORE INSERT OR UPDATE on memberships: a worker never becomes an owner, whoever writes.
create function private.memberships_owner_not_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'owner'
    and (new.worker_id is not null or private.is_worker_login(new.user_id)) then
    raise exception 'a worker can''t be an owner' using errcode = 'MLOW3';
  end if;
  return new;
end;
$$;

create trigger owner_changes_before_insert
  before insert on public.owner_changes
  for each row execute function private.owner_changes_before_insert();
create trigger owner_changes_before_update
  before update on public.owner_changes
  for each row execute function private.owner_changes_before_update();
create trigger owner_changes_no_delete
  before delete on public.owner_changes
  for each row execute function private.owner_changes_no_delete();
create trigger owner_changes_no_truncate
  before truncate on public.owner_changes
  for each statement execute function private.owner_changes_no_delete();
create trigger owner_changes_audit
  after insert or update or delete on public.owner_changes
  for each row execute function private.audit_row_change();

create trigger memberships_owner_not_worker
  before insert or update on public.memberships
  for each row execute function private.memberships_owner_not_worker();

-- BEFORE INSERT/UPDATE/DELETE on memberships: the secret key never makes someone an owner and
-- never changes or removes an owner row. Owner changes run inside the definer functions (as
-- their owner, postgres), so current_user is service_role only for a direct secret-key write.
-- Not security definer, so current_user is the caller.
create function private.memberships_owner_not_service_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'service_role' and (
    (tg_op in ('INSERT', 'UPDATE') and new.role = 'owner')
    or (tg_op in ('UPDATE', 'DELETE') and old.role = 'owner')
  ) then
    raise exception 'owners change only through owner requests, never with the secret key'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger memberships_owner_not_service_role
  before insert or update or delete on public.memberships
  for each row execute function private.memberships_owner_not_service_role();

-- ---------------------------------------------------------------------------
-- 4. Request and decide
-- ---------------------------------------------------------------------------

-- Asks for an owner change. With one owner adding an owner it happens at once (and, for an
-- invite, returns the token to email); otherwise it waits for another owner.
create function private.request_owner_change_impl(
  p_organisation_id uuid,
  p_kind public.owner_change_kind,
  p_membership_id uuid,
  p_email text,
  p_new_role public.membership_role,
  p_reason text
)
returns table (
  change_id uuid,
  change_status public.owner_change_status,
  invite_token text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_email text := lower(btrim(p_email));
  v_reason text := nullif(btrim(p_reason), '');
  v_owners integer;
  target public.memberships%rowtype;
  c public.owner_changes%rowtype;
  v_token text;
begin
  if p_kind is null then
    raise exception 'choose an owner change' using errcode = '22023';
  end if;
  if uid is null or p_organisation_id is null
    or not (p_organisation_id in (select private.user_org_ids())) then
    raise exception 'only an owner can change who owns the company' using errcode = '42501';
  end if;
  -- Lock order everywhere: the organisation, then memberships, then invite or request rows.
  perform private.lock_owners(p_organisation_id);
  perform private.assert_owner(p_organisation_id);

  if p_kind = 'remove' then
    if exists (
      select 1 from public.memberships m
      where m.id = p_membership_id and m.user_id = uid
    ) then
      raise exception 'you can''t remove yourself: step down to another role instead'
        using errcode = 'MLTM6';
    end if;
  end if;

  target := private.owner_change_check(
    p_organisation_id, p_kind, p_membership_id, null,
    case when p_kind = 'invite' then v_email end,
    case when p_kind = 'demote' then p_new_role end
  );
  v_owners := private.owner_count(p_organisation_id);

  begin
    insert into public.owner_changes (
      organisation_id, kind, target_membership_id, target_user_id, invite_email, new_role,
      reason, requested_by, owners_at_request, single_owner
    )
    values (
      p_organisation_id,
      p_kind,
      target.id,
      target.user_id,
      case when p_kind = 'invite' then v_email end,
      case when p_kind = 'demote' then p_new_role end,
      v_reason,
      uid,
      v_owners,
      p_kind in ('add', 'invite') and v_owners = 1
    )
    returning * into c;
  exception
    when unique_violation then
      raise exception 'an owner change for this person is already waiting for approval'
        using errcode = 'MLOW7';
  end;

  if c.status = 'approved' then
    v_token := private.owner_change_apply(c);
  end if;

  return query select c.id, c.status, v_token;
end;
$$;

-- Approves, rejects or withdraws a pending owner change. Approve and reject: an owner other than
-- the requester. Withdraw: the requester. Approval checks everything again and makes the change
-- (for an invite, returns the token to email).
create function private.decide_owner_change_impl(
  p_organisation_id uuid,
  p_change_id uuid,
  p_decision text
)
returns table (
  change_id uuid,
  change_status public.owner_change_status,
  invite_token text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  c public.owner_changes%rowtype;
  v_token text;
begin
  if uid is null then
    raise exception 'sign in to change the owners' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject', 'cancel') then
    raise exception 'choose approve, reject or withdraw' using errcode = '22023';
  end if;
  if p_organisation_id is null or not (p_organisation_id in (select private.user_org_ids())) then
    raise exception 'only an owner can change who owns the company' using errcode = '42501';
  end if;
  -- Lock order everywhere: the organisation, then memberships, then invite or request rows.
  perform private.lock_owners(p_organisation_id);
  if p_decision <> 'cancel' then
    perform private.assert_owner(p_organisation_id);
  end if;

  select * into c
  from public.owner_changes x
  where x.id = p_change_id
    and x.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if c.status <> 'pending' then
    raise exception 'this request has already been decided' using errcode = 'MLOW4';
  end if;

  if p_decision = 'cancel' then
    if c.requested_by <> uid then
      raise exception 'only the owner who asked can withdraw this; another owner can reject it'
        using errcode = '42501';
    end if;
    update public.owner_changes x
    set status = 'cancelled', cancelled_by = uid
    where x.id = c.id
    returning * into c;
    return query select c.id, c.status, null::text;
    return;
  end if;

  if uid = c.requested_by then
    raise exception 'you asked for this change, so another owner must approve or reject it'
      using errcode = 'MLOW2';
  end if;

  if p_decision = 'reject' then
    update public.owner_changes x
    set status = 'rejected', rejected_by = uid
    where x.id = c.id
    returning * into c;
    return query select c.id, c.status, null::text;
    return;
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id
      and m.user_id = c.requested_by
      and m.role = 'owner'
  ) then
    raise exception 'the owner who asked for this is no longer an owner: reject it' using errcode = 'MLOW5';
  end if;
  perform private.owner_change_check(
    p_organisation_id, c.kind, c.target_membership_id, c.target_user_id, c.invite_email, c.new_role
  );

  update public.owner_changes x
  set status = 'approved', approved_by = uid
  where x.id = c.id
  returning * into c;
  v_token := private.owner_change_apply(c);

  return query select c.id, c.status, v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Invites and team functions from 1.12, for several owners
-- ---------------------------------------------------------------------------

-- Same checks; the second message now says "an owner".
create or replace function private.assert_team_manager(org uuid, needs_owner boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to manage your team' using errcode = '42501';
  end if;
  perform 1
  from public.memberships m
  where m.organisation_id = org
    and m.user_id = auth.uid()
  for share;
  if org is null or not private.has_role(org, array['owner', 'admin']) then
    raise exception 'only an owner or an admin can manage the team' using errcode = '42501';
  end if;
  if needs_owner and not private.has_role(org, array['owner']) then
    raise exception 'only an owner can make someone an admin or change an admin or owner'
      using errcode = '42501';
  end if;
end;
$$;

-- True while an owner invite can still be used: its request is approved, its inviter is an
-- owner, and a request one owner approved alone hasn't been overtaken by a second owner.
-- Expects private.lock_owners already held.
create function private.owner_invite_usable(inv public.membership_invites)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.owner_changes%rowtype;
begin
  select * into c from public.owner_changes x where x.id = inv.owner_change_id;
  if not found or c.status <> 'approved' or c.kind <> 'invite'
    or c.organisation_id <> inv.organisation_id or c.invite_email <> inv.email then
    return 'invalid';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = inv.organisation_id
      and m.user_id = inv.created_by
      and m.role = 'owner'
  ) then
    return 'invalid';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = inv.organisation_id
      and m.user_id = c.requested_by
      and m.role = 'owner'
  ) then
    return 'invalid';
  end if;
  if c.approved_by is not null and not exists (
    select 1 from public.memberships m
    where m.organisation_id = inv.organisation_id
      and m.user_id = c.approved_by
      and m.role = 'owner'
  ) then
    return 'invalid';
  end if;
  if c.single_owner and private.owner_count(inv.organisation_id) >= 2 then
    return 'needs_approval';
  end if;
  return 'ok';
end;
$$;

-- As in 1.12; replacing a pending admin or owner invite needs an owner.
create or replace function private.create_membership_invite_impl(
  p_organisation_id uuid,
  p_email text,
  p_role public.membership_role
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_email text := lower(btrim(p_email));
  v_token text;
  v_existing public.membership_role;
  v_pending_id uuid;
  v_pending_role public.membership_role;
begin
  perform private.assert_team_manager(p_organisation_id, false);
  if p_role is null or not (p_role = any (private.team_roles())) then
    raise exception 'choose admin, HR, finance, operations manager or line manager'
      using errcode = '22023';
  end if;
  if p_role = 'admin' then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;
  if v_email is null
    or char_length(v_email) not between 3 and 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'enter a valid email address' using errcode = '22023';
  end if;

  if v_email like '%.invalid' or exists (
    select 1
    from auth.users u
    where lower(u.email) = v_email
      and u.raw_app_meta_data ->> 'login' = 'worker'
  ) then
    raise exception 'this address can''t be invited as a manager' using errcode = 'MLTM2';
  end if;

  select m.role
  into v_existing
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.organisation_id = p_organisation_id
    and lower(u.email) = v_email
  limit 1;
  if v_existing = 'worker' then
    raise exception 'this address can''t be invited as a manager' using errcode = 'MLTM2';
  elsif v_existing is not null then
    raise exception 'this person is already a member' using errcode = 'MLTM1';
  end if;

  select i.id, i.role
  into v_pending_id, v_pending_role
  from public.membership_invites i
  where i.organisation_id = p_organisation_id
    and i.email = v_email
    and i.accepted_at is null
    and i.revoked_at is null
  for update;
  if v_pending_role in ('admin', 'owner') then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;

  perform private.record_team_invite_send(p_organisation_id);

  if v_pending_id is not null then
    update public.membership_invites i
    set revoked_at = now(),
        revoked_by = uid
    where i.id = v_pending_id;
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.membership_invites (organisation_id, email, role, token_hash, created_by)
  values (
    p_organisation_id,
    v_email,
    p_role,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    uid
  );

  return v_token;
end;
$$;

-- As in 1.12, and owner invites too (owners only; refused when it needs a fresh approval).
create or replace function private.resend_membership_invite_impl(p_organisation_id uuid, p_invite_id uuid)
returns table (token text, invite_email text, invite_role public.membership_role, invite_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  inv public.membership_invites%rowtype;
  v_token text;
  v_expires_at timestamptz;
begin
  -- Owner invites: the organisation lock first, then memberships, then the invite row (the
  -- order every owner change takes), so a resend and an acceptance can't deadlock.
  if p_organisation_id in (select private.user_org_ids()) and exists (
    select 1 from public.membership_invites i
    where i.id = p_invite_id and i.organisation_id = p_organisation_id and i.role = 'owner'
  ) then
    perform private.lock_owners(p_organisation_id);
  end if;
  perform private.assert_team_manager(p_organisation_id, false);

  select *
  into inv
  from public.membership_invites i
  where i.id = p_invite_id
    and i.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if inv.accepted_at is not null then
    raise exception 'this invite has already been used' using errcode = 'MLTM3';
  end if;
  if inv.revoked_at is not null then
    raise exception 'this invite was cancelled' using errcode = 'MLTM5';
  end if;
  if not (inv.role = any (private.team_roles()) or inv.role = 'owner') then
    raise exception 'this invite is from before team invites and can''t be sent again'
      using errcode = '22023';
  end if;
  if inv.role in ('admin', 'owner') then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;
  if inv.role = 'owner' then
    perform private.lock_owners(p_organisation_id);
    if private.owner_invite_usable(inv) = 'invalid' then
      raise exception 'this owner invite is no longer valid: cancel it and ask again'
        using errcode = '42501';
    end if;
    if private.owner_invite_usable(inv) = 'needs_approval' then
      raise exception 'the company has two or more owners now, so this owner invite needs another owner''s approval: cancel it and ask again'
        using errcode = 'MLOW6';
    end if;
  end if;
  if exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organisation_id = p_organisation_id
      and lower(u.email) = inv.email
  ) then
    raise exception 'this person is already a member' using errcode = 'MLTM1';
  end if;

  perform private.record_team_invite_send(p_organisation_id);

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  update public.membership_invites i
  set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
      expires_at = now() + interval '7 days',
      sent_at = now(),
      -- An owner invite keeps the owner who asked for it as its inviter.
      created_by = case when inv.role = 'owner' then inv.created_by else uid end
  where i.id = inv.id
  returning i.expires_at into v_expires_at;

  return query select v_token, inv.email, inv.role, v_expires_at;
end;
$$;

-- As in 1.12, and owner invites too (owners only).
create or replace function private.revoke_membership_invite_impl(p_organisation_id uuid, p_invite_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inv public.membership_invites%rowtype;
begin
  perform private.assert_team_manager(p_organisation_id, false);

  select *
  into inv
  from public.membership_invites i
  where i.id = p_invite_id
    and i.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if inv.accepted_at is not null then
    raise exception 'this invite has already been used' using errcode = 'MLTM3';
  end if;
  if inv.revoked_at is not null then
    raise exception 'this invite was cancelled' using errcode = 'MLTM5';
  end if;
  if not (inv.role = any (private.team_roles()) or inv.role = 'owner') then
    raise exception 'this invite is from before team invites' using errcode = '22023';
  end if;
  if inv.role in ('admin', 'owner') then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;

  update public.membership_invites i
  set revoked_at = now(),
      revoked_by = auth.uid()
  where i.id = inv.id;
end;
$$;

-- As in 1.12, and owner invites: the request behind it is approved, the inviter is still an
-- owner, and an invite one owner sent alone is refused once the company has two or more owners.
create or replace function private.accept_membership_invite_impl(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  inv public.membership_invites%rowtype;
  v_email text;
  v_confirmed_at timestamptz;
  v_login text;
  v_existing public.membership_role;
  v_inviter_role public.membership_role;
  v_usable text;
  v_org uuid;
  v_password_set_at text;
begin
  if uid is null then
    raise exception 'sign in to accept the invite' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'this invite link is not valid' using errcode = '22023';
  end if;

  -- Owner invites: the organisation lock first, then the invite row (the order every owner
  -- change takes).
  select i.organisation_id into v_org
  from public.membership_invites i
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and i.role = 'owner';
  if v_org is not null then
    perform private.lock_owners(v_org);
  end if;

  select *
  into inv
  from public.membership_invites i
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;

  if not found then
    raise exception 'this invite link is not valid' using errcode = '22023';
  end if;
  if inv.accepted_at is not null then
    raise exception 'this invite has already been used' using errcode = 'MLTM3';
  end if;
  if inv.revoked_at is not null then
    raise exception 'this invite was cancelled' using errcode = 'MLTM5';
  end if;
  if inv.expires_at <= now() then
    raise exception 'this invite has expired' using errcode = 'MLTM4';
  end if;
  if not (inv.role = any (private.team_roles()) or inv.role = 'owner') then
    raise exception 'this invite is no longer valid' using errcode = '42501';
  end if;

  select lower(u.email), u.email_confirmed_at, u.raw_app_meta_data ->> 'login',
    u.raw_app_meta_data ->> 'password_set_at'
  into v_email, v_confirmed_at, v_login, v_password_set_at
  from auth.users u
  where u.id = uid;

  if v_login = 'worker' then
    raise exception 'a worker''s sign-in can''t join as a manager' using errcode = 'MLTM2';
  end if;

  if v_email is distinct from inv.email or v_confirmed_at is null then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;

  -- Slice 1.13: an account's password is trusted only once it was chosen after the address was
  -- confirmed, from an email-link session (app_metadata.password_set_at, written by the server
  -- with the secret key; backfilled for accounts confirmed before this migration). Otherwise
  -- it may be a password someone else chose by signing the address up first.
  if not private.password_trusted(v_password_set_at, v_confirmed_at) then
    raise exception 'choose your password from the link we emailed you, then accept'
      using errcode = 'MLPW1';
  end if;

  select m.role
  into v_inviter_role
  from public.memberships m
  where m.organisation_id = inv.organisation_id
    and m.user_id = inv.created_by
  for share;
  if inv.created_by is null
    or v_inviter_role is null
    or not (
      v_inviter_role = 'owner'
      or (v_inviter_role = 'admin' and inv.role not in ('admin', 'owner'))
    ) then
    raise exception 'this invite is no longer valid' using errcode = '42501';
  end if;

  if inv.role = 'owner' then
    v_usable := private.owner_invite_usable(inv);
    if v_usable = 'needs_approval' then
      raise exception 'this owner invite now needs a second owner''s approval' using errcode = 'MLOW6';
    elsif v_usable <> 'ok' then
      raise exception 'this invite is no longer valid' using errcode = '42501';
    end if;
  end if;

  select m.role
  into v_existing
  from public.memberships m
  where m.organisation_id = inv.organisation_id
    and m.user_id = uid;
  if v_existing = 'worker' then
    raise exception 'your sign-in is a worker''s at this company' using errcode = 'MLTM2';
  elsif v_existing is not null then
    raise exception 'you are already a member of this organisation' using errcode = 'MLTM1';
  end if;

  insert into public.memberships (organisation_id, user_id, role, created_by)
  values (inv.organisation_id, uid, inv.role, inv.created_by);

  update public.membership_invites i
  set accepted_at = now(),
      accepted_by = uid
  where i.id = inv.id;

  return inv.organisation_id;
end;
$$;

-- As in 1.12; owners are changed through owner requests, never here.
create or replace function private.team_target(p_organisation_id uuid, p_membership_id uuid)
returns public.memberships
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target public.memberships%rowtype;
begin
  perform private.assert_team_manager(p_organisation_id, false);

  select *
  into target
  from public.memberships m
  where m.id = p_membership_id
    and m.organisation_id = p_organisation_id
  for update;
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if target.user_id = auth.uid() then
    raise exception 'you can''t change your own role or remove yourself' using errcode = 'MLTM6';
  end if;
  if target.role = 'owner' then
    raise exception 'owners are changed with an owner request, which another owner approves'
      using errcode = 'MLTM7';
  end if;
  if not (target.role = any (private.team_roles())) then
    raise exception 'workers and client approvers are managed from People' using errcode = 'MLTM8';
  end if;
  if target.role = 'admin' then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;
  return target;
end;
$$;

-- Decision 20, now "an owner's first import": the message names any owner.
create or replace function private.import_bank_details_single_approver(
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
as $fn$
begin
  if not private.import_single_approver(p_organisation_id, p_batch_id) then
    raise exception 'Only an owner''s first import, before setup is finished, can skip the bank-detail approval.'
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
    'First import by an owner before company setup was finished (owner decision 20): bank details saved without a second approver.'
  );
end;
$fn$;

drop function public.membership_invite_lookup(text);
drop function private.membership_invite_lookup_impl(text);

-- As in 1.12, plus invited_at (the invite's created_at): the join page asks for a password from
-- an email link when the address was confirmed after it.
create function private.membership_invite_lookup_impl(p_token text)
returns table (
  invite_id uuid,
  organisation_id uuid,
  organisation_name text,
  email text,
  role public.membership_role,
  inviter_name text,
  expires_at timestamptz,
  state text,
  invited_at timestamptz
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
    i.email,
    i.role,
    p.full_name,
    i.expires_at,
    case
      when i.accepted_at is not null then 'accepted'
      when i.revoked_at is not null then 'revoked'
      when i.expires_at <= now() then 'expired'
      else 'pending'
    end,
    i.created_at
  from public.membership_invites i
  join public.organisations o on o.id = i.organisation_id
  left join public.profiles p on p.user_id = i.created_by
  where p_token ~ '^[0-9a-f]{64}$'
    and i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

create function public.membership_invite_lookup(p_token text)
returns table (
  invite_id uuid,
  organisation_id uuid,
  organisation_name text,
  email text,
  role public.membership_role,
  inviter_name text,
  expires_at timestamptz,
  state text,
  invited_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.membership_invite_lookup_impl(p_token)
$$;

revoke all on function private.membership_invite_lookup_impl(text) from public, anon, authenticated;
revoke all on function public.membership_invite_lookup(text) from public, anon, authenticated;
grant execute on function private.membership_invite_lookup_impl(text) to service_role;
grant execute on function public.membership_invite_lookup(text) to service_role;

comment on table public.memberships is
  'User x organisation x role. One role per user per organisation. Every organisation keeps at least one owner and may have several (slice 1.13). Rows are added only by create_organisation, accept_membership_invite, accept_worker_invite or server code with the secret key; manager roles change and managers leave only through change_member_role and remove_member, owners only through request_owner_change and decide_owner_change. Workers are never owners. Signed-in users cannot insert, update or delete directly.';

-- ---------------------------------------------------------------------------
-- 6. RLS and grants
-- ---------------------------------------------------------------------------

-- Owners and admins read (the Team page). No insert, update or delete for signed-in users:
-- request_owner_change and decide_owner_change only.
alter table public.owner_changes enable row level security;

create policy owner_changes_select on public.owner_changes for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin']));

revoke all on table public.owner_changes from anon, authenticated, service_role;
grant select on table public.owner_changes to authenticated, service_role;

create function public.request_owner_change(
  p_organisation_id uuid,
  p_kind public.owner_change_kind,
  p_membership_id uuid default null,
  p_email text default null,
  p_new_role public.membership_role default null,
  p_reason text default null
)
returns table (
  change_id uuid,
  change_status public.owner_change_status,
  invite_token text
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.request_owner_change_impl(
    p_organisation_id, p_kind, p_membership_id, p_email, p_new_role, p_reason
  )
$$;

create function public.decide_owner_change(
  p_organisation_id uuid,
  p_change_id uuid,
  p_decision text
)
returns table (
  change_id uuid,
  change_status public.owner_change_status,
  invite_token text
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.decide_owner_change_impl(p_organisation_id, p_change_id, p_decision)
$$;

revoke all on function private.owner_count(uuid) from public, anon, authenticated;
revoke all on function private.lock_owners(uuid) from public, anon, authenticated;
revoke all on function private.assert_owner(uuid) from public, anon, authenticated;
revoke all on function private.is_worker_login(uuid) from public, anon, authenticated;
revoke all on function private.owner_change_check(uuid, public.owner_change_kind, uuid, uuid, text, public.membership_role) from public, anon, authenticated;
revoke all on function private.owner_change_apply(public.owner_changes) from public, anon, authenticated;
revoke all on function private.owner_invite_usable(public.membership_invites) from public, anon, authenticated;
revoke all on function private.owner_changes_before_insert() from public, anon, authenticated;
revoke all on function private.owner_changes_before_update() from public, anon, authenticated;
revoke all on function private.owner_changes_no_delete() from public, anon, authenticated;
revoke all on function private.memberships_owner_not_worker() from public, anon, authenticated;
revoke all on function private.password_trusted(text, timestamptz) from public, anon, authenticated;
revoke all on function private.memberships_owner_not_service_role() from public, anon, authenticated;
revoke all on function private.end_other_sessions_impl() from public, anon;
grant execute on function private.end_other_sessions_impl() to authenticated;
revoke all on function public.end_other_sessions() from public, anon;
grant execute on function public.end_other_sessions() to authenticated;
revoke all on function private.email_link_allowed_impl(text[]) from public, anon, authenticated;
grant execute on function private.email_link_allowed_impl(text[]) to service_role;
revoke all on function public.email_link_allowed(text[]) from public, anon, authenticated;
grant execute on function public.email_link_allowed(text[]) to service_role;
revoke all on function private.request_owner_change_impl(uuid, public.owner_change_kind, uuid, text, public.membership_role, text) from public, anon;
revoke all on function private.decide_owner_change_impl(uuid, uuid, text) from public, anon;
grant execute on function private.request_owner_change_impl(uuid, public.owner_change_kind, uuid, text, public.membership_role, text) to authenticated;
grant execute on function private.decide_owner_change_impl(uuid, uuid, text) to authenticated;

revoke all on function public.request_owner_change(uuid, public.owner_change_kind, uuid, text, public.membership_role, text) from public, anon;
revoke all on function public.decide_owner_change(uuid, uuid, text) from public, anon;
grant execute on function public.request_owner_change(uuid, public.owner_change_kind, uuid, text, public.membership_role, text) to authenticated;
grant execute on function public.decide_owner_change(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Untrusted password sessions see nothing
-- ---------------------------------------------------------------------------
-- A password session is trusted only once the account chose its password after confirming its
-- address (app_metadata.password_set_at, written by the server; backfilled above for accounts
-- already confirmed). Otherwise the password may be one somebody else chose by signing the
-- address up first, and their token, used straight against the Data API, must read nothing.
-- Email-link sessions (every amr method one of otp, magiclink, recovery, email/signup, invite),
-- worker logins (app_metadata.login = 'worker'; they sign in through an OTP minted by the
-- server) and calls with no token (the secret key) are trusted. Any other session, a password
-- one included, is trusted only when private.password_trusted holds for the account
-- (password_set_at at or after email_confirmed_at, read from auth.users by primary key). The
-- token is read once.
create function private.session_trusted()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with t as (select auth.jwt() as jwt, auth.uid() as uid)
  select case
    when t.uid is null then true
    when (t.jwt -> 'app_metadata' ->> 'login') = 'worker' then true
    -- An email-link session: every amr method is one of these (the same list as
    -- EMAIL_LINK_METHODS in src/lib/auth/amr.ts). Anything else, unknown methods included,
    -- needs a trusted password.
    when jsonb_typeof(t.jwt -> 'amr') = 'array'
      and jsonb_array_length(t.jwt -> 'amr') > 0
      and not exists (
        select 1
        from jsonb_array_elements(t.jwt -> 'amr') e
        where coalesce(e ->> 'method', '') not in ('otp', 'magiclink', 'recovery', 'email/signup', 'invite')
      ) then true
    else coalesce((
      select private.password_trusted(u.raw_app_meta_data ->> 'password_set_at', u.email_confirmed_at)
      from auth.users u
      where u.id = t.uid
    ), false)
  end
  from t
$$;

-- The caller's id when their session is trusted, else null. Every tenancy helper and the
-- policies that compare a row with the caller use it, so an untrusted session has no
-- organisations, no roles, no worker record and no own rows.
create function private.session_uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case when private.session_trusted() then auth.uid() end
$$;

revoke all on function private.session_trusted() from public, anon;
revoke all on function private.session_uid() from public, anon;
grant execute on function private.session_trusted() to authenticated, service_role;
grant execute on function private.session_uid() to authenticated, service_role;

create or replace function private.user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.memberships m
  where m.user_id = (select private.session_uid())
$$;

create or replace function private.has_role(org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organisation_id = org
      and m.user_id = (select private.session_uid())
      and m.role::text = any (roles)
  )
$$;

create or replace function private.manages_member(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships target
    join public.memberships me on me.organisation_id = target.organisation_id
    where target.user_id = uid
      and me.user_id = (select private.session_uid())
      and me.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
  )
$$;

create or replace function private.my_worker_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.worker_id
  from public.memberships m
  where m.user_id = (select private.session_uid())
    and m.worker_id is not null
$$;

create or replace function private.is_line_manager_for(org uuid, lm_worker uuid, lm_membership uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (lm_worker is not null or lm_membership is not null) and exists (
    select 1
    from public.memberships m
    where m.organisation_id = org
      and m.user_id = (select private.session_uid())
      and m.role = 'line_manager'
      and (m.id = lm_membership or (m.worker_id is not null and m.worker_id = lm_worker))
  )
$$;

-- The policies that compare a row with the caller directly.
drop policy memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select to authenticated
  using (
    user_id = (select private.session_uid())
    or private.has_role(
      organisation_id,
      array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
    )
  );

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (user_id = (select private.session_uid()) or private.manages_member(user_id));

drop policy profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = (select private.session_uid()))
  with check (user_id = (select private.session_uid()));

drop policy bank_detail_changes_update on public.bank_detail_changes;
create policy bank_detail_changes_update on public.bank_detail_changes for update to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'hr', 'finance'])
    or requested_by = (select private.session_uid())
  )
  with check (
    private.has_role(organisation_id, array['owner', 'hr', 'finance'])
    or requested_by = (select private.session_uid())
  );

-- Creating a company trusts the caller's session too: an untrusted password session can't
-- create one (for instance the victim's, before they reach /set-password).
create or replace function private.create_organisation_impl(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_name text := btrim(p_name);
  org_id uuid;
begin
  if uid is null or not private.session_trusted() then
    raise exception 'sign in to create an organisation' using errcode = '42501';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 200 then
    raise exception 'organisation name must be 1 to 200 characters' using errcode = '22023';
  end if;
  if v_name ~ '[\x01-\x1f\x7f-\x9f<>]' or v_name ~* '(://|www\.)' then
    raise exception 'organisation name must be plain text, without < or > or a web address'
      using errcode = '22023';
  end if;

  insert into public.organisations (name, created_by)
  values (v_name, uid)
  returning id into org_id;

  insert into public.memberships (organisation_id, user_id, role, created_by)
  values (org_id, uid, 'owner', uid);

  return org_id;
end;
$$;

create or replace function private.create_first_organisation_impl(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or not private.session_trusted() then
    raise exception 'sign in to create an organisation' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_first_organisation:' || uid::text, 0));

  if exists (select 1 from public.memberships m where m.user_id = uid) then
    return null;
  end if;

  return private.create_organisation_impl(p_name);
end;
$$;
