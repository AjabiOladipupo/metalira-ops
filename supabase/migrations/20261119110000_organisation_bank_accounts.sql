-- Slice 2.3: the company's own collection bank account, with two-person approval and a 72-hour
-- hold.
--
-- The account clients pay invoices into (CLAUDE.md rule 6: customers connect only their own bank
-- account; Metalira never holds or moves money). One table holds both the accounts and the
-- requests to add or change one, because an account is a request that was approved:
--
--   pending ──approve (a second person)──▶ approved ──72 hours──▶ active ──replaced──▶ retired
--      │                                      │
--      ├──reject (a second person)──▶ rejected └──stop during the hold──▶ cancelled
--      └──withdraw (the requester)──▶ cancelled
--
-- * Who (Phase 2 roles table): owner, admin and finance raise a request. An owner or a finance
--   user who is not the requester approves or rejects it (CLAUDE.md rule 10). Enforced three
--   times, as for bank_detail_changes (slice 1.7): the BEFORE UPDATE trigger (clear error), the
--   check constraints `approved_by <> requested_by` and `rejected_by <> requested_by` (hold even
--   for the table owner and the secret key), and RLS and column grants for signed-in users. The
--   secret key can't approve at all: an approval needs a signed-in approver.
-- * The hold: applies_after = decided_at + 72 hours. An approved account becomes `active` only
--   after that, and the account it replaces becomes `retired` in the same transaction. Who moves
--   it: pg_cron every 5 minutes, the app on read, and the daily cron route (which also emails).
--   Invoices must not depend on that timing: public.org_bank_account_as_of(org, at) answers
--   "which account was in force at this moment" from the rows themselves.
-- * First account (owner decision, 19 Nov 2026; mirrors decision 20 for the first import): the
--   FIRST account, added by an owner while company setup is unfinished, becomes active at once
--   with no second approver. Once per company: the organisation row is locked while the trigger
--   decides, a partial unique index allows one such row ever, and it is audited as
--   `billing.bank_account_single_approver`.
-- * Insert-only history: a row's own columns never change after insert and rows are never
--   deleted. Only the status moves forward, and the trigger fills the decision columns itself.
-- * Encryption: bank_account_enc is sealed by the server for this row
--   (organisation, `organisation_bank_accounts`, `bank_account_enc`, row id), so it never moves.
--   The database has no key and can't check that bank_account_last4 belongs to it; the server
--   does on approval and on every reveal (src/server/billing/company-bank.ts).
-- * Who reads what: the table (requests, history, ciphertext) is readable by owner, admin and
--   finance only. Every manager reads the account in force, masked to its last four digits,
--   through public.org_bank_account_masked. The full number is shown only to owner and finance
--   by the server, audited as `pii.reveal`.
-- * Personal data never reaches audit_log in clear: the row audit drops `_enc` and
--   `bank_account*` keys (private.audit_secret_key).
--
-- Refusals: MLOB1 (requester deciding), MLOB3 (hold), MLOB4 (already decided, edited or
-- deleted).

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create type public.org_bank_account_status as enum (
  'pending',
  'approved',
  'active',
  'retired',
  'rejected',
  'cancelled'
);

create table public.organisation_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  -- The signed-in user who raised it (the trigger sets it from the session whatever is sent).
  -- No foreign key, as on audit_log.
  requested_by uuid not null default private.session_uid(),

  bank_name text not null
    constraint organisation_bank_accounts_bank_name_text check (
      bank_name = btrim(bank_name)
      and char_length(bank_name) between 1 and 200
      and bank_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and bank_name !~* '(://|www\.)'
    ),
  account_name text not null
    constraint organisation_bank_accounts_account_name_text check (
      account_name = btrim(account_name)
      and char_length(account_name) between 1 and 200
      and account_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and account_name !~* '(://|www\.)'
    ),
  bank_account_enc bytea not null,
  bank_account_last4 text not null
    constraint organisation_bank_accounts_last4_format check (bank_account_last4 ~ '^[0-9]{4}$'),
  reason text
    constraint organisation_bank_accounts_reason_text check (
      reason = btrim(reason)
      and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),

  -- True only for the first account an owner added alone during setup (set by the trigger).
  single_approver boolean not null default false,

  status public.org_bank_account_status not null default 'pending',
  approved_by uuid,
  rejected_by uuid,
  cancelled_by uuid,
  decided_at timestamptz,
  decision_note text
    constraint organisation_bank_accounts_decision_note_text check (
      decision_note = btrim(decision_note)
      and char_length(decision_note) between 1 and 500
      and decision_note !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  -- When the account takes effect: decided_at + 72 hours (decided_at for the first account).
  applies_after timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  cancelled_at timestamptz,
  -- When owners and finance were told it is in use (set by the server after it emails).
  applied_notified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint organisation_bank_accounts_organisation_id_id_key unique (organisation_id, id),

  -- The two-person rule, for every writer.
  constraint organisation_bank_accounts_second_approver check (approved_by <> requested_by),
  constraint organisation_bank_accounts_second_rejecter check (rejected_by <> requested_by),

  -- Each status carries exactly its decision columns.
  constraint organisation_bank_accounts_status_columns check (
    case status
      when 'pending' then
        not single_approver
        and num_nonnulls(approved_by, rejected_by, cancelled_by, decided_at, applies_after,
          activated_at, retired_at, cancelled_at, applied_notified_at) = 0
      when 'approved' then
        not single_approver
        and approved_by is not null and decided_at is not null
        and applies_after = decided_at + interval '72 hours'
        and num_nonnulls(rejected_by, cancelled_by, activated_at, retired_at, cancelled_at,
          applied_notified_at) = 0
      when 'rejected' then
        not single_approver
        and rejected_by is not null and decided_at is not null
        and num_nonnulls(approved_by, cancelled_by, applies_after, activated_at, retired_at,
          cancelled_at, applied_notified_at) = 0
      when 'cancelled' then
        not single_approver
        and cancelled_by is not null and cancelled_at is not null
        and num_nonnulls(rejected_by, activated_at, retired_at, applied_notified_at) = 0
        and (approved_by is null or cancelled_at < applies_after)
      else
        -- active or retired: it took effect, after two people or as the first account.
        decided_at is not null and applies_after is not null
        and activated_at >= applies_after
        and num_nonnulls(rejected_by, cancelled_by, cancelled_at) = 0
        and (
          (not single_approver and approved_by is not null
            and applies_after = decided_at + interval '72 hours')
          or (single_approver and approved_by is null and applies_after = decided_at)
        )
        and (
          (status = 'active' and retired_at is null)
          or (status = 'retired' and retired_at >= activated_at)
        )
    end
  )
);

-- One account in force per company, one open request (waiting or on hold) per company, and one
-- single-approver first account per company, ever.
create unique index organisation_bank_accounts_one_active_key
  on public.organisation_bank_accounts (organisation_id)
  where status = 'active';
create unique index organisation_bank_accounts_one_open_key
  on public.organisation_bank_accounts (organisation_id)
  where status in ('pending', 'approved');
create unique index organisation_bank_accounts_one_single_approver_key
  on public.organisation_bank_accounts (organisation_id)
  where single_approver;
create index organisation_bank_accounts_history_idx
  on public.organisation_bank_accounts (organisation_id, created_at desc);
create index organisation_bank_accounts_due_idx
  on public.organisation_bank_accounts (applies_after)
  where status = 'approved';
create index organisation_bank_accounts_unnotified_idx
  on public.organisation_bank_accounts (organisation_id)
  where status in ('active', 'retired') and applied_notified_at is null;

comment on table public.organisation_bank_accounts is
  'The company''s own collection bank account and the requests to add or change it: two-person approval, then a 72-hour hold (CLAUDE.md rules 6 and 10). Insert-only history; the status moves forward by trigger-checked updates. bank_account_enc is encrypted for this row.';
comment on column public.organisation_bank_accounts.applies_after is
  'decided_at + 72 hours on approval. Until then invoices use the previous account.';
comment on column public.organisation_bank_accounts.single_approver is
  'The first account, added by an owner alone while company setup was unfinished. Once per company, audited as billing.bank_account_single_approver.';

-- ---------------------------------------------------------------------------
-- 2. Trigger functions
-- ---------------------------------------------------------------------------

-- BEFORE INSERT. A new row is a pending request raised by the caller, except the first account
-- an owner adds during setup, which is active at once. Definer: it reads the caller's roles and
-- locks the organisation row; the role check comes first.
create function private.organisation_bank_accounts_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.session_uid();
  v_completed timestamptz;
  v_first boolean := false;
begin
  -- A signed-in session that isn't trusted (slice 1.13) acts as nobody, never as the server.
  if auth.uid() is not null and v_actor is null then
    raise exception 'Sign in again to change the company bank account.' using errcode = '42501';
  end if;
  if v_actor is not null then
    if not private.has_role(new.organisation_id, array['owner', 'admin', 'finance']) then
      raise exception 'Only an owner, an admin or finance can ask to change the company bank account.'
        using errcode = '42501';
    end if;
    new.requested_by := v_actor;
  end if;
  if new.requested_by is null then
    raise exception 'A bank account request needs the person who raised it.' using errcode = '23502';
  end if;

  new.status := 'pending';
  new.single_approver := false;
  new.approved_by := null;
  new.rejected_by := null;
  new.cancelled_by := null;
  new.decided_at := null;
  new.decision_note := null;
  new.applies_after := null;
  new.activated_at := null;
  new.retired_at := null;
  new.cancelled_at := null;
  new.applied_notified_at := null;
  new.created_at := now();
  new.updated_at := now();

  -- The first account: a signed-in owner, setup unfinished, and no account has ever been
  -- approved or added this way. The row lock makes two requests at once take turns (the second
  -- then sees the first one's row) and stops setup finishing half way through.
  if v_actor is not null and private.has_role(new.organisation_id, array['owner']) then
    select o.setup_completed_at into v_completed
    from public.organisations o
    where o.id = new.organisation_id
    for update;
    v_first := found
      and v_completed is null
      and not exists (
        select 1
        from public.organisation_bank_accounts a
        where a.organisation_id = new.organisation_id
          and (a.single_approver or a.status in ('approved', 'active', 'retired'))
      );
  end if;
  if v_first then
    new.status := 'active';
    new.single_approver := true;
    new.decided_at := now();
    new.applies_after := now();
    new.activated_at := now();
  end if;
  return new;
end;
$$;

-- AFTER INSERT: the first-account exception is always audited, by the database, in the same
-- transaction (the row audit logs the insert itself).
create function private.organisation_bank_accounts_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.single_approver then
    perform private.log_audit_impl(
      new.organisation_id,
      'billing.bank_account_single_approver',
      'organisation_bank_accounts',
      new.id,
      null,
      jsonb_build_object('bank_name', new.bank_name, 'account_name', new.account_name),
      'First company bank account, added by an owner before company setup was finished: no second approver (owner decision, 19 Nov 2026).'
    );
  end if;
  return null;
end;
$$;

-- BEFORE UPDATE. The request itself is fixed; only the status moves, and this function decides
-- whether the move is allowed and fills in who and when. Definer: it reads the caller's roles
-- and the company's other rows.
create function private.organisation_bank_accounts_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.session_uid();
  v_approver boolean;
begin
  if auth.uid() is not null and v_actor is null then
    raise exception 'Sign in again to change the company bank account.' using errcode = '42501';
  end if;
  if (
    new.id, new.organisation_id, new.requested_by, new.bank_name, new.account_name,
    new.bank_account_enc, new.bank_account_last4, new.reason, new.single_approver, new.created_at
  ) is distinct from (
    old.id, old.organisation_id, old.requested_by, old.bank_name, old.account_name,
    old.bank_account_enc, old.bank_account_last4, old.reason, old.single_approver, old.created_at
  ) then
    raise exception 'A bank account request can''t be edited. Reject it and raise a new one.'
      using errcode = 'MLOB4';
  end if;

  if new.status = old.status then
    -- The only change without a status move: marking an account in use as emailed, once.
    if old.status in ('active', 'retired')
      and old.applied_notified_at is null
      and new.applied_notified_at is not null
      and (
        new.approved_by, new.rejected_by, new.cancelled_by, new.decided_at, new.decision_note,
        new.applies_after, new.activated_at, new.retired_at, new.cancelled_at
      ) is not distinct from (
        old.approved_by, old.rejected_by, old.cancelled_by, old.decided_at, old.decision_note,
        old.applies_after, old.activated_at, old.retired_at, old.cancelled_at
      ) then
      return new;
    end if;
    raise exception 'This request has already been decided.' using errcode = 'MLOB4';
  end if;

  -- From here the status moves. Everything but the note is set here, never by the caller.
  new.approved_by := old.approved_by;
  new.rejected_by := old.rejected_by;
  new.cancelled_by := old.cancelled_by;
  new.decided_at := old.decided_at;
  new.applies_after := old.applies_after;
  new.activated_at := old.activated_at;
  new.retired_at := old.retired_at;
  new.cancelled_at := old.cancelled_at;
  new.applied_notified_at := old.applied_notified_at;

  v_approver := v_actor is not null
    and private.has_role(old.organisation_id, array['owner', 'finance']);

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    if not v_approver then
      raise exception 'Only an owner or finance can approve or reject a company bank account.'
        using errcode = '42501';
    end if;
    if v_actor = old.requested_by then
      raise exception 'You raised this request, so someone else must approve or reject it.'
        using errcode = 'MLOB1';
    end if;
    new.decided_at := now();
    if new.status = 'approved' then
      new.approved_by := v_actor;
      new.applies_after := new.decided_at + interval '72 hours';
    else
      new.rejected_by := v_actor;
    end if;

  elsif old.status = 'pending' and new.status = 'cancelled' then
    if v_actor is null or v_actor <> old.requested_by then
      raise exception 'Only the person who raised this request can withdraw it. Reject it instead.'
        using errcode = '42501';
    end if;
    new.cancelled_by := v_actor;
    new.cancelled_at := now();
    new.decision_note := old.decision_note;

  elsif old.status = 'approved' and new.status = 'cancelled' then
    if not v_approver then
      raise exception 'Only an owner or finance can stop an approved bank account change.'
        using errcode = '42501';
    end if;
    if now() >= old.applies_after then
      raise exception 'The 72-hour hold has ended, so this account is in use. Raise a new change instead.'
        using errcode = 'MLOB3';
    end if;
    new.cancelled_by := v_actor;
    new.cancelled_at := now();

  elsif old.status = 'approved' and new.status = 'active' then
    if now() < old.applies_after then
      raise exception 'This account is on hold for 72 hours after approval.' using errcode = 'MLOB3';
    end if;
    new.activated_at := now();
    new.decision_note := old.decision_note;

  elsif old.status = 'active' and new.status = 'retired' then
    -- An account is retired only by the one that replaces it: an approved account of the same
    -- company whose hold has ended (private.apply_due_org_bank_accounts retires, then activates).
    if not exists (
      select 1
      from public.organisation_bank_accounts a
      where a.organisation_id = old.organisation_id
        and a.status = 'approved'
        and a.applies_after <= now()
    ) then
      raise exception 'An account is retired only when an approved account replaces it.'
        using errcode = 'MLOB4';
    end if;
    new.retired_at := now();
    new.decision_note := old.decision_note;

  else
    raise exception 'This request has already been decided.' using errcode = 'MLOB4';
  end if;

  return new;
end;
$$;

-- BEFORE DELETE: accounts and requests are history.
create function private.organisation_bank_accounts_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Company bank accounts are kept as history and can''t be deleted.'
    using errcode = 'MLOB4';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------

create trigger organisation_bank_accounts_before_insert
  before insert on public.organisation_bank_accounts
  for each row execute function private.organisation_bank_accounts_before_insert();
create trigger organisation_bank_accounts_after_insert
  after insert on public.organisation_bank_accounts
  for each row execute function private.organisation_bank_accounts_after_insert();
create trigger organisation_bank_accounts_before_update
  before update on public.organisation_bank_accounts
  for each row execute function private.organisation_bank_accounts_before_update();
create trigger organisation_bank_accounts_set_updated_at
  before update on public.organisation_bank_accounts
  for each row execute function private.set_updated_at();
create trigger organisation_bank_accounts_no_delete
  before delete on public.organisation_bank_accounts
  for each row execute function private.organisation_bank_accounts_no_delete();
create trigger organisation_bank_accounts_audit
  after insert or update or delete on public.organisation_bank_accounts
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants
-- ---------------------------------------------------------------------------
-- Read: owner, admin, finance (the people who raise and decide). Every other manager reads the
-- account in force, masked, through public.org_bank_account_masked. Insert: owner, admin,
-- finance. Update (status moves only, checked by trigger): owner and finance, and the requester
-- (to withdraw). No delete.

alter table public.organisation_bank_accounts enable row level security;

create policy organisation_bank_accounts_select on public.organisation_bank_accounts
  for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance']));

create policy organisation_bank_accounts_insert on public.organisation_bank_accounts
  for insert to authenticated
  with check (
    requested_by = (select private.session_uid())
    and (status = 'pending' or (status = 'active' and single_approver))
    and private.has_role(organisation_id, array['owner', 'admin', 'finance'])
  );

create policy organisation_bank_accounts_update on public.organisation_bank_accounts
  for update to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'finance'])
    or (
      requested_by = (select private.session_uid())
      and private.has_role(organisation_id, array['owner', 'admin', 'finance'])
    )
  )
  with check (
    private.has_role(organisation_id, array['owner', 'finance'])
    or (
      requested_by = (select private.session_uid())
      and private.has_role(organisation_id, array['owner', 'admin', 'finance'])
    )
  );

revoke all on table public.organisation_bank_accounts from anon, authenticated;
grant select on table public.organisation_bank_accounts to authenticated;
grant insert (
  id, organisation_id, bank_name, account_name, bank_account_enc, bank_account_last4, reason
) on table public.organisation_bank_accounts to authenticated;
grant update (status, decision_note) on table public.organisation_bank_accounts to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Request, decide, withdraw (run as the caller: RLS, grants and triggers apply)
-- ---------------------------------------------------------------------------

-- Raises a request. p_bank_account_enc must be sealed for this row: (p_organisation_id,
-- 'organisation_bank_accounts', 'bank_account_enc', p_id). Returns the row's status: `pending`,
-- or `active` when it was the first account added by an owner during setup.
create function public.request_org_bank_account(
  p_organisation_id uuid,
  p_id uuid,
  p_bank_name text,
  p_account_name text,
  p_bank_account_enc bytea,
  p_bank_account_last4 text,
  p_reason text default null
)
returns table (id uuid, status public.org_bank_account_status, single_approver boolean)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  insert into public.organisation_bank_accounts as a (
    id, organisation_id, bank_name, account_name, bank_account_enc, bank_account_last4, reason
  )
  values (
    p_id, p_organisation_id, p_bank_name, p_account_name, p_bank_account_enc,
    p_bank_account_last4, nullif(btrim(p_reason), '')
  )
  returning a.id, a.status, a.single_approver;
end;
$$;

-- Approves or rejects a pending request, or stops an approved one during the hold. The trigger
-- refuses the requester and fills in who and when.
create function public.decide_org_bank_account(
  p_organisation_id uuid,
  p_id uuid,
  p_decision text,
  p_note text default null
)
returns table (
  id uuid,
  status public.org_bank_account_status,
  applies_after timestamptz,
  bank_account_last4 text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_from public.org_bank_account_status;
  v_to public.org_bank_account_status;
begin
  case p_decision
    when 'approve' then v_from := 'pending'; v_to := 'approved';
    when 'reject' then v_from := 'pending'; v_to := 'rejected';
    when 'stop' then v_from := 'approved'; v_to := 'cancelled';
    else raise exception 'Choose approve, reject or stop.' using errcode = '22023';
  end case;

  return query
  update public.organisation_bank_accounts a
  set status = v_to, decision_note = nullif(btrim(p_note), '')
  where a.id = p_id
    and a.organisation_id = p_organisation_id
    and a.status = v_from
  returning a.id, a.status, a.applies_after, a.bank_account_last4;
  if not found then
    raise exception 'That request wasn''t found, or someone has already decided it.'
      using errcode = 'P0002';
  end if;
end;
$$;

-- The requester takes back a request nobody has decided yet.
create function public.withdraw_org_bank_account(p_organisation_id uuid, p_id uuid)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.organisation_bank_accounts a
  set status = 'cancelled'
  where a.id = p_id
    and a.organisation_id = p_organisation_id
    and a.status = 'pending'
  returning a.id into v_id;
  if v_id is null then
    raise exception 'That request wasn''t found, or someone has already decided it.'
      using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Applying accounts whose hold has ended
-- ---------------------------------------------------------------------------

-- Moves every approved account whose hold has ended to active, retiring the account it replaces
-- first, in one transaction. p_organisation_id null means every organisation, which only
-- callers without a signed-in user (pg_cron, the secret key) may ask for; a signed-in caller
-- must name an organisation they belong to. Returns how many accounts became active. Safe to
-- call any number of times: the due row is locked, so two callers at once apply it once.
create function private.apply_due_org_bank_accounts(p_organisation_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
  v_count integer := 0;
begin
  if auth.uid() is not null and (
    p_organisation_id is null
    or p_organisation_id not in (select private.user_org_ids())
  ) then
    raise exception 'Choose an organisation you belong to.' using errcode = '42501';
  end if;

  for r in
    select a.id, a.organisation_id
    from public.organisation_bank_accounts a
    where a.status = 'approved'
      and a.applies_after <= now()
      and (p_organisation_id is null or a.organisation_id = p_organisation_id)
    order by a.applies_after
    for update
  loop
    update public.organisation_bank_accounts a
    set status = 'retired'
    where a.organisation_id = r.organisation_id and a.status = 'active';

    update public.organisation_bank_accounts a
    set status = 'active'
    where a.id = r.id and a.status = 'approved';
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function public.apply_due_org_bank_accounts(p_organisation_id uuid)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.apply_due_org_bank_accounts(p_organisation_id)
$$;

select cron.schedule(
  'apply-org-bank-accounts',
  '*/5 * * * *',
  'select private.apply_due_org_bank_accounts(null)'
);

-- ---------------------------------------------------------------------------
-- 7. The account in force at a moment
-- ---------------------------------------------------------------------------

-- The account in force for a company at p_at: the latest account, approved by a second person
-- or added as the first account, whose hold had ended by then. Correct whether or not the apply
-- job has run. No row when the company had no account yet.
create function private.org_bank_account_in_force(p_organisation_id uuid, p_at timestamptz)
returns setof public.organisation_bank_accounts
language sql
stable
security definer
set search_path = ''
as $$
  select a.*
  from public.organisation_bank_accounts a
  where a.organisation_id = p_organisation_id
    and a.status in ('approved', 'active', 'retired')
    and a.applies_after <= p_at
  order by a.applies_after desc
  limit 1
$$;

-- For invoices (Phase 6): the account as of the issue date, with its ciphertext (decrypts under
-- this row's own context). Owner, admin and finance, and callers without a signed-in user
-- (server code with the secret key); anyone else gets 42501, never an empty answer.
create function private.org_bank_account_as_of(p_organisation_id uuid, p_at timestamptz)
returns table (
  id uuid,
  bank_name text,
  account_name text,
  bank_account_enc bytea,
  bank_account_last4 text,
  in_force_from timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
    and not private.has_role(p_organisation_id, array['owner', 'admin', 'finance']) then
    raise exception 'Only an owner, an admin or finance can read the company bank account for an invoice.'
      using errcode = '42501';
  end if;
  return query
  select a.id, a.bank_name, a.account_name, a.bank_account_enc, a.bank_account_last4,
    a.applies_after
  from private.org_bank_account_in_force(p_organisation_id, p_at) a;
end;
$$;

create function public.org_bank_account_as_of(
  p_organisation_id uuid,
  p_at timestamptz default now()
)
returns table (
  id uuid,
  bank_name text,
  account_name text,
  bank_account_enc bytea,
  bank_account_last4 text,
  in_force_from timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.org_bank_account_as_of(p_organisation_id, p_at)
$$;

-- For every manager: the account in force now, masked to its last four digits. No ciphertext.
create function private.org_bank_account_masked(p_organisation_id uuid)
returns table (
  id uuid,
  bank_name text,
  account_name text,
  bank_account_last4 text,
  in_force_from timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_role(
    p_organisation_id,
    array['owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager']
  ) then
    raise exception 'Only managers in this organisation can see its bank account.'
      using errcode = '42501';
  end if;
  return query
  select a.id, a.bank_name, a.account_name, a.bank_account_last4, a.applies_after
  from private.org_bank_account_in_force(p_organisation_id, now()) a;
end;
$$;

create function public.org_bank_account_masked(p_organisation_id uuid)
returns table (
  id uuid,
  bank_name text,
  account_name text,
  bank_account_last4 text,
  in_force_from timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.org_bank_account_masked(p_organisation_id)
$$;

-- ---------------------------------------------------------------------------
-- 8. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.organisation_bank_accounts_before_insert() from public, anon, authenticated;
revoke all on function private.organisation_bank_accounts_after_insert() from public, anon, authenticated;
revoke all on function private.organisation_bank_accounts_before_update() from public, anon, authenticated;
revoke all on function private.organisation_bank_accounts_no_delete() from public, anon, authenticated;
revoke all on function private.org_bank_account_in_force(uuid, timestamptz) from public, anon, authenticated;

revoke all on function public.request_org_bank_account(uuid, uuid, text, text, bytea, text, text) from public, anon;
grant execute on function public.request_org_bank_account(uuid, uuid, text, text, bytea, text, text) to authenticated, service_role;

revoke all on function public.decide_org_bank_account(uuid, uuid, text, text) from public, anon;
grant execute on function public.decide_org_bank_account(uuid, uuid, text, text) to authenticated, service_role;

revoke all on function public.withdraw_org_bank_account(uuid, uuid) from public, anon;
grant execute on function public.withdraw_org_bank_account(uuid, uuid) to authenticated, service_role;

revoke all on function private.apply_due_org_bank_accounts(uuid) from public, anon;
grant execute on function private.apply_due_org_bank_accounts(uuid) to authenticated, service_role;
revoke all on function public.apply_due_org_bank_accounts(uuid) from public, anon;
grant execute on function public.apply_due_org_bank_accounts(uuid) to authenticated, service_role;

revoke all on function private.org_bank_account_as_of(uuid, timestamptz) from public, anon;
grant execute on function private.org_bank_account_as_of(uuid, timestamptz) to authenticated, service_role;
revoke all on function public.org_bank_account_as_of(uuid, timestamptz) from public, anon;
grant execute on function public.org_bank_account_as_of(uuid, timestamptz) to authenticated, service_role;

revoke all on function private.org_bank_account_masked(uuid) from public, anon;
grant execute on function private.org_bank_account_masked(uuid) to authenticated, service_role;
revoke all on function public.org_bank_account_masked(uuid) from public, anon;
grant execute on function public.org_bank_account_masked(uuid) to authenticated, service_role;
