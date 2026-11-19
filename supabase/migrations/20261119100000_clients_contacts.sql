-- Slice 2.1: clients and contacts, and the audit channel.
--
-- 1. `clients` (name-only since 1.3) gains its billing details and a status. Clients are
--    archived, never deleted.
-- 2. `client_contacts`: the people at a client that invoices, approvals and site matters go
--    to. One primary per client and role. Contacts are marked removed, never deleted.
-- 3. Roles (docs/PHASE_2.md "Roles"): owner, admin and ops_manager write clients and sites.
--    hr keeps INSERT only, because the people import creates name-only clients and sites.
--    Contacts are read and written by owner, admin, finance and ops_manager. The delete
--    policies and grants on clients, sites and projects go: nothing here is ever deleted.
-- 4. `public.create_client`: a client with its first billing contact and first site in one
--    transaction, as the caller (RLS applies). Add client and Setup step 4 use it.
-- 5. `audit_log.channel`: which door a change came through (web, worker_app, import, system,
--    later lira). A BEFORE INSERT trigger on audit_log sets it, so every existing write path
--    (row triggers, log_audit, definer functions) is covered without being rewritten. It is a
--    label for reading the log, not a permission: the actor is still auth.uid().

-- ---------------------------------------------------------------------------
-- 1. clients: billing details and status
-- ---------------------------------------------------------------------------
-- Plain-text rule as on clients.name (20261116103000): no control characters, no < or >, no
-- web address. RC number and TIN use the organisations formats (20261116101100).

alter table public.clients
  add column legal_name text
    constraint clients_legal_name_text check (
      legal_name = btrim(legal_name)
      and char_length(legal_name) between 1 and 200
      and legal_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and legal_name !~* '(://|www\.)'
    ),
  add column rc_number text
    constraint clients_rc_number_format check (rc_number ~ '^((RC|BN|IT) )?[0-9]{1,8}$'),
  add column tin text
    constraint clients_tin_format check (tin ~ '^([0-9]{8}-[0-9]{4}|[0-9]{10,13})$'),
  add column billing_address text
    constraint clients_billing_address_text check (
      billing_address = btrim(billing_address)
      and char_length(billing_address) between 1 and 300
      and billing_address !~ '[\x01-\x08\x0b-\x1f\x7f-\x9f<>]'
      and billing_address !~* '(://|www\.)'
    ),
  add column state text
    constraint clients_state_text check (
      state = btrim(state)
      and char_length(state) between 1 and 60
      and state !~ '[\x01-\x1f\x7f-\x9f<>]'
      and state !~* '(://|www\.)'
    ),
  -- Null means the organisation's payment_terms_days.
  add column billing_terms_days integer
    constraint clients_billing_terms_days_range check (billing_terms_days between 0 and 180),
  add column status text not null default 'active'
    constraint clients_status_value check (status in ('active', 'archived')),
  add column notes text
    constraint clients_notes_text check (
      notes = btrim(notes)
      and char_length(notes) between 1 and 2000
      and notes !~ '[\x01-\x08\x0b-\x1f\x7f-\x9f<>]'
    );

comment on table public.clients is
  'A company the organisation works for. Created by hand, by Setup quick add, or name-only by the people import. Archived, never deleted.';
comment on column public.clients.billing_terms_days is
  'Days a client has to pay an invoice. Null means the organisation''s payment_terms_days.';

-- ---------------------------------------------------------------------------
-- 2. client_contacts
-- ---------------------------------------------------------------------------

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  client_id uuid not null,
  name text not null
    constraint client_contacts_name_text check (
      name = btrim(name)
      and char_length(name) between 1 and 200
      and name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name !~* '(://|www\.)'
    ),
  email text not null
    constraint client_contacts_email_format check (
      email = lower(btrim(email))
      and char_length(email) <= 254
      and email ~ '^[^@[:space:]<>]+@[^@[:space:]<>]+\.[^@[:space:]<>.]+$'
    ),
  phone text
    constraint client_contacts_phone_format check (phone ~ '^\+?[0-9]{7,15}$'),
  role text not null
    constraint client_contacts_role_value check (role in ('billing', 'approver', 'ops')),
  is_primary boolean not null default false,
  status text not null default 'active'
    constraint client_contacts_status_value check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint client_contacts_organisation_id_id_key unique (organisation_id, id),
  constraint client_contacts_client_fkey foreign key (organisation_id, client_id)
    references public.clients (organisation_id, id),
  constraint client_contacts_removed_not_primary check (status = 'active' or not is_primary)
);

-- One primary per client and role.
create unique index client_contacts_one_primary_idx
  on public.client_contacts (organisation_id, client_id, role)
  where is_primary;

-- The same address once per client and role while it is active.
create unique index client_contacts_active_email_idx
  on public.client_contacts (organisation_id, client_id, role, email)
  where status = 'active';

create index client_contacts_client_idx on public.client_contacts (organisation_id, client_id);

comment on table public.client_contacts is
  'People at a client: billing (invoices and receipts), approver (timesheets, later) and ops (site matters). One primary per client and role. Marked removed, never deleted.';

-- Keeps the rules that span rows:
-- * the address is stored lower-cased;
-- * a contact never moves to another client or organisation;
-- * a removed contact is not primary;
-- * making a contact primary demotes the previous primary of that client and role;
-- * the first active contact of a client and role becomes primary on its own.
-- Runs as the caller, so RLS applies to the demotion too.
create function private.client_contacts_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(btrim(new.email));

  if tg_op = 'UPDATE' then
    if new.organisation_id <> old.organisation_id or new.client_id <> old.client_id then
      raise exception 'A contact can''t move to another client.' using errcode = 'MLCC1';
    end if;
    if new.role <> old.role then
      raise exception 'A contact''s role can''t change. Remove it and add a new one.'
        using errcode = 'MLCC2';
    end if;
    if old.status = 'removed' then
      raise exception 'A removed contact can''t be changed. Add it again.' using errcode = 'MLCC3';
    end if;
    -- A primary stops being primary only when another takes over (the demotion below runs as a
    -- nested trigger, depth 2) or it is removed. Unticking it directly would leave the role
    -- without a primary.
    if old.is_primary and not new.is_primary and new.status = 'active'
      and pg_trigger_depth() = 1 then
      raise exception 'Make another contact primary instead.' using errcode = 'MLCC4';
    end if;
  end if;

  if new.status = 'removed' then
    new.is_primary := false;
    return new;
  end if;

  -- One writer at a time per client and role, so two saves can't both become primary.
  perform pg_advisory_xact_lock(
    hashtextextended('client_contacts:' || new.client_id::text || ':' || new.role, 0)
  );

  if new.is_primary then
    update public.client_contacts c
    set is_primary = false
    where c.organisation_id = new.organisation_id
      and c.client_id = new.client_id
      and c.role = new.role
      and c.is_primary
      and c.id <> new.id;
  elsif tg_op = 'INSERT' and not exists (
    select 1
    from public.client_contacts c
    where c.organisation_id = new.organisation_id
      and c.client_id = new.client_id
      and c.role = new.role
      and c.is_primary
  ) then
    new.is_primary := true;
  end if;

  return new;
end;
$$;

revoke all on function private.client_contacts_before_write() from public, anon, authenticated;

create trigger client_contacts_before_write before insert or update on public.client_contacts
  for each row execute function private.client_contacts_before_write();
-- When the primary of a role is removed, the longest-standing other active contact of that
-- client and role takes over, so a role with contacts always has a primary. AFTER, so the row
-- being removed is already saved as not primary when the next one is promoted. Runs as the
-- caller, so RLS applies.
create function private.client_contacts_after_remove()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_primary and old.status = 'active' and new.status = 'removed' then
    update public.client_contacts c
    set is_primary = true
    where c.id = (
      select n.id
      from public.client_contacts n
      where n.organisation_id = new.organisation_id
        and n.client_id = new.client_id
        and n.role = new.role
        and n.status = 'active'
        and n.id <> new.id
      order by n.created_at, n.id
      limit 1
    );
  end if;
  return null;
end;
$$;

revoke all on function private.client_contacts_after_remove() from public, anon, authenticated;

create trigger client_contacts_after_remove after update on public.client_contacts
  for each row execute function private.client_contacts_after_remove();
create trigger client_contacts_set_updated_at before update on public.client_contacts
  for each row execute function private.set_updated_at();
create trigger client_contacts_audit after insert or update or delete on public.client_contacts
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 3. Row-level security and grants
-- ---------------------------------------------------------------------------

-- clients: owner, admin and ops_manager write; hr inserts name-only clients (the people import),
-- nothing more. Rows are read as in 1.3, but the billing columns are not granted to signed-in
-- users: hr, line managers and assigned workers read client rows, and the billing details and
-- notes are for owner, admin, finance and ops_manager only, through public.client_billing.
-- No delete for anyone.
drop policy clients_insert on public.clients;
drop policy clients_update on public.clients;
drop policy clients_delete on public.clients;

create policy clients_insert on public.clients for insert to authenticated
  with check (
    private.has_role(organisation_id, array['owner', 'admin', 'ops_manager'])
    or (
      private.has_role(organisation_id, array['hr'])
      and legal_name is null and rc_number is null and tin is null and billing_address is null
      and state is null and billing_terms_days is null and notes is null
    )
  );
create policy clients_update on public.clients for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));

revoke all on table public.clients from anon, authenticated;
grant select (id, organisation_id, name, status, created_at, created_by, updated_at)
  on table public.clients to authenticated;
grant insert (
  id, organisation_id, name, legal_name, rc_number, tin, billing_address, state,
  billing_terms_days, notes
) on table public.clients to authenticated;
grant update (
  name, legal_name, rc_number, tin, billing_address, state, billing_terms_days, status, notes
) on table public.clients to authenticated;

-- The billing columns, for the roles that work with them. Security definer because the columns
-- are not granted; it checks the role itself and returns nothing for anyone else. A public
-- invoker wrapper is what the Data API exposes, as for the other definer functions.
create function private.client_billing(p_organisation_id uuid, p_client_id uuid default null)
returns table (
  client_id uuid,
  legal_name text,
  rc_number text,
  tin text,
  billing_address text,
  state text,
  billing_terms_days integer,
  notes text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.legal_name, c.rc_number, c.tin, c.billing_address, c.state,
    c.billing_terms_days, c.notes
  from public.clients c
  where c.organisation_id = p_organisation_id
    and (p_client_id is null or c.id = p_client_id)
    and private.has_role(p_organisation_id, array['owner', 'admin', 'finance', 'ops_manager'])
$$;

revoke all on function private.client_billing(uuid, uuid) from public, anon;
grant execute on function private.client_billing(uuid, uuid) to authenticated;

create function public.client_billing(p_organisation_id uuid, p_client_id uuid default null)
returns table (
  client_id uuid,
  legal_name text,
  rc_number text,
  tin text,
  billing_address text,
  state text,
  billing_terms_days integer,
  notes text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.client_billing(p_organisation_id, p_client_id)
$$;

revoke all on function public.client_billing(uuid, uuid) from public, anon;
grant execute on function public.client_billing(uuid, uuid) to authenticated;

-- sites: the same roles. Phase 2.2 adds the address, geofence and checkpoints.
drop policy sites_insert on public.sites;
drop policy sites_update on public.sites;
drop policy sites_delete on public.sites;

create policy sites_insert on public.sites for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager', 'hr']));
create policy sites_update on public.sites for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'ops_manager']));

revoke delete on table public.sites from authenticated;

-- projects: only the delete goes now; Phase 8 decides the rest.
drop policy projects_delete on public.projects;
revoke delete on table public.projects from authenticated;

-- client_contacts: owner, admin, finance and ops_manager read and write. No delete.
alter table public.client_contacts enable row level security;

create policy client_contacts_select on public.client_contacts for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));
create policy client_contacts_insert on public.client_contacts for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));
create policy client_contacts_update on public.client_contacts for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));

revoke all on table public.client_contacts from anon, authenticated;
grant select on table public.client_contacts to authenticated;
grant insert (id, organisation_id, client_id, name, email, phone, role, is_primary)
  on table public.client_contacts to authenticated;
grant update (name, email, phone, is_primary, status) on table public.client_contacts to authenticated;

-- ---------------------------------------------------------------------------
-- 4. create_client: a client, its first billing contact and a first site, in one transaction
-- ---------------------------------------------------------------------------
-- Used by Add client (details and a billing contact) and Setup step 4's quick add (a name, a
-- billing email and a first site). Security invoker: every insert runs under the caller's RLS
-- and column grants, so a caller who may not write clients, contacts or sites gets 42501 and
-- nothing is saved. The table checks and the contact trigger apply as for a direct insert.
create function public.create_client(
  p_organisation_id uuid,
  p_name text,
  p_legal_name text default null,
  p_rc_number text default null,
  p_tin text default null,
  p_billing_address text default null,
  p_state text default null,
  p_billing_terms_days integer default null,
  p_notes text default null,
  p_contact_name text default null,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_site_name text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_client uuid;
  v_email text := nullif(lower(btrim(p_contact_email)), '');
  v_site text := nullif(btrim(p_site_name), '');
begin
  insert into public.clients (
    organisation_id, name, legal_name, rc_number, tin, billing_address, state,
    billing_terms_days, notes
  )
  values (
    p_organisation_id, p_name, p_legal_name, p_rc_number, p_tin, p_billing_address, p_state,
    p_billing_terms_days, p_notes
  )
  returning id into v_client;

  if v_email is not null then
    insert into public.client_contacts (
      organisation_id, client_id, name, email, phone, role, is_primary
    )
    values (
      p_organisation_id, v_client, coalesce(nullif(btrim(p_contact_name), ''), 'Billing contact'),
      v_email, p_contact_phone, 'billing', true
    );
  end if;

  if v_site is not null then
    insert into public.sites (organisation_id, client_id, name)
    values (p_organisation_id, v_client, v_site);
  end if;

  return v_client;
end;
$$;

revoke all on function public.create_client(
  uuid, text, text, text, text, text, text, integer, text, text, text, text, text
) from public, anon;
grant execute on function public.create_client(
  uuid, text, text, text, text, text, text, integer, text, text, text, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. audit_log.channel
-- ---------------------------------------------------------------------------
-- A constant default: no table rewrite and no row trigger fires, so the append-only guard is
-- untouched. Rows written before this migration read 'web'.
alter table public.audit_log
  add column channel text not null default 'web'
    constraint audit_log_channel_value
      check (channel in ('web', 'worker_app', 'import', 'system', 'lira'));

comment on column public.audit_log.channel is
  'Which door the change came through: web (manager app), worker_app, import, system (jobs and server tasks), lira (the ops agent, later). Set by private.audit_log_set_channel; a label only: never used for permission, rate-limit, billing or alert decisions.';

-- BEFORE INSERT on audit_log. Works out the channel for the row being written, in this order:
-- 1. `metalira.audit_channel`, a transaction-local setting a SQL function may set
--    (`perform set_config('metalira.audit_channel', 'import', true)`).
-- 2. The `x-metalira-channel` request header the app's server clients send
--    (src/lib/supabase/server.ts, src/server/supabase/admin.ts).
-- 3. No request at all (pg_cron, psql), or the secret key with no header: 'system'.
-- 4. Otherwise 'web'.
-- The channel always comes from here, whatever the insert supplied, so a direct insert with
-- the secret key can't choose its own. 'system' is never taken from a header, and 'lira' is not
-- accepted from a header or the setting yet: the agent's write path decides that when it is
-- built (docs/LIRA.md). A signed-in user calling the Data API directly can still label their
-- own change 'worker_app' or 'import'; the actor on the row is always theirs.
-- It must never raise: every audited write in the product passes through here.
create function private.audit_log_set_channel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_local text;
  v_header text;
  v_claims text;
  v_role text;
begin
  new.channel := 'web';
  begin
    v_local := nullif(current_setting('metalira.audit_channel', true), '');
    v_claims := nullif(current_setting('request.jwt.claims', true), '');
    v_header := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-metalira-channel';
    if v_claims is not null then
      v_role := v_claims::jsonb ->> 'role';
    end if;
  exception when others then
    return new;
  end;

  if v_local in ('web', 'worker_app', 'import', 'system') then
    new.channel := v_local;
  elsif v_header in ('web', 'worker_app', 'import') then
    new.channel := v_header;
  elsif v_claims is null or v_role = 'service_role' then
    new.channel := 'system';
  end if;
  return new;
end;
$$;

revoke all on function private.audit_log_set_channel() from public, anon, authenticated;

create trigger audit_log_set_channel before insert on public.audit_log
  for each row execute function private.audit_log_set_channel();
