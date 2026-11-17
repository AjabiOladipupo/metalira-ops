-- Slice 1.12: team invites for managers (added on owner request, 17 Nov 2026).
--
-- The two-person rule (bank-detail changes now, payroll release later) needs a second manager,
-- so owners and admins can now invite managers by email, change their role and remove them.
-- This builds on public.membership_invites from slice 0.3 rather than adding a second invite
-- table: same hashed single-use token, same 7-day expiry, same "accepted only by the invited,
-- confirmed email" rule.
--
-- Rules (enforced here, for every client, not only in the app):
-- * Owners and admins invite, with one manager role: admin, hr, finance, ops_manager or
--   line_manager. Only the owner can grant admin (invite, resend or change to/from admin).
-- * Nobody changes their own role or removes themselves. The owner can't be removed or
--   demoted. Workers and client approvers are managed elsewhere (People), never here.
-- * A worker's login (app_metadata.login = 'worker') can't be invited or accept, in any company,
--   and a login that is a worker in the company can't also be a manager there.
-- * Invites are never deleted: cancelling sets revoked_at, accepting sets accepted_at, and a
--   resend issues a new token on the same row (the old link stops working).
-- * Role changes and removals go only through the functions below: signed-in users lose their
--   direct update and delete grants on memberships, so the checks can't be bypassed. The audit
--   triggers from 0.3 log every row change with the caller as actor (who, what, before, after).
--
-- Refusals carry SQLSTATEs the app maps to plain English:
--   MLTM1 already a member          MLTM2 a worker's login in this company
--   MLTM3 invite already used       MLTM4 invite expired
--   MLTM5 invite cancelled          MLTM6 own role or own membership
--   MLTM7 the owner can't be changed or removed
--   MLTM8 not a manager membership (workers and client approvers)
--   42501 role not allowed, wrong account, inviter no longer allowed
--   22023 bad input or token        P0002 not found in this organisation

-- ---------------------------------------------------------------------------
-- 1. membership_invites: cancelled state, last send, manager roles only
-- ---------------------------------------------------------------------------

alter table public.membership_invites
  add column revoked_at timestamptz,
  add column revoked_by uuid references auth.users (id) on delete set null,
  add column sent_at timestamptz not null default now(),
  add constraint membership_invites_accepted_or_revoked
    check (num_nonnulls(accepted_at, revoked_at) <= 1);

-- New invites carry one manager role. NOT VALID: rows from before this slice are left alone,
-- and acceptance refuses any that is not a manager role.
alter table public.membership_invites
  add constraint membership_invites_manager_role
    check (role in ('admin', 'hr', 'finance', 'ops_manager', 'line_manager')) not valid;

drop index public.membership_invites_one_pending_idx;
create unique index membership_invites_one_pending_idx
  on public.membership_invites (organisation_id, email)
  where accepted_at is null and revoked_at is null;

comment on table public.membership_invites is
  'Email invites for managers to join an organisation (slices 0.3, 1.12). Created and resent by public.create_membership_invite / resend_membership_invite, cancelled by revoke_membership_invite, accepted by accept_membership_invite. Never deleted. token_hash is SHA-256 (hex) of the token; the token itself is never stored.';

-- Invites are cancelled, never deleted.
drop policy membership_invites_delete on public.membership_invites;
revoke delete on table public.membership_invites from authenticated;

-- ---------------------------------------------------------------------------
-- 2. memberships: role changes and removals only through the functions below
-- ---------------------------------------------------------------------------

drop policy memberships_update on public.memberships;
drop policy memberships_delete on public.memberships;
revoke update, delete on table public.memberships from authenticated;

comment on table public.memberships is
  'User x organisation x role. One role per user per organisation. Every organisation keeps at least one owner. Rows are added only by create_organisation, accept_membership_invite, accept_worker_invite or server code with the secret key; roles change and members leave only through change_member_role and remove_member. Signed-in users cannot insert, update or delete directly.';

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- The roles a team invite or a role change may grant.
create function private.team_roles()
returns public.membership_role[]
language sql
immutable
set search_path = ''
as $$
  select array['admin', 'hr', 'finance', 'ops_manager', 'line_manager']::public.membership_role[]
$$;

-- Raises unless the caller is an owner or admin of `org`, and an owner when `needs_owner`.
create function private.assert_team_manager(org uuid, needs_owner boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to manage your team' using errcode = '42501';
  end if;
  if org is null or not private.has_role(org, array['owner', 'admin']) then
    raise exception 'only the owner or an admin can manage the team' using errcode = '42501';
  end if;
  if needs_owner and not private.has_role(org, array['owner']) then
    raise exception 'only the owner can make someone an admin or change an admin'
      using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Invites: create, resend, cancel, look up, accept
-- ---------------------------------------------------------------------------

-- Creates the pending invite for `p_email` (cancelling any earlier pending one) and returns the
-- raw token, which exists nowhere else: the caller's server code emails the link.
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

  -- A worker's login (synthetic, PIN-protected; app_metadata.login = 'worker', set only with
  -- the secret key) never becomes a manager, in this company or any other.
  if v_email like '%.invalid' or exists (
    select 1
    from auth.users u
    where lower(u.email) = v_email
      and u.raw_app_meta_data ->> 'login' = 'worker'
  ) then
    raise exception 'this email is a worker''s sign-in' using errcode = 'MLTM2';
  end if;

  select m.role
  into v_existing
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.organisation_id = p_organisation_id
    and lower(u.email) = v_email
  limit 1;
  if v_existing = 'worker' then
    raise exception 'this email is a worker''s sign-in at this company' using errcode = 'MLTM2';
  elsif v_existing is not null then
    raise exception 'this person is already a member' using errcode = 'MLTM1';
  end if;

  update public.membership_invites i
  set revoked_at = now(),
      revoked_by = uid
  where i.organisation_id = p_organisation_id
    and i.email = v_email
    and i.accepted_at is null
    and i.revoked_at is null;

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

-- Issues a new link for a pending (or expired) invite: new token, 7 more days. The old link
-- stops working. The resender becomes the inviter, so acceptance checks their role.
create function private.resend_membership_invite_impl(p_organisation_id uuid, p_invite_id uuid)
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
  if inv.role = 'admin' then
    perform private.assert_team_manager(p_organisation_id, true);
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

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  update public.membership_invites i
  set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
      expires_at = now() + interval '7 days',
      sent_at = now(),
      created_by = uid
  where i.id = inv.id
  returning i.expires_at into v_expires_at;

  return query select v_token, inv.email, inv.role, v_expires_at;
end;
$$;

-- Cancels a pending invite. Its link stops working; the row stays for the record.
create function private.revoke_membership_invite_impl(p_organisation_id uuid, p_invite_id uuid)
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
  if inv.role = 'admin' then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;

  update public.membership_invites i
  set revoked_at = now(),
      revoked_by = auth.uid()
  where i.id = inv.id;
end;
$$;

-- What the invite page (/join/[token]) shows. Server secret key only: the visitor may be
-- signed out, and holding the token (256 random bits) is what entitles them to see it.
-- state: pending, accepted, revoked or expired. No row for an unknown token.
create function private.membership_invite_lookup_impl(p_token text)
returns table (
  invite_id uuid,
  organisation_id uuid,
  organisation_name text,
  email text,
  role public.membership_role,
  inviter_name text,
  expires_at timestamptz,
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
    i.email,
    i.role,
    p.full_name,
    i.expires_at,
    case
      when i.accepted_at is not null then 'accepted'
      when i.revoked_at is not null then 'revoked'
      when i.expires_at <= now() then 'expired'
      else 'pending'
    end
  from public.membership_invites i
  join public.organisations o on o.id = i.organisation_id
  left join public.profiles p on p.user_id = i.created_by
  where p_token ~ '^[0-9a-f]{64}$'
    and i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

-- Joins the caller to the invite's organisation with the invite's role. The invite must be
-- pending and unexpired, addressed to the caller's confirmed email, and its inviter must still
-- be allowed to grant that role. Single use.
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
begin
  if uid is null then
    raise exception 'sign in to accept the invite' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'this invite link is not valid' using errcode = '22023';
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
  if not (inv.role = any (private.team_roles())) then
    raise exception 'this invite is no longer valid' using errcode = '42501';
  end if;

  select lower(u.email), u.email_confirmed_at, u.raw_app_meta_data ->> 'login'
  into v_email, v_confirmed_at, v_login
  from auth.users u
  where u.id = uid;

  if v_login = 'worker' then
    raise exception 'a worker''s sign-in can''t join as a manager' using errcode = 'MLTM2';
  end if;

  if v_email is distinct from inv.email or v_confirmed_at is null then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;

  if inv.created_by is null or not exists (
    select 1
    from public.memberships m
    where m.organisation_id = inv.organisation_id
      and m.user_id = inv.created_by
      and (m.role = 'owner' or (m.role = 'admin' and inv.role <> 'admin'))
  ) then
    raise exception 'this invite is no longer valid' using errcode = '42501';
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

-- ---------------------------------------------------------------------------
-- 5. Members: list, change role, remove
-- ---------------------------------------------------------------------------

-- The company's managers with their sign-in email (which lives in auth.users), for the Team
-- page. Owners and admins only. Workers and client approvers are not listed.
create function private.team_members_impl(p_organisation_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  role public.membership_role,
  full_name text,
  email text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_team_manager(p_organisation_id, false);
  return query
    select m.id, m.user_id, m.role, p.full_name, lower(u.email)::text, m.created_at
    from public.memberships m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.user_id = m.user_id
    where m.organisation_id = p_organisation_id
      and m.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
    order by m.created_at, m.id;
end;
$$;

-- Loads and locks the membership a role change or removal acts on, after the shared checks.
create function private.team_target(p_organisation_id uuid, p_membership_id uuid)
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
    raise exception 'the owner can''t be removed or have their role changed' using errcode = 'MLTM7';
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

-- Gives a manager another manager role. Returns who they are and both roles, for the notice.
create function private.change_member_role_impl(
  p_organisation_id uuid,
  p_membership_id uuid,
  p_role public.membership_role
)
returns table (
  member_user_id uuid,
  member_email text,
  member_name text,
  old_role public.membership_role,
  new_role public.membership_role
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target public.memberships%rowtype;
begin
  if p_role is null or not (p_role = any (private.team_roles())) then
    raise exception 'choose admin, HR, finance, operations manager or line manager'
      using errcode = '22023';
  end if;
  target := private.team_target(p_organisation_id, p_membership_id);
  if p_role = 'admin' then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;
  if p_role = target.role then
    raise exception 'they already have that role' using errcode = '22023';
  end if;

  update public.memberships m
  set role = p_role
  where m.id = target.id;

  return query
    select target.user_id, lower(u.email)::text, p.full_name, target.role, p_role
    from auth.users u
    left join public.profiles p on p.user_id = u.id
    where u.id = target.user_id;
end;
$$;

-- Removes a manager from the company. Their reportees lose them as line manager (foreign key
-- on delete set null). Returns who they were, for the notice.
create function private.remove_member_impl(p_organisation_id uuid, p_membership_id uuid)
returns table (
  member_user_id uuid,
  member_email text,
  member_name text,
  old_role public.membership_role
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target public.memberships%rowtype;
  v_email text;
  v_name text;
begin
  target := private.team_target(p_organisation_id, p_membership_id);

  select lower(u.email)::text, p.full_name
  into v_email, v_name
  from auth.users u
  left join public.profiles p on p.user_id = u.id
  where u.id = target.user_id;

  delete from public.memberships m
  where m.id = target.id;

  return query select target.user_id, v_email, v_name, target.role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Public invoker wrappers
-- ---------------------------------------------------------------------------

create function public.resend_membership_invite(p_organisation_id uuid, p_invite_id uuid)
returns table (token text, invite_email text, invite_role public.membership_role, invite_expires_at timestamptz)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.resend_membership_invite_impl(p_organisation_id, p_invite_id)
$$;

create function public.revoke_membership_invite(p_organisation_id uuid, p_invite_id uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.revoke_membership_invite_impl(p_organisation_id, p_invite_id)
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
  state text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.membership_invite_lookup_impl(p_token)
$$;

create function public.team_members(p_organisation_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  role public.membership_role,
  full_name text,
  email text,
  joined_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.team_members_impl(p_organisation_id)
$$;

create function public.change_member_role(
  p_organisation_id uuid,
  p_membership_id uuid,
  p_role public.membership_role
)
returns table (
  member_user_id uuid,
  member_email text,
  member_name text,
  old_role public.membership_role,
  new_role public.membership_role
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.change_member_role_impl(p_organisation_id, p_membership_id, p_role)
$$;

create function public.remove_member(p_organisation_id uuid, p_membership_id uuid)
returns table (
  member_user_id uuid,
  member_email text,
  member_name text,
  old_role public.membership_role
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.remove_member_impl(p_organisation_id, p_membership_id)
$$;

-- ---------------------------------------------------------------------------
-- 7. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.team_roles() from public, anon;
revoke all on function private.assert_team_manager(uuid, boolean) from public, anon;
revoke all on function private.resend_membership_invite_impl(uuid, uuid) from public, anon;
revoke all on function private.revoke_membership_invite_impl(uuid, uuid) from public, anon;
revoke all on function private.membership_invite_lookup_impl(text) from public, anon, authenticated;
revoke all on function private.team_members_impl(uuid) from public, anon;
revoke all on function private.team_target(uuid, uuid) from public, anon;
revoke all on function private.change_member_role_impl(uuid, uuid, public.membership_role) from public, anon;
revoke all on function private.remove_member_impl(uuid, uuid) from public, anon;

grant execute on function private.team_roles() to authenticated, service_role;
grant execute on function private.assert_team_manager(uuid, boolean) to authenticated;
grant execute on function private.resend_membership_invite_impl(uuid, uuid) to authenticated;
grant execute on function private.revoke_membership_invite_impl(uuid, uuid) to authenticated;
grant execute on function private.membership_invite_lookup_impl(text) to service_role;
grant execute on function private.team_members_impl(uuid) to authenticated;
grant execute on function private.team_target(uuid, uuid) to authenticated;
grant execute on function private.change_member_role_impl(uuid, uuid, public.membership_role) to authenticated;
grant execute on function private.remove_member_impl(uuid, uuid) to authenticated;

revoke all on function public.resend_membership_invite(uuid, uuid) from public, anon;
revoke all on function public.revoke_membership_invite(uuid, uuid) from public, anon;
revoke all on function public.membership_invite_lookup(text) from public, anon, authenticated;
revoke all on function public.team_members(uuid) from public, anon;
revoke all on function public.change_member_role(uuid, uuid, public.membership_role) from public, anon;
revoke all on function public.remove_member(uuid, uuid) from public, anon;

grant execute on function public.resend_membership_invite(uuid, uuid) to authenticated;
grant execute on function public.revoke_membership_invite(uuid, uuid) to authenticated;
grant execute on function public.membership_invite_lookup(text) to service_role;
grant execute on function public.team_members(uuid) to authenticated;
grant execute on function public.change_member_role(uuid, uuid, public.membership_role) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
