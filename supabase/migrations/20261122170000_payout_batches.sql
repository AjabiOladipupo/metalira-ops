-- Slice 5.4: bank file export and release (docs/PHASE_5.md 5.4, decisions 9, 11 and 12; CLAUDE.md
-- rules 1, 4, 5, 6, 9 and 10).
--
-- 1. Bank details as of a moment gain the bank code (Phase 2 carry): bank_detail_changes keeps the
--    worker's bank code from before an approved change (previous_bank_code, set by a trigger when
--    a second person approves), and private.worker_bank_details_as_of returns bank_code as its
--    last column: the change's code, the code the change replaces while it is in the hold, or the
--    worker's. Its body and role check (owner, hr, finance, or the secret key) are unchanged.
-- 2. payout_batches and payout_items: one bank file per batch, with its control totals (item
--    count, total in kobo, SHA-256 of the file's bytes) and one item per payslip of the run: the
--    bank name, bank code, account name, the account's last 4 digits and the bank-detail change
--    used, never the account number. One active batch per run (partial unique index); making a
--    new one voids the previous with a reason. Both are insert-only except the status moves the
--    functions make (a batch active -> voided, its pending items -> voided). Guards fire ALWAYS
--    (replica mode included) and refuse truncate, as 5.3's do.
-- 3. The private bucket `payroll-files` (CSV only, 5 MB), objects at
--    {organisation_id}/{run_id}/{batch_id}.csv. There is no storage policy for it at all: no
--    signed-in role reads, lists, writes or deletes its objects. The server uploads with the secret
--    key and opens a file by a 60-second signed URL, for owner and finance only, after
--    payout_file_download (below) checks the role and audits the download.
-- 4. payroll_runs gains released_at and released_by; the run's guard (5.3's, otherwise unchanged)
--    allows exactly one more move, approved -> released, which changes nothing else.
-- 5. Functions (private security definer behind public invoker wrappers, search_path '', the
--    organisation checked against the signed-in user's memberships in a trusted session):
--    * payout_plan(org, run, with_ciphertext): each payslip of an approved or released run with
--      the bank details in force now, whether a bank change is waiting or in its hold, and the
--      bank anomaly HR acknowledged for the worker. Owner or finance see it without ciphertext (the
--      Pay step's preview); only the secret key gets the encrypted account numbers, which the
--      server decrypts in memory to check their last 4 digits and write the file.
--    * make_payout_batch(org, run, batch, format, sha256, bytes, items, void_reason): owner or
--      finance. Checks the file is stored at the batch's path with that size, that the items are
--      exactly the run's payslips with today's bank details and the rules below, records the
--      batch and items, voids the previous batch (a reason needed), audited.
--    * payout_file_download(org, batch): owner or finance; the active batch's path, audited as
--      payroll.bank_file_downloaded (the batch id only).
--    * release_payroll_run(org, run): owner or finance, never anyone who prepared or changed the
--      run (private.payroll_run_touchers: rule 10's stricter reading) nor whoever made the active
--      file (MLBFA), with an active batch;
--      approved -> released; the decision row; audited. 5.5 hooks payslip publication to it on the
--      server (src/server/payroll/release.ts, onPayrollReleased).
--
-- Who is paid (decision 11), per payslip, with the details in force when the file is made:
--   net ₦0                                   left out, nothing_to_pay
--   no account on file                       left out (no_bank_details) only when HR acknowledged
--                                            a bank anomaly for them on this run; else MLBF2
--   a change waiting or in its 72-hour hold  left out (bank_change_in_hold) when HR acknowledged a
--                                            bank anomaly for them; else paid to the account in force
--   no bank code                             MLBF3, by name (the server refuses first)
--   last 4 digits don't match the number     MLBF1, by name (the server only: the database has no key)
--   otherwise                                paid: amount = net pay, details = those in force
--
-- Refusals (SQLSTATE), new here:
--   MLBF1 an account number's last 4 digits don't match (raised by the server, not SQL)
--   MLBF2 a worker has no bank details and HR didn't acknowledge it on this run
--   MLBF3 a worker's bank details have no bank code
--   MLBF4 the items don't match the run's payslips and bank details now (or nobody to pay)
--   MLBF5 the run or file isn't in a state that allows this (not approved, released, voided)
--   MLBF6 replacing the current file needs a reason
--   MLBF7 release needs an active bank file
--   MLBF8 the releaser prepared or changed the run (rule 10)
--   MLBF9 the file isn't stored at the batch's path with that size
--   MLBFA the releaser made the active bank file (security review M1)
--   MLBFB replacing a downloaded file needs the statement that it wasn't uploaded (money H1)
--   MLBFC release named a file that isn't the active one, or its hash differs (money H2)
--   MLBFD release before anyone downloaded the active file (money L1)
--   MLBFE a download after release needs a reason (money L2)
-- Reused: 42501 (role, untrusted session), 22023 (bad input), P0002 (not in the company), MLPRD
-- (5.2/5.3's posted-run guard).
-- No money maths here beyond sums and equality checks; naira formatting is the server's.

-- ---------------------------------------------------------------------------
-- 1. Bank code as of a moment
-- ---------------------------------------------------------------------------

alter table public.bank_detail_changes
  add column previous_bank_code text
    constraint bank_detail_changes_previous_bank_code_format check (previous_bank_code ~ '^[0-9]{3,6}$');

comment on column public.bank_detail_changes.previous_bank_code is
  'The worker''s bank code when the change was approved (slice 5.4): the code payouts use with the previous account until the hold ends. Set by trigger.';

-- Sets previous_bank_code when a second person approves (pending -> approved), from the worker's
-- row as it is then (as 1.7's trigger does for the other previous_* columns); otherwise keeps it.
-- A separate trigger so 1.7's before-update function stays as it is.
create function private.bank_detail_changes_previous_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.previous_bank_code := null;
    return new;
  end if;
  if old.status = 'pending' and new.status = 'approved' then
    select w.bank_code into new.previous_bank_code
    from public.workers w
    where w.id = old.worker_id and w.organisation_id = old.organisation_id;
  else
    new.previous_bank_code := old.previous_bank_code;
  end if;
  return new;
end;
$$;

revoke all on function private.bank_detail_changes_previous_code() from public, anon, authenticated;

-- Backfill (security review L5): approved changes still inside their hold get the worker's code
-- now, which is still the code in force before the change (nothing applied it yet). Done before
-- the trigger exists, with 1.7's ordinary triggers skipped (they refuse an update without a status
-- move); the audit trigger is skipped too, and the backfill writes no number.
set session_replication_role = replica;
update public.bank_detail_changes c
set previous_bank_code = w.bank_code
from public.workers w
where w.id = c.worker_id and w.organisation_id = c.organisation_id
  and c.status = 'approved' and c.applies_after > now();
set session_replication_role = origin;

create trigger bank_detail_changes_previous_code
  before insert or update on public.bank_detail_changes
  for each row execute function private.bank_detail_changes_previous_code();
-- Fires whatever session_replication_role says, as 5.3's payroll guards do.
alter table public.bank_detail_changes enable always trigger bank_detail_changes_previous_code;

-- 1.7's function (migration 20261116214500, its latest version), with bank_code added as the last
-- column. The return type changes, so it is dropped and created again with the same grants.
drop function public.worker_bank_details_as_of(uuid, uuid, timestamptz);
drop function private.worker_bank_details_as_of(uuid, uuid, timestamptz);

-- The account in force for a worker at p_at: the latest approved or applied change whose hold
-- ended by then; otherwise the account the first later change replaces (its snapshot); otherwise
-- the worker's current details. Correct whether or not the apply job has run yet.
-- bank_account_enc decrypts under workers.bank_account_enc of the worker.
--
-- 5.4: unchanged but for bank_code and the secret-key branch of the role check.
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
  bank_detail_change_id uuid,
  bank_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- 5.4 (security review L6): no signed-in user means the secret key only, as payout_plan.
  if auth.uid() is not null then
    if not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
      raise exception 'Only the owner, HR or finance can read the bank details used for a payout.'
        using errcode = '42501';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
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
    select ch.bank_name, ch.account_name, ch.bank_account_enc, ch.bank_account_last4, ch.id,
      ch.bank_code
    from changes ch
    where ch.applies_after <= p_at
    order by ch.applies_after desc
    limit 1
  ),
  replaced as (
    select ch.previous_bank_name, ch.previous_account_name, ch.previous_bank_account_enc,
      ch.previous_bank_account_last4, null::uuid, ch.previous_bank_code
    from changes ch
    where ch.applies_after > p_at
      and not exists (select 1 from in_force)
    order by ch.applies_after asc
    limit 1
  ),
  current_details as (
    select w.bank_name, w.account_name, w.bank_account_enc, w.bank_account_last4, null::uuid,
      w.bank_code
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
  bank_detail_change_id uuid,
  bank_code text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.worker_bank_details_as_of(p_organisation_id, p_worker_id, p_at)
$$;

revoke all on function private.worker_bank_details_as_of(uuid, uuid, timestamptz) from public, anon;
grant execute on function private.worker_bank_details_as_of(uuid, uuid, timestamptz) to authenticated, service_role;

revoke all on function public.worker_bank_details_as_of(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.worker_bank_details_as_of(uuid, uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Released runs
-- ---------------------------------------------------------------------------

alter table public.payroll_runs
  add column released_at timestamptz,
  add column released_by uuid,
  add constraint payroll_runs_released_pair check ((released_at is null) = (released_by is null)),
  add constraint payroll_runs_released_state check ((status = 'released') = (released_at is not null)),
  -- Rule 10, in SQL: whoever confirms the money went to the bank never prepared, submitted or last
  -- recalculated the run (release_payroll_run also refuses every other toucher).
  add constraint payroll_runs_release_two_people check (
    released_by is null or (
      released_by <> prepared_by
      and released_by is distinct from submitted_by
      and released_by is distinct from calculated_by
    )
  );

comment on column public.payroll_runs.released_by is
  'Who confirmed the bank file went to the bank (slice 5.4): owner or finance, never anyone who prepared or changed the run.';

-- 5.3's guard (migration 20261122130000), plus:
-- * a new run has no release;
-- * approved -> released is the one move a posted run makes, and it changes nothing but status,
--   released_at, released_by and updated_at;
-- * only that move records a releaser.
create or replace function private.payroll_runs_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- No foreign key to tax_rule_sets (5.0's truncate guard must stay first): checked here.
    if not exists (
      select 1 from public.tax_rule_sets t
      where t.organisation_id = new.organisation_id and t.id = new.rule_set_id
    ) then
      raise exception 'The run''s rule set isn''t one of the company''s.' using errcode = 'MLPRD';
    end if;
    if new.status <> 'draft' or new.calculated_at is not null or new.submitted_at is not null
      or new.inputs_sha256 is not null or new.worker_count <> 0 or new.gross_kobo <> 0
      or new.net_kobo <> 0 or new.employer_cost_kobo <> 0 or not new.needs_recalculation
      or new.approved_at is not null or new.approved_by is not null
      or new.released_at is not null or new.released_by is not null then
      raise exception 'A new payroll run starts as an empty draft.' using errcode = 'MLPRD';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A payroll run is never deleted.' using errcode = 'MLPRD';
  end if;
  -- Release (slice 5.4): the bank file went to the bank. Nothing else about the run changes.
  if old.status = 'approved' and new.status = 'released' then
    if new.released_at is null or new.released_by is null
      or (to_jsonb(new) - 'status' - 'released_at' - 'released_by' - 'updated_at')
        is distinct from (to_jsonb(old) - 'status' - 'released_at' - 'released_by' - 'updated_at')
    then
      raise exception 'A release records who released the run and when, and changes nothing else.'
        using errcode = 'MLPRD';
    end if;
    new.updated_at := now();
    return new;
  end if;
  -- Posted is final (rule 5): nothing else about an approved or released run changes.
  if old.status in ('approved', 'released') then
    raise exception 'This payroll run is posted and never changes. Corrections go in a later run.'
      using errcode = 'MLPRD';
  end if;
  if new.released_at is not null or new.released_by is not null then
    raise exception 'Only a release records who released the run.' using errcode = 'MLPRD';
  end if;
  if (
    new.id, new.organisation_id, new.kind, new.period_start, new.period_end, new.pay_date,
    new.rule_set_id, new.prepared_by, new.currency, new.created_at
  ) is distinct from (
    old.id, old.organisation_id, old.kind, old.period_start, old.period_end, old.pay_date,
    old.rule_set_id, old.prepared_by, old.currency, old.created_at
  ) then
    raise exception 'A payroll run''s period, pay date, rule set and preparer never change.'
      using errcode = 'MLPRD';
  end if;
  if (
    new.itf_applies, new.inputs_sha256, new.needs_recalculation, new.calculated_at,
    new.calculated_by, new.gross_kobo, new.paye_kobo, new.pension_employee_kobo,
    new.pension_employer_kobo, new.nhf_kobo, new.other_deductions_kobo, new.net_kobo,
    new.nsitf_kobo, new.itf_kobo, new.employer_cost_kobo, new.carried_forward_kobo,
    new.worker_count
  ) is distinct from (
    old.itf_applies, old.inputs_sha256, old.needs_recalculation, old.calculated_at,
    old.calculated_by, old.gross_kobo, old.paye_kobo, old.pension_employee_kobo,
    old.pension_employer_kobo, old.nhf_kobo, old.other_deductions_kobo, old.net_kobo,
    old.nsitf_kobo, old.itf_kobo, old.employer_cost_kobo, old.carried_forward_kobo,
    old.worker_count
  ) and not (old.status = 'draft' and new.status = 'draft') then
    raise exception 'Only a draft run is recalculated.' using errcode = 'MLPRD';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status = 'review')
    or (old.status = 'review' and new.status = 'draft')
    or (old.status = 'review' and new.status = 'approved')
  ) then
    raise exception 'A payroll run moves from draft to review, back to draft, or on to approved.'
      using errcode = 'MLPRD';
  end if;
  if new.status = 'approved' then
    if new.approved_at is null or new.approved_by is null
      or (new.submitted_at, new.submitted_by) is distinct from (old.submitted_at, old.submitted_by) then
      raise exception 'An approval records who approved and when, and changes nothing else.'
        using errcode = 'MLPRD';
    end if;
  elsif new.approved_at is not null or new.approved_by is not null then
    raise exception 'Only an approval records an approver.' using errcode = 'MLPRD';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create index payroll_runs_released_idx on public.payroll_runs (organisation_id, released_at desc)
  where status = 'released';

-- ---------------------------------------------------------------------------
-- 3. Payout batches and items
-- ---------------------------------------------------------------------------

create table public.payout_batches (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  -- The bank file format (src/server/payroll/bank-formats/): `generic-csv` first, then each
  -- pilot's bulk-payment template (decision 12).
  bank_format text not null
    constraint payout_batches_bank_format check (bank_format ~ '^[a-z][a-z0-9-]{1,39}$'),
  -- Object name in the private payroll-files bucket. Opened only by 60-second signed URLs.
  file_path text not null
    constraint payout_batches_file_path_key unique,
  -- The SHA-256 of the file's bytes as the server made them (security review L2): attested by
  -- the server, which made and stored the file; the database can't hash a stored object. No
  -- signed-in role can write to the bucket, so a batch can only point at a file the server stored.
  file_sha256 text not null
    constraint payout_batches_file_sha256_format check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes integer not null constraint payout_batches_file_bytes check (file_bytes > 0),
  -- Control totals: the workers paid by this file and what they are paid.
  item_count integer not null constraint payout_batches_item_count check (item_count > 0),
  total_kobo bigint not null constraint payout_batches_total check (total_kobo > 0),
  -- Workers in the run but not in the file, and their net pay.
  left_out_count integer not null constraint payout_batches_left_out_count check (left_out_count >= 0),
  left_out_kobo bigint not null constraint payout_batches_left_out_kobo check (left_out_kobo >= 0),
  currency text not null default 'NGN' constraint payout_batches_currency check (currency = 'NGN'),
  status text not null default 'active'
    constraint payout_batches_status_value check (status in ('active', 'voided')),
  made_by uuid not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text
    constraint payout_batches_void_reason_text check (
      void_reason = btrim(void_reason) and char_length(void_reason) between 1 and 500
      and void_reason !~ '[\x01-\x1f\x7f-\x9f<>]' and void_reason !~* '(://|www\.)'
      -- An account number never lands in free text (and so in audit_log) in clear.
      and regexp_replace(void_reason, '[^0-9]', '', 'g') !~ '[0-9]{10}'
    ),
  constraint payout_batches_organisation_id_id_key unique (organisation_id, id),
  constraint payout_batches_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payout_batches_file_path_shape check (
    file_path = organisation_id::text || '/' || run_id::text || '/' || id::text || '.csv'
  ),
  constraint payout_batches_voided check (
    case status
      when 'active' then num_nonnulls(voided_at, voided_by, void_reason) = 0
      else num_nulls(voided_at, voided_by, void_reason) = 0
    end
  )
);

-- One active batch per run.
create unique index payout_batches_one_active on public.payout_batches (organisation_id, run_id)
  where status = 'active';
create index payout_batches_run_idx on public.payout_batches (organisation_id, run_id, created_at desc);

comment on table public.payout_batches is
  'A payroll run''s bank file (slice 5.4) with its control totals: item count, total in kobo, SHA-256. One active per run; a new one voids the previous with a reason. Written only by make_payout_batch; insert-only but the void.';

create table public.payout_items (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  batch_id uuid not null,
  run_id uuid not null,
  payslip_id uuid not null,
  worker_id uuid not null,
  -- Row order in the file (pending items), then the workers left out.
  position integer not null constraint payout_items_position check (position > 0),
  -- pending: in the file; left_out: not in it, with the reason; voided: its batch was replaced.
  -- (Phase 6 adds matched, from bank statement debits.)
  status text not null
    constraint payout_items_status_value check (status in ('pending', 'left_out', 'voided')),
  left_out_reason text
    constraint payout_items_left_out_reason_value check (
      left_out_reason in ('no_bank_details', 'bank_change_in_hold', 'nothing_to_pay')
    ),
  -- The details in force when the file was made (worker_bank_details_as_of); never the number.
  bank_name text,
  bank_code text constraint payout_items_bank_code_format check (bank_code ~ '^[0-9]{3,6}$'),
  account_name text,
  bank_account_last4 text
    constraint payout_items_bank_account_last4_format check (bank_account_last4 ~ '^[0-9]{4}$'),
  bank_detail_change_id uuid,
  amount_kobo bigint not null constraint payout_items_amount_nonneg check (amount_kobo >= 0),
  currency text not null default 'NGN' constraint payout_items_currency check (currency = 'NGN'),
  created_at timestamptz not null default now(),
  constraint payout_items_organisation_id_id_key unique (organisation_id, id),
  constraint payout_items_batch_payslip_key unique (batch_id, payslip_id),
  constraint payout_items_batch_position_key unique (batch_id, position),
  constraint payout_items_batch_fkey foreign key (organisation_id, batch_id)
    references public.payout_batches (organisation_id, id),
  constraint payout_items_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payout_items_payslip_fkey foreign key (organisation_id, payslip_id)
    references public.payslips (organisation_id, id),
  constraint payout_items_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payout_items_left_out check (
    (status = 'left_out') = (left_out_reason is not null)
  ),
  constraint payout_items_paid_details check (
    status = 'left_out' or (
      amount_kobo > 0
      and num_nulls(bank_name, bank_code, account_name, bank_account_last4) = 0
    )
  )
);

create index payout_items_batch_idx on public.payout_items (organisation_id, batch_id, position);
create index payout_items_payslip_idx on public.payout_items (organisation_id, payslip_id);

comment on table public.payout_items is
  'One payslip of a payroll run in a bank file (slice 5.4): paid (pending until Phase 6 matches the debit) or left out with a reason. Bank name, code, account name and last 4 digits only. Insert-only but the void.';

-- Guards (every role, the secret key and the database owner included).

-- A batch is made for an approved (not released) run and is stamped now; it never goes; the one
-- change is active -> voided, with who, when and why, while the run is still approved.
create function private.payout_batches_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'A bank file is kept.' using errcode = 'MLBF5';
  end if;
  v_status := private.payroll_run_status(new.organisation_id, new.run_id);
  if tg_op = 'INSERT' then
    if v_status is distinct from 'approved' then
      raise exception 'A bank file is made for an approved run that isn''t released yet.'
        using errcode = 'MLBF5';
    end if;
    if new.status <> 'active' or num_nonnulls(new.voided_at, new.voided_by, new.void_reason) > 0 then
      raise exception 'A new bank file starts active.' using errcode = 'MLBF5';
    end if;
    new.created_at := now();
    return new;
  end if;
  if not (old.status = 'active' and new.status = 'voided')
    or new.voided_by is null or new.void_reason is null
    or (to_jsonb(new) - 'status' - 'voided_at' - 'voided_by' - 'void_reason')
      is distinct from (to_jsonb(old) - 'status' - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'A bank file never changes; a new one replaces it.' using errcode = 'MLBF5';
  end if;
  if v_status is distinct from 'approved' then
    raise exception 'The run is released, so its bank file stays.' using errcode = 'MLBF5';
  end if;
  new.voided_at := now();
  return new;
end;
$$;

revoke all on function private.payout_batches_guard() from public, anon, authenticated;

-- Items are written with their batch, in the batch's own transaction (its created_at is that
-- transaction's now()), and never go. The one change is pending -> voided once the batch is voided.
create function private.payout_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.payout_batches%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Bank file items are kept.' using errcode = 'MLBF5';
  end if;
  select b.* into v_batch
  from public.payout_batches b
  where b.organisation_id = new.organisation_id and b.id = new.batch_id;
  if tg_op = 'INSERT' then
    if v_batch.id is null or v_batch.status <> 'active' or v_batch.created_at <> now()
      or v_batch.run_id <> new.run_id then
      raise exception 'Bank file items are written with their file, once.' using errcode = 'MLBF5';
    end if;
    if new.status = 'voided' then
      raise exception 'A new item is in the file or left out.' using errcode = 'MLBF5';
    end if;
    new.created_at := now();
    return new;
  end if;
  if not (old.status = 'pending' and new.status = 'voided' and v_batch.status = 'voided')
    or (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'Bank file items never change.' using errcode = 'MLBF5';
  end if;
  return new;
end;
$$;

revoke all on function private.payout_items_guard() from public, anon, authenticated;

create trigger payout_batches_guard
  before insert or update or delete on public.payout_batches
  for each row execute function private.payout_batches_guard();
create trigger payout_items_guard
  before insert or update or delete on public.payout_items
  for each row execute function private.payout_items_guard();
create trigger payout_batches_no_truncate before truncate on public.payout_batches
  for each statement execute function private.payroll_no_truncate();
create trigger payout_items_no_truncate before truncate on public.payout_items
  for each statement execute function private.payroll_no_truncate();
create trigger payout_batches_audit after insert or update on public.payout_batches
  for each row execute function private.audit_row_change();
create trigger payout_items_audit after insert or update on public.payout_items
  for each row execute function private.audit_row_change();

-- As 5.3's: these fire whatever session_replication_role says.
alter table public.payout_batches enable always trigger payout_batches_guard;
alter table public.payout_items enable always trigger payout_items_guard;
alter table public.payout_batches enable always trigger payout_batches_no_truncate;
alter table public.payout_items enable always trigger payout_items_no_truncate;

-- Row-level security: owner, hr and finance read (hr sees the control totals and masked last 4
-- digits; the file itself opens for owner and finance only); nobody writes directly.
alter table public.payout_batches enable row level security;
alter table public.payout_items enable row level security;

create policy payout_batches_select on public.payout_batches for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payout_items_select on public.payout_items for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.payout_batches, public.payout_items from anon, authenticated, service_role;
grant select on table public.payout_batches, public.payout_items to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The private bucket
-- ---------------------------------------------------------------------------

-- No storage.objects policy names this bucket: signed-in roles can't read, list, upload or delete
-- its objects. The server writes with the secret key and opens a file by a 60-second signed URL.
-- (5.6's schedules use the same bucket.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payroll-files', 'payroll-files', false, 5242880, array['text/csv'])
-- 5.6 (migration 20261122160000) creates it first (private, CSV): kept as it is.
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------------

-- Owner or finance of the organisation, in a trusted session: makes, downloads and releases.
create function private.require_payout_maker(p_organisation_id uuid)
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
    or not private.has_role(p_organisation_id, array['owner', 'finance']) then
    raise exception 'Only an owner or Finance can make, download or release the bank file.'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function private.require_payout_maker(uuid) from public, anon, authenticated;

-- Each payslip of the run with the bank details in force now. No role check: definers call it.
create function private.payout_plan_rows(p_organisation_id uuid, p_run_id uuid)
returns table (
  payslip_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  net_kobo bigint,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  bank_account_enc bytea,
  in_hold boolean,
  acknowledged_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id, s.worker_id, btrim(w.first_name || ' ' || w.last_name), w.staff_id, s.net_kobo,
    d.bank_name, d.bank_code, d.account_name, d.bank_account_last4, d.bank_detail_change_id,
    d.bank_account_enc,
    exists (
      select 1 from public.bank_detail_changes c
      where c.organisation_id = s.organisation_id and c.worker_id = s.worker_id
        and (c.status = 'pending' or (c.status = 'approved' and c.applies_after > now()))
    ),
    (
      select min(a.code) from public.payroll_anomalies a
      where a.organisation_id = s.organisation_id and a.run_id = s.run_id
        and a.worker_id = s.worker_id and a.code in ('bank_missing', 'bank_in_hold')
        and a.acknowledged_at is not null
    )
  from public.payslips s
  join public.workers w on w.organisation_id = s.organisation_id and w.id = s.worker_id
  left join lateral private.worker_bank_details_as_of(s.organisation_id, s.worker_id, now()) d
    on true
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
  order by w.last_name, w.first_name, w.staff_id, s.id
$$;

revoke all on function private.payout_plan_rows(uuid, uuid) from public, anon, authenticated;

-- What the bank file of an approved or released run would hold now. Owner or finance (trusted
-- session) read it without ciphertext; only the secret key (no signed-in user) gets the encrypted
-- account numbers, for the server to decrypt in memory. Net pay is text: no number holds kobo.
create function private.payout_plan(
  p_organisation_id uuid,
  p_run_id uuid,
  p_with_ciphertext boolean
)
returns table (
  payslip_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  net_kobo text,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  bank_account_enc bytea,
  on_file boolean,
  in_hold boolean,
  acknowledged_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if auth.uid() is not null then
    if coalesce(p_with_ciphertext, true) then
      raise exception 'Only the server reads encrypted account numbers.' using errcode = '42501';
    end if;
    perform private.require_payout_maker(p_organisation_id);
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only an owner or Finance can read the bank file''s plan.' using errcode = '42501';
  end if;
  v_status := private.payroll_run_status(p_organisation_id, p_run_id);
  if v_status is null then
    raise exception 'That payroll run wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status not in ('approved', 'released') then
    raise exception 'The bank file is made once the run is approved.' using errcode = 'MLBF5';
  end if;
  return query
  select r.payslip_id, r.worker_id, r.worker_name, r.staff_id, r.net_kobo::text, r.bank_name,
    r.bank_code, r.account_name, r.bank_account_last4, r.bank_detail_change_id,
    case when p_with_ciphertext then r.bank_account_enc end,
    r.bank_account_enc is not null, r.in_hold, r.acknowledged_code
  from private.payout_plan_rows(p_organisation_id, p_run_id) r;
end;
$$;

revoke all on function private.payout_plan(uuid, uuid, boolean) from public, anon;
grant execute on function private.payout_plan(uuid, uuid, boolean) to authenticated, service_role;

create function public.payout_plan(
  p_organisation_id uuid,
  p_run_id uuid,
  p_with_ciphertext boolean default false
)
returns table (
  payslip_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  net_kobo text,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  bank_account_enc bytea,
  on_file boolean,
  in_hold boolean,
  acknowledged_code text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.payout_plan(p_organisation_id, p_run_id, p_with_ciphertext)
$$;

revoke all on function public.payout_plan(uuid, uuid, boolean) from public, anon;
grant execute on function public.payout_plan(uuid, uuid, boolean) to authenticated, service_role;

-- Up to five names from a list, then "and N more".
create function private.payout_names(p_names text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(cardinality(p_names), 0) <= 5 then array_to_string(p_names, ', ')
    else array_to_string(p_names[1:5], ', ') || ' and ' || (cardinality(p_names) - 5)::text || ' more'
  end
$$;

revoke all on function private.payout_names(text[]) from public, anon, authenticated;

-- Rows make_payout_batch compares: the run's plan with what is expected for each payslip, and the
-- items the server sent.
create type private.payout_plan_row as (
  payslip_id uuid,
  worker_id uuid,
  worker_name text,
  net_kobo bigint,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  expected text
);

create type private.payout_given_row as (
  payslip_id uuid,
  position integer,
  status text,
  left_out_reason text,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  amount_kobo text
);

-- Records a bank file the server made and stored (owner or finance, trusted session). p_items has
-- one entry per payslip of the run: {payslip_id, position, status (pending | left_out),
-- left_out_reason, bank_name, bank_code, account_name, bank_account_last4,
-- bank_detail_change_id, amount_kobo (text)}. Everything is checked against the bank details in
-- force now and the rules in the header; the server has already decrypted each number and checked
-- its last 4 digits (MLBF1), which the database can't. Voids the active batch with p_void_reason.
-- Returns {batch_id, item_count, total_kobo, left_out_count, voided_batch_id}.
create function private.make_payout_batch(
  p_organisation_id uuid,
  p_run_id uuid,
  p_batch_id uuid,
  p_bank_format text,
  p_file_sha256 text,
  p_file_bytes integer,
  p_items jsonb,
  p_void_reason text,
  p_not_uploaded boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payout_maker(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_active public.payout_batches%rowtype;
  v_path text;
  v_size text;
  v_reason text := nullif(btrim(coalesce(p_void_reason, '')), '');
  v_names text[];
  v_plan private.payout_plan_row[];
  v_given private.payout_given_row[];
  v_slips integer;
  v_given_count integer;
  v_positions integer;
  v_count integer;
  v_left integer;
  v_total bigint;
  v_left_kobo bigint;
  v_downloaded record;
begin
  if p_run_id is null or p_batch_id is null then
    raise exception 'Name the run and the file.' using errcode = '22023';
  end if;
  if p_bank_format is null or p_bank_format !~ '^[a-z][a-z0-9-]{1,39}$' then
    raise exception 'Choose a bank file format.' using errcode = '22023';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The file''s SHA-256 isn''t one.' using errcode = '22023';
  end if;
  if p_file_bytes is null or p_file_bytes <= 0 then
    raise exception 'The file is empty.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'The file''s items are missing.' using errcode = '22023';
  end if;
  if v_reason is not null and (
    char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v_reason ~* '(://|www\.)' or regexp_replace(v_reason, '[^0-9]', '', 'g') ~ '[0-9]{10}'
  ) then
    raise exception 'Say why in up to 500 characters, with no web addresses or account numbers.'
      using errcode = '22023';
  end if;

  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status = 'released' then
    raise exception 'This run is released: its bank file went to the bank and stays.'
      using errcode = 'MLBF5';
  end if;
  if v_run.status <> 'approved' then
    raise exception 'The bank file is made once the run is approved.' using errcode = 'MLBF5';
  end if;

  select b.* into v_active
  from public.payout_batches b
  where b.organisation_id = p_organisation_id and b.run_id = p_run_id and b.status = 'active'
  for update;
  if v_active.id is not null and v_reason is null then
    raise exception 'This run already has a bank file. Say why it is replaced.' using errcode = 'MLBF6';
  end if;
  -- Money review H1: a file someone downloaded may be at the bank already. Replacing it needs the
  -- caller's explicit statement that it wasn't uploaded, kept in the void reason and the audit row.
  if v_active.id is not null then
    select l.actor_id, l.at into v_downloaded
    from public.audit_log l
    where l.organisation_id = p_organisation_id and l.action = 'payroll.bank_file_downloaded'
      and l.entity = 'payout_batches' and l.entity_id = v_active.id
    order by l.at desc
    limit 1;
    if v_downloaded.at is not null then
      if not coalesce(p_not_uploaded, false) then
        raise exception 'The current file was downloaded. Confirm it wasn''t uploaded to the bank before replacing it, or two files may be paid.'
          using errcode = 'MLBFB';
      end if;
      v_reason := v_reason || ' (confirmed the replaced file was not uploaded to the bank)';
      if char_length(v_reason) > 500 then
        raise exception 'Say why in fewer words.' using errcode = '22023';
      end if;
    end if;
  end if;

  -- The file is stored at this batch's path with the size the server says.
  v_path := p_organisation_id::text || '/' || p_run_id::text || '/' || p_batch_id::text || '.csv';
  select o.metadata ->> 'size' into v_size
  from storage.objects o
  where o.bucket_id = 'payroll-files' and o.name = v_path;
  if v_size is null or v_size <> p_file_bytes::text then
    raise exception 'The bank file wasn''t stored. Try again.' using errcode = 'MLBF9';
  end if;

  begin
    v_given := array(
      select g from jsonb_populate_recordset(null::private.payout_given_row, p_items) g
    );
  exception when others then
    raise exception 'The file''s items aren''t in the expected shape.' using errcode = '22023';
  end;

  v_plan := array(
    select row(
      r.payslip_id, r.worker_id, r.worker_name, r.net_kobo, r.bank_name, r.bank_code,
      r.account_name, r.bank_account_last4, r.bank_detail_change_id,
      case
        when r.net_kobo = 0 then 'left_out:nothing_to_pay'
        when num_nulls(r.bank_account_enc, r.bank_name, r.account_name, r.bank_account_last4) > 0
          and r.acknowledged_code is not null then 'left_out:no_bank_details'
        when num_nulls(r.bank_account_enc, r.bank_name, r.account_name, r.bank_account_last4) > 0
          then 'refuse:no_details'
        when r.in_hold and r.acknowledged_code is not null then 'left_out:bank_change_in_hold'
        when r.bank_code is null then 'refuse:no_code'
        else 'pending'
      end
    )::private.payout_plan_row
    from private.payout_plan_rows(p_organisation_id, p_run_id) r
  );

  select array_agg(p.worker_name order by p.worker_name) into v_names
  from unnest(v_plan) p where p.expected = 'refuse:no_details';
  if v_names is not null then
    raise exception 'No bank details for %, and HR didn''t acknowledge it on this run. Add their details (a second person approves them) and make the file again.',
      private.payout_names(v_names) using errcode = 'MLBF2';
  end if;
  select array_agg(p.worker_name order by p.worker_name) into v_names
  from unnest(v_plan) p where p.expected = 'refuse:no_code';
  if v_names is not null then
    raise exception 'No bank code for %. Check their bank details on their page, then make the file again.',
      private.payout_names(v_names) using errcode = 'MLBF3';
  end if;

  v_slips := coalesce(cardinality(v_plan), 0);
  select count(*), count(distinct g.payslip_id), count(distinct g.position)
  into v_given_count, v_count, v_positions
  from unnest(v_given) g;
  if v_slips = 0 or v_given_count <> v_slips or v_count <> v_slips or v_positions <> v_slips
    or exists (
      select 1 from unnest(v_given) g
      where g.payslip_id is null or g.position is null or g.position < 1 or g.position > v_slips
        or g.status is null or g.status not in ('pending', 'left_out')
    )
    or exists (
      select 1
      from unnest(v_plan) p
      left join unnest(v_given) g on g.payslip_id = p.payslip_id
      where g.payslip_id is null
        or (p.expected = 'pending' and (
          g.status <> 'pending' or g.left_out_reason is not null
          -- The cast only when the text is whole kobo (OR doesn't fix the order of evaluation).
          or (case when g.amount_kobo ~ '^[0-9]{1,15}$' then g.amount_kobo::bigint end)
            is distinct from p.net_kobo
          or (g.bank_name, g.bank_code, g.account_name, g.bank_account_last4, g.bank_detail_change_id)
            is distinct from
             (p.bank_name, p.bank_code, p.account_name, p.bank_account_last4, p.bank_detail_change_id)
        ))
        or (p.expected like 'left_out:%' and (
          g.status <> 'left_out' or g.left_out_reason is distinct from substr(p.expected, 10)
        ))
    ) then
    raise exception 'The file doesn''t match the run''s payslips and the bank details in force now. Try again.'
      using errcode = 'MLBF4';
  end if;

  select count(*) filter (where p.expected = 'pending'),
         count(*) filter (where p.expected <> 'pending'),
         coalesce(sum(p.net_kobo) filter (where p.expected = 'pending'), 0),
         coalesce(sum(p.net_kobo) filter (where p.expected <> 'pending'), 0)
  into v_count, v_left, v_total, v_left_kobo
  from unnest(v_plan) p;
  if v_count = 0 then
    raise exception 'Nobody in this run can be paid by bank file.' using errcode = 'MLBF4';
  end if;
  if v_total + v_left_kobo <> v_run.net_kobo then
    raise exception 'The file''s total doesn''t reconcile with the run''s net pay.' using errcode = 'MLBF4';
  end if;

  if v_active.id is not null then
    update public.payout_batches b
    set status = 'voided', voided_by = v_uid, voided_at = now(), void_reason = v_reason
    where b.id = v_active.id;
    update public.payout_items i
    set status = 'voided'
    where i.organisation_id = p_organisation_id and i.batch_id = v_active.id
      and i.status = 'pending';
  end if;

  insert into public.payout_batches (
    id, organisation_id, run_id, bank_format, file_path, file_sha256, file_bytes, item_count,
    total_kobo, left_out_count, left_out_kobo, made_by
  )
  values (
    p_batch_id, p_organisation_id, p_run_id, p_bank_format, v_path, p_file_sha256, p_file_bytes,
    v_count, v_total, v_left, v_left_kobo, v_uid
  );

  insert into public.payout_items (
    organisation_id, batch_id, run_id, payslip_id, worker_id, position, status, left_out_reason,
    bank_name, bank_code, account_name, bank_account_last4, bank_detail_change_id, amount_kobo
  )
  select p_organisation_id, p_batch_id, p_run_id, p.payslip_id, p.worker_id, g.position,
    g.status, g.left_out_reason,
    p.bank_name, p.bank_code, p.account_name, p.bank_account_last4, p.bank_detail_change_id,
    case when p.expected = 'pending' then p.net_kobo else 0 end
  from unnest(v_plan) p
  join unnest(v_given) g on g.payslip_id = p.payslip_id
  order by g.position;

  perform private.log_audit_impl(
    p_organisation_id, 'payroll.bank_file_made', 'payout_batches', p_batch_id, null,
    jsonb_build_object(
      'run_id', p_run_id, 'batch_id', p_batch_id, 'bank_format', p_bank_format,
      'item_count', v_count, 'total_kobo', v_total::text, 'left_out_count', v_left,
      'file_sha256', p_file_sha256, 'voided_batch_id', v_active.id,
      'replaced_was_downloaded', v_downloaded.at is not null,
      'not_uploaded_attested', v_downloaded.at is not null and coalesce(p_not_uploaded, false)
    ),
    v_reason
  );

  return jsonb_build_object(
    'batch_id', p_batch_id, 'item_count', v_count, 'total_kobo', v_total::text,
    'left_out_count', v_left, 'voided_batch_id', v_active.id
  );
end;
$$;

revoke all on function private.make_payout_batch(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  from public, anon;
grant execute on function private.make_payout_batch(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  to authenticated;

create function public.make_payout_batch(
  p_organisation_id uuid,
  p_run_id uuid,
  p_batch_id uuid,
  p_bank_format text,
  p_file_sha256 text,
  p_file_bytes integer,
  p_items jsonb,
  p_void_reason text default null,
  p_not_uploaded boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.make_payout_batch(
    p_organisation_id, p_run_id, p_batch_id, p_bank_format, p_file_sha256, p_file_bytes, p_items,
    p_void_reason, p_not_uploaded
  )
$$;

revoke all on function public.make_payout_batch(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  from public, anon;
grant execute on function public.make_payout_batch(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  to authenticated;

-- The active bank file's object name, for the server to open by a 60-second signed URL (owner or
-- finance, trusted session). Audited as payroll.bank_file_downloaded with the batch id only (and
-- the reason, once the run is released). Once released, a download needs a reason (money review
-- L2): the file is already paid and must not be uploaded again.
create function private.payout_file_download(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_reason text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payout_maker(p_organisation_id);
  v_batch public.payout_batches%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select b.* into v_batch
  from public.payout_batches b
  where b.organisation_id = p_organisation_id and b.id = p_batch_id;
  if v_batch.id is null then
    raise exception 'That bank file wasn''t found.' using errcode = 'P0002';
  end if;
  if v_batch.status <> 'active' then
    raise exception 'This file was replaced. Download the current one.' using errcode = 'MLBF5';
  end if;
  if v_reason is not null and (
    char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v_reason ~* '(://|www\.)' or regexp_replace(v_reason, '[^0-9]', '', 'g') ~ '[0-9]{10}'
  ) then
    raise exception 'Say why in up to 500 characters, with no web addresses or account numbers.'
      using errcode = '22023';
  end if;
  if private.payroll_run_status(p_organisation_id, v_batch.run_id) = 'released' and v_reason is null then
    raise exception 'This file is already paid. Say why you need it again; never upload it to the bank again.'
      using errcode = 'MLBFE';
  end if;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.bank_file_downloaded', 'payout_batches', v_batch.id, null,
    jsonb_build_object('batch_id', v_batch.id), v_reason
  );
  return v_batch.file_path;
end;
$$;

revoke all on function private.payout_file_download(uuid, uuid, text) from public, anon;
grant execute on function private.payout_file_download(uuid, uuid, text) to authenticated;

create function public.payout_file_download(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_reason text default null
)
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.payout_file_download(p_organisation_id, p_batch_id, p_reason)
$$;

revoke all on function public.payout_file_download(uuid, uuid, text) from public, anon;
grant execute on function public.payout_file_download(uuid, uuid, text) to authenticated;

-- Who downloaded a run's bank files and when (owner, hr, finance), from the audit log: the Pay
-- step and the make-file preview say "downloaded by … at …" before a file is replaced.
create function private.payout_file_downloads(p_organisation_id uuid, p_run_id uuid)
returns table (batch_id uuid, actor_id uuid, downloaded_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only an owner, HR or Finance sees bank file downloads.' using errcode = '42501';
  end if;
  return query
  select l.entity_id, l.actor_id, l.at
  from public.audit_log l
  join public.payout_batches b on b.organisation_id = l.organisation_id and b.id = l.entity_id
  where l.organisation_id = p_organisation_id and b.run_id = p_run_id
    and l.action = 'payroll.bank_file_downloaded' and l.entity = 'payout_batches'
  order by l.at desc
  limit 500;
end;
$$;

revoke all on function private.payout_file_downloads(uuid, uuid) from public, anon;
grant execute on function private.payout_file_downloads(uuid, uuid) to authenticated;

create function public.payout_file_downloads(p_organisation_id uuid, p_run_id uuid)
returns table (batch_id uuid, actor_id uuid, downloaded_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.payout_file_downloads(p_organisation_id, p_run_id)
$$;

revoke all on function public.payout_file_downloads(uuid, uuid) from public, anon;
grant execute on function public.payout_file_downloads(uuid, uuid) to authenticated;

-- Releases an approved run: Finance or the owner confirms that the bank file named (its id and
-- SHA-256, as the screen showed it) went to the bank. Refused:
--   MLBF8 anyone who prepared or changed the run (rule 10's stricter reading: approval's list);
--   MLBF7 no active file;  MLBFC the file named isn't the active one, or its hash differs (a file
--   replaced while the person was looking: money review H2);  MLBFA whoever made the active file
--   (security review M1; the approver may release);  MLBFD nobody downloaded the active file
--   (money review L1).
-- A retry of the same release (the run released with that file) returns the release's decision
-- instead of failing (money review M2), so the server's idempotent follow-ups run again. Records
-- the decision and returns its id. The server then runs onPayrollReleased (5.5's publication).
create function private.release_payroll_run(
  p_organisation_id uuid,
  p_run_id uuid,
  p_batch_id uuid,
  p_file_sha256 text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payout_maker(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_batch public.payout_batches%rowtype;
  v_id uuid;
begin
  if p_batch_id is null or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Name the bank file you uploaded (its id and SHA-256).' using errcode = '22023';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  select b.* into v_batch
  from public.payout_batches b
  where b.organisation_id = p_organisation_id and b.run_id = p_run_id and b.status = 'active'
  for share;
  if v_run.status = 'released' then
    if v_batch.id = p_batch_id and v_batch.file_sha256 = p_file_sha256 then
      select d.id into v_id
      from public.payroll_run_decisions d
      where d.organisation_id = p_organisation_id and d.run_id = p_run_id
        and d.decision = 'released'
      order by d.created_at desc
      limit 1;
      if v_id is not null then
        return v_id;
      end if;
    end if;
    raise exception 'This run is already released.' using errcode = 'MLBF5';
  end if;
  if v_run.status <> 'approved' then
    raise exception 'Only an approved run is released.' using errcode = 'MLBF5';
  end if;
  if v_uid = any (private.payroll_run_touchers(p_organisation_id, p_run_id)) then
    raise exception 'You prepared or changed this run, so a different person must release it.'
      using errcode = 'MLBF8';
  end if;
  if v_batch.id is null then
    raise exception 'Make the bank file and upload it to the bank before releasing.'
      using errcode = 'MLBF7';
  end if;
  if v_batch.id <> p_batch_id or v_batch.file_sha256 <> p_file_sha256 then
    raise exception 'The bank file changed since you looked. Reload the page, check the control totals and confirm again.'
      using errcode = 'MLBFC';
  end if;
  -- Security review M1: whoever made the file doesn't confirm it went to the bank. (The approver
  -- may release; the preparer may make the file, so P prepares and makes, F approves and releases.)
  if v_uid = v_batch.made_by then
    raise exception 'You made this bank file, so a different person must confirm it went to the bank.'
      using errcode = 'MLBFA';
  end if;
  if not exists (
    select 1 from public.audit_log l
    where l.organisation_id = p_organisation_id and l.action = 'payroll.bank_file_downloaded'
      and l.entity = 'payout_batches' and l.entity_id = v_batch.id
  ) then
    raise exception 'Nobody has downloaded this bank file yet. Download it and upload it to the bank first.'
      using errcode = 'MLBFD';
  end if;

  update public.payroll_runs r
  set status = 'released', released_at = now(), released_by = v_uid
  where r.id = p_run_id;
  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, actor_id, inputs_sha256, gross_kobo, net_kobo, worker_count
  )
  values (
    p_organisation_id, p_run_id, 'released', v_uid, v_run.inputs_sha256, v_run.gross_kobo,
    v_run.net_kobo, v_run.worker_count
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_released', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'decision_id', v_id, 'batch_id', v_batch.id, 'item_count', v_batch.item_count,
      'total_kobo', v_batch.total_kobo::text, 'left_out_count', v_batch.left_out_count,
      'left_out_kobo', v_batch.left_out_kobo::text, 'net_kobo', v_run.net_kobo::text,
      'file_sha256', v_batch.file_sha256
    ),
    null
  );
  return v_id;
end;
$$;

revoke all on function private.release_payroll_run(uuid, uuid, uuid, text) from public, anon;
grant execute on function private.release_payroll_run(uuid, uuid, uuid, text) to authenticated;

create function public.release_payroll_run(
  p_organisation_id uuid,
  p_run_id uuid,
  p_batch_id uuid,
  p_file_sha256 text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.release_payroll_run(p_organisation_id, p_run_id, p_batch_id, p_file_sha256)
$$;

revoke all on function public.release_payroll_run(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.release_payroll_run(uuid, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Sweeping bank files (security review M2)
-- ---------------------------------------------------------------------------

-- Bank files due for removal, oldest first: an object at the bank-file path shape
-- ({organisation_id}/{run_id}/{batch_id}.csv, three uuids) that no batch names, 15 minutes after
-- it was stored (the server stores, then records, within seconds; a refusal deletes at once), and
-- the file of a batch voided 7 days ago or more. Other paths in the bucket (5.6's) are never
-- matched. The secret key only. Storage refuses deletes in SQL, so the server removes the objects
-- through the Storage API (src/server/payroll/payout-sweep.ts: after each file it makes, for that
-- company, and daily from /api/cron/contract-documents), then records the sweep below.
create function private.payroll_files_due(p_organisation_id uuid, p_limit integer)
returns table (organisation_id uuid, path text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null or coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server sweeps bank files.' using errcode = '42501';
  end if;
  return query
  select split_part(o.name, '/', 1)::uuid, o.name,
    case when b.id is null then 'orphan' else 'voided' end
  from storage.objects o
  left join public.payout_batches b on b.file_path = o.name
  where o.bucket_id = 'payroll-files'
    and o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$'
    and (p_organisation_id is null or split_part(o.name, '/', 1) = p_organisation_id::text)
    and (
      (b.id is null and o.created_at < now() - interval '15 minutes')
      or (b.status = 'voided' and b.voided_at < now() - interval '7 days')
    )
  order by o.created_at
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
end;
$$;

revoke all on function private.payroll_files_due(uuid, integer) from public, anon, authenticated;
grant execute on function private.payroll_files_due(uuid, integer) to service_role;

create function public.payroll_files_due(p_organisation_id uuid default null, p_limit integer default 500)
returns table (organisation_id uuid, path text, reason text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.payroll_files_due(p_organisation_id, p_limit)
$$;

revoke all on function public.payroll_files_due(uuid, integer) from public, anon, authenticated;
grant execute on function public.payroll_files_due(uuid, integer) to service_role;

-- One audit row per company per sweep: the paths removed (never a file's contents). The secret
-- key only; the actor is the system (null).
create function private.record_payroll_file_sweep(p_organisation_id uuid, p_paths text[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null or coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server records a sweep.' using errcode = '42501';
  end if;
  if p_organisation_id is null or coalesce(cardinality(p_paths), 0) = 0
    or cardinality(p_paths) > 1000
    or exists (
      select 1 from unnest(p_paths) x
      where x is null or split_part(x, '/', 1) <> p_organisation_id::text
    ) then
    raise exception 'Name the company and the paths removed (its own).' using errcode = '22023';
  end if;
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, null, 'payroll.bank_files_swept', 'payout_batches', null, null,
    jsonb_build_object('paths', to_jsonb(p_paths), 'count', cardinality(p_paths))
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function private.record_payroll_file_sweep(uuid, text[]) from public, anon, authenticated;
grant execute on function private.record_payroll_file_sweep(uuid, text[]) to service_role;

create function public.record_payroll_file_sweep(p_organisation_id uuid, p_paths text[])
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_payroll_file_sweep(p_organisation_id, p_paths)
$$;

revoke all on function public.record_payroll_file_sweep(uuid, text[]) from public, anon, authenticated;
grant execute on function public.record_payroll_file_sweep(uuid, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 7. The bank on a payslip (closes 5.5's TODO(5.4))
-- ---------------------------------------------------------------------------

-- 5.5's private.payslip_view (migration 20261122150000), unchanged but for the bank: before a
-- payslip is frozen (its first PDF, payslip_snapshots), it shows the bank name and last 4 digits
-- the released run's bank file paid (payout_items of the active batch), and the worker record
-- only when no item paid it (left out, or the run not released). payslip_take_snapshot freezes
-- what this view says, so the snapshot takes the payout item's bank too.
create or replace function private.payslip_view(p_organisation_id uuid, p_payslip_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'payslip_id', s.id,
    'run_id', s.run_id,
    'worker_id', s.worker_id,
    'run_status', r.status,
    'period_start', r.period_start,
    'period_end', r.period_end,
    'pay_date', r.pay_date,
    'currency', s.currency,
    'gross_kobo', s.gross_kobo::text,
    'paye_kobo', s.paye_kobo::text,
    'pension_employee_kobo', s.pension_employee_kobo::text,
    'pension_employer_kobo', s.pension_employer_kobo::text,
    'nhf_kobo', s.nhf_kobo::text,
    'other_deductions_kobo', s.other_deductions_kobo::text,
    'net_kobo', s.net_kobo::text,
    'carried_forward_kobo', s.carried_forward_kobo::text,
    'nsitf_kobo', s.nsitf_kobo::text,
    'itf_kobo', s.itf_kobo::text,
    'employment_type', s.employment_type,
    'tax_state', s.tax_state,
    'pfa_name', s.pfa_name,
    'rule_set_name', t.name,
    'organisation', jsonb_build_object(
      'name', o.name, 'legal_name', o.legal_name, 'address', o.address, 'logo_path', o.logo_path
    ),
    'worker', jsonb_build_object(
      'first_name', w.first_name,
      'last_name', w.last_name,
      'staff_id', w.staff_id,
      'job_title', w.job_title,
      -- Frozen with the payslip's first PDF (payslip_snapshots); until then the bank the released
      -- run's bank file paid (slice 5.4's payout item), else the worker record.
      'bank_name', case when sp.payslip_id is null then coalesce(pi.bank_name, w.bank_name)
        else sp.bank_name end,
      'bank_account_last4', case when sp.payslip_id is null
        then coalesce(pi.bank_account_last4, w.bank_account_last4)
        else sp.bank_account_last4 end,
      'rsa_pin_last4', case when sp.payslip_id is null then w.rsa_pin_last4 else sp.rsa_pin_last4 end
    ),
    'annual_rent_kobo', (
      select st -> 'inputs' ->> 'annual_rent_kobo'
      from jsonb_array_elements(
        case when jsonb_typeof(s.trace -> 'steps') = 'array' then s.trace -> 'steps' else '[]'::jsonb end
      ) st
      where st ->> 'step' = 'rent_relief'
      limit 1
    ),
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'position', l.position, 'code', l.code, 'kind', l.kind, 'label', l.label,
          'amount_kobo', l.amount_kobo::text
        )
        order by l.position
      )
      from public.payslip_lines l
      where l.organisation_id = s.organisation_id and l.payslip_id = s.id
    ), '[]'::jsonb),
    -- Year to date (decision "Year to date"): this worker's payslips of RELEASED runs in the
    -- calendar year of this one's pay date, up to and including this one in the order
    -- my_payslips lists them (pay date, then approval time, then id). Only released runs, so an
    -- approved run not released yet never shows through a released payslip's figures. Frozen with
    -- the payslip's first PDF (payslip_snapshots), so a run released later never changes it.
    'year_to_date', case when sp.payslip_id is not null then jsonb_build_object(
        'year', sp.ytd_year,
        'payslips', sp.ytd_payslips,
        'gross_kobo', sp.ytd_gross_kobo::text,
        'paye_kobo', sp.ytd_paye_kobo::text,
        'pension_employee_kobo', sp.ytd_pension_employee_kobo::text,
        'nhf_kobo', sp.ytd_nhf_kobo::text,
        'net_kobo', sp.ytd_net_kobo::text
      ) else (
      select jsonb_build_object(
        'year', extract(year from r.pay_date)::integer,
        'payslips', count(*)::integer,
        'gross_kobo', coalesce(sum(y.gross_kobo), 0)::bigint::text,
        'paye_kobo', coalesce(sum(y.paye_kobo), 0)::bigint::text,
        'pension_employee_kobo', coalesce(sum(y.pension_employee_kobo), 0)::bigint::text,
        'nhf_kobo', coalesce(sum(y.nhf_kobo), 0)::bigint::text,
        'net_kobo', coalesce(sum(y.net_kobo), 0)::bigint::text
      )
      from public.payslips y
      join public.payroll_runs yr on yr.organisation_id = y.organisation_id and yr.id = y.run_id
      where y.organisation_id = s.organisation_id
        and y.worker_id = s.worker_id
        and (y.id = s.id or yr.status = 'released')
        and yr.pay_date >= make_date(extract(year from r.pay_date)::integer, 1, 1)
        and (y.id = s.id or (yr.pay_date, yr.approved_at, y.id) <= (r.pay_date, r.approved_at, s.id))
    ) end,
    'snapshot_at', sp.taken_at,
    'document', (
      select jsonb_build_object('id', d.id, 'made_at', d.made_at)
      from public.payslip_documents d
      where d.organisation_id = s.organisation_id and d.payslip_id = s.id
      order by d.made_at desc, d.id desc
      limit 1
    )
  )
  from public.payslips s
  join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
  join public.workers w on w.organisation_id = s.organisation_id and w.id = s.worker_id
  join public.organisations o on o.id = s.organisation_id
  left join public.tax_rule_sets t on t.organisation_id = s.organisation_id and t.id = s.rule_set_id
  left join public.payslip_snapshots sp
    on sp.organisation_id = s.organisation_id and sp.payslip_id = s.id
  -- The released run's active bank file paid this payslip (an item left out pays nothing).
  left join lateral (
    select i.bank_name, i.bank_account_last4
    from public.payout_items i
    join public.payout_batches b on b.organisation_id = i.organisation_id and b.id = i.batch_id
    where i.organisation_id = s.organisation_id and i.payslip_id = s.id
      and b.status = 'active' and i.status = 'pending' and r.status = 'released'
    limit 1
  ) pi on true
  where s.organisation_id = p_organisation_id and s.id = p_payslip_id
$$;
