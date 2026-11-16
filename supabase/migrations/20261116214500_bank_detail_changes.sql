-- Slice 1.7: bank-detail changes with two-person approval and a 72-hour hold.
--
-- A worker's bank details (workers.bank_name, account_name, bank_account_enc,
-- bank_account_last4) change only through a row here (CLAUDE.md rule 10, owner decision 9):
--
--   pending ──approve (a second person)──▶ approved ──72 hours──▶ applied
--      │                                      │
--      ├──reject (a second person)──▶ rejected └──stop during the hold──▶ cancelled
--      └──withdraw (the requester)──▶ cancelled
--
-- * Who: owner, admin and hr raise requests for any worker; a worker raises one for themselves
--   (wired in slice 1.10). Owner, hr and finance decide. The requester can never approve or
--   reject their own request, and nobody decides a change to their own bank details. Enforced
--   three times: the BEFORE UPDATE trigger (clear error), the check constraints
--   `approved_by <> requested_by` and `rejected_by <> requested_by` (hold even for the table
--   owner and the secret key), and RLS and column grants for signed-in users.
-- * Insert-only history: a request's own columns never change after insert and rows are never
--   deleted. Only the status moves forward, and the trigger fills the decision columns
--   (approved_by, decided_at, applies_after, ...) itself; the caller can't supply them.
-- * The hold: applies_after = decided_at + 72 hours. workers.bank_* change only when a request
--   moves approved -> applied, which the trigger refuses before applies_after, and which writes
--   workers in the same transaction (with the row audit). Who moves it:
--     - pg_cron, every 5 minutes, through private.apply_due_bank_detail_changes(null);
--     - the app, on read, through public.apply_due_bank_detail_changes(org) (approvals page,
--       worker page, and the daily cron route that also emails the "applied" notices).
--   Either can run first; the update is idempotent (`where status = 'approved'`). Payouts must
--   not depend on that timing, so public.worker_bank_details_as_of(org, worker, at) answers
--   "which account was in force at this moment" from the requests themselves.
-- * Encryption context: bank_account_enc here is encrypted by the server for its destination,
--   `workers.bank_account_enc` of the worker (src/server/crypto/pii.ts binds organisation,
--   table, column and row into the tag). That is what lets the database copy the bytes into
--   workers when the hold ends, with no key in SQL. A value spliced in from another worker or
--   column still fails its integrity check when revealed or paid out.
-- * The last four digits: the database has no key, so it can't check that bank_account_last4
--   matches bank_account_enc. The server does, on approval (decideBankChange in
--   src/server/people/bank-changes.ts decrypts the request and refuses a mismatch), so what the
--   approver sees on the card and in the emails is what will be paid. A requester who writes
--   rows directly gains nothing: any number they could encrypt for a worker they can already
--   send through the app, where it shows with its real last four digits.
-- * New workers (recorded from the 1.3 review): a new worker row never carries bank details
--   from a signed-in user, on any path (Add employee, import, a direct insert, or a direct
--   create_worker call), whether or not the company has finished setup. public.create_worker
--   turns them into a pending request instead, and the worker keeps needs_pay_details until a
--   second person approves and the hold ends. Signed-in users have no insert grant on the
--   workers bank columns, and a BEFORE INSERT trigger refuses them for every signed-in caller,
--   definer functions included. The owner has not yet decided whether the first bulk import at
--   onboarding may stay single-approver (docs/PHASE_1.md 1.7); until they do, it is held too.
-- * Personal data never reaches audit_log in clear: the row audit drops `_enc` and
--   `bank_account*` keys (private.audit_secret_key), so it logs the bank name, account name,
--   status and who decided, never the number or its last four digits.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create type public.bank_detail_change_status as enum (
  'pending',
  'approved',
  'rejected',
  'applied',
  'cancelled'
);

create table public.bank_detail_changes (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  -- The signed-in user who raised it (the trigger sets it from the session whatever is sent).
  -- No foreign key, as on audit_log.
  requested_by uuid not null default auth.uid(),
  -- True when the worker raised it from their own login (slice 1.10).
  raised_by_worker boolean not null default false,

  -- The new details. Same text rules as the workers columns they replace.
  bank_name text not null
    constraint bank_detail_changes_bank_name_text check (
      bank_name = btrim(bank_name)
      and char_length(bank_name) between 1 and 200
      and bank_name !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  account_name text not null
    constraint bank_detail_changes_account_name_text check (
      account_name = btrim(account_name)
      and char_length(account_name) between 1 and 200
      and account_name !~ '[\x01-\x1f\x7f-\x9f<>]'
      and account_name !~* '(://|www\.)'
    ),
  bank_account_enc bytea not null,
  bank_account_last4 text not null
    constraint bank_detail_changes_bank_account_last4_format check (bank_account_last4 ~ '^[0-9]{4}$'),
  reason text
    constraint bank_detail_changes_reason_text check (
      reason = btrim(reason)
      and char_length(reason) between 1 and 500
      and reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),

  -- What the worker had when the change was approved: the account payouts use until the hold
  -- ends (public.worker_bank_details_as_of). Copied by trigger from workers.
  previous_bank_name text,
  previous_account_name text,
  previous_bank_account_enc bytea,
  previous_bank_account_last4 text,

  status public.bank_detail_change_status not null default 'pending',
  approved_by uuid,
  rejected_by uuid,
  cancelled_by uuid,
  decided_at timestamptz,
  decision_note text
    constraint bank_detail_changes_decision_note_text check (
      decision_note = btrim(decision_note)
      and char_length(decision_note) between 1 and 500
      and decision_note !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  applies_after timestamptz,
  applied_at timestamptz,
  cancelled_at timestamptz,
  -- When the worker was told the change applied (claimed by the server before it emails).
  applied_notified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bank_detail_changes_organisation_id_id_key unique (organisation_id, id),
  constraint bank_detail_changes_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),

  -- The two-person rule, for every writer.
  constraint bank_detail_changes_second_approver check (approved_by <> requested_by),
  constraint bank_detail_changes_second_rejecter check (rejected_by <> requested_by),

  -- Each status carries exactly its decision columns.
  constraint bank_detail_changes_status_columns check (
    case status
      when 'pending' then
        num_nonnulls(approved_by, rejected_by, cancelled_by, decided_at, applies_after,
          applied_at, cancelled_at, applied_notified_at) = 0
      when 'approved' then
        approved_by is not null and decided_at is not null
        and applies_after = decided_at + interval '72 hours'
        and num_nonnulls(rejected_by, applied_at, cancelled_by, cancelled_at, applied_notified_at) = 0
      when 'rejected' then
        rejected_by is not null and decided_at is not null
        and num_nonnulls(approved_by, applies_after, applied_at, cancelled_by, cancelled_at,
          applied_notified_at) = 0
      when 'applied' then
        approved_by is not null and decided_at is not null
        and applies_after = decided_at + interval '72 hours'
        and applied_at >= applies_after
        and num_nonnulls(rejected_by, cancelled_by, cancelled_at) = 0
      when 'cancelled' then
        cancelled_by is not null and cancelled_at is not null
        and num_nonnulls(rejected_by, applied_at, applied_notified_at) = 0
        and (approved_by is null or cancelled_at < applies_after)
    end
  ),
  constraint bank_detail_changes_previous_last4_format check (
    previous_bank_account_last4 ~ '^[0-9]{4}$'
  )
);

-- At most one open request (waiting for approval or on hold) per worker, so the snapshot of
-- the previous account taken at approval is still what the hold replaces.
create unique index bank_detail_changes_one_open_key
  on public.bank_detail_changes (worker_id)
  where status in ('pending', 'approved');
create index bank_detail_changes_organisation_status_idx
  on public.bank_detail_changes (organisation_id, status, created_at desc);
create index bank_detail_changes_due_idx
  on public.bank_detail_changes (applies_after)
  where status = 'approved';
create index bank_detail_changes_unnotified_idx
  on public.bank_detail_changes (organisation_id)
  where status = 'applied' and applied_notified_at is null;

comment on table public.bank_detail_changes is
  'Bank-detail change requests: two-person approval, then a 72-hour hold before workers.bank_* change (CLAUDE.md rule 10, owner decision 9). Insert-only history; the status moves forward by trigger-checked updates. bank_account_enc is encrypted for workers.bank_account_enc of the worker.';
comment on column public.bank_detail_changes.applies_after is
  'decided_at + 72 hours on approval. Until then payouts use the previous account.';

-- ---------------------------------------------------------------------------
-- 2. Trigger functions
-- ---------------------------------------------------------------------------

-- BEFORE INSERT. A new request is always pending, raised by the caller, for an active worker
-- the caller may raise one for. Definer: it reads the worker and the caller's memberships; the
-- role check comes first, so nothing about another organisation's workers is revealed.
create function private.bank_detail_changes_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_status public.worker_status;
begin
  if v_actor is not null then
    if not (
      private.has_role(new.organisation_id, array['owner', 'admin', 'hr'])
      or new.worker_id in (select private.my_worker_ids())
    ) then
      raise exception 'Only the owner, an admin, HR or the employee can ask to change bank details.'
        using errcode = '42501';
    end if;
    new.requested_by := v_actor;
  end if;
  if new.requested_by is null then
    raise exception 'A bank-detail change needs the person who raised it.' using errcode = '23502';
  end if;

  select w.status into v_status
  from public.workers w
  where w.id = new.worker_id and w.organisation_id = new.organisation_id;
  if v_status is null then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status = 'ended' then
    raise exception 'This employee has left, so their bank details can''t change.'
      using errcode = 'MLBK5';
  end if;

  new.raised_by_worker := v_actor is not null and new.worker_id in (select private.my_worker_ids());
  new.status := 'pending';
  new.approved_by := null;
  new.rejected_by := null;
  new.cancelled_by := null;
  new.decided_at := null;
  new.decision_note := null;
  new.applies_after := null;
  new.applied_at := null;
  new.cancelled_at := null;
  new.applied_notified_at := null;
  new.previous_bank_name := null;
  new.previous_account_name := null;
  new.previous_bank_account_enc := null;
  new.previous_bank_account_last4 := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

-- BEFORE UPDATE. The request itself is fixed; only the status moves, and this function decides
-- whether the move is allowed and fills in who and when. Definer: it reads the caller's roles
-- and the worker's current bank details.
create function private.bank_detail_changes_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_approver boolean;
begin
  if (
    new.id, new.organisation_id, new.worker_id, new.requested_by, new.raised_by_worker,
    new.bank_name, new.account_name, new.bank_account_enc, new.bank_account_last4, new.reason,
    new.created_at
  ) is distinct from (
    old.id, old.organisation_id, old.worker_id, old.requested_by, old.raised_by_worker,
    old.bank_name, old.account_name, old.bank_account_enc, old.bank_account_last4, old.reason,
    old.created_at
  ) then
    raise exception 'A bank-detail request can''t be edited. Reject it and raise a new one.'
      using errcode = 'MLBK4';
  end if;

  if new.status = old.status then
    -- The only change without a status move: marking an applied change as emailed, once.
    if old.status = 'applied'
      and old.applied_notified_at is null
      and new.applied_notified_at is not null
      and (
        new.approved_by, new.rejected_by, new.cancelled_by, new.decided_at, new.decision_note,
        new.applies_after, new.applied_at, new.cancelled_at, new.previous_bank_name,
        new.previous_account_name, new.previous_bank_account_enc, new.previous_bank_account_last4
      ) is not distinct from (
        old.approved_by, old.rejected_by, old.cancelled_by, old.decided_at, old.decision_note,
        old.applies_after, old.applied_at, old.cancelled_at, old.previous_bank_name,
        old.previous_account_name, old.previous_bank_account_enc, old.previous_bank_account_last4
      ) then
      return new;
    end if;
    raise exception 'This request has already been decided.' using errcode = 'MLBK4';
  end if;

  -- From here the status moves. Everything but the note is set here, never by the caller.
  new.approved_by := old.approved_by;
  new.rejected_by := old.rejected_by;
  new.cancelled_by := old.cancelled_by;
  new.decided_at := old.decided_at;
  new.applies_after := old.applies_after;
  new.applied_at := old.applied_at;
  new.cancelled_at := old.cancelled_at;
  new.applied_notified_at := old.applied_notified_at;
  new.previous_bank_name := old.previous_bank_name;
  new.previous_account_name := old.previous_account_name;
  new.previous_bank_account_enc := old.previous_bank_account_enc;
  new.previous_bank_account_last4 := old.previous_bank_account_last4;

  v_approver := v_actor is not null
    and private.has_role(old.organisation_id, array['owner', 'hr', 'finance']);

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    if not v_approver then
      raise exception 'Only the owner, HR or finance can approve or reject bank-detail changes.'
        using errcode = '42501';
    end if;
    if v_actor = old.requested_by then
      raise exception 'You raised this request, so someone else must approve or reject it.'
        using errcode = 'MLBK1';
    end if;
    if old.worker_id in (select private.my_worker_ids()) then
      raise exception 'These are your own bank details, so someone else must decide.'
        using errcode = 'MLBK2';
    end if;
    new.decided_at := now();
    if new.status = 'approved' then
      new.approved_by := v_actor;
      new.applies_after := new.decided_at + interval '72 hours';
      select w.bank_name, w.account_name, w.bank_account_enc, w.bank_account_last4
      into new.previous_bank_name, new.previous_account_name, new.previous_bank_account_enc,
        new.previous_bank_account_last4
      from public.workers w
      where w.id = old.worker_id and w.organisation_id = old.organisation_id;
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

  elsif old.status = 'approved' and new.status = 'cancelled' then
    if not v_approver then
      raise exception 'Only the owner, HR or finance can stop an approved bank-detail change.'
        using errcode = '42501';
    end if;
    if now() >= old.applies_after then
      raise exception 'The 72-hour hold has ended, so this change has taken effect. Raise a new change instead.'
        using errcode = 'MLBK3';
    end if;
    new.cancelled_by := v_actor;
    new.cancelled_at := now();

  elsif old.status = 'approved' and new.status = 'applied' then
    if now() < old.applies_after then
      raise exception 'This change is on hold for 72 hours after approval.' using errcode = 'MLBK3';
    end if;
    new.applied_at := now();
    new.decision_note := old.decision_note;

  else
    raise exception 'This request has already been decided.' using errcode = 'MLBK4';
  end if;

  return new;
end;
$$;

-- AFTER UPDATE: when the hold ends (approved -> applied), the worker's bank details become the
-- requested ones, in the same transaction. Definer because signed-in users have no update grant
-- on the workers bank columns. The workers triggers recompute needs_pay_details and write the
-- row audit and the personal-data audit ("bank_account changed", never the value).
create function private.bank_detail_changes_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'approved' and new.status = 'applied' then
    update public.workers w
    set bank_name = new.bank_name,
        account_name = new.account_name,
        bank_account_enc = new.bank_account_enc,
        bank_account_last4 = new.bank_account_last4
    where w.id = new.worker_id
      and w.organisation_id = new.organisation_id;
  end if;
  return null;
end;
$$;

-- BEFORE DELETE: requests are history.
create function private.bank_detail_changes_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Bank-detail requests are kept as history and can''t be deleted.'
    using errcode = 'MLBK4';
end;
$$;

-- BEFORE INSERT on workers: a new worker's bank details need a second approver, so a row
-- inserted by a signed-in user can't carry them (public.create_worker turns them into a
-- request). The column grants already refuse a direct insert; this also covers any definer
-- function a signed-in user reaches. Only callers with no signed-in user (server code with the
-- secret key, CLAUDE.md rule 2) may insert them.
create function private.workers_bank_details_need_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if num_nonnulls(new.bank_name, new.account_name, new.bank_account_enc, new.bank_account_last4) > 0
    and auth.uid() is not null then
    raise exception 'Bank details for a new employee need a second person to approve them. Add the employee, then raise a bank-detail change.'
      using errcode = 'MLBK6';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------

create trigger bank_detail_changes_before_insert
  before insert on public.bank_detail_changes
  for each row execute function private.bank_detail_changes_before_insert();
create trigger bank_detail_changes_before_update
  before update on public.bank_detail_changes
  for each row execute function private.bank_detail_changes_before_update();
create trigger bank_detail_changes_set_updated_at
  before update on public.bank_detail_changes
  for each row execute function private.set_updated_at();
create trigger bank_detail_changes_after_update
  after update on public.bank_detail_changes
  for each row execute function private.bank_detail_changes_after_update();
create trigger bank_detail_changes_no_delete
  before delete on public.bank_detail_changes
  for each row execute function private.bank_detail_changes_no_delete();
create trigger bank_detail_changes_audit
  after insert or update or delete on public.bank_detail_changes
  for each row execute function private.audit_row_change();

create trigger workers_bank_details_need_approval
  before insert on public.workers
  for each row execute function private.workers_bank_details_need_approval();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants
-- ---------------------------------------------------------------------------
-- Read: owner, admin, hr, finance; a worker reads their own requests. Insert: owner, admin, hr,
-- or the worker for themselves. Update (status moves only, checked by trigger): owner, hr and
-- finance, and the requester (to withdraw). No delete.

alter table public.bank_detail_changes enable row level security;

create policy bank_detail_changes_select on public.bank_detail_changes for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr', 'finance'])
    or worker_id in (select private.my_worker_ids())
  );

create policy bank_detail_changes_insert on public.bank_detail_changes for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and status = 'pending'
    and (
      private.has_role(organisation_id, array['owner', 'admin', 'hr'])
      or worker_id in (select private.my_worker_ids())
    )
  );

create policy bank_detail_changes_update on public.bank_detail_changes for update to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'hr', 'finance'])
    or requested_by = (select auth.uid())
  )
  with check (
    private.has_role(organisation_id, array['owner', 'hr', 'finance'])
    or requested_by = (select auth.uid())
  );

revoke all on table public.bank_detail_changes from anon, authenticated;
grant select on table public.bank_detail_changes to authenticated;
grant insert (
  id, organisation_id, worker_id, bank_name, account_name, bank_account_enc, bank_account_last4,
  reason
) on table public.bank_detail_changes to authenticated;
grant update (status, decision_note) on table public.bank_detail_changes to authenticated;

-- A new worker's bank details arrive only as a request (public.create_worker), never on the row.
revoke insert (bank_name, account_name, bank_account_enc, bank_account_last4)
  on table public.workers from authenticated;

-- ---------------------------------------------------------------------------
-- 5. Applying changes whose hold has ended
-- ---------------------------------------------------------------------------

-- Moves every approved change whose hold has ended to applied (the triggers write workers).
-- p_organisation_id null means every organisation, which only callers without a signed-in user
-- (pg_cron, the secret key) may ask for; a signed-in caller must name an organisation they
-- belong to. Returns how many changes applied. Safe to call any number of times.
create function private.apply_due_bank_detail_changes(p_organisation_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is not null and (
    p_organisation_id is null
    or p_organisation_id not in (select private.user_org_ids())
  ) then
    raise exception 'Choose an organisation you belong to.' using errcode = '42501';
  end if;

  update public.bank_detail_changes c
  set status = 'applied'
  where c.status = 'approved'
    and c.applies_after <= now()
    and (p_organisation_id is null or c.organisation_id = p_organisation_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.apply_due_bank_detail_changes(p_organisation_id uuid)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.apply_due_bank_detail_changes(p_organisation_id)
$$;

-- pg_cron applies due changes every 5 minutes, so workers.bank_* follow the hold even when
-- nobody opens the app. The schedule is upserted by name.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'apply-bank-detail-changes',
  '*/5 * * * *',
  'select private.apply_due_bank_detail_changes(null)'
);

-- ---------------------------------------------------------------------------
-- 6. Bank details as of a moment (for payouts)
-- ---------------------------------------------------------------------------

-- The account in force for a worker at p_at: the latest approved or applied change whose hold
-- ended by then; otherwise the account the first later change replaces (its snapshot); otherwise
-- the worker's current details. Correct whether or not the apply job has run yet.
-- bank_account_enc decrypts under workers.bank_account_enc of the worker.
--
-- Definer, with its own role check: run as a caller who can't read bank_detail_changes, the
-- "changes" step would find nothing and quietly fall back to the worker's current row, which
-- during the gap between applies_after and the next apply run is still the old account. So only
-- the owner, HR and finance (who decide and pay) may ask, and callers without a signed-in user
-- (server code with the secret key); anyone else gets 42501, never a wrong answer. Callers use
-- public.worker_bank_details_as_of below, which only forwards here.
create function private.worker_bank_details_as_of(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_at timestamptz
)
returns table (
  bank_name text,
  account_name text,
  bank_account_enc bytea,
  bank_account_last4 text,
  bank_detail_change_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null
    and not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only the owner, HR or finance can read the bank details used for a payout.'
      using errcode = '42501';
  end if;

  return query
  with changes as (
    select c.*
    from public.bank_detail_changes c
    where c.organisation_id = p_organisation_id
      and c.worker_id = p_worker_id
      and c.status in ('approved', 'applied')
  ),
  in_force as (
    select ch.bank_name, ch.account_name, ch.bank_account_enc, ch.bank_account_last4, ch.id
    from changes ch
    where ch.applies_after <= p_at
    order by ch.applies_after desc
    limit 1
  ),
  replaced as (
    select ch.previous_bank_name, ch.previous_account_name, ch.previous_bank_account_enc,
      ch.previous_bank_account_last4, null::uuid
    from changes ch
    where ch.applies_after > p_at
      and not exists (select 1 from in_force)
    order by ch.applies_after asc
    limit 1
  ),
  current_details as (
    select w.bank_name, w.account_name, w.bank_account_enc, w.bank_account_last4, null::uuid
    from public.workers w
    where w.id = p_worker_id
      and w.organisation_id = p_organisation_id
      and not exists (select 1 from changes)
  )
  select * from in_force
  union all
  select * from replaced
  union all
  select * from current_details;
end;
$$;

create function public.worker_bank_details_as_of(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_at timestamptz default now()
)
returns table (
  bank_name text,
  account_name text,
  bank_account_enc bytea,
  bank_account_last4 text,
  bank_detail_change_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.worker_bank_details_as_of(p_organisation_id, p_worker_id, p_at)
$$;

-- ---------------------------------------------------------------------------
-- 7. New workers: bank details become a request
-- ---------------------------------------------------------------------------

-- As in 20261116103000, except that bank details are never written to the worker: they are
-- raised as a pending bank_detail_changes request by the caller, on every path (Add employee,
-- the import, which calls this per row, or a direct call), setup finished or not. A
-- `hold_bank_details` key in p_worker, sent by earlier app versions, is ignored.
-- bank_account_enc must be encrypted for workers.bank_account_enc of p_worker.id, as before,
-- which is also what the request holds. Incomplete bank details (a name without the number,
-- say) can't become a request, so they are left off and the worker keeps needs_pay_details, as
-- the import does for a bad account number. The request's last four digits are checked against
-- its encrypted number when a second person approves it (decideBankChange).
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
      reason
    )
    values (
      v_org, v_id, r.bank_name, r.account_name, r.bank_account_enc, r.bank_account_last4,
      'Bank details for a new employee'
    );
  end if;

  if p_pay_rate is not null then
    perform public.add_pay_rate(v_org, v_id, p_pay_rate);
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.bank_detail_changes_before_insert() from public, anon, authenticated;
revoke all on function private.bank_detail_changes_before_update() from public, anon, authenticated;
revoke all on function private.bank_detail_changes_after_update() from public, anon, authenticated;
revoke all on function private.bank_detail_changes_no_delete() from public, anon, authenticated;
revoke all on function private.workers_bank_details_need_approval() from public, anon, authenticated;

revoke all on function private.apply_due_bank_detail_changes(uuid) from public, anon;
grant execute on function private.apply_due_bank_detail_changes(uuid) to authenticated, service_role;

revoke all on function public.apply_due_bank_detail_changes(uuid) from public, anon;
grant execute on function public.apply_due_bank_detail_changes(uuid) to authenticated, service_role;

revoke all on function private.worker_bank_details_as_of(uuid, uuid, timestamptz) from public, anon;
grant execute on function private.worker_bank_details_as_of(uuid, uuid, timestamptz) to authenticated, service_role;

revoke all on function public.worker_bank_details_as_of(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.worker_bank_details_as_of(uuid, uuid, timestamptz) to authenticated, service_role;

revoke all on function public.create_worker(jsonb, jsonb) from public, anon;
grant execute on function public.create_worker(jsonb, jsonb) to authenticated, service_role;
