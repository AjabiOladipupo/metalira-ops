-- Slice U.4: self-onboarding invites (owner request, 25 Nov 2026; plan in docs/U4_SELF_ONBOARDING.md).
--
-- The owner or HR types an email and picks ONE role (HR, finance, ops manager, line manager,
-- supervisor, guard or cleaner). The invitee opens the emailed link, fills in their own details
-- and sends them. Nothing is active until the owner or HR approves; approval creates the
-- membership (manager roles) and/or the worker (worker roles, or a manager also paid through
-- payroll) with the role the invite fixed.
--
-- 1. workers.date_of_birth and workers.home_address (nullable), so self-entered details survive.
-- 2. public.onboarding_invites: one row per invite. Token: 256 random bits, only its SHA-256 kept,
--    7 days, single use (submitting ends it), a resend replaces it. The role, company, department,
--    line manager and "also on payroll" are the inviter's and never change (guard, ENABLE ALWAYS).
--    The invitee's NIN, RSA PIN, NHF number and account number arrive encrypted by the server for
--    this row (src/server/crypto/pii.ts) with their last 4 for display; approval and cancelling
--    clear them. No row audit trigger (it would copy the submission): the functions write
--    `onboarding.*` audit rows with ids only, and public.log_audit refuses those names.
-- 3. private.onboarding_attempts: hashed keys for the public endpoints' limits.
-- 4. Functions, each definer with an empty search_path behind a public wrapper:
--    create / resend / cancel (owner or HR of the company the server passes from the verified
--    session, trusted session only), lookup and submit (the server's secret key only: the visitor
--    is signed out or is the invited manager, whom the server has verified), approve (owner or HR,
--    trusted session), the emails-sent count for "N of 30 left", and the attempt limiter.
-- 5. worker_consents accept channel 'onboarding' (the consent the invitee ticked, recorded at
--    approval with the time they ticked it and the notice version they saw).
-- 6. public.log_audit (5.10's version) also refuses `onboarding.%`.
--
-- Bank details (CLAUDE.md rule 10): the invitee's account becomes, at approval, a pending
-- `not_checked` bank-detail change raised by the approver (as the people import raises them). The
-- approver is its requester, so the existing rules stop them approving it; a second person (owner,
-- HR or finance) approves it, giving the note the database asks for on an unchecked account (MLBLC).
--
-- Refusals:
--   MLSO1 the address can't be invited here (already a member, a worker's sign-in, or an employee
--         with this email)
--   MLSO2 an invite for this address is already open (resend or cancel it)
--   MLSO3 this invite has already been used
--   MLSO4 this invite has expired
--   MLSO5 this invite was cancelled
--   MLSO6 not in a state for this action (resend a submitted invite, approve an unsubmitted one)
--   MLSO7 the signed-in account isn't the invited address, or isn't confirmed
--   MLSO8 an invite is never edited or deleted outside these functions
--   MLSO9 too many invites in 24 hours (50 a company)
--   42501 role or untrusted session; 22023 bad input; P0002 not in this company

-- ---------------------------------------------------------------------------
-- 0. Shared text check
-- ---------------------------------------------------------------------------

-- Plain one-line text of 1 to p_max characters: trimmed, no control characters or angle
-- brackets, no web address, no personal number (private.has_personal_number). Null passes.
create function private.onboarding_text_ok(p_text text, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is null or (
    p_text = btrim(p_text)
    and char_length(p_text) between 1 and p_max
    and p_text !~ '[\x01-\x1f\x7f-\x9f<>]'
    and p_text !~* '(://|www\.)'
    and not private.has_personal_number(p_text)
  )
$$;

revoke all on function private.onboarding_text_ok(text, integer) from public, anon;
-- Column checks call it as whoever writes.
grant execute on function private.onboarding_text_ok(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Two worker details the invitee gives
-- ---------------------------------------------------------------------------

alter table public.workers
  add column date_of_birth date
    constraint workers_date_of_birth_range check (date_of_birth between '1900-01-01' and '2100-12-31'),
  add column home_address text
    constraint workers_home_address_text check (private.onboarding_text_ok(home_address, 300));

comment on column public.workers.date_of_birth is
  'Slice U.4: the date of birth the employee gave at self-onboarding (or HR entered).';
comment on column public.workers.home_address is
  'Slice U.4: the home address the employee gave at self-onboarding (or HR entered). No personal numbers.';

-- ---------------------------------------------------------------------------
-- 2. onboarding_invites
-- ---------------------------------------------------------------------------

create table public.onboarding_invites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  email text not null
    constraint onboarding_invites_email_format check (
      email = lower(btrim(email)) and char_length(email) between 3 and 320
      and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    ),
  role text not null
    constraint onboarding_invites_role_value check (
      role in ('hr', 'finance', 'ops_manager', 'line_manager', 'supervisor', 'guard', 'cleaner')
    ),
  -- Worker roles always; a manager when the inviter ticked "also paid through payroll".
  on_payroll boolean not null default false,
  department_id uuid,
  line_manager_worker_id uuid,
  line_manager_membership_id uuid,
  token_hash text not null
    constraint onboarding_invites_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'sent'
    constraint onboarding_invites_status_value check (
      status in ('sent', 'opened', 'submitted', 'approved', 'cancelled')
    ),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  opened_at timestamptz,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),

  -- The submission. A manager's account (from an email link to `email`).
  user_id uuid references auth.users (id) on delete set null,
  first_name text constraint onboarding_invites_first_name_text check (private.onboarding_text_ok(first_name, 100)),
  last_name text constraint onboarding_invites_last_name_text check (private.onboarding_text_ok(last_name, 100)),
  phone text constraint onboarding_invites_phone_format check (phone ~ '^0(70|80|81|90|91)[0-9]{8}$'),
  date_of_birth date
    constraint onboarding_invites_date_of_birth_range check (date_of_birth between '1900-01-01' and '2100-12-31'),
  home_address text constraint onboarding_invites_home_address_text check (private.onboarding_text_ok(home_address, 300)),
  next_of_kin_name text constraint onboarding_invites_next_of_kin_name_text check (private.onboarding_text_ok(next_of_kin_name, 200)),
  next_of_kin_phone text constraint onboarding_invites_next_of_kin_phone_format check (next_of_kin_phone ~ '^0(70|80|81|90|91)[0-9]{8}$'),
  nin_enc bytea,
  nin_last4 text constraint onboarding_invites_nin_last4 check (nin_last4 ~ '^[0-9]{4}$'),
  pfa_name text constraint onboarding_invites_pfa_name_text check (private.onboarding_text_ok(pfa_name, 200)),
  rsa_pin_enc bytea,
  rsa_pin_last4 text constraint onboarding_invites_rsa_pin_last4 check (rsa_pin_last4 ~ '^[A-Z0-9]{1,4}$'),
  tax_state text constraint onboarding_invites_tax_state_text check (private.onboarding_text_ok(tax_state, 100)),
  nhf_opt_in boolean not null default false,
  nhf_number_enc bytea,
  nhf_number_last4 text constraint onboarding_invites_nhf_last4 check (nhf_number_last4 ~ '^[A-Za-z0-9/-]{1,4}$'),
  annual_rent_declared_kobo bigint
    constraint onboarding_invites_rent_range check (annual_rent_declared_kobo between 0 and 1000000000000000),
  currency text not null default 'NGN' constraint onboarding_invites_currency check (currency = 'NGN'),
  bank_code text constraint onboarding_invites_bank_code_format check (bank_code ~ '^[0-9A-Za-z]{3,10}$'),
  bank_name text constraint onboarding_invites_bank_name_text check (private.onboarding_text_ok(bank_name, 100)),
  account_name text constraint onboarding_invites_account_name_text check (private.onboarding_text_ok(account_name, 200)),
  bank_account_enc bytea,
  bank_account_last4 text constraint onboarding_invites_bank_last4 check (bank_account_last4 ~ '^[0-9]{4}$'),
  -- HMAC of the account number keyed from the personal data key, bound to the company and bank
  -- (src/server/billing/bank-lookup.ts bankAccountDigest), so approval proves the number it
  -- re-encrypts is the one the invitee sent.
  bank_account_digest text constraint onboarding_invites_bank_digest check (bank_account_digest ~ '^[0-9a-f]{64}$'),
  location_consent_version text constraint onboarding_invites_location_version check (location_consent_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  location_consent_at timestamptz,
  selfie_consent_version text constraint onboarding_invites_selfie_version check (selfie_consent_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  selfie_consent_at timestamptz,

  -- What approval created.
  worker_id uuid,
  membership_id uuid,

  constraint onboarding_invites_organisation_id_id_key unique (organisation_id, id),
  constraint onboarding_invites_token_hash_key unique (token_hash),
  constraint onboarding_invites_department_fkey foreign key (organisation_id, department_id)
    references public.departments (organisation_id, id),
  constraint onboarding_invites_line_manager_worker_fkey foreign key (organisation_id, line_manager_worker_id)
    references public.workers (organisation_id, id),
  constraint onboarding_invites_line_manager_membership_fkey foreign key (organisation_id, line_manager_membership_id)
    references public.memberships (organisation_id, id),
  constraint onboarding_invites_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint onboarding_invites_one_line_manager check (
    num_nonnulls(line_manager_worker_id, line_manager_membership_id) <= 1
  ),
  constraint onboarding_invites_worker_roles_on_payroll check (
    on_payroll or role in ('hr', 'finance', 'ops_manager', 'line_manager')
  ),
  constraint onboarding_invites_pii_pairs check (
    (nin_enc is null) = (nin_last4 is null)
    and (rsa_pin_enc is null) = (rsa_pin_last4 is null)
    and (nhf_number_enc is null) = (nhf_number_last4 is null)
    and (bank_account_enc is null) = (bank_account_last4 is null)
    and (bank_account_enc is null) = (bank_account_digest is null)
    and (bank_account_enc is null or num_nulls(bank_code, bank_name, account_name) = 0)
  )
);

create unique index onboarding_invites_one_open_key
  on public.onboarding_invites (organisation_id, email)
  where status in ('sent', 'opened', 'submitted');
create index onboarding_invites_org_idx on public.onboarding_invites (organisation_id, sent_at desc);

comment on table public.onboarding_invites is
  'Self-onboarding invites (slice U.4): the role is fixed by the inviter; the invitee sends their own details; owner or HR approves. Written only by the self-onboarding functions; personal data encrypted per row and cleared on approval or cancel. token_hash is SHA-256 (hex) of the token; the token itself is never stored.';

alter table public.onboarding_invites enable row level security;

create policy onboarding_invites_select on public.onboarding_invites
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr'])));

revoke all on table public.onboarding_invites from anon, authenticated, service_role;
grant select on table public.onboarding_invites to authenticated, service_role;

-- Never deleted or truncated. What the inviter chose never changes, and the status only moves
-- forward: sent/opened -> sent (resend), sent -> opened, sent/opened -> submitted,
-- submitted -> approved, sent/opened/submitted -> cancelled. Approved and cancelled are final.
-- For every role, the secret key and the database owner too.
create function private.onboarding_invites_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'An onboarding invite is never deleted. Cancel it instead.' using errcode = 'MLSO8';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'sent' or new.user_id is not null or new.worker_id is not null
      or new.membership_id is not null or new.submitted_at is not null then
      raise exception 'A new onboarding invite starts unsent and empty.' using errcode = 'MLSO8';
    end if;
    new.created_at := now();
    return new;
  end if;
  if (new.id, new.organisation_id, new.email, new.role, new.on_payroll, new.department_id,
      new.line_manager_worker_id, new.line_manager_membership_id, new.created_by, new.created_at)
    is distinct from
     (old.id, old.organisation_id, old.email, old.role, old.on_payroll, old.department_id,
      old.line_manager_worker_id, old.line_manager_membership_id, old.created_by, old.created_at) then
    raise exception 'The role and choices of an invite never change. Cancel it and send a new one.'
      using errcode = 'MLSO8';
  end if;
  if old.status in ('approved', 'cancelled') then
    raise exception 'This invite is closed.' using errcode = 'MLSO8';
  end if;
  if not (
    (old.status = new.status and old.status in ('sent', 'opened', 'submitted'))
    or (old.status in ('sent', 'opened') and new.status in ('sent', 'opened', 'submitted', 'cancelled'))
    or (old.status = 'submitted' and new.status in ('approved', 'cancelled'))
  ) then
    raise exception 'That isn''t a step this invite can take.' using errcode = 'MLSO8';
  end if;
  return new;
end;
$$;

revoke all on function private.onboarding_invites_guard() from public, anon, authenticated;

create trigger onboarding_invites_guard
  before insert or update or delete on public.onboarding_invites
  for each row execute function private.onboarding_invites_guard();
alter table public.onboarding_invites enable always trigger onboarding_invites_guard;

create function private.onboarding_invites_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Onboarding invites are never deleted.' using errcode = 'MLSO8';
end;
$$;

revoke all on function private.onboarding_invites_no_truncate() from public, anon, authenticated;

create trigger onboarding_invites_no_truncate
  before truncate on public.onboarding_invites
  for each statement execute function private.onboarding_invites_no_truncate();
alter table public.onboarding_invites enable always trigger onboarding_invites_no_truncate;

-- ---------------------------------------------------------------------------
-- 3. Limits on the public endpoints
-- ---------------------------------------------------------------------------

create table private.onboarding_attempts (
  id bigint generated always as identity primary key,
  key text not null constraint onboarding_attempts_key_length check (char_length(key) between 8 and 200),
  at timestamptz not null default now()
);
create index onboarding_attempts_key_idx on private.onboarding_attempts (key, at);
revoke all on table private.onboarding_attempts from public, anon, authenticated, service_role;

-- Records one attempt under each key unless one of them reached its cap in the last hour.
-- Keys: 'submit:<hash>' (a token's submits and email links, 10 an hour), 'ip:<hash>' (30 an
-- hour), 'view:<hash>' (page views from one address, 120 an hour). Server secret key only.
create function private.onboarding_attempt_allowed(p_keys text[])
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
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 4 then
    raise exception 'give one to four keys' using errcode = '22023';
  end if;
  foreach k in array p_keys loop
    perform pg_advisory_xact_lock(hashtextextended('onboarding_attempt:' || k, 0));
  end loop;
  foreach k in array p_keys loop
    v_cap := case split_part(k, ':', 1) when 'ip' then 30 when 'view' then 120 else 10 end;
    if (
      select count(*) from private.onboarding_attempts a
      where a.key = k and a.at > now() - interval '1 hour'
    ) >= v_cap then
      return false;
    end if;
  end loop;
  insert into private.onboarding_attempts (key) select unnest(p_keys);
  delete from private.onboarding_attempts a where a.at < now() - interval '1 day';
  return true;
end;
$$;

revoke all on function private.onboarding_attempt_allowed(text[]) from public, anon, authenticated;
grant execute on function private.onboarding_attempt_allowed(text[]) to service_role;

create function public.onboarding_attempt_allowed(p_keys text[])
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.onboarding_attempt_allowed(p_keys)
$$;

revoke all on function public.onboarding_attempt_allowed(text[]) from public, anon, authenticated;
grant execute on function public.onboarding_attempt_allowed(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------

-- The caller is the owner or HR of p_organisation_id with a trusted session. Returns their id.
create function private.onboarding_assert_staff(p_organisation_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
begin
  if v_uid is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'hr']) then
    raise exception 'Only the owner or HR can onboard people.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function private.onboarding_assert_staff(uuid) from public, anon, authenticated;

-- Manager roles become memberships; the others are worker job titles.
create function private.onboarding_is_manager_role(p_role text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role in ('hr', 'finance', 'ops_manager', 'line_manager')
$$;

revoke all on function private.onboarding_is_manager_role(text) from public, anon, authenticated;

create function private.onboarding_job_title(p_role text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'supervisor' then 'Supervisor'
    when 'guard' then 'Guard'
    when 'cleaner' then 'Cleaner'
    when 'hr' then 'HR'
    when 'finance' then 'Finance'
    when 'ops_manager' then 'Operations manager'
    when 'line_manager' then 'Line manager'
  end
$$;

revoke all on function private.onboarding_job_title(text) from public, anon, authenticated;

-- Refuses (MLSO1) an address that is already a member of the company, a worker's sign-in
-- anywhere, or an active employee's email here.
create function private.onboarding_assert_address(p_organisation_id uuid, p_email text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_email like '%.invalid' or exists (
    select 1 from auth.users u
    where lower(u.email) = p_email and u.raw_app_meta_data ->> 'login' = 'worker'
  ) or exists (
    select 1 from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organisation_id = p_organisation_id and lower(u.email) = p_email
  ) or exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.status = 'active' and lower(w.email) = p_email
  ) then
    raise exception 'This address already belongs to someone in the company.' using errcode = 'MLSO1';
  end if;
end;
$$;

revoke all on function private.onboarding_assert_address(uuid, text) from public, anon, authenticated;

-- Writes an `onboarding.*` audit row: ids and the role only, never personal data.
create function private.onboarding_audit(
  p_organisation_id uuid,
  p_actor uuid,
  p_action text,
  p_invite_id uuid,
  p_after jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, after)
  values (p_organisation_id, p_actor, p_action, 'onboarding_invites', p_invite_id, p_after)
$$;

revoke all on function private.onboarding_audit(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Clears the submission's personal data (names stay, for the list).
create function private.onboarding_clear_personal(p_invite_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.onboarding_invites i
  set phone = null, date_of_birth = null, home_address = null, next_of_kin_name = null,
      next_of_kin_phone = null, nin_enc = null, nin_last4 = null, pfa_name = null,
      rsa_pin_enc = null, rsa_pin_last4 = null, tax_state = null, nhf_number_enc = null,
      nhf_number_last4 = null, annual_rent_declared_kobo = null, bank_code = null,
      bank_name = null, account_name = null, bank_account_enc = null, bank_account_last4 = null,
      bank_account_digest = null
  where i.id = p_invite_id
$$;

revoke all on function private.onboarding_clear_personal(uuid) from public, anon, authenticated;

-- 4a. Create
create function private.create_self_onboarding_invite(
  p_organisation_id uuid,
  p_email text,
  p_role text,
  p_on_payroll boolean,
  p_department_id uuid,
  p_line_manager_worker_id uuid,
  p_line_manager_membership_id uuid
)
returns table (invite_id uuid, token text, invite_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.onboarding_assert_staff(p_organisation_id);
  v_email text := lower(btrim(p_email));
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if p_role is null or p_role not in (
    'hr', 'finance', 'ops_manager', 'line_manager', 'supervisor', 'guard', 'cleaner'
  ) then
    raise exception 'Choose HR, finance, operations manager, line manager, supervisor, guard or cleaner.'
      using errcode = '22023';
  end if;
  -- Security review H1: manager roles are the owner's to grant (HR and finance are owner-only
  -- roles since 20261119110100, and HR can't make managers today). HR onboards worker roles only.
  if private.onboarding_is_manager_role(p_role)
    and not private.has_role(p_organisation_id, array['owner']) then
    raise exception 'Only the owner can invite managers. HR invites supervisors, guards and cleaners.'
      using errcode = '42501';
  end if;
  if v_email is null or char_length(v_email) not between 3 and 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if p_line_manager_worker_id is not null and p_line_manager_membership_id is not null then
    raise exception 'Choose one line manager.' using errcode = '22023';
  end if;
  if p_department_id is not null and not exists (
    select 1 from public.departments d
    where d.organisation_id = p_organisation_id and d.id = p_department_id
  ) then
    raise exception 'That department wasn''t found.' using errcode = 'P0002';
  end if;
  if p_line_manager_worker_id is not null and not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = p_line_manager_worker_id
      and w.status = 'active'
  ) then
    raise exception 'That line manager wasn''t found.' using errcode = 'P0002';
  end if;
  if p_line_manager_membership_id is not null and not exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id and m.id = p_line_manager_membership_id
      and m.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
  ) then
    raise exception 'That line manager wasn''t found.' using errcode = 'P0002';
  end if;

  perform private.onboarding_assert_address(p_organisation_id, v_email);

  -- One company's sends queue here, so the daily count holds.
  perform pg_advisory_xact_lock(hashtextextended('onboarding_invites:' || p_organisation_id::text, 0));
  if (
    select count(*) from public.onboarding_invites i
    where i.organisation_id = p_organisation_id and i.sent_at > now() - interval '24 hours'
  ) >= 50 then
    raise exception 'Your company has sent 50 onboarding invites in 24 hours. Try again tomorrow.'
      using errcode = 'MLSO9';
  end if;
  if exists (
    select 1 from public.onboarding_invites i
    where i.organisation_id = p_organisation_id and i.email = v_email
      and i.status in ('sent', 'opened', 'submitted')
  ) then
    raise exception 'An invite for this address is already open. Resend or cancel it.'
      using errcode = 'MLSO2';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.onboarding_invites (
    organisation_id, email, role, on_payroll, department_id, line_manager_worker_id,
    line_manager_membership_id, token_hash, created_by
  )
  values (
    p_organisation_id, v_email, p_role,
    coalesce(p_on_payroll, false) or not private.onboarding_is_manager_role(p_role),
    p_department_id, p_line_manager_worker_id, p_line_manager_membership_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid
  )
  returning id, expires_at into v_id, v_expires;

  perform private.onboarding_audit(
    p_organisation_id, v_uid, 'onboarding.invited', v_id, jsonb_build_object('role', p_role)
  );
  return query select v_id, v_token, v_expires;
end;
$$;

revoke all on function private.create_self_onboarding_invite(uuid, text, text, boolean, uuid, uuid, uuid)
  from public, anon;
grant execute on function private.create_self_onboarding_invite(uuid, text, text, boolean, uuid, uuid, uuid)
  to authenticated;

create function public.create_self_onboarding_invite(
  p_organisation_id uuid,
  p_email text,
  p_role text,
  p_on_payroll boolean default false,
  p_department_id uuid default null,
  p_line_manager_worker_id uuid default null,
  p_line_manager_membership_id uuid default null
)
returns table (invite_id uuid, token text, invite_expires_at timestamptz)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.create_self_onboarding_invite(
    p_organisation_id, p_email, p_role, p_on_payroll, p_department_id, p_line_manager_worker_id,
    p_line_manager_membership_id
  )
$$;

revoke all on function public.create_self_onboarding_invite(uuid, text, text, boolean, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.create_self_onboarding_invite(uuid, text, text, boolean, uuid, uuid, uuid)
  to authenticated;

-- 4b. Resend: a new token and 7 more days for an invite nobody has submitted. The old link stops.
create function private.resend_self_onboarding_invite(p_organisation_id uuid, p_invite_id uuid)
returns table (token text, invite_email text, invite_role text, invite_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.onboarding_assert_staff(p_organisation_id);
  inv public.onboarding_invites%rowtype;
  v_token text;
  v_expires timestamptz;
begin
  select * into inv
  from public.onboarding_invites i
  where i.organisation_id = p_organisation_id and i.id = p_invite_id
  for update;
  if not found then
    raise exception 'That invite wasn''t found.' using errcode = 'P0002';
  end if;
  if inv.status not in ('sent', 'opened') then
    raise exception 'Only an invite nobody has sent details for can be sent again.' using errcode = 'MLSO6';
  end if;
  if private.onboarding_is_manager_role(inv.role)
    and not private.has_role(p_organisation_id, array['owner']) then
    raise exception 'Only the owner can send a manager invite.' using errcode = '42501';
  end if;
  perform private.onboarding_assert_address(p_organisation_id, inv.email);

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  update public.onboarding_invites i
  set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
      status = 'sent',
      sent_at = now(),
      opened_at = null,
      expires_at = now() + interval '7 days'
  where i.id = inv.id
  returning i.expires_at into v_expires;

  perform private.onboarding_audit(
    p_organisation_id, v_uid, 'onboarding.resent', inv.id, jsonb_build_object('role', inv.role)
  );
  return query select v_token, inv.email, inv.role, v_expires;
end;
$$;

revoke all on function private.resend_self_onboarding_invite(uuid, uuid) from public, anon;
grant execute on function private.resend_self_onboarding_invite(uuid, uuid) to authenticated;

create function public.resend_self_onboarding_invite(p_organisation_id uuid, p_invite_id uuid)
returns table (token text, invite_email text, invite_role text, invite_expires_at timestamptz)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.resend_self_onboarding_invite(p_organisation_id, p_invite_id)
$$;

revoke all on function public.resend_self_onboarding_invite(uuid, uuid) from public, anon;
grant execute on function public.resend_self_onboarding_invite(uuid, uuid) to authenticated;

-- 4c. Cancel: the link stops working and any details sent are cleared.
create function private.cancel_self_onboarding_invite(p_organisation_id uuid, p_invite_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.onboarding_assert_staff(p_organisation_id);
  inv public.onboarding_invites%rowtype;
begin
  select * into inv
  from public.onboarding_invites i
  where i.organisation_id = p_organisation_id and i.id = p_invite_id
  for update;
  if not found then
    raise exception 'That invite wasn''t found.' using errcode = 'P0002';
  end if;
  if inv.status not in ('sent', 'opened', 'submitted') then
    raise exception 'This invite is already closed.' using errcode = 'MLSO6';
  end if;
  perform private.onboarding_clear_personal(inv.id);
  update public.onboarding_invites i
  set status = 'cancelled', decided_at = now(), decided_by = v_uid
  where i.id = inv.id;
  perform private.onboarding_audit(
    p_organisation_id, v_uid, 'onboarding.cancelled', inv.id,
    jsonb_build_object('role', inv.role, 'was', inv.status)
  );
end;
$$;

revoke all on function private.cancel_self_onboarding_invite(uuid, uuid) from public, anon;
grant execute on function private.cancel_self_onboarding_invite(uuid, uuid) to authenticated;

create function public.cancel_self_onboarding_invite(p_organisation_id uuid, p_invite_id uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.cancel_self_onboarding_invite(p_organisation_id, p_invite_id)
$$;

revoke all on function public.cancel_self_onboarding_invite(uuid, uuid) from public, anon;
grant execute on function public.cancel_self_onboarding_invite(uuid, uuid) to authenticated;

-- 4d. Lookup (secret key only): what the invite page needs. Holding the token entitles the
-- visitor to the company name and the role; the server keeps the rest. state: pending,
-- submitted, approved, cancelled or expired. No row for an unknown token. p_mark_opened moves a
-- sent invite to opened.
create function private.self_onboarding_lookup(p_token text, p_mark_opened boolean)
returns table (
  invite_id uuid,
  organisation_id uuid,
  organisation_name text,
  email text,
  role text,
  on_payroll boolean,
  state text,
  user_id uuid,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inv public.onboarding_invites%rowtype;
  v_state text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select * into inv
  from public.onboarding_invites i
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found then
    return;
  end if;
  v_state := case
    when inv.status in ('sent', 'opened') and inv.expires_at <= now() then 'expired'
    when inv.status in ('sent', 'opened') then 'pending'
    else inv.status
  end;
  if v_state = 'pending' and inv.status = 'sent' and coalesce(p_mark_opened, false) then
    update public.onboarding_invites i
    set status = 'opened', opened_at = now()
    where i.id = inv.id and i.status = 'sent';
  end if;
  return query
  select inv.id, inv.organisation_id, o.name, inv.email, inv.role, inv.on_payroll, v_state,
    inv.user_id, inv.expires_at
  from public.organisations o
  where o.id = inv.organisation_id;
end;
$$;

revoke all on function private.self_onboarding_lookup(text, boolean) from public, anon, authenticated;
grant execute on function private.self_onboarding_lookup(text, boolean) to service_role;

create function public.self_onboarding_lookup(p_token text, p_mark_opened boolean default false)
returns table (
  invite_id uuid,
  organisation_id uuid,
  organisation_name text,
  email text,
  role text,
  on_payroll boolean,
  state text,
  user_id uuid,
  expires_at timestamptz
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.self_onboarding_lookup(p_token, p_mark_opened)
$$;

revoke all on function public.self_onboarding_lookup(text, boolean) from public, anon, authenticated;
grant execute on function public.self_onboarding_lookup(text, boolean) to service_role;

-- 4e. Submit (secret key only, after the server checked the visitor). The role, company and
-- the inviter's choices stay the invite's: only the listed detail keys are read, never a role.
-- A manager role needs p_user_id, whose confirmed sign-in address must be the invite's and who
-- isn't a worker's sign-in or already in the company. Encrypted values arrive as bytea hex
-- ("\x...") made by the server for this invite row. Ends the token.
create function private.submit_self_onboarding(p_token text, p_user_id uuid, p_details jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inv public.onboarding_invites%rowtype;
  v_manager boolean;
  v_employee boolean;
  v_email text;
  v_confirmed timestamptz;
  v_login text;
  d jsonb := coalesce(p_details, '{}'::jsonb);
  v_rent bigint;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'This invite link is not valid.' using errcode = '22023';
  end if;
  if jsonb_typeof(d) <> 'object' then
    raise exception 'Send the details as an object.' using errcode = '22023';
  end if;
  select * into inv
  from public.onboarding_invites i
  where i.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if not found then
    raise exception 'This invite link is not valid.' using errcode = '22023';
  end if;
  if inv.status in ('submitted', 'approved') then
    raise exception 'This invite has already been used.' using errcode = 'MLSO3';
  end if;
  if inv.status = 'cancelled' then
    raise exception 'This invite was cancelled.' using errcode = 'MLSO5';
  end if;
  if inv.expires_at <= now() then
    raise exception 'This invite has expired.' using errcode = 'MLSO4';
  end if;

  v_manager := private.onboarding_is_manager_role(inv.role);
  if v_manager then
    if p_user_id is null then
      raise exception 'Create your account first.' using errcode = 'MLSO7';
    end if;
    select lower(u.email), u.email_confirmed_at, u.raw_app_meta_data ->> 'login'
    into v_email, v_confirmed, v_login
    from auth.users u
    where u.id = p_user_id;
    if v_email is distinct from inv.email or v_confirmed is null or v_login = 'worker' then
      raise exception 'This invite is for a different email address.' using errcode = 'MLSO7';
    end if;
    if exists (
      select 1 from public.memberships m
      where m.organisation_id = inv.organisation_id and m.user_id = p_user_id
    ) then
      raise exception 'You are already a member of this company.' using errcode = 'MLSO1';
    end if;
  elsif p_user_id is not null then
    raise exception 'A worker''s details are sent without an account.' using errcode = '22023';
  end if;
  -- Employee details: every worker role, and a manager the company also pays through payroll.
  v_employee := inv.on_payroll;

  if nullif(btrim(d ->> 'first_name'), '') is null or nullif(btrim(d ->> 'last_name'), '') is null
    or nullif(btrim(d ->> 'phone'), '') is null then
    raise exception 'Enter your name and phone number.' using errcode = '22023';
  end if;
  if (d ? 'location_consent_version' and not private.consent_notice_known('location', d ->> 'location_consent_version'))
    or (d ? 'selfie_consent_version' and not private.consent_notice_known('selfie', d ->> 'selfie_consent_version')) then
    raise exception 'That consent notice isn''t one we know.' using errcode = '22023';
  end if;
  begin
    v_rent := nullif(d ->> 'annual_rent_declared_kobo', '')::bigint;
  exception when others then
    raise exception 'Enter the rent in whole kobo.' using errcode = '22023';
  end;

  update public.onboarding_invites i
  set status = 'submitted',
      submitted_at = now(),
      user_id = case when v_manager then p_user_id end,
      first_name = btrim(d ->> 'first_name'),
      last_name = btrim(d ->> 'last_name'),
      phone = btrim(d ->> 'phone'),
      date_of_birth = case when v_employee then nullif(d ->> 'date_of_birth', '')::date end,
      home_address = case when v_employee then nullif(btrim(d ->> 'home_address'), '') end,
      next_of_kin_name = case when v_employee then nullif(btrim(d ->> 'next_of_kin_name'), '') end,
      next_of_kin_phone = case when v_employee then nullif(btrim(d ->> 'next_of_kin_phone'), '') end,
      nin_enc = case when v_employee then nullif(d ->> 'nin_enc', '')::bytea end,
      nin_last4 = case when v_employee then nullif(d ->> 'nin_last4', '') end,
      pfa_name = case when v_employee then nullif(btrim(d ->> 'pfa_name'), '') end,
      rsa_pin_enc = case when v_employee then nullif(d ->> 'rsa_pin_enc', '')::bytea end,
      rsa_pin_last4 = case when v_employee then nullif(d ->> 'rsa_pin_last4', '') end,
      tax_state = case when v_employee then nullif(btrim(d ->> 'tax_state'), '') end,
      nhf_opt_in = v_employee and coalesce((d ->> 'nhf_opt_in')::boolean, false),
      nhf_number_enc = case when v_employee then nullif(d ->> 'nhf_number_enc', '')::bytea end,
      nhf_number_last4 = case when v_employee then nullif(d ->> 'nhf_number_last4', '') end,
      annual_rent_declared_kobo = case when v_employee then v_rent end,
      bank_code = case when v_employee then nullif(d ->> 'bank_code', '') end,
      bank_name = case when v_employee then nullif(btrim(d ->> 'bank_name'), '') end,
      account_name = case when v_employee then nullif(btrim(d ->> 'account_name'), '') end,
      bank_account_enc = case when v_employee then nullif(d ->> 'bank_account_enc', '')::bytea end,
      bank_account_last4 = case when v_employee then nullif(d ->> 'bank_account_last4', '') end,
      bank_account_digest = case when v_employee then nullif(d ->> 'bank_account_digest', '') end,
      location_consent_version = case when v_employee then nullif(d ->> 'location_consent_version', '') end,
      location_consent_at = case when v_employee and nullif(d ->> 'location_consent_version', '') is not null then now() end,
      selfie_consent_version = case when v_employee then nullif(d ->> 'selfie_consent_version', '') end,
      selfie_consent_at = case when v_employee and nullif(d ->> 'selfie_consent_version', '') is not null then now() end
  where i.id = inv.id;

  perform private.onboarding_audit(
    inv.organisation_id, case when v_manager then p_user_id end, 'onboarding.submitted', inv.id,
    jsonb_build_object('role', inv.role)
  );
  return inv.id;
end;
$$;

revoke all on function private.submit_self_onboarding(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function private.submit_self_onboarding(text, uuid, jsonb) to service_role;

create function public.submit_self_onboarding(p_token text, p_user_id uuid, p_details jsonb)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.submit_self_onboarding(p_token, p_user_id, p_details)
$$;

revoke all on function public.submit_self_onboarding(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.submit_self_onboarding(text, uuid, jsonb) to service_role;

-- 4f. Approve (owner or HR, trusted session). Creates what the invite's role says, with the
-- invitee's own details from the row. From the caller it takes only what the database can't make
-- without the key or what is HR's to decide: the worker id, staff ID, employment type and start
-- date, the pay rate (owner or HR, through create_worker / add_pay_rate), and the personal
-- numbers re-encrypted for their new rows (p_worker nin_enc and rsa_pin_enc, p_bank_account_enc,
-- p_nhf_id / p_nhf_enc). The job title, email, department and line manager come from the invite.
create function private.approve_self_onboarding(
  p_organisation_id uuid,
  p_invite_id uuid,
  p_worker jsonb,
  p_pay_rate jsonb,
  p_bank_account_enc bytea,
  p_nhf_id uuid,
  p_nhf_enc bytea
)
returns table (worker_id uuid, membership_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.onboarding_assert_staff(p_organisation_id);
  inv public.onboarding_invites%rowtype;
  v_worker uuid;
  v_membership uuid;
  v_login text;
  v_email text;
  v_confirmed timestamptz;
  v_supervisor boolean;
begin
  select * into inv
  from public.onboarding_invites i
  where i.organisation_id = p_organisation_id and i.id = p_invite_id
  for update;
  if not found then
    raise exception 'That invite wasn''t found.' using errcode = 'P0002';
  end if;
  if inv.status <> 'submitted' then
    raise exception 'Only details that were sent and not yet decided can be approved.'
      using errcode = 'MLSO6';
  end if;

  -- The membership, with the invite's role.
  -- Security review H1, checked again here: the approver may not be who sent the invite.
  if private.onboarding_is_manager_role(inv.role)
    and not private.has_role(p_organisation_id, array['owner']) then
    raise exception 'Only the owner can approve a manager.' using errcode = '42501';
  end if;

  if private.onboarding_is_manager_role(inv.role) then
    -- Security review L3: still the invited, confirmed address and no worker's sign-in.
    select u.raw_app_meta_data ->> 'login', lower(u.email), u.email_confirmed_at
    into v_login, v_email, v_confirmed
    from auth.users u where u.id = inv.user_id;
    if inv.user_id is null or not found or v_login = 'worker'
      or v_email is distinct from inv.email or v_confirmed is null then
      raise exception 'This person''s account is no longer valid. Cancel the invite and send a new one.'
        using errcode = 'MLSO7';
    end if;
    if exists (
      select 1 from public.memberships m
      where m.organisation_id = p_organisation_id and m.user_id = inv.user_id
    ) then
      raise exception 'This person is already a member of your company.' using errcode = 'MLSO1';
    end if;
    insert into public.memberships (organisation_id, user_id, role, created_by)
    values (p_organisation_id, inv.user_id, inv.role::public.membership_role, v_uid)
    returning id into v_membership;
  end if;

  -- The worker, when the role pays them through payroll.
  if inv.on_payroll then
    if p_worker is null or jsonb_typeof(p_worker) <> 'object'
      or nullif(p_worker ->> 'id', '') is null then
      raise exception 'Give the employee''s start date and employment type.' using errcode = '22023';
    end if;
    if (inv.nin_enc is null) <> (nullif(p_worker ->> 'nin_enc', '') is null)
      or (inv.rsa_pin_enc is null) <> (nullif(p_worker ->> 'rsa_pin_enc', '') is null)
      or (inv.bank_account_enc is null) <> (p_bank_account_enc is null)
      -- Security review L1: the number re-encrypted is the one the invitee sent.
      or (inv.bank_account_enc is not null
        and (p_worker ->> 'bank_account_digest') is distinct from inv.bank_account_digest)
      or (inv.nhf_number_enc is null) <> (p_nhf_enc is null)
      or (p_nhf_enc is null) <> (p_nhf_id is null) then
      raise exception 'The personal numbers sent don''t match the details. Reload and try again.'
        using errcode = '22023';
    end if;
    v_supervisor := exists (
      select 1 from public.workers w
      where w.organisation_id = p_organisation_id and w.status = 'active' and w.phone = inv.phone
    );
    v_worker := public.create_worker(
      jsonb_build_object(
        'id', p_worker ->> 'id',
        'organisation_id', p_organisation_id,
        'staff_id', p_worker ->> 'staff_id',
        'first_name', inv.first_name,
        'last_name', inv.last_name,
        'phone', inv.phone,
        'email', inv.email,
        'job_title', private.onboarding_job_title(inv.role),
        'department_id', inv.department_id,
        'line_manager_worker_id', inv.line_manager_worker_id,
        'line_manager_membership_id', inv.line_manager_membership_id,
        'employment_type', p_worker ->> 'employment_type',
        'start_date', p_worker ->> 'start_date',
        'nin_enc', nullif(p_worker ->> 'nin_enc', ''),
        'tax_state', inv.tax_state,
        'pfa_name', inv.pfa_name,
        'rsa_pin_enc', nullif(p_worker ->> 'rsa_pin_enc', ''),
        'rsa_pin_last4', inv.rsa_pin_last4,
        'nhf_opt_in', inv.nhf_opt_in,
        'annual_rent_declared_kobo', inv.annual_rent_declared_kobo,
        'next_of_kin_name', inv.next_of_kin_name,
        'next_of_kin_phone', inv.next_of_kin_phone,
        'supervisor_clock_in', v_supervisor
      ),
      p_pay_rate
    );
    update public.workers w
    set date_of_birth = inv.date_of_birth, home_address = inv.home_address
    where w.id = v_worker and w.organisation_id = p_organisation_id;

    -- Rule 10: a pending, unchecked request raised by the approver, so a second person decides it.
    if inv.bank_account_enc is not null then
      insert into public.bank_detail_changes (
        organisation_id, worker_id, bank_name, account_name, bank_account_enc,
        bank_account_last4, reason, bank_code
      )
      values (
        p_organisation_id, v_worker, inv.bank_name, inv.account_name, p_bank_account_enc,
        inv.bank_account_last4, 'Bank details the employee gave at self-onboarding', inv.bank_code
      );
    end if;

    if inv.nhf_number_enc is not null then
      perform private.set_payroll_nhf_number(
        p_organisation_id, v_worker, p_nhf_id, p_nhf_enc, inv.nhf_number_last4,
        'Given by the employee at self-onboarding'
      );
    end if;

    if inv.location_consent_version is not null then
      insert into public.worker_consents (
        organisation_id, worker_id, kind, notice_version, accepted_at, channel, created_by
      )
      values (
        p_organisation_id, v_worker, 'location', inv.location_consent_version,
        inv.location_consent_at, 'onboarding', null
      );
    end if;
    if inv.selfie_consent_version is not null then
      insert into public.worker_consents (
        organisation_id, worker_id, kind, notice_version, accepted_at, channel, created_by
      )
      values (
        p_organisation_id, v_worker, 'selfie', inv.selfie_consent_version,
        inv.selfie_consent_at, 'onboarding', null
      );
    end if;
  end if;

  perform private.onboarding_clear_personal(inv.id);
  update public.onboarding_invites i
  set status = 'approved', decided_at = now(), decided_by = v_uid,
      worker_id = v_worker, membership_id = v_membership
  where i.id = inv.id;

  perform private.onboarding_audit(
    p_organisation_id, v_uid, 'onboarding.approved', inv.id,
    jsonb_build_object('role', inv.role, 'worker_id', v_worker, 'membership_id', v_membership)
  );
  return query select v_worker, v_membership;
end;
$$;

revoke all on function private.approve_self_onboarding(uuid, uuid, jsonb, jsonb, bytea, uuid, bytea)
  from public, anon;
grant execute on function private.approve_self_onboarding(uuid, uuid, jsonb, jsonb, bytea, uuid, bytea)
  to authenticated;

create function public.approve_self_onboarding(
  p_organisation_id uuid,
  p_invite_id uuid,
  p_worker jsonb default null,
  p_pay_rate jsonb default null,
  p_bank_account_enc bytea default null,
  p_nhf_id uuid default null,
  p_nhf_enc bytea default null
)
returns table (worker_id uuid, membership_id uuid)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.approve_self_onboarding(
    p_organisation_id, p_invite_id, p_worker, p_pay_rate, p_bank_account_enc, p_nhf_id, p_nhf_enc
  )
$$;

revoke all on function public.approve_self_onboarding(uuid, uuid, jsonb, jsonb, bytea, uuid, bytea)
  from public, anon;
grant execute on function public.approve_self_onboarding(uuid, uuid, jsonb, jsonb, bytea, uuid, bytea)
  to authenticated;

-- 4g. Emails sent in the last 24 hours (the company's and overall), for "N of 30 emails left".
create function private.self_onboarding_emails_sent(p_organisation_id uuid)
returns table (company integer, overall integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.onboarding_assert_staff(p_organisation_id);
  return query select s.company, s.overall from private.emails_sent_24h(p_organisation_id) s;
end;
$$;

revoke all on function private.self_onboarding_emails_sent(uuid) from public, anon;
grant execute on function private.self_onboarding_emails_sent(uuid) to authenticated;

create function public.self_onboarding_emails_sent(p_organisation_id uuid)
returns table (company integer, overall integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.self_onboarding_emails_sent(p_organisation_id)
$$;

revoke all on function public.self_onboarding_emails_sent(uuid) from public, anon;
grant execute on function public.self_onboarding_emails_sent(uuid) to authenticated;

-- 4h. Submissions nobody decided within 14 days are cancelled and their personal data cleared
-- (security review L4). Server secret key only: the daily bank-detail-changes cron route calls
-- it. Returns how many it closed.
create function private.expire_self_onboarding_submissions()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inv record;
  v_count integer := 0;
begin
  for inv in
    select i.id, i.organisation_id, i.role
    from public.onboarding_invites i
    where i.status = 'submitted' and i.submitted_at < now() - interval '14 days'
    order by i.id
    for update skip locked
  loop
    perform private.onboarding_clear_personal(inv.id);
    update public.onboarding_invites i
    set status = 'cancelled', decided_at = now(), decided_by = null
    where i.id = inv.id;
    perform private.onboarding_audit(
      inv.organisation_id, null, 'onboarding.expired', inv.id, jsonb_build_object('role', inv.role)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.expire_self_onboarding_submissions() from public, anon, authenticated;
grant execute on function private.expire_self_onboarding_submissions() to service_role;

create function public.expire_self_onboarding_submissions()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.expire_self_onboarding_submissions()
$$;

revoke all on function public.expire_self_onboarding_submissions() from public, anon, authenticated;
grant execute on function public.expire_self_onboarding_submissions() to service_role;

-- ---------------------------------------------------------------------------
-- 5. Consents recorded at approval
-- ---------------------------------------------------------------------------

alter table public.worker_consents
  drop constraint worker_consents_channel_value,
  add constraint worker_consents_channel_value check (channel in ('worker_app', 'onboarding'));

-- ---------------------------------------------------------------------------
-- 5b. Date of birth and home address never reach audit_log (security review L5): 20261116090000's
--     private.audit_secret_key with the two parts added (src/server/identity/audit.ts in step).
-- ---------------------------------------------------------------------------

create or replace function private.audit_secret_key(k text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with n as (
    select lower(
      regexp_replace(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'), '[^a-zA-Z0-9]+', '_', 'g')
    ) as key
  )
  select n.key ~ '(_enc$|password|secret)'
    or n.key ~ '(^|_)(nin|bvn|pin|pin_hash|rsa_pin|passwd|passcode|token|token_hash|api_key|apikey|account_number|account_no|bank_account|nuban|otp|date_of_birth|home_address)(_|$)'
  from n
$$;

-- ---------------------------------------------------------------------------
-- 6. public.log_audit refuses onboarding.% (5.10's version, migration 20261122280000, with that
--    one addition marked "Slice U.4"). The grants stand.
-- ---------------------------------------------------------------------------

create or replace function public.log_audit(
  p_organisation_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_action in (
    'payroll.bank_file_downloaded', 'payroll.supplementary_file_downloaded',
    'payroll.instalment_not_carried', 'payroll.results_saved', 'payroll.run_created',
    'payroll.run_submitted', 'payroll.adjustment_added', 'payroll.adjustment_removed',
    'payroll.anomalies_acknowledged', 'payroll.instalment_carried', 'worker_auth.locked',
    'people.bank_details_single_approver',
    -- Slice 5.10.
    'payroll.rent_declared_set'
  )
  -- Slice U.4: only the self-onboarding functions write these.
  or p_action like 'onboarding.%' then
    raise exception 'That audit event is written only by the change it records.'
      using errcode = '42501';
  end if;
  return private.log_audit_impl(
    p_organisation_id, p_action, p_entity, p_entity_id, p_before, p_after, p_reason
  );
end;
$$;
