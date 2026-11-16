-- Slice 0.3: tenancy core.
--
-- PostGIS, a locked-down `private` schema, the identity tables (organisations,
-- profiles, memberships, membership_invites, audit_log), the RLS helpers, the
-- audit write path, the organisation-creation RPC and the invite RPCs.
--
-- Ground rules applied here (CLAUDE.md and docs/PHASE_0.md "Decisions"):
-- * Security-definer functions live only in schema `private` and pin
--   `search_path = ''`, so every name below is schema-qualified.
-- * Column grants: the table-level privilege is revoked first, then specific
--   columns are granted. A column-level revoke alone does nothing.
-- * audit_log is append-only for every role. Row changes are logged by AFTER
--   triggers in the same transaction; app events go through public.log_audit.
--   `authenticated` has no INSERT grant on audit_log.

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------

create extension if not exists postgis with schema extensions;
-- digest() and gen_random_bytes() for invite tokens.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. Default privileges
-- ---------------------------------------------------------------------------
-- Supabase grants everything on new public objects to anon, authenticated and
-- service_role. anon never needs table, sequence or function access in this
-- app, and functions should not be executable by PUBLIC unless granted.

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 3. Private schema (never exposed through the Data API)
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;
alter default privileges in schema private revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 4. Types and tables
-- ---------------------------------------------------------------------------

create type public.membership_role as enum (
  'owner',
  'admin',
  'hr',
  'finance',
  'ops_manager',
  'line_manager',
  'worker',
  'client_approver'
);

-- Tenant root: no organisation_id column (DATA_MODEL exception).
create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint organisations_name_length check (char_length(btrim(name)) between 1 and 200),
  legal_name text constraint organisations_legal_name_length check (char_length(legal_name) <= 200),
  rc_number text constraint organisations_rc_number_length check (char_length(rc_number) <= 50),
  logo_path text constraint organisations_logo_path_length check (char_length(logo_path) <= 500),
  invoice_email text constraint organisations_invoice_email_length check (char_length(invoice_email) <= 320),
  plan text not null default 'trial',
  timezone text not null default 'Africa/Lagos'
    constraint organisations_timezone_length check (char_length(timezone) between 1 and 64),
  pay_cycle_start_day smallint not null default 20
    constraint organisations_pay_cycle_start_day_range check (pay_cycle_start_day between 1 and 28),
  pay_day smallint not null default 25
    constraint organisations_pay_day_range check (pay_day between 1 and 31),
  work_days_per_week smallint not null default 5
    constraint organisations_work_days_per_week_range check (work_days_per_week between 1 and 7),
  standard_shift_minutes integer not null default 480
    constraint organisations_standard_shift_minutes_range check (standard_shift_minutes between 1 and 1440),
  hourly_rate_divisor_days smallint not null default 20
    constraint organisations_hourly_rate_divisor_days_range check (hourly_rate_divisor_days between 1 and 31),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.organisations is
  'Tenant root. Created only through public.create_organisation. Pay settings default per docs/RULES_NIGERIA.md "Pay policy".';

-- One row per login (DATA_MODEL exception: no organisation_id).
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text constraint profiles_full_name_length check (char_length(full_name) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One per auth user. Created by the private.handle_new_user trigger on auth.users.';

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null,
  -- No FK until the Phase 1 workers table exists.
  worker_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint memberships_one_role_per_org unique (organisation_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);

comment on table public.memberships is
  'User x organisation x role. One role per user per organisation. Every organisation keeps at least one owner. Rows are added only by create_organisation, accept_membership_invite or server code with the secret key; signed-in users cannot insert directly.';

-- An owner or admin invites someone by email. The invitee joins by calling
-- public.accept_membership_invite with the token while signed in with that
-- (confirmed) email address. Only the SHA-256 of the token is stored.
create table public.membership_invites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  email text not null
    constraint membership_invites_email_format check (
      char_length(email) between 3 and 320
      and email = lower(btrim(email))
      and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    ),
  role public.membership_role not null,
  token_hash text not null
    constraint membership_invites_token_hash_unique unique,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null
);

-- At most one pending invite per email per organisation.
create unique index membership_invites_one_pending_idx
  on public.membership_invites (organisation_id, email)
  where accepted_at is null;

comment on table public.membership_invites is
  'Email invites to join an organisation. Created by public.create_membership_invite, accepted by public.accept_membership_invite. token_hash is SHA-256 (hex) of the token.';

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  -- Deliberately no FK: deleting a user must never need an UPDATE here.
  actor_id uuid default auth.uid(),
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  at timestamptz not null default now()
);

create index audit_log_organisation_at_idx on public.audit_log (organisation_id, at desc);
create index audit_log_entity_idx on public.audit_log (entity, entity_id);

comment on table public.audit_log is
  'Append-only. Written by private.audit_row_change triggers and public.log_audit. Update, delete and truncate fail for every role.';

-- ---------------------------------------------------------------------------
-- 5. RLS helpers (security definer, private, search_path = '')
-- ---------------------------------------------------------------------------

-- Organisation ids the caller belongs to.
create function private.user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id
  from public.memberships m
  where m.user_id = (select auth.uid())
$$;

-- True when the caller holds one of `roles` in organisation `org`.
create function private.has_role(org uuid, roles text[])
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
      and m.user_id = (select auth.uid())
      and m.role::text = any (roles)
  )
$$;

-- True when user `uid` belongs to an organisation in which the caller holds a
-- manager role (owner, admin, hr, finance, ops_manager, line_manager). Workers
-- and client approvers never see other people. Keeps the profiles policy from
-- recursing through memberships RLS.
create function private.manages_member(uid uuid)
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
      and me.user_id = (select auth.uid())
      and me.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
  )
$$;

-- ---------------------------------------------------------------------------
-- 6. Trigger functions
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Removes secrets from a JSON document before it reaches audit_log: keys ending
-- in `_enc` (column-encrypted personal data), `pin_hash` and `token_hash`, at
-- any depth.
create function private.audit_redact(doc jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  result jsonb;
  k text;
  v jsonb;
begin
  if doc is null then
    return null;
  end if;

  case jsonb_typeof(doc)
    when 'object' then
      result := '{}'::jsonb;
      for k, v in select e.key, e.value from jsonb_each(doc) as e loop
        if k ~* '_enc$' or lower(k) in ('pin_hash', 'token_hash') then
          continue;
        end if;
        result := result || jsonb_build_object(k, private.audit_redact(v));
      end loop;
      return result;
    when 'array' then
      return coalesce(
        (
          select jsonb_agg(private.audit_redact(t.elem) order by t.ord)
          from jsonb_array_elements(doc) with ordinality as t (elem, ord)
        ),
        '[]'::jsonb
      );
    else
      return doc;
  end case;
end;
$$;

-- AFTER INSERT/UPDATE/DELETE row trigger. Writes '<table>.<op>' with redacted
-- before/after documents and the caller as actor, in the same transaction.
-- Optional trigger argument: the column holding the organisation id
-- (default 'organisation_id'; the organisations table passes 'id').
create function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  org_column text := coalesce(tg_argv[0], 'organisation_id');
  old_doc jsonb;
  new_doc jsonb;
  row_doc jsonb;
  row_id text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_doc := private.audit_redact(to_jsonb(old));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_doc := private.audit_redact(to_jsonb(new));
  end if;

  -- Skip updates that change nothing but updated_at.
  if tg_op = 'UPDATE' and (old_doc - 'updated_at') = (new_doc - 'updated_at') then
    return null;
  end if;

  row_doc := coalesce(new_doc, old_doc);
  row_id := row_doc ->> 'id';

  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    (row_doc ->> org_column)::uuid,
    auth.uid(),
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    case
      when row_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then row_id::uuid
    end,
    old_doc,
    new_doc
  );

  return null;
end;
$$;

-- BEFORE UPDATE/DELETE row trigger and BEFORE TRUNCATE statement trigger on
-- audit_log. Stops the table owner too, who is not subject to grants.
create function private.audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'P0001';
end;
$$;

-- AFTER UPDATE/DELETE row trigger on memberships: every organisation keeps at
-- least one owner. Locks the organisation row so two concurrent demotions are
-- serialised and the second one sees the first.
create function private.memberships_keep_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.organisation_id = old.organisation_id then
    return null;
  end if;

  perform 1
  from public.organisations o
  where o.id = old.organisation_id
  for no key update;

  if not exists (
    select 1
    from public.memberships m
    where m.organisation_id = old.organisation_id
      and m.role = 'owner'
  ) then
    raise exception 'an organisation must keep at least one owner' using errcode = 'P0001';
  end if;

  return null;
end;
$$;

-- AFTER INSERT on auth.users: one profile per login, full name from sign-up
-- metadata.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, full_name)
  values (
    new.id,
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 200), '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RPC implementations (definer, private) and public invoker wrappers
-- ---------------------------------------------------------------------------

-- Creates an organisation and the caller's owner membership atomically. The
-- audit triggers log both rows with the caller as actor.
create function private.create_organisation_impl(p_name text)
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
  if uid is null then
    raise exception 'sign in to create an organisation' using errcode = '42501';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 200 then
    raise exception 'organisation name must be 1 to 200 characters' using errcode = '22023';
  end if;

  insert into public.organisations (name, created_by)
  values (v_name, uid)
  returning id into org_id;

  insert into public.memberships (organisation_id, user_id, role, created_by)
  values (org_id, uid, 'owner', uid);

  return org_id;
end;
$$;

-- Writes an app-level audit event (for example 'pii.reveal'). The actor is
-- always the caller and the time is always now(); neither can be supplied.
-- Only manager roles may call it: workers and client approvers cannot plant
-- events in the log owners and admins read. Before and after are capped at
-- 16 KB each.
create function private.log_audit_impl(
  p_organisation_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  new_id uuid;
begin
  if uid is null then
    raise exception 'sign in to write to the audit log' using errcode = '42501';
  end if;
  if p_organisation_id is null or not private.has_role(
    p_organisation_id,
    array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
  ) then
    raise exception 'only managers in this organisation can write to the audit log'
      using errcode = '42501';
  end if;
  if p_action is null
    or char_length(p_action) > 100
    or p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception 'audit action must look like module.event' using errcode = '22023';
  end if;
  if p_action ~ '\.(insert|update|delete)$' then
    raise exception 'row-change actions are written by triggers only' using errcode = '22023';
  end if;
  if p_entity is null or char_length(p_entity) > 100 or p_entity !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'audit entity must be a lower-case name' using errcode = '22023';
  end if;
  if p_reason is not null and char_length(p_reason) > 1000 then
    raise exception 'audit reason must be 1000 characters or fewer' using errcode = '22023';
  end if;
  if octet_length(coalesce(p_before::text, '')) > 16384
    or octet_length(coalesce(p_after::text, '')) > 16384 then
    raise exception 'audit before and after must be 16 KB or smaller each' using errcode = '22023';
  end if;

  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after, reason)
  values (
    p_organisation_id,
    uid,
    p_action,
    p_entity,
    p_entity_id,
    private.audit_redact(p_before),
    private.audit_redact(p_after),
    nullif(btrim(p_reason), '')
  )
  returning id into new_id;

  return new_id;
end;
$$;

-- Creates (or replaces) the pending invite for `p_email` and returns the raw
-- token, which exists nowhere else: the caller's server code emails the link.
-- Owners and admins invite; only owners invite owners.
create function private.create_membership_invite_impl(
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
begin
  if uid is null then
    raise exception 'sign in to invite people' using errcode = '42501';
  end if;
  if p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin']) then
    raise exception 'only owners and admins can invite people' using errcode = '42501';
  end if;
  if p_role is null then
    raise exception 'choose a role for the invite' using errcode = '22023';
  end if;
  if p_role = 'owner' and not private.has_role(p_organisation_id, array['owner']) then
    raise exception 'only owners can invite owners' using errcode = '42501';
  end if;
  if v_email is null
    or char_length(v_email) not between 3 and 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'enter a valid email address' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organisation_id = p_organisation_id
      and lower(u.email) = v_email
  ) then
    raise exception 'this person is already a member' using errcode = '23505';
  end if;

  delete from public.membership_invites i
  where i.organisation_id = p_organisation_id
    and i.email = v_email
    and i.accepted_at is null;

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

-- Joins the caller to the invite's organisation. The invite must be pending,
-- unexpired, addressed to the caller's confirmed email, and its inviter must
-- still be allowed to grant that role. Single use.
create function private.accept_membership_invite_impl(p_token text)
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
    raise exception 'this invite has already been used' using errcode = '22023';
  end if;
  if inv.expires_at <= now() then
    raise exception 'this invite has expired' using errcode = '22023';
  end if;

  select lower(u.email), u.email_confirmed_at
  into v_email, v_confirmed_at
  from auth.users u
  where u.id = uid;

  if v_email is distinct from inv.email or v_confirmed_at is null then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;

  if inv.created_by is null or not exists (
    select 1
    from public.memberships m
    where m.organisation_id = inv.organisation_id
      and m.user_id = inv.created_by
      and (m.role = 'owner' or (m.role = 'admin' and inv.role <> 'owner'))
  ) then
    raise exception 'this invite is no longer valid' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.memberships m
    where m.organisation_id = inv.organisation_id
      and m.user_id = uid
  ) then
    raise exception 'you are already a member of this organisation' using errcode = '23505';
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

create function public.create_membership_invite(
  p_organisation_id uuid,
  p_email text,
  p_role public.membership_role
)
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.create_membership_invite_impl(p_organisation_id, p_email, p_role)
$$;

create function public.accept_membership_invite(p_token text)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.accept_membership_invite_impl(p_token)
$$;

create function public.create_organisation(p_name text)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.create_organisation_impl(p_name)
$$;

create function public.log_audit(
  p_organisation_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.log_audit_impl(p_organisation_id, p_action, p_entity, p_entity_id, p_before, p_after, p_reason)
$$;

-- ---------------------------------------------------------------------------
-- 8. Triggers
-- ---------------------------------------------------------------------------

create trigger organisations_set_updated_at
  before update on public.organisations
  for each row execute function private.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

create trigger organisations_audit
  after insert or update or delete on public.organisations
  for each row execute function private.audit_row_change('id');

create trigger memberships_audit
  after insert or update or delete on public.memberships
  for each row execute function private.audit_row_change();

create trigger membership_invites_audit
  after insert or update or delete on public.membership_invites
  for each row execute function private.audit_row_change();

create trigger memberships_keep_owner
  after update or delete on public.memberships
  for each row execute function private.memberships_keep_owner();

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function private.audit_log_immutable();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.audit_log_immutable();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- 9. Row-level security
-- ---------------------------------------------------------------------------

alter table public.organisations enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_invites enable row level security;
alter table public.audit_log enable row level security;

-- organisations: members read; owner and admin update. No insert policy
-- (create_organisation only) and no delete policy.
create policy organisations_select on public.organisations
  for select to authenticated
  using (id in (select private.user_org_ids()));

create policy organisations_update on public.organisations
  for update to authenticated
  using (private.has_role(id, array['owner', 'admin']))
  with check (private.has_role(id, array['owner', 'admin']));

-- profiles: own row, plus members of organisations where the caller is a
-- manager. Own row only for update. Rows are created by trigger and removed by
-- cascade.
create policy profiles_select on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or private.manages_member(user_id));

create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- memberships: everyone reads their own rows; managers read their
-- organisation's rows. Owner and admin change and remove every role except
-- owner; only owners manage owner rows. No insert policy or grant: rows come
-- from create_organisation and accept_membership_invite (or server code).
create policy memberships_select on public.memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.has_role(
      organisation_id,
      array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
    )
  );

create policy memberships_update on public.memberships
  for update to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin'])
    and (role <> 'owner' or private.has_role(organisation_id, array['owner']))
  )
  with check (
    private.has_role(organisation_id, array['owner', 'admin'])
    and (role <> 'owner' or private.has_role(organisation_id, array['owner']))
  );

create policy memberships_delete on public.memberships
  for delete to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin'])
    and (role <> 'owner' or private.has_role(organisation_id, array['owner']))
  );

-- membership_invites: owner and admin read and revoke (delete) pending
-- invites; only owners revoke owner invites. No insert or update policy:
-- create_membership_invite and accept_membership_invite only.
create policy membership_invites_select on public.membership_invites
  for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin']));

create policy membership_invites_delete on public.membership_invites
  for delete to authenticated
  using (
    accepted_at is null
    and private.has_role(organisation_id, array['owner', 'admin'])
    and (role <> 'owner' or private.has_role(organisation_id, array['owner']))
  );

-- audit_log: owner and admin read. No insert, update or delete policy.
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin']));

-- ---------------------------------------------------------------------------
-- 10. Table grants (revoke the table-level privilege, then grant columns)
-- ---------------------------------------------------------------------------

revoke all on table public.organisations from anon, authenticated;
grant select on table public.organisations to authenticated;
grant update (
  name,
  legal_name,
  rc_number,
  logo_path,
  invoice_email,
  timezone,
  pay_cycle_start_day,
  pay_day,
  work_days_per_week,
  standard_shift_minutes,
  hourly_rate_divisor_days
) on table public.organisations to authenticated;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (full_name) on table public.profiles to authenticated;

revoke all on table public.memberships from anon, authenticated;
grant select, delete on table public.memberships to authenticated;
grant update (role, worker_id) on table public.memberships to authenticated;

revoke all on table public.membership_invites from anon, authenticated;
grant select, delete on table public.membership_invites to authenticated;

-- audit_log: no role may update, delete or truncate. Server code using the
-- secret key may insert (system events with no signed-in actor).
revoke all on table public.audit_log from public, anon, authenticated, service_role;
grant select on table public.audit_log to authenticated;
grant select, insert on table public.audit_log to service_role;

-- ---------------------------------------------------------------------------
-- 11. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.user_org_ids() from public, anon;
revoke all on function private.has_role(uuid, text[]) from public, anon;
revoke all on function private.manages_member(uuid) from public, anon;
revoke all on function private.create_organisation_impl(text) from public, anon;
revoke all on function private.create_membership_invite_impl(uuid, text, public.membership_role) from public, anon;
revoke all on function private.accept_membership_invite_impl(text) from public, anon;
revoke all on function private.log_audit_impl(uuid, text, text, uuid, jsonb, jsonb, text) from public, anon;
revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.audit_redact(jsonb) from public, anon, authenticated;
revoke all on function private.audit_row_change() from public, anon, authenticated;
revoke all on function private.audit_log_immutable() from public, anon, authenticated;
revoke all on function private.memberships_keep_owner() from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;

grant execute on function private.user_org_ids() to authenticated, service_role;
grant execute on function private.has_role(uuid, text[]) to authenticated, service_role;
grant execute on function private.manages_member(uuid) to authenticated, service_role;
grant execute on function private.create_organisation_impl(text) to authenticated;
grant execute on function private.create_membership_invite_impl(uuid, text, public.membership_role) to authenticated;
grant execute on function private.accept_membership_invite_impl(text) to authenticated;
grant execute on function private.log_audit_impl(uuid, text, text, uuid, jsonb, jsonb, text) to authenticated;

revoke all on function public.create_organisation(text) from public, anon;
revoke all on function public.log_audit(uuid, text, text, uuid, jsonb, jsonb, text) from public, anon;
revoke all on function public.create_membership_invite(uuid, text, public.membership_role) from public, anon;
revoke all on function public.accept_membership_invite(text) from public, anon;
grant execute on function public.create_organisation(text) to authenticated;
grant execute on function public.create_membership_invite(uuid, text, public.membership_role) to authenticated;
grant execute on function public.accept_membership_invite(text) to authenticated;
grant execute on function public.log_audit(uuid, text, text, uuid, jsonb, jsonb, text) to authenticated;
