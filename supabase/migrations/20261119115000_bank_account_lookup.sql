-- Slice 2.3b: bank picker and account name check.
--
-- Wherever a bank account is entered (the company's collection account, slice 2.3; a worker's
-- bank details, slices 1.3, 1.7 and 1.10), the bank is chosen from a list with its bank code and
-- the account name comes from the bank network, never from the person typing. The server looks
-- the name up with Metalira's own account-validation provider (src/lib/payments/, called only
-- from src/server/billing/bank-lookup.ts) and records every lookup here.
--
-- * public.bank_account_lookups: one row per lookup. Written only with the secret key, through
--   begin_bank_account_lookup (rate limits: 30 an hour per user, 100 an hour per company) and
--   finish_bank_account_lookup. Signed-in users read their own rows. The account number is never
--   stored: an HMAC digest (keyed by the server, bound to the company and bank code) and the last
--   four digits only. Rows are kept 30 days for the rate limits and the record, then removed.
-- * A request (organisation_bank_accounts, bank_detail_changes) names the lookup it was checked
--   with (bank_lookup_id). A BEFORE INSERT trigger then takes the account name from the lookup,
--   whatever the caller sent, and refuses a lookup that is someone else's, another company's,
--   for another purpose or worker, unresolved, older than 30 minutes, already used, or for a
--   different bank code, digest or last four digits. Each lookup backs one request.
-- * name_check records how the bank's name compared with the expected names when the request
--   was raised: `match`, `near` (needs a reason of 10 characters or more, shown to the approver),
--   or `not_checked` (no lookup: the people import, which never looks names up per row). A
--   `no_match` is refused by the server and never stored on a request. The comparison is fuzzy
--   (src/lib/bank-name-match.ts), so the database can't repeat it: the server recomputes it from
--   the stored bank name on approval and refuses `no_match`, or `near` without a reason, and
--   checks the decrypted number against the stored digest. The stored value is a record only.
-- * The company account always needs a lookup from a signed-in user (it has no import path).
--   Worker requests may be `not_checked` (the import), and the approver sees that plainly.
-- * workers: bank_code, and the last check of the bank details on file (bank_name_check,
--   bank_checked_name, bank_checked_at, bank_checked_by). Set when a bank change applies (from
--   the change), or by "Check bank details" on the person page (finish_bank_account_lookup with
--   purpose `worker_check`, where the server looked up the number on file). Not writable by
--   signed-in users.
-- * Rows from before this slice keep bank_code and name_check null ("Not checked").
--
-- Refusals: MLBL1 (your hourly limit), MLBL2 (the company's limit: 100 an hour, or 40 a day
-- while setup is unfinished), MLBL9 (the platform's hourly ceiling), MLBL3 (lookup not
-- found or not yours), MLBL4 (expired), MLBL5 (already used), MLBL6 (account changed after the
-- check), MLBL7 (the company account needs a check), MLBL8 (fixed after insert).

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

create type public.bank_lookup_purpose as enum ('company_bank', 'worker_bank', 'worker_check');
create type public.bank_lookup_status as enum ('pending', 'resolved', 'not_found', 'failed');
create type public.bank_name_check as enum ('match', 'near', 'no_match', 'not_checked');

-- ---------------------------------------------------------------------------
-- 2. Lookups
-- ---------------------------------------------------------------------------

create table public.bank_account_lookups (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  -- The signed-in user the server looked it up for. No foreign key, as on audit_log.
  requested_by uuid not null,
  purpose public.bank_lookup_purpose not null,
  -- The worker it is for: required for worker_check, null for a worker being added.
  worker_id uuid,
  bank_code text not null
    constraint bank_account_lookups_bank_code_format check (bank_code ~ '^[0-9]{3,6}$'),
  bank_account_digest text not null
    constraint bank_account_lookups_digest_format check (bank_account_digest ~ '^[0-9a-f]{64}$'),
  bank_account_last4 text not null
    constraint bank_account_lookups_last4_format check (bank_account_last4 ~ '^[0-9]{4}$'),
  status public.bank_lookup_status not null default 'pending',
  -- The name the bank network returned, as returned (trimmed).
  account_name text
    constraint bank_account_lookups_account_name_text check (
      account_name = btrim(account_name)
      and char_length(account_name) between 1 and 200
      and account_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and account_name !~* '(://|www\.)'
    ),
  -- `bank`: the provider's live service answered. `sandbox`: its sandbox (previews). `test`:
  -- the deterministic test resolver. Only `bank` is accepted on approval in production; the
  -- others are labelled "Test lookup" wherever they show.
  source text
    constraint bank_account_lookups_source check (source in ('bank', 'sandbox', 'test')),
  -- The network address the server saw (x-real-ip), for the per-address limit.
  client_ip text
    constraint bank_account_lookups_client_ip_length check (char_length(client_ip) <= 64),
  -- worker_check only: md5 of the ciphertext the number was read from, so the result is kept
  -- only if the worker's account is still that one when the bank answers.
  worker_enc_md5 text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  used_at timestamptz,

  constraint bank_account_lookups_organisation_id_id_key unique (organisation_id, id),
  constraint bank_account_lookups_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint bank_account_lookups_check_has_worker check (
    purpose <> 'worker_check' or worker_id is not null
  ),
  constraint bank_account_lookups_status_columns check (
    case status
      when 'pending' then num_nonnulls(account_name, source, finished_at, used_at) = 0
      when 'resolved' then account_name is not null and source is not null
        and finished_at is not null
      else account_name is null and finished_at is not null and used_at is null
    end
  )
);

create index bank_account_lookups_user_idx
  on public.bank_account_lookups (requested_by, created_at desc);
create index bank_account_lookups_organisation_idx
  on public.bank_account_lookups (organisation_id, created_at desc);
create index bank_account_lookups_worker_idx
  on public.bank_account_lookups (worker_id)
  where worker_id is not null;

comment on table public.bank_account_lookups is
  'Account name lookups from the bank network (slice 2.3b). Written only by the server with the secret key; the account number is kept as a keyed digest and last four digits. A request names the lookup it was checked with, and the database takes the account name from here.';

alter table public.bank_account_lookups enable row level security;

-- Signed-in users read only their own lookups, in a company they belong to.
create policy bank_account_lookups_select on public.bank_account_lookups
  for select to authenticated
  using (
    requested_by = (select private.session_uid())
    and organisation_id in (select private.user_org_ids())
  );

revoke all on table public.bank_account_lookups from anon, authenticated;
revoke truncate, delete, references, trigger on table public.bank_account_lookups from service_role;
grant select on table public.bank_account_lookups to authenticated;
grant select, insert, update on table public.bank_account_lookups to service_role;

-- Whether test and sandbox lookups may back real requests. Only local and CI databases say yes:
-- supabase/seed.sql inserts the setting, and `supabase db reset` / `supabase start` run the seed
-- there. The hosted project gets migrations only (never the seed), so there the setting is
-- absent and test or sandbox answers can be shown but never used (Vercel previews share the
-- production database).
create table private.settings (
  key text primary key,
  value text not null
);
revoke all on table private.settings from public, anon, authenticated;

create function private.test_bank_lookups_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.value = 'on' from private.settings s where s.key = 'allow_test_bank_lookups'),
    false
  )
$$;

-- Starts a lookup for p_user_id (the server has verified the session), after checking their
-- role for the purpose and the limits under one lock. Secret key only.
--
-- Limits (they protect people's names and Metalira's provider account):
--   per user: 30 an hour;            per network address (x-real-ip): 60 an hour;
--   per company: 20 an hour for the company account, 100 an hour for workers;
--   a company that hasn't finished setup (anyone can create one): 10 a day;
--   the platform: 2,000 an hour, of which companies in setup share at most 200.
create function private.begin_bank_account_lookup(
  p_organisation_id uuid,
  p_user_id uuid,
  p_purpose public.bank_lookup_purpose,
  p_worker_id uuid,
  p_bank_code text,
  p_bank_account_digest text,
  p_bank_account_last4 text,
  p_client_ip text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_roles text[];
  v_allowed boolean;
  v_in_setup boolean;
  v_worker_enc_md5 text;
  v_id uuid;
  v_ip text := nullif(left(btrim(p_client_ip), 64), '');
begin
  if auth.uid() is not null then
    raise exception 'Only the server can look up bank accounts.' using errcode = '42501';
  end if;
  if p_organisation_id is null or p_user_id is null or p_purpose is null then
    raise exception 'A lookup needs a company, a user and a purpose.' using errcode = '22023';
  end if;

  v_roles := case p_purpose
    when 'company_bank' then array['owner', 'admin', 'finance']
    else array['owner', 'admin', 'hr']
  end;
  select exists (
    select 1
    from public.memberships m
    where m.organisation_id = p_organisation_id
      and m.user_id = p_user_id
      and (
        m.role::text = any (v_roles)
        -- A worker checks only their own new bank details (slice 1.10).
        or (
          p_purpose = 'worker_bank'
          and m.role = 'worker'
          and p_worker_id is not null
          and m.worker_id = p_worker_id
        )
      )
  ) into v_allowed;
  if not v_allowed then
    raise exception 'Your role can''t check this bank account.' using errcode = '42501';
  end if;

  if p_worker_id is not null then
    select md5(w.bank_account_enc) into v_worker_enc_md5
    from public.workers w
    where w.id = p_worker_id and w.organisation_id = p_organisation_id;
    if not found then
      raise exception 'That employee wasn''t found.' using errcode = 'P0002';
    end if;
  end if;

  select o.setup_completed_at is null into v_in_setup
  from public.organisations o
  where o.id = p_organisation_id;

  -- One lock for all lookups, so parallel lookups can't pass a limit together. The network
  -- call happens after this returns, so the lock is held only for the counts.
  perform pg_advisory_xact_lock(hashtextextended('bank_account_lookups', 0));
  if (
    select count(*) from public.bank_account_lookups l
    where l.requested_by = p_user_id and l.created_at > now() - interval '1 hour'
  ) >= 30 then
    raise exception 'You have checked 30 bank accounts in the last hour. Try again later.'
      using errcode = 'MLBL1';
  end if;
  if v_ip is not null and (
    select count(*) from public.bank_account_lookups l
    where l.client_ip = v_ip and l.created_at > now() - interval '1 hour'
  ) >= 60 then
    raise exception 'Too many bank account checks from your network in the last hour. Try again later.'
      using errcode = 'MLBL1';
  end if;
  if p_purpose = 'company_bank' and (
    select count(*) from public.bank_account_lookups l
    where l.organisation_id = p_organisation_id and l.purpose = 'company_bank'
      and l.created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'Your company has checked its own account 20 times in the last hour. Try again later.'
      using errcode = 'MLBL2';
  end if;
  if p_purpose <> 'company_bank' and (
    select count(*) from public.bank_account_lookups l
    where l.organisation_id = p_organisation_id and l.purpose <> 'company_bank'
      and l.created_at > now() - interval '1 hour'
  ) >= 100 then
    raise exception 'Your company has checked 100 employee bank accounts in the last hour. Try again later.'
      using errcode = 'MLBL2';
  end if;
  if v_in_setup and (
    select count(*) from public.bank_account_lookups l
    where l.organisation_id = p_organisation_id and l.created_at > now() - interval '24 hours'
  ) >= 10 then
    raise exception 'Your company can check 10 bank accounts a day until setup is finished.'
      using errcode = 'MLBL2';
  end if;
  if (
    select count(*) from public.bank_account_lookups l
    where l.created_at > now() - interval '1 hour'
  ) >= 2000 or (
    v_in_setup and (
      select count(*)
      from public.bank_account_lookups l
      join public.organisations o on o.id = l.organisation_id
      where o.setup_completed_at is null and l.created_at > now() - interval '1 hour'
    ) >= 200
  ) then
    raise exception 'Bank account checks are busy right now. Try again in a few minutes.'
      using errcode = 'MLBL9';
  end if;

  insert into public.bank_account_lookups (
    organisation_id, requested_by, purpose, worker_id, bank_code, bank_account_digest,
    bank_account_last4, client_ip, worker_enc_md5
  )
  values (
    p_organisation_id, p_user_id, p_purpose, p_worker_id, p_bank_code, p_bank_account_digest,
    p_bank_account_last4, v_ip,
    case when p_purpose = 'worker_check' then v_worker_enc_md5 end
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Records what the bank said, and returns whether the answer may back a request: a live
-- bank's answer always; a test or sandbox answer only where the database allows test lookups.
-- A usable `worker_check` (the server looked up the number on file) is also written to the
-- worker, unless their account changed meanwhile (bound to the ciphertext it was read from).
-- Secret key only; a lookup finishes once.
create function private.finish_bank_account_lookup(
  p_id uuid,
  p_status public.bank_lookup_status,
  p_account_name text default null,
  p_source text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.bank_account_lookups;
  v_usable boolean;
begin
  if auth.uid() is not null then
    raise exception 'Only the server can record a bank lookup.' using errcode = '42501';
  end if;
  if p_status is null or p_status = 'pending' then
    raise exception 'Record how the lookup ended.' using errcode = '22023';
  end if;

  update public.bank_account_lookups b
  set status = p_status,
      account_name = case when p_status = 'resolved' then btrim(p_account_name) end,
      source = case when p_status = 'resolved' then p_source end,
      finished_at = now()
  where b.id = p_id and b.status = 'pending'
  returning b.* into l;
  if l.id is null then
    raise exception 'That lookup wasn''t found or has already finished.' using errcode = 'P0002';
  end if;

  v_usable := l.status = 'resolved'
    and (l.source = 'bank' or private.test_bank_lookups_allowed());

  if v_usable and l.purpose = 'worker_check' then
    update public.workers w
    set bank_checked_name = l.account_name,
        bank_checked_at = l.finished_at,
        bank_checked_by = l.requested_by,
        bank_checked_code = l.bank_code,
        bank_checked_source = l.source
    where w.id = l.worker_id
      and w.organisation_id = l.organisation_id
      and md5(w.bank_account_enc) = l.worker_enc_md5;
  end if;
  return v_usable;
end;
$$;

-- Invoker wrappers for the Data API (the definer functions stay in private). Secret key only.
create function public.begin_bank_account_lookup(
  p_organisation_id uuid,
  p_user_id uuid,
  p_purpose public.bank_lookup_purpose,
  p_worker_id uuid,
  p_bank_code text,
  p_bank_account_digest text,
  p_bank_account_last4 text,
  p_client_ip text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.begin_bank_account_lookup(
    p_organisation_id, p_user_id, p_purpose, p_worker_id, p_bank_code, p_bank_account_digest,
    p_bank_account_last4, p_client_ip
  )
$$;

create function public.finish_bank_account_lookup(
  p_id uuid,
  p_status public.bank_lookup_status,
  p_account_name text default null,
  p_source text default null
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.finish_bank_account_lookup(p_id, p_status, p_account_name, p_source)
$$;

-- ---------------------------------------------------------------------------
-- 3. Columns on the request tables and workers
-- ---------------------------------------------------------------------------

alter table public.organisation_bank_accounts
  add column bank_code text
    constraint organisation_bank_accounts_bank_code_format check (bank_code ~ '^[0-9]{3,6}$'),
  add column bank_lookup_id uuid,
  add column bank_account_digest text
    constraint organisation_bank_accounts_digest_format check (bank_account_digest ~ '^[0-9a-f]{64}$'),
  add column name_check public.bank_name_check,
  add column name_check_reason text
    constraint organisation_bank_accounts_name_check_reason_text check (
      name_check_reason = btrim(name_check_reason)
      and char_length(name_check_reason) between 10 and 500
      and name_check_reason !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name_check_reason !~ '[0-9]{10}'
    ),
  add column name_check_source text
    constraint organisation_bank_accounts_name_check_source check (name_check_source in ('bank', 'sandbox', 'test')),
  -- The names the check compared with when the request was raised (set by the trigger from
  -- the company's legal and trading names), so the approver sees if they changed since.
  add column name_check_expected text,
  -- null: raised before slice 2.3b. Otherwise checked (match or near, with the lookup) or not.
  add constraint organisation_bank_accounts_name_check_columns check (
    name_check is null
    or (name_check in ('match', 'near')
      and num_nulls(bank_code, bank_lookup_id, bank_account_digest, name_check_source) = 0
      and (name_check = 'match' or name_check_reason is not null))
    or (name_check = 'not_checked'
      and num_nonnulls(bank_lookup_id, bank_account_digest, name_check_reason, name_check_source) = 0)
  );

alter table public.bank_detail_changes
  add column bank_code text
    constraint bank_detail_changes_bank_code_format check (bank_code ~ '^[0-9]{3,6}$'),
  add column bank_lookup_id uuid,
  add column bank_account_digest text
    constraint bank_detail_changes_digest_format check (bank_account_digest ~ '^[0-9a-f]{64}$'),
  add column name_check public.bank_name_check,
  add column name_check_reason text
    constraint bank_detail_changes_name_check_reason_text check (
      name_check_reason = btrim(name_check_reason)
      and char_length(name_check_reason) between 10 and 500
      and name_check_reason !~ '[\x01-\x1f\x7f-\x9f<>]'
      and name_check_reason !~ '[0-9]{10}'
    ),
  add column name_check_source text
    constraint bank_detail_changes_name_check_source check (name_check_source in ('bank', 'sandbox', 'test')),
  -- The employee's name when the request was raised (set by the trigger).
  add column name_check_expected text,
  add constraint bank_detail_changes_name_check_columns check (
    name_check is null
    or (name_check in ('match', 'near')
      and num_nulls(bank_code, bank_lookup_id, bank_account_digest, name_check_source) = 0
      and (name_check = 'match' or name_check_reason is not null))
    or (name_check = 'not_checked'
      and num_nonnulls(bank_lookup_id, bank_account_digest, name_check_reason, name_check_source) = 0)
  );

create unique index organisation_bank_accounts_bank_lookup_key
  on public.organisation_bank_accounts (bank_lookup_id)
  where bank_lookup_id is not null;
create unique index bank_detail_changes_bank_lookup_key
  on public.bank_detail_changes (bank_lookup_id)
  where bank_lookup_id is not null;

alter table public.workers
  add column bank_code text
    constraint workers_bank_code_format check (bank_code ~ '^[0-9]{3,6}$'),
  -- The last check of the bank details on file: the name the bank gave and when. The match is
  -- recomputed by the app from the name, so it can't drift from the rules.
  add column bank_checked_name text
    constraint workers_bank_checked_name_text check (
      bank_checked_name = btrim(bank_checked_name)
      and char_length(bank_checked_name) between 1 and 200
      and bank_checked_name !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  add column bank_checked_at timestamptz,
  add column bank_checked_by uuid,
  add column bank_checked_code text
    constraint workers_bank_checked_code_format check (bank_checked_code ~ '^[0-9]{3,6}$'),
  add column bank_checked_source text
    constraint workers_bank_checked_source check (bank_checked_source in ('bank', 'sandbox', 'test')),
  add constraint workers_bank_checked_columns check (
    (bank_checked_name is null) = (bank_checked_at is null)
    and (bank_checked_name is null) = (bank_checked_source is null)
  );

comment on column public.workers.bank_checked_name is
  'The account name the bank network gave for the bank details on file, at bank_checked_at (slice 2.3b). Null: not checked.';

-- Signed-in users write none of the new columns directly (the workers grants are per column).
grant insert (bank_code, bank_lookup_id, bank_account_digest, name_check, name_check_reason)
  on table public.organisation_bank_accounts to authenticated;
grant insert (bank_code, bank_lookup_id, bank_account_digest, name_check, name_check_reason)
  on table public.bank_detail_changes to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Taking a lookup into a request
-- ---------------------------------------------------------------------------

-- Checks that a lookup backs this request and marks it used. Returns the lookup.
create function private.take_bank_account_lookup(
  p_lookup_id uuid,
  p_organisation_id uuid,
  p_requested_by uuid,
  p_purpose public.bank_lookup_purpose,
  p_worker_id uuid,
  p_bank_code text,
  p_bank_account_digest text,
  p_bank_account_last4 text
)
returns public.bank_account_lookups
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.bank_account_lookups;
begin
  select * into l
  from public.bank_account_lookups b
  where b.id = p_lookup_id
  for update;
  if l.id is null
    or l.organisation_id <> p_organisation_id
    or l.requested_by is distinct from p_requested_by
    or l.purpose <> p_purpose
    or (l.worker_id is not null and l.worker_id is distinct from p_worker_id)
    or l.status <> 'resolved' then
    raise exception 'That bank check wasn''t found. Check the account again.'
      using errcode = 'MLBL3';
  end if;
  if l.used_at is not null then
    raise exception 'That bank check has already been used. Check the account again.'
      using errcode = 'MLBL5';
  end if;
  if l.created_at < now() - interval '30 minutes' then
    raise exception 'That bank check is more than 30 minutes old. Check the account again.'
      using errcode = 'MLBL4';
  end if;
  if (l.bank_code, l.bank_account_digest, l.bank_account_last4)
    is distinct from (p_bank_code, p_bank_account_digest, p_bank_account_last4) then
    raise exception 'The bank or account number changed after the check. Check the account again.'
      using errcode = 'MLBL6';
  end if;

  if l.source <> 'bank' and not private.test_bank_lookups_allowed() then
    raise exception 'Test lookups can''t be used for real bank details. Check the account with a live bank lookup.'
      using errcode = 'MLBLT';
  end if;

  update public.bank_account_lookups b set used_at = now() where b.id = l.id;
  return l;
end;
$$;

-- BEFORE INSERT on organisation_bank_accounts, after organisation_bank_accounts_before_insert
-- (triggers fire in name order). A signed-in requester must name a lookup; the account name is
-- the bank's.
create function private.organisation_bank_accounts_lookup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.bank_account_lookups;
begin
  if new.bank_lookup_id is null then
    if auth.uid() is not null then
      raise exception 'Check the account name with the bank before sending the request.'
        using errcode = 'MLBL7';
    end if;
    new.name_check := 'not_checked';
    new.bank_account_digest := null;
    new.name_check_reason := null;
    new.name_check_source := null;
    return new;
  end if;

  l := private.take_bank_account_lookup(
    new.bank_lookup_id, new.organisation_id, new.requested_by, 'company_bank', null,
    new.bank_code, new.bank_account_digest, new.bank_account_last4
  );
  if new.name_check is null or new.name_check not in ('match', 'near') then
    raise exception 'Say how the bank''s account name compared.' using errcode = '22023';
  end if;
  new.account_name := l.account_name;
  new.name_check_source := l.source;
  if new.name_check = 'match' then
    new.name_check_reason := null;
  end if;
  select nullif(concat_ws(' / ', o.legal_name, o.trading_name), '')
  into new.name_check_expected
  from public.organisations o
  where o.id = new.organisation_id;
  return new;
end;
$$;

-- The employee's name as the check compares it (definer: a worker may not read every column).
create function private.worker_check_name(p_organisation_id uuid, p_worker_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select w.first_name || ' ' || w.last_name
  from public.workers w
  where w.id = p_worker_id and w.organisation_id = p_organisation_id
$$;

-- BEFORE INSERT on bank_detail_changes, after bank_detail_changes_before_insert. Invoker on
-- purpose: `current_user` is then the role that ran the insert. A signed-in user writing
-- through the Data API (`authenticated`, directly or through an invoker function such as
-- create_worker) must name a lookup (MLBL7). Only the people import, through the definer
-- function private.import_bank_change, and the secret key raise requests without one
-- (`not_checked`), and approving those needs the approver to say how they confirmed it.
create function private.bank_detail_changes_lookup()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  l public.bank_account_lookups;
begin
  new.name_check_expected := private.worker_check_name(new.organisation_id, new.worker_id);
  if new.bank_lookup_id is null then
    if auth.uid() is not null and current_user = 'authenticated' then
      raise exception 'Check the account name with the bank before sending the request.'
        using errcode = 'MLBL7';
    end if;
    new.name_check := 'not_checked';
    new.bank_account_digest := null;
    new.name_check_reason := null;
    new.name_check_source := null;
    return new;
  end if;

  l := private.take_bank_account_lookup(
    new.bank_lookup_id, new.organisation_id, new.requested_by, 'worker_bank', new.worker_id,
    new.bank_code, new.bank_account_digest, new.bank_account_last4
  );
  if new.name_check is null or new.name_check not in ('match', 'near') then
    raise exception 'Say how the bank''s account name compared.' using errcode = '22023';
  end if;
  new.account_name := l.account_name;
  new.name_check_source := l.source;
  if new.name_check = 'match' then
    new.name_check_reason := null;
  end if;
  return new;
end;
$$;

-- BEFORE UPDATE on both tables: the check is part of the request, fixed after insert. And on
-- approval: a request checked with a test or sandbox lookup can't be approved where test
-- lookups aren't allowed (the hosted project), and an unchecked worker request (the import, or
-- raised before slice 2.3b) needs the approver to say how they confirmed the account.
create function private.bank_request_check_fixed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.bank_code, new.bank_lookup_id, new.bank_account_digest, new.name_check,
    new.name_check_reason, new.name_check_source, new.name_check_expected
  ) is distinct from (
    old.bank_code, old.bank_lookup_id, old.bank_account_digest, old.name_check,
    old.name_check_reason, old.name_check_source, old.name_check_expected
  ) then
    raise exception 'A bank request can''t be edited. Reject it and raise a new one.'
      using errcode = 'MLBL8';
  end if;

  if old.status = 'pending' and new.status = 'approved' then
    if new.name_check in ('match', 'near') and new.name_check_source <> 'bank'
      and not private.test_bank_lookups_allowed() then
      raise exception 'Test lookups can''t be used for real bank details. Reject this request and raise it again with a live bank lookup.'
        using errcode = 'MLBLT';
    end if;
    if tg_table_name = 'bank_detail_changes'
      and coalesce(new.name_check, 'not_checked') = 'not_checked'
      and char_length(coalesce(btrim(new.decision_note), '')) < 10 then
      raise exception 'This account wasn''t checked with the bank. Say how you confirmed it (at least 10 characters), for example from the employee''s bank letter.'
        using errcode = 'MLBLC';
    end if;
  end if;
  return new;
end;
$$;

create trigger organisation_bank_accounts_lookup
  before insert on public.organisation_bank_accounts
  for each row execute function private.organisation_bank_accounts_lookup();
create trigger organisation_bank_accounts_lookup_fixed
  before update on public.organisation_bank_accounts
  for each row execute function private.bank_request_check_fixed();
create trigger bank_detail_changes_lookup
  before insert on public.bank_detail_changes
  for each row execute function private.bank_detail_changes_lookup();
create trigger bank_detail_changes_lookup_fixed
  before update on public.bank_detail_changes
  for each row execute function private.bank_request_check_fixed();

-- ---------------------------------------------------------------------------
-- 5. Applying a change carries the bank code and the check onto the worker
-- ---------------------------------------------------------------------------

-- As in 20261116214500, plus bank_code and the check: an applied change replaces both.
create or replace function private.bank_detail_changes_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checked boolean := new.name_check in ('match', 'near');
begin
  if old.status = 'approved' and new.status = 'applied' then
    update public.workers w
    set bank_name = new.bank_name,
        account_name = new.account_name,
        bank_account_enc = new.bank_account_enc,
        bank_account_last4 = new.bank_account_last4,
        bank_code = new.bank_code,
        bank_checked_name = case when v_checked then new.account_name end,
        bank_checked_at = case when v_checked then new.created_at end,
        bank_checked_by = case when v_checked then new.requested_by end,
        bank_checked_code = case when v_checked then new.bank_code end,
        bank_checked_source = case when v_checked then new.name_check_source end
    where w.id = new.worker_id
      and w.organisation_id = new.organisation_id;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Raising requests with the check
-- ---------------------------------------------------------------------------

-- As in 20261119110000, plus the bank code and the lookup. The account name sent is replaced by
-- the lookup's.
drop function public.request_org_bank_account(uuid, uuid, text, text, bytea, text, text);

create function public.request_org_bank_account(
  p_organisation_id uuid,
  p_id uuid,
  p_bank_name text,
  p_account_name text,
  p_bank_account_enc bytea,
  p_bank_account_last4 text,
  p_reason text default null,
  p_bank_code text default null,
  p_bank_lookup_id uuid default null,
  p_bank_account_digest text default null,
  p_name_check public.bank_name_check default null,
  p_name_check_reason text default null
)
returns table (
  id uuid,
  status public.org_bank_account_status,
  single_approver boolean,
  account_name text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  insert into public.organisation_bank_accounts as a (
    id, organisation_id, bank_name, account_name, bank_account_enc, bank_account_last4, reason,
    bank_code, bank_lookup_id, bank_account_digest, name_check, name_check_reason
  )
  values (
    p_id, p_organisation_id, p_bank_name, p_account_name, p_bank_account_enc,
    p_bank_account_last4, nullif(btrim(p_reason), ''), p_bank_code, p_bank_lookup_id,
    p_bank_account_digest, p_name_check, nullif(btrim(p_name_check_reason), '')
  )
  returning a.id, a.status, a.single_approver, a.account_name;
end;
$$;

revoke all on function public.request_org_bank_account(uuid, uuid, text, text, bytea, text, text, text, uuid, text, public.bank_name_check, text) from public, anon;
grant execute on function public.request_org_bank_account(uuid, uuid, text, text, bytea, text, text, text, uuid, text, public.bank_name_check, text) to authenticated, service_role;

-- As in 20261116214500, plus the bank code and the check from p_worker's `bank_code`,
-- `bank_lookup_id`, `bank_account_digest`, `name_check` and `name_check_reason` keys. Without a
-- lookup (the people import) the request is `not_checked`.
create or replace function public.create_worker(p_worker jsonb, p_pay_rate jsonb default null)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_org uuid;
  r public.workers;
begin
  r := jsonb_populate_record(null::public.workers, p_worker);

  insert into public.workers (
    id, organisation_id, staff_id, first_name, last_name, phone, email, job_title,
    department_id, line_manager_worker_id, line_manager_membership_id, employment_type,
    start_date, nin_enc, tin, tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in,
    annual_rent_declared_kobo, next_of_kin_name, next_of_kin_phone, supervisor_clock_in
  )
  values (
    r.id, r.organisation_id, r.staff_id, r.first_name, r.last_name, r.phone, r.email,
    r.job_title, r.department_id, r.line_manager_worker_id, r.line_manager_membership_id,
    r.employment_type, r.start_date, r.nin_enc, r.tin, r.tax_state, r.pfa_name, r.rsa_pin_enc,
    r.rsa_pin_last4, coalesce(r.nhf_opt_in, false), r.annual_rent_declared_kobo,
    r.next_of_kin_name, r.next_of_kin_phone, coalesce(r.supervisor_clock_in, false)
  )
  returning id, organisation_id into v_id, v_org;

  if num_nulls(r.bank_name, r.account_name, r.bank_account_enc, r.bank_account_last4) = 0 then
    insert into public.bank_detail_changes (
      organisation_id, worker_id, bank_name, account_name, bank_account_enc, bank_account_last4,
      reason, bank_code, bank_lookup_id, bank_account_digest, name_check, name_check_reason
    )
    values (
      v_org, v_id, r.bank_name, r.account_name, r.bank_account_enc, r.bank_account_last4,
      'Bank details for a new employee', r.bank_code,
      nullif(p_worker ->> 'bank_lookup_id', '')::uuid,
      nullif(p_worker ->> 'bank_account_digest', ''),
      nullif(p_worker ->> 'name_check', '')::public.bank_name_check,
      nullif(btrim(p_worker ->> 'name_check_reason'), '')
    );
  end if;

  if p_pay_rate is not null then
    perform public.add_pay_rate(v_org, v_id, p_pay_rate);
  end if;

  return v_id;
end;
$$;

revoke all on function public.create_worker(jsonb, jsonb) from public, anon;
grant execute on function public.create_worker(jsonb, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. The people import raises unchecked bank-detail requests
-- ---------------------------------------------------------------------------

-- A new employee's bank details from an import, as a pending `not_checked` request (the
-- import never looks names up per row; "Check bank details" does later, and approving needs
-- the approver to say how they confirmed it). Definer, so the request is inserted by the
-- function's owner rather than `authenticated`; the bank_detail_changes triggers still take
-- the requester and the role check from the signed-in caller. Only for a worker created in
-- this transaction by the caller's own commit of a checked batch.
create function private.import_bank_change(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_worker_id uuid,
  p_bank_name text,
  p_account_name text,
  p_bank_account_enc bytea,
  p_bank_account_last4 text,
  p_bank_code text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Your role can''t import employees.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.import_batches b
    where b.id = p_batch_id and b.organisation_id = p_organisation_id
      and b.status not in ('uploaded', 'cancelled')
  ) or not exists (
    select 1 from public.workers w
    where w.id = p_worker_id and w.organisation_id = p_organisation_id
      and w.created_at = now()
  ) then
    raise exception 'Bank details from an import go only to employees it is creating.'
      using errcode = '42501';
  end if;
  insert into public.bank_detail_changes (
    organisation_id, worker_id, bank_name, account_name, bank_account_enc, bank_account_last4,
    reason, bank_code
  )
  values (
    p_organisation_id, p_worker_id, p_bank_name, p_account_name, p_bank_account_enc,
    p_bank_account_last4, 'Bank details for a new employee', p_bank_code
  );
end;
$$;

-- As in 20261117180000, except that bank details of a new employee (outside the owner's first
-- import, decision 20) are raised through private.import_bank_change.
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
      -- Slice 2.3b: create_worker no longer takes unchecked bank details from a signed-in
      -- caller, so they go in as a `not_checked` request through the definer function.
      v_worker_id := public.create_worker(
        v_worker - 'bank_name' - 'account_name' - 'bank_account_enc' - 'bank_account_last4'
          - 'bank_code' - 'bank_lookup_id' - 'bank_account_digest' - 'name_check'
          - 'name_check_reason',
        null
      );
      if num_nulls(v_bank.bank_name, v_bank.account_name, v_bank.bank_account_enc,
          v_bank.bank_account_last4) = 0 then
        perform private.import_bank_change(
          p_organisation_id, p_batch_id, v_worker_id, v_bank.bank_name, v_bank.account_name,
          v_bank.bank_account_enc, v_bank.bank_account_last4, v_bank.bank_code
        );
      end if;
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

revoke all on function private.import_bank_change(uuid, uuid, uuid, text, text, bytea, text, text) from public, anon;
grant execute on function private.import_bank_change(uuid, uuid, uuid, text, text, bytea, text, text) to authenticated;
revoke all on function public.commit_import_batch(uuid, uuid, jsonb) from public, anon;
grant execute on function public.commit_import_batch(uuid, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Housekeeping and grants
-- ---------------------------------------------------------------------------

-- Lookups are kept 30 days (the hourly limits need one hour; the rest is the record of who
-- checked what). Requests keep their own copy of the name and the check.
create function private.purge_bank_account_lookups()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.bank_account_lookups l where l.created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

select cron.schedule(
  'purge-bank-account-lookups',
  '17 3 * * *',
  $$select private.purge_bank_account_lookups()$$
);

revoke all on function private.take_bank_account_lookup(uuid, uuid, uuid, public.bank_lookup_purpose, uuid, text, text, text) from public, anon;
-- The worker request trigger runs as the inserting role (see bank_detail_changes_lookup).
grant execute on function private.take_bank_account_lookup(uuid, uuid, uuid, public.bank_lookup_purpose, uuid, text, text, text) to authenticated, service_role;
revoke all on function private.organisation_bank_accounts_lookup() from public, anon, authenticated;
revoke all on function private.bank_detail_changes_lookup() from public, anon, authenticated;
revoke all on function private.bank_request_check_fixed() from public, anon, authenticated;
revoke all on function private.purge_bank_account_lookups() from public, anon, authenticated;
revoke all on function private.test_bank_lookups_allowed() from public, anon;
grant execute on function private.test_bank_lookups_allowed() to authenticated, service_role;
revoke all on function private.worker_check_name(uuid, uuid) from public, anon;
grant execute on function private.worker_check_name(uuid, uuid) to authenticated, service_role;

revoke all on function private.begin_bank_account_lookup(uuid, uuid, public.bank_lookup_purpose, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function private.begin_bank_account_lookup(uuid, uuid, public.bank_lookup_purpose, uuid, text, text, text, text) to service_role;
revoke all on function private.finish_bank_account_lookup(uuid, public.bank_lookup_status, text, text) from public, anon, authenticated;
grant execute on function private.finish_bank_account_lookup(uuid, public.bank_lookup_status, text, text) to service_role;
revoke all on function public.begin_bank_account_lookup(uuid, uuid, public.bank_lookup_purpose, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_bank_account_lookup(uuid, uuid, public.bank_lookup_purpose, uuid, text, text, text, text) to service_role;
revoke all on function public.finish_bank_account_lookup(uuid, public.bank_lookup_status, text, text) from public, anon, authenticated;
grant execute on function public.finish_bank_account_lookup(uuid, public.bank_lookup_status, text, text) to service_role;
