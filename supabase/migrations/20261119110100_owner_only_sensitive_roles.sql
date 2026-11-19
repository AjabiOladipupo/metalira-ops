-- Owner decision, 19 Nov 2026: only owners give, change or take away the admin, finance and HR
-- roles. Finance approves the company bank account (slice 2.3) and finance and HR approve worker
-- bank-detail changes (slice 1.7), so an admin who could make a second account of their own
-- finance could approve their own change. Admins still invite and change operations managers and
-- line managers.
--
-- The functions below are the latest definitions (20261118120000_owners.sql, and
-- change_member_role_impl from 20261117120000_team_invites.sql) with "admin" widened to
-- private.owner_only_role(): creating, resending, accepting, changing to or from, and removing.
-- Accepting re-checks the inviter: an invite an admin created for admin, finance or HR before
-- this migration can't be accepted afterwards. Every owner is emailed when someone is given one
-- of these roles (src/server/identity/owner-notices.ts, notifyOwnerGrantedRole).

create function private.owner_only_role(r public.membership_role)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select r in ('admin', 'finance', 'hr')
$$;

revoke all on function private.owner_only_role(public.membership_role) from public, anon;
grant execute on function private.owner_only_role(public.membership_role) to authenticated, service_role;

-- Same checks; the owner-only message names the three roles.
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
    raise exception 'only an owner can give, change or remove the admin, finance or HR role, or change an owner'
      using errcode = '42501';
  end if;
end;
$$;

-- Owner-only roles: creating the invite, and replacing a pending one.
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
  if private.owner_only_role(p_role) then
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
  if v_pending_role = 'owner' or private.owner_only_role(v_pending_role) then
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

-- Owner-only roles: resending.
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
  if inv.role = 'owner' or private.owner_only_role(inv.role) then
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

-- Accepting: an admin's invite is good only for operations manager or line manager.
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
      or (v_inviter_role = 'admin' and inv.role in ('ops_manager', 'line_manager'))
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

-- Changing or removing someone who has an owner-only role.
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
  if private.owner_only_role(target.role) then
    perform private.assert_team_manager(p_organisation_id, true);
  end if;
  return target;
end;
$$;

-- Giving an owner-only role.
create or replace function private.change_member_role_impl(
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
  if private.owner_only_role(p_role) then
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
