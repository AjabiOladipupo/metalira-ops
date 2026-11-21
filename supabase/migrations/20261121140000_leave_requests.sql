-- Slice 4.4: leave requests and balances (docs/PHASE_4.md 4.4).
--
-- 1. `leave_ledger` (insert-only for every role, the secret key and the database owner included):
--    grant, carry_over, taken, returned and adjustment rows in whole days, signed. A balance is the
--    sum of a worker's rows for a type and leave year; it is never stored.
-- 2. `leave_requests`: a worker asks for whole days of one type inside one calendar year. Status
--    moves only inside the functions below: pending_line_manager -> pending_hr -> approved, or
--    declined, or cancelled (by the worker before the final decision, by HR after it).
-- 3. `leave_decisions` (insert-only): each step's decision (line_manager, hr), with a note, the
--    days counted at that moment and the actor.
-- 4. `manager_emails` (insert-only): one row per email sent to managers (a new request to the line
--    manager, step 1 approved to HR). The shared email caps count these as well as the worker
--    inbox emails, so manager mail can't push the account past Resend's daily limit.
--
-- The year (owner decisions 2 and coordinator, 21 Nov 2026):
-- * The leave year is the calendar year. A request lies inside one year (a request that crosses
--   31 December is two requests) and can't be for a year that hasn't started.
-- * `ensure_leave_year` gives each active worker, for each active type, the year's `grant` from
--   the entitlement version in force on 1 January, prorated for a joiner (decision 2, half up).
-- * A version that starts later in the year counts only from its own date: once it is in force it
--   adds an `adjustment` of (new days - old days) x days from that date (or the worker's start, if
--   later) to 31 December / days in the year, rounded half up away from zero. Scheduled versions
--   (not yet in force) add nothing, because they can still be replaced.
-- * A type with a carry-over cap in force on 1 January carries min(last year's remainder, cap),
--   read from last year's ledger as it stands then (no recursion into older years).
-- * It runs from the daily cron (/api/cron/leave-year, 05:00 Lagos) and on the first read of a
--   balance, and is idempotent (one grant, one carry-over per worker, type and year; one
--   adjustment per version).
--
-- Working days (decision 3, mirrored in src/lib/leave/days.ts): a working-day type counts the
-- worker's working days in the range minus the company's public holidays. A day with an assigned
-- shift is a working day; on or before the worker's last rostered day a day without one is an
-- off-day; after it, the worker's usual days (workers.usual_work_days, else the company's
-- default_work_days) stand in. A calendar-day type counts every day. The count is taken again at
-- each approval, and the request keeps the latest count.
--
-- Who decides (decisions 6 and 9): step 1 is the worker's line manager (a line_manager login whose
-- membership or worker record is on the worker); a worker with no line-manager login goes to an
-- owner, admin or ops_manager. Step 2 is HR (owner, admin or hr). Nobody decides their own leave.
--
-- Pay (coordinator, 21 Nov 2026): no money here. The request records the pay_percent of the version
-- in force on its start date and `pay_below_service` when the worker's service at the start is
-- below the version's pay_min_service_months (preset A maternity: unpaid below 6 months). The leave
-- itself is allowed; Phase 5 pays from these fields.
--
-- Refusals (SQLSTATE):
--   MLLQ1 overlaps another live request
--   MLLQ2 not enough days left
--   MLLQ3 the type needs more service
--   MLLQ4 the request isn't at that step (already decided, cancelled, or the other step)
--   MLLQ5 an insert-only row changed or deleted, or a table truncated
--   MLLQ6 your own leave
--   MLLQ7 no days to count in the range
--   MLLQ8 dates: a past start, across the new year, a year not started, too long
--   MLLQ9 a request changed outside the functions
--   22023 bad input
--   42501 the wrong role, or an untrusted session
--   P0002 not found in the organisation

-- ---------------------------------------------------------------------------
-- 1. Shared pure helpers
-- ---------------------------------------------------------------------------

-- Plain text a person types (a reason or note): trimmed, 1 to p_max characters, no control
-- characters except line breaks, no angle brackets, no web addresses and no run of 10 or more
-- digits (rule 9: no personal numbers; the inbox rule). Null when empty or when it fails.
create function private.leave_clean_text(p_text text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when nullif(btrim(p_text), '') is null then null
    when char_length(btrim(p_text)) > p_max then null
    when regexp_replace(btrim(p_text), '\n', '', 'g') ~ '[\x01-\x1f\x7f-\x9f<>]' then null
    when btrim(p_text) ~* '(://|www\.)' then null
    when btrim(p_text) ~ '[0-9]([ -]*[0-9]){9,}' then null
    else btrim(p_text)
  end
$$;

revoke all on function private.leave_clean_text(text, integer) from public, anon;
-- The tables' CHECK constraints call it, so the roles that write rows need it (pure).
grant execute on function private.leave_clean_text(text, integer) to authenticated, service_role;

-- A joiner's share of p_days for p_year (decision 2; src/lib/leave/entitlements.ts
-- prorateEntitlement): days x days from p_from to 31 Dec / days in the year, half up. A negative
-- p_days rounds half away from zero (the adjustment for a version that lowers the days).
create function private.leave_prorate(p_days integer, p_from date, p_year integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_days is null or p_from is null or p_year is null then 0
    when p_from <= make_date(p_year, 1, 1) then p_days
    when p_from > make_date(p_year, 12, 31) then 0
    else sign(p_days)::integer * floor(
      (2 * abs(p_days)::bigint * ((make_date(p_year, 12, 31) - p_from) + 1)
        + (make_date(p_year, 12, 31) - make_date(p_year, 1, 1) + 1))
      / (2 * (make_date(p_year, 12, 31) - make_date(p_year, 1, 1) + 1))::numeric
    )::integer
  end
$$;

revoke all on function private.leave_prorate(integer, date, integer) from public, anon, authenticated;

-- Whole months of service from p_start to p_at (0 before the start).
create function private.leave_service_months(p_start date, p_at date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_start is null or p_at is null or p_at < p_start then 0
    else (extract(year from age(p_at, p_start)) * 12 + extract(month from age(p_at, p_start)))::integer
  end
$$;

revoke all on function private.leave_service_months(date, date) from public, anon, authenticated;

-- "4 to 6 Nov 2026", "4 Nov 2026" (one day), "28 Oct to 3 Nov 2026".
create function private.leave_range_label(p_start date, p_end date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_start = p_end then to_char(p_start, 'FMDD Mon YYYY')
    when date_trunc('month', p_start) = date_trunc('month', p_end)
      then to_char(p_start, 'FMDD') || ' to ' || to_char(p_end, 'FMDD Mon YYYY')
    else to_char(p_start, 'FMDD Mon') || ' to ' || to_char(p_end, 'FMDD Mon YYYY')
  end
$$;

revoke all on function private.leave_range_label(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  leave_type_id uuid not null,
  leave_year integer not null
    constraint leave_requests_year_range check (leave_year between 2000 and 2100),
  start_date date not null,
  end_date date not null,
  -- Whole days (decision 3), counted when asked and again at each approval.
  days integer not null
    constraint leave_requests_days_range check (days between 1 and 366),
  -- Optional, plain text (the worker's words).
  reason text
    constraint leave_requests_reason_text check (
      reason is null or reason = private.leave_clean_text(reason, 500)
    ),
  status text not null default 'pending_line_manager'
    constraint leave_requests_status_values check (
      status in ('pending_line_manager', 'pending_hr', 'approved', 'declined', 'cancelled')
    ),
  -- Ticked by an approver on a type that needs a certificate (no attachments in Phase 4).
  certificate_seen boolean not null default false,
  -- For Phase 5 (no money here): the version's pay on the start date, and whether the worker's
  -- service then is below the service the pay needs.
  pay_percent integer not null
    constraint leave_requests_pay_range check (pay_percent between 0 and 100),
  pay_below_service boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  decided_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text
    constraint leave_requests_cancel_reason_text check (
      cancel_reason is null or cancel_reason = private.leave_clean_text(cancel_reason, 500)
    ),
  updated_at timestamptz not null default now(),
  constraint leave_requests_organisation_id_id_key unique (organisation_id, id),
  constraint leave_requests_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint leave_requests_type_fkey foreign key (organisation_id, leave_type_id)
    references public.leave_types (organisation_id, id),
  constraint leave_requests_dates check (end_date >= start_date),
  constraint leave_requests_one_year check (
    extract(year from start_date) = leave_year and extract(year from end_date) = leave_year
  ),
  constraint leave_requests_cancelled_pair check (
    (status = 'cancelled') = (cancelled_at is not null)
  ),
  -- No two live requests of one worker on the same day.
  constraint leave_requests_no_overlap exclude using gist (
    worker_id with =,
    daterange(start_date, end_date, '[]') with &&
  ) where (status in ('pending_line_manager', 'pending_hr', 'approved'))
);

create index leave_requests_org_status_idx on public.leave_requests (organisation_id, status, start_date);
create index leave_requests_worker_idx on public.leave_requests (worker_id, start_date);

comment on table public.leave_requests is
  'A worker''s request for whole days of one leave type inside one calendar year (slice 4.4). Line manager, then HR. Status moves only inside the leave functions; never deleted.';

create table public.leave_decisions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  request_id uuid not null,
  -- Copied from the request, for row-level security by worker.
  worker_id uuid not null,
  step text not null
    constraint leave_decisions_step_values check (step in ('line_manager', 'hr')),
  decision text not null
    constraint leave_decisions_decision_values check (decision in ('approved', 'declined')),
  note text
    constraint leave_decisions_note_text check (
      note is null or note = private.leave_clean_text(note, 500)
    ),
  certificate_seen boolean not null default false,
  -- The days counted when the decision was made.
  days integer not null
    constraint leave_decisions_days_range check (days between 0 and 366),
  actor uuid not null,
  created_at timestamptz not null default now(),
  constraint leave_decisions_organisation_id_id_key unique (organisation_id, id),
  constraint leave_decisions_request_fkey foreign key (organisation_id, request_id)
    references public.leave_requests (organisation_id, id),
  constraint leave_decisions_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint leave_decisions_one_per_step unique (request_id, step)
);

comment on table public.leave_decisions is
  'Each step''s decision on a leave request (slice 4.4). Insert-only for every role.';

create table public.leave_ledger (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  leave_type_id uuid not null,
  leave_year integer not null
    constraint leave_ledger_year_range check (leave_year between 2000 and 2100),
  kind text not null
    constraint leave_ledger_kind_values check (
      kind in ('grant', 'carry_over', 'taken', 'returned', 'adjustment')
    ),
  -- Whole days, signed: grant and carry_over 0 or more, taken below 0, returned above 0, an
  -- adjustment either way but never 0.
  days integer not null
    constraint leave_ledger_days_range check (days between -366 and 366),
  request_id uuid,
  -- The entitlement version a grant or a system adjustment came from.
  entitlement_id uuid,
  reason text
    constraint leave_ledger_reason_text check (
      reason is null or reason = private.leave_clean_text(reason, 500)
    ),
  -- Null for rows the system writes (the yearly grant, carry-over and version adjustments).
  actor uuid,
  created_at timestamptz not null default now(),
  constraint leave_ledger_organisation_id_id_key unique (organisation_id, id),
  constraint leave_ledger_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint leave_ledger_type_fkey foreign key (organisation_id, leave_type_id)
    references public.leave_types (organisation_id, id),
  constraint leave_ledger_request_fkey foreign key (organisation_id, request_id)
    references public.leave_requests (organisation_id, id),
  constraint leave_ledger_entitlement_fkey foreign key (organisation_id, entitlement_id)
    references public.leave_entitlements (organisation_id, id),
  constraint leave_ledger_signs check (
    case kind
      when 'grant' then days >= 0
      when 'carry_over' then days >= 0
      when 'taken' then days < 0 and request_id is not null
      when 'returned' then days > 0 and request_id is not null
      else days <> 0 and reason is not null
    end
  )
);

-- Idempotency of the yearly rows and one taken / returned row per request.
create unique index leave_ledger_grant_key
  on public.leave_ledger (worker_id, leave_type_id, leave_year) where kind = 'grant';
create unique index leave_ledger_carry_key
  on public.leave_ledger (worker_id, leave_type_id, leave_year) where kind = 'carry_over';
create unique index leave_ledger_version_adjustment_key
  on public.leave_ledger (worker_id, leave_type_id, leave_year, entitlement_id)
  where kind = 'adjustment' and entitlement_id is not null;
create unique index leave_ledger_taken_key on public.leave_ledger (request_id) where kind = 'taken';
create unique index leave_ledger_returned_key on public.leave_ledger (request_id) where kind = 'returned';
create index leave_ledger_balance_idx on public.leave_ledger (organisation_id, worker_id, leave_year);

comment on table public.leave_ledger is
  'Leave days granted, carried over, taken, returned and adjusted (slice 4.4), whole days, signed. Insert-only for every role. A balance is the sum, never stored.';

create table public.manager_emails (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  -- What the email was about (leave_line_manager, leave_hr, ...).
  kind text not null
    constraint manager_emails_kind_format check (kind ~ '^[a-z][a-z_]{1,39}$'),
  -- The record it was about (a leave request): one claim per kind and record.
  ref_id uuid not null,
  recipients integer not null
    constraint manager_emails_recipients_range check (recipients between 1 and 10),
  created_at timestamptz not null default now(),
  constraint manager_emails_organisation_id_id_key unique (organisation_id, id),
  constraint manager_emails_once unique (kind, ref_id)
);

create index manager_emails_created_idx on public.manager_emails (created_at);

comment on table public.manager_emails is
  'Emails sent to managers (slice 4.4: new leave requests, step 1 approvals), counted with worker inbox emails against the shared daily caps. No addresses or text. Insert-only.';

-- ---------------------------------------------------------------------------
-- 3. Guards: insert-only rows, requests changed only by the functions
-- ---------------------------------------------------------------------------

create function private.leave_insert_only_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'These rows are kept as written. Add a new row instead.' using errcode = 'MLLQ5';
end;
$$;

revoke all on function private.leave_insert_only_guard() from public, anon, authenticated;

create trigger leave_ledger_insert_only before update or delete on public.leave_ledger
  for each row execute function private.leave_insert_only_guard();
create trigger leave_ledger_no_truncate before truncate on public.leave_ledger
  for each statement execute function private.leave_insert_only_guard();
create trigger leave_decisions_insert_only before update or delete on public.leave_decisions
  for each row execute function private.leave_insert_only_guard();
create trigger leave_decisions_no_truncate before truncate on public.leave_decisions
  for each statement execute function private.leave_insert_only_guard();
create trigger manager_emails_insert_only before update or delete on public.manager_emails
  for each row execute function private.leave_insert_only_guard();
create trigger manager_emails_no_truncate before truncate on public.manager_emails
  for each statement execute function private.leave_insert_only_guard();
create trigger leave_requests_no_truncate before truncate on public.leave_requests
  for each statement execute function private.leave_insert_only_guard();

-- BEFORE INSERT/UPDATE/DELETE on leave_requests:
-- * a new request starts at pending_line_manager, with nothing decided or cancelled;
-- * never deleted;
-- * only the status, the latest count of days, certificate_seen, the pay fields, decided_at and the
--   cancellation fields change, and only through one of the allowed moves:
--   pending_line_manager -> pending_hr | declined | cancelled; pending_hr -> approved | declined |
--   cancelled; approved -> cancelled. The days and pay change only with a move. The functions
--   below make the moves; nobody else holds update rights.
create function private.leave_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending_line_manager' or new.certificate_seen or new.decided_at is not null
      or new.cancelled_at is not null or new.cancelled_by is not null
      or new.cancel_reason is not null then
      raise exception 'A new leave request waits for the line manager.' using errcode = 'MLLQ9';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A leave request is never deleted. Cancel it instead.' using errcode = 'MLLQ9';
  end if;
  if (
    new.id, new.organisation_id, new.worker_id, new.leave_type_id, new.leave_year,
    new.start_date, new.end_date, new.reason, new.created_at, new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.worker_id, old.leave_type_id, old.leave_year,
    old.start_date, old.end_date, old.reason, old.created_at, old.created_by
  ) then
    raise exception 'A leave request''s dates and type never change. Cancel it and ask again.'
      using errcode = 'MLLQ9';
  end if;
  if new.status = old.status then
    raise exception 'A leave request changes only when it is decided or cancelled.'
      using errcode = 'MLLQ9';
  end if;
  if not (
    (old.status = 'pending_line_manager' and new.status in ('pending_hr', 'declined', 'cancelled'))
    or (old.status = 'pending_hr' and new.status in ('approved', 'declined', 'cancelled'))
    or (old.status = 'approved' and new.status = 'cancelled')
  ) then
    raise exception 'This leave request was already decided.' using errcode = 'MLLQ4';
  end if;
  if old.certificate_seen and not new.certificate_seen then
    raise exception 'Certificate seen stays ticked.' using errcode = 'MLLQ9';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.leave_requests_guard() from public, anon, authenticated;

create trigger leave_requests_guard
  before insert or update or delete on public.leave_requests
  for each row execute function private.leave_requests_guard();

create trigger leave_requests_audit after insert or update or delete on public.leave_requests
  for each row execute function private.audit_row_change();
create trigger leave_decisions_audit after insert or update or delete on public.leave_decisions
  for each row execute function private.audit_row_change();
create trigger leave_ledger_audit after insert or update or delete on public.leave_ledger
  for each row execute function private.audit_row_change();
create trigger manager_emails_audit after insert or update or delete on public.manager_emails
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.leave_requests enable row level security;
alter table public.leave_decisions enable row level security;
alter table public.leave_ledger enable row level security;
alter table public.manager_emails enable row level security;

-- Owner, admin and hr; the line manager for their reportees; the worker their own. ops_manager
-- reads dates and type only, through public.leave_request_list.
create policy leave_requests_select on public.leave_requests for select to authenticated
  using (
    organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr']))
    or worker_id in (select private.my_reportee_ids())
    or worker_id in (select private.my_worker_ids())
  );

create policy leave_decisions_select on public.leave_decisions for select to authenticated
  using (
    organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr']))
    or worker_id in (select private.my_reportee_ids())
    or worker_id in (select private.my_worker_ids())
  );

create policy leave_ledger_select on public.leave_ledger for select to authenticated
  using (
    organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr']))
    or worker_id in (select private.my_reportee_ids())
    or worker_id in (select private.my_worker_ids())
  );

create policy manager_emails_select on public.manager_emails for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'admin'])));

revoke all on table public.leave_requests from anon, authenticated;
revoke all on table public.leave_decisions from anon, authenticated;
revoke all on table public.leave_ledger from anon, authenticated;
revoke all on table public.manager_emails from anon, authenticated;
grant select on table public.leave_requests to authenticated;
grant select on table public.leave_decisions to authenticated;
grant select on table public.leave_ledger to authenticated;
grant select on table public.manager_emails to authenticated;

-- The secret key may insert (the isolation registry seeds rows that way) but never change,
-- delete or truncate; the triggers refuse the database owner too.
revoke update, delete, truncate on table public.leave_requests from service_role;
revoke update, delete, truncate on table public.leave_decisions from service_role;
revoke update, delete, truncate on table public.leave_ledger from service_role;
revoke update, delete, truncate on table public.manager_emails from service_role;

-- ---------------------------------------------------------------------------
-- 5. Counting days, versions, balances
-- ---------------------------------------------------------------------------

-- The entitlement version of a type in force on a date.
create function private.leave_version_on(p_leave_type_id uuid, p_date date)
returns public.leave_entitlements
language sql
stable
security definer
set search_path = ''
as $$
  select e.*
  from public.leave_entitlements e
  where e.leave_type_id = p_leave_type_id
    and e.effective_from <= p_date
    and (e.effective_to is null or e.effective_to >= p_date)
  limit 1
$$;

revoke all on function private.leave_version_on(uuid, date) from public, anon, authenticated;

-- The days a request covers (decision 3; src/lib/leave/days.ts countLeaveDays), the rostered
-- shifts in the range and their sites. No role check: callers check first.
create function private.leave_count_days(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_counting text,
  p_from date,
  p_to date
)
returns table (days integer, shifts integer, site_names text[])
language sql
stable
security definer
set search_path = ''
as $$
  with worker as (
    select coalesce(w.usual_work_days, o.default_work_days) as work_days
    from public.workers w
    join public.organisations o on o.id = w.organisation_id
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  ),
  last_rostered as (
    select max(sa.shift_date) as last_day
    from public.shift_assignments sa
    where sa.organisation_id = p_organisation_id and sa.worker_id = p_worker_id
      and sa.status = 'assigned'
  ),
  assigned as (
    select sa.shift_date, sa.site_id
    from public.shift_assignments sa
    where sa.organisation_id = p_organisation_id and sa.worker_id = p_worker_id
      and sa.status = 'assigned' and sa.shift_date between p_from and p_to
  ),
  holidays as (
    select h.holiday_date
    from public.public_holidays h
    where h.organisation_id = p_organisation_id and h.removed_at is null
      and h.holiday_date between p_from and p_to
  ),
  span as (
    select d::date as day
    from generate_series(p_from, p_to, interval '1 day') d
  )
  select
    case
      when p_counting = 'calendar_days' then (select count(*) from span)::integer
      else (
        select count(*)
        from span s, worker wk, last_rostered lr
        where s.day not in (select holiday_date from holidays)
          and (
            s.day in (select shift_date from assigned)
            or (
              (lr.last_day is null or s.day > lr.last_day)
              and extract(isodow from s.day)::smallint = any (wk.work_days)
            )
          )
      )::integer
    end,
    (select count(*) from assigned)::integer,
    coalesce((
      select array_agg(distinct si.name order by si.name)
      from assigned a
      join public.sites si on si.organisation_id = p_organisation_id and si.id = a.site_id
    ), '{}'::text[])
$$;

revoke all on function private.leave_count_days(uuid, uuid, text, date, date)
  from public, anon, authenticated;

-- A worker's balance of a type for a year: the sum of the ledger.
create function private.leave_balance(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_leave_type_id uuid,
  p_year integer
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.days), 0)::integer
  from public.leave_ledger l
  where l.organisation_id = p_organisation_id and l.worker_id = p_worker_id
    and l.leave_type_id = p_leave_type_id and l.leave_year = p_year
$$;

revoke all on function private.leave_balance(uuid, uuid, uuid, integer) from public, anon, authenticated;

-- Days of a worker's requests of a type and year still waiting for a decision (not yet in the
-- ledger), leaving out p_except.
create function private.leave_pending_days(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_leave_type_id uuid,
  p_year integer,
  p_except uuid
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(r.days), 0)::integer
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.worker_id = p_worker_id
    and r.leave_type_id = p_leave_type_id and r.leave_year = p_year
    and r.status in ('pending_line_manager', 'pending_hr')
    and r.id is distinct from p_except
$$;

revoke all on function private.leave_pending_days(uuid, uuid, uuid, integer, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The leave year
-- ---------------------------------------------------------------------------

-- Grants, carry-over and version adjustments for p_year, for every active worker of the company
-- (p_worker_ids null) or the ones listed. Idempotent. Years after this one are skipped (their
-- versions can still change). No role check: the callers check. Returns the rows added.
create function private.leave_ensure_year_core(
  p_organisation_id uuid,
  p_year integer,
  p_worker_ids uuid[] default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := private.org_today(p_organisation_id);
  v_jan1 date;
  v_dec31 date;
  v_added integer := 0;
  v_n integer;
begin
  if p_organisation_id is null or p_year is null or p_year not between 2000 and 2100
    or p_year > extract(year from v_today)::integer then
    return 0;
  end if;
  v_jan1 := make_date(p_year, 1, 1);
  v_dec31 := make_date(p_year, 12, 31);

  -- The grant, from the version in force on 1 January, prorated for a joiner.
  insert into public.leave_ledger (
    organisation_id, worker_id, leave_type_id, leave_year, kind, days, entitlement_id
  )
  select w.organisation_id, w.id, t.id, p_year, 'grant',
    private.leave_prorate(e.days_per_year, w.start_date, p_year), e.id
  from public.workers w
  join public.leave_types t on t.organisation_id = w.organisation_id and t.status = 'active'
  join public.leave_entitlements e
    on e.leave_type_id = t.id and e.effective_from <= v_jan1
   and (e.effective_to is null or e.effective_to >= v_jan1)
  where w.organisation_id = p_organisation_id
    and w.status = 'active'
    and w.start_date <= v_dec31
    and (p_worker_ids is null or w.id = any (p_worker_ids))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  -- Carry-over: min(last year's remainder, the cap in force on 1 January), once, where last year
  -- has rows.
  insert into public.leave_ledger (
    organisation_id, worker_id, leave_type_id, leave_year, kind, days, entitlement_id
  )
  select w.organisation_id, w.id, t.id, p_year, 'carry_over',
    least(greatest(prev.remainder, 0), e.carry_over_cap_days), e.id
  from public.workers w
  join public.leave_types t on t.organisation_id = w.organisation_id and t.status = 'active'
  join public.leave_entitlements e
    on e.leave_type_id = t.id and e.effective_from <= v_jan1
   and (e.effective_to is null or e.effective_to >= v_jan1)
  join lateral (
    select sum(l.days)::integer as remainder
    from public.leave_ledger l
    where l.organisation_id = w.organisation_id and l.worker_id = w.id
      and l.leave_type_id = t.id and l.leave_year = p_year - 1
    having count(*) > 0
  ) prev on true
  where w.organisation_id = p_organisation_id
    and w.status = 'active'
    and w.start_date <= v_dec31
    and e.carry_over_cap_days is not null
    and (p_worker_ids is null or w.id = any (p_worker_ids))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  -- A version that started after 1 January and is in force now (or has been): the difference from
  -- the version before it, prorated from its date (or the worker's start, if later).
  insert into public.leave_ledger (
    organisation_id, worker_id, leave_type_id, leave_year, kind, days, entitlement_id, reason
  )
  select w.organisation_id, w.id, t.id, p_year, 'adjustment', x.adj, v.id,
    'Days a year changed from ' || coalesce(prev.days_per_year, 0) || ' to ' || v.days_per_year
      || ' on ' || to_char(v.effective_from, 'FMDD Mon YYYY')
  from public.workers w
  join public.leave_types t on t.organisation_id = w.organisation_id and t.status = 'active'
  join public.leave_entitlements v
    on v.leave_type_id = t.id and v.effective_from > v_jan1 and v.effective_from <= v_dec31
   and v.effective_from <= v_today
  left join lateral (
    select e.days_per_year
    from public.leave_entitlements e
    where e.leave_type_id = t.id and e.effective_from < v.effective_from
    order by e.effective_from desc
    limit 1
  ) prev on true
  cross join lateral (
    select private.leave_prorate(
      v.days_per_year - coalesce(prev.days_per_year, 0),
      greatest(v.effective_from, w.start_date),
      p_year
    ) as adj
  ) x
  where w.organisation_id = p_organisation_id
    and w.status = 'active'
    and w.start_date <= v_dec31
    and x.adj <> 0
    and (p_worker_ids is null or w.id = any (p_worker_ids))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  return v_added;
end;
$$;

revoke all on function private.leave_ensure_year_core(uuid, integer, uuid[])
  from public, anon, authenticated;

-- The cron's call (secret key, no session) or an owner, admin or hr in a trusted session.
create function private.ensure_leave_year(p_organisation_id uuid, p_year integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    perform private.require_leave_setup_role(p_organisation_id);
  end if;
  if p_organisation_id is null or not exists (
    select 1 from public.organisations o where o.id = p_organisation_id
  ) then
    raise exception 'That company wasn''t found.' using errcode = 'P0002';
  end if;
  if p_year is null or p_year not between 2000 and 2100 then
    raise exception 'Choose a year between 2000 and 2100.' using errcode = '22023';
  end if;
  perform set_config('metalira.audit_channel', 'system', true);
  perform pg_advisory_xact_lock(hashtextextended('leave_year:' || p_organisation_id::text, 0));
  return private.leave_ensure_year_core(p_organisation_id, p_year, null);
end;
$$;

revoke all on function private.ensure_leave_year(uuid, integer) from public, anon;
grant execute on function private.ensure_leave_year(uuid, integer) to authenticated, service_role;

create function public.ensure_leave_year(p_organisation_id uuid, p_year integer)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.ensure_leave_year(p_organisation_id, p_year)
$$;

revoke all on function public.ensure_leave_year(uuid, integer) from public, anon;
grant execute on function public.ensure_leave_year(uuid, integer) to authenticated, service_role;

-- Companies with an active leave type, for the cron to work through in chunks (secret key only).
create function private.leave_year_organisations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct t.organisation_id
  from public.leave_types t
  join public.organisations o on o.id = t.organisation_id
  where t.status = 'active' and o.people_enabled
  order by 1
$$;

revoke all on function private.leave_year_organisations() from public, anon, authenticated;
grant execute on function private.leave_year_organisations() to service_role;

create function public.leave_year_organisations()
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.leave_year_organisations()
$$;

revoke all on function public.leave_year_organisations() from public, anon, authenticated;
grant execute on function public.leave_year_organisations() to service_role;

-- ---------------------------------------------------------------------------
-- 7. Who may see and decide
-- ---------------------------------------------------------------------------

-- Does the worker have a line manager who can sign in (a line_manager login whose membership or
-- worker record is on the worker)? Otherwise step 1 falls to an owner, admin or ops_manager.
create function private.leave_has_line_manager(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workers w
    join public.memberships m
      on m.organisation_id = w.organisation_id and m.role = 'line_manager'
     and (
       m.id = w.line_manager_membership_id
       or (m.worker_id is not null and m.worker_id = w.line_manager_worker_id)
     )
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  )
$$;

revoke all on function private.leave_has_line_manager(uuid, uuid) from public, anon, authenticated;

-- Is the caller (trusted session) the worker's line manager in this company?
create function private.leave_is_my_reportee(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.my_line_manager_keys() k
    join public.workers w
      on w.organisation_id = k.organisation_id
     and (
       w.line_manager_membership_id = k.membership_id
       or (k.worker_id is not null and w.line_manager_worker_id = k.worker_id)
     )
    where k.organisation_id = p_organisation_id and w.id = p_worker_id
  )
$$;

revoke all on function private.leave_is_my_reportee(uuid, uuid) from public, anon, authenticated;

-- May the caller decide step 1 for this worker? Their line manager; with none, an owner, admin or
-- ops_manager. Never the worker themselves.
create function private.leave_can_decide_step1(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_uid() is not null
    and p_worker_id not in (select private.my_worker_ids())
    and case
      when private.leave_has_line_manager(p_organisation_id, p_worker_id)
        then private.leave_is_my_reportee(p_organisation_id, p_worker_id)
      else private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager'])
    end
$$;

revoke all on function private.leave_can_decide_step1(uuid, uuid) from public, anon, authenticated;

-- May the caller decide step 2 (HR) for this worker? Owner, admin or hr, never for themselves.
create function private.leave_can_decide_step2(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_uid() is not null
    and p_worker_id not in (select private.my_worker_ids())
    and private.has_role(p_organisation_id, array['owner', 'admin', 'hr'])
$$;

revoke all on function private.leave_can_decide_step2(uuid, uuid) from public, anon, authenticated;

-- May the caller read this worker's leave? Owner, admin, hr and ops_manager (ops for the
-- roster), their line manager, or the worker.
create function private.leave_can_read_worker(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.session_uid() is not null and (
    private.has_role(p_organisation_id, array['owner', 'admin', 'hr', 'ops_manager'])
    or private.leave_is_my_reportee(p_organisation_id, p_worker_id)
    or p_worker_id in (
      select m.worker_id from public.memberships m
      where m.organisation_id = p_organisation_id and m.user_id = private.session_uid()
        and m.worker_id is not null
    )
  )
$$;

revoke all on function private.leave_can_read_worker(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Reads
-- ---------------------------------------------------------------------------

-- Balances for p_year: the worker's own (a worker login), every active worker's or the listed
-- ones (owner, admin, hr) or the caller's reportees (line_manager). Ensures the year first, so the
-- first read of a balance grants it. Returns one row per worker and active type:
-- granted (grant + carry-over), adjusted, taken (net of returns, as a positive number), pending
-- (waiting for a decision), balance (the ledger sum) and available (balance - pending).
create function private.leave_balances(
  p_organisation_id uuid,
  p_year integer,
  p_worker_ids uuid[] default null
)
returns table (
  worker_id uuid,
  leave_type_id uuid,
  granted integer,
  carried integer,
  adjusted integer,
  taken integer,
  pending integer,
  balance integer,
  available integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_workers uuid[];
  v_own uuid;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to see leave balances.' using errcode = '42501';
  end if;
  if p_year is null or p_year not between 2000 and 2100 then
    raise exception 'Choose a year between 2000 and 2100.' using errcode = '22023';
  end if;

  select m.worker_id into v_own
  from public.memberships m
  where m.organisation_id = p_organisation_id and m.user_id = private.session_uid()
    and m.role = 'worker' and m.worker_id is not null;

  if v_own is not null then
    v_workers := array[v_own];
  elsif private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    select array_agg(w.id) into v_workers
    from public.workers w
    where w.organisation_id = p_organisation_id
      and (
        (p_worker_ids is null and w.status = 'active')
        or w.id = any (coalesce(p_worker_ids, '{}'::uuid[]))
      );
  elsif private.has_role(p_organisation_id, array['line_manager']) then
    select array_agg(r.id) into v_workers
    from private.my_reportee_ids() r(id)
    join public.workers w on w.id = r.id and w.organisation_id = p_organisation_id
    where (p_worker_ids is null and w.status = 'active')
      or w.id = any (coalesce(p_worker_ids, '{}'::uuid[]));
  else
    raise exception 'Your role can''t see leave balances.' using errcode = '42501';
  end if;

  if v_workers is null or cardinality(v_workers) = 0 then
    return;
  end if;
  perform private.leave_ensure_year_core(p_organisation_id, p_year, v_workers);

  return query
  select w.id, t.id,
    coalesce(sum(l.days) filter (where l.kind = 'grant'), 0)::integer,
    coalesce(sum(l.days) filter (where l.kind = 'carry_over'), 0)::integer,
    coalesce(sum(l.days) filter (where l.kind = 'adjustment'), 0)::integer,
    (-coalesce(sum(l.days) filter (where l.kind in ('taken', 'returned')), 0))::integer,
    private.leave_pending_days(p_organisation_id, w.id, t.id, p_year, null),
    coalesce(sum(l.days), 0)::integer,
    (coalesce(sum(l.days), 0) - private.leave_pending_days(p_organisation_id, w.id, t.id, p_year, null))::integer
  from public.workers w
  join public.leave_types t on t.organisation_id = w.organisation_id and t.status = 'active'
  left join public.leave_ledger l
    on l.organisation_id = w.organisation_id and l.worker_id = w.id and l.leave_type_id = t.id
   and l.leave_year = p_year
  where w.organisation_id = p_organisation_id and w.id = any (v_workers)
  group by w.id, t.id, t.name
  order by w.id, t.name;
end;
$$;

revoke all on function private.leave_balances(uuid, integer, uuid[]) from public, anon;
grant execute on function private.leave_balances(uuid, integer, uuid[]) to authenticated;

create function public.leave_balances(
  p_organisation_id uuid,
  p_year integer,
  p_worker_ids uuid[] default null
)
returns table (
  worker_id uuid,
  leave_type_id uuid,
  granted integer,
  carried integer,
  adjusted integer,
  taken integer,
  pending integer,
  balance integer,
  available integer
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.leave_balances(p_organisation_id, p_year, p_worker_ids)
$$;

revoke all on function public.leave_balances(uuid, integer, uuid[]) from public, anon;
grant execute on function public.leave_balances(uuid, integer, uuid[]) to authenticated;

-- What the worker's request form needs to count days on the phone as they type
-- (src/lib/leave/days.ts): their working week, last rostered day, the company's holidays and
-- their assigned shifts from p_from to p_to (at most 400 days). The worker only.
create function private.my_leave_calendar(p_organisation_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_worker uuid := private.my_worker_in(p_organisation_id);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose up to 400 days.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'today', private.org_today(p_organisation_id),
    'work_days', (
      select to_jsonb(coalesce(w.usual_work_days, o.default_work_days))
      from public.workers w join public.organisations o on o.id = w.organisation_id
      where w.id = v_worker
    ),
    'start_date', (select w.start_date from public.workers w where w.id = v_worker),
    -- Who decides step 1, by name, or null when nobody is set (an owner, admin or ops_manager
    -- decides then).
    'line_manager_name', (
      select case when private.leave_has_line_manager(w.organisation_id, w.id) then coalesce(
        nullif(btrim(lmw.first_name || ' ' || lmw.last_name), ''),
        nullif(btrim(lmp.full_name), '')
      ) end
      from public.workers w
      left join public.workers lmw
        on lmw.organisation_id = w.organisation_id and lmw.id = w.line_manager_worker_id
      left join public.memberships lmm
        on lmm.organisation_id = w.organisation_id and lmm.id = w.line_manager_membership_id
      left join public.profiles lmp on lmp.user_id = lmm.user_id
      where w.id = v_worker
    ),
    'last_rostered', (
      select max(sa.shift_date) from public.shift_assignments sa
      where sa.organisation_id = p_organisation_id and sa.worker_id = v_worker
        and sa.status = 'assigned'
    ),
    'holidays', coalesce((
      select jsonb_agg(jsonb_build_object('date', h.holiday_date, 'name', h.name)
        order by h.holiday_date)
      from public.public_holidays h
      where h.organisation_id = p_organisation_id and h.removed_at is null
        and h.holiday_date between p_from and p_to
    ), '[]'::jsonb),
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object('date', sa.shift_date, 'site', si.name)
        order by sa.shift_date, si.name)
      from public.shift_assignments sa
      join public.sites si on si.organisation_id = sa.organisation_id and si.id = sa.site_id
      where sa.organisation_id = p_organisation_id and sa.worker_id = v_worker
        and sa.status = 'assigned' and sa.shift_date between p_from and p_to
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function private.my_leave_calendar(uuid, date, date) from public, anon;
grant execute on function private.my_leave_calendar(uuid, date, date) to authenticated;

create function public.my_leave_calendar(p_organisation_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.my_leave_calendar(p_organisation_id, p_from, p_to)
$$;

revoke all on function public.my_leave_calendar(uuid, date, date) from public, anon;
grant execute on function public.my_leave_calendar(uuid, date, date) to authenticated;

-- The days a range covers for one worker and type, counted now, with the rostered shifts and
-- their sites: for the manager's decision screen. Anyone who may read the worker's leave.
create function private.leave_day_count(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_leave_type_id uuid,
  p_from date,
  p_to date
)
returns table (days integer, shifts integer, site_names text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counting text;
begin
  if not private.leave_can_read_worker(p_organisation_id, p_worker_id) then
    raise exception 'Your role can''t see this worker''s leave.' using errcode = '42501';
  end if;
  select t.counting into v_counting
  from public.leave_types t
  where t.organisation_id = p_organisation_id and t.id = p_leave_type_id;
  if v_counting is null then
    raise exception 'That leave type wasn''t found.' using errcode = 'P0002';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose up to a year of dates.' using errcode = '22023';
  end if;
  return query
  select c.days, c.shifts, c.site_names
  from private.leave_count_days(p_organisation_id, p_worker_id, v_counting, p_from, p_to) c;
end;
$$;

revoke all on function private.leave_day_count(uuid, uuid, uuid, date, date) from public, anon;
grant execute on function private.leave_day_count(uuid, uuid, uuid, date, date) to authenticated;

create function public.leave_day_count(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_leave_type_id uuid,
  p_from date,
  p_to date
)
returns table (days integer, shifts integer, site_names text[])
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.leave_day_count(p_organisation_id, p_worker_id, p_leave_type_id, p_from, p_to)
$$;

revoke all on function public.leave_day_count(uuid, uuid, uuid, date, date) from public, anon;
grant execute on function public.leave_day_count(uuid, uuid, uuid, date, date) to authenticated;

-- Leave requests for the manager screens, with names (line managers don't read workers; slice
-- 4.0): owner, admin and hr every request; ops_manager every request with dates and type only
-- (reason and notes left out, except where they decide step 1); line_manager their reportees'.
-- Filters: p_statuses (null for all), requests overlapping p_from to p_to, one p_request_id.
create function private.leave_request_list(
  p_organisation_id uuid,
  p_statuses text[] default null,
  p_from date default null,
  p_to date default null,
  p_request_id uuid default null
)
returns table (
  id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  department_name text,
  leave_type_id uuid,
  leave_type_name text,
  counting text,
  needs_certificate boolean,
  start_date date,
  end_date date,
  leave_year integer,
  days integer,
  reason text,
  status text,
  certificate_seen boolean,
  pay_percent integer,
  pay_below_service boolean,
  created_at timestamptz,
  decided_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  line_manager_name text,
  has_line_manager boolean,
  lm_decision text,
  lm_note text,
  lm_decided_at timestamptz,
  lm_actor_name text,
  hr_decision text,
  hr_note text,
  hr_decided_at timestamptz,
  hr_actor_name text,
  can_decide_step1 boolean,
  can_decide_step2 boolean,
  can_cancel boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_full boolean;
  v_ops boolean;
  v_lm boolean;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to see leave requests.' using errcode = '42501';
  end if;
  v_full := private.has_role(p_organisation_id, array['owner', 'admin', 'hr']);
  v_ops := private.has_role(p_organisation_id, array['ops_manager']);
  v_lm := private.has_role(p_organisation_id, array['line_manager']);
  if not (v_full or v_ops or v_lm) then
    raise exception 'Your role can''t see leave requests.' using errcode = '42501';
  end if;

  return query
  with base as (
    select r.*, private.leave_can_decide_step1(r.organisation_id, r.worker_id) as step1_ok
    from public.leave_requests r
    where r.organisation_id = p_organisation_id
      and (p_statuses is null or r.status = any (p_statuses))
      and (p_from is null or r.end_date >= p_from)
      and (p_to is null or r.start_date <= p_to)
      and (p_request_id is null or r.id = p_request_id)
      and (
        v_full or v_ops
        or r.worker_id in (select private.my_reportee_ids())
      )
  )
  select
    b.id,
    b.worker_id,
    btrim(w.first_name || ' ' || w.last_name),
    w.staff_id,
    d.name,
    b.leave_type_id,
    t.name,
    t.counting,
    t.needs_certificate,
    b.start_date,
    b.end_date,
    b.leave_year,
    b.days,
    case when v_full or v_lm or b.step1_ok then b.reason end,
    b.status,
    b.certificate_seen,
    case when v_full then b.pay_percent end,
    case when v_full then b.pay_below_service end,
    b.created_at,
    b.decided_at,
    b.cancelled_at,
    case when v_full or v_lm or b.step1_ok then b.cancel_reason end,
    coalesce(
      nullif(btrim(lmw.first_name || ' ' || lmw.last_name), ''),
      nullif(btrim(lmp.full_name), '')
    ),
    private.leave_has_line_manager(b.organisation_id, b.worker_id),
    lmd.decision,
    case when v_full or v_lm or b.step1_ok then lmd.note end,
    lmd.created_at,
    nullif(btrim(lmdp.full_name), ''),
    hrd.decision,
    case when v_full or v_lm or b.step1_ok then hrd.note end,
    hrd.created_at,
    nullif(btrim(hrdp.full_name), ''),
    b.status = 'pending_line_manager' and b.step1_ok,
    b.status = 'pending_hr' and private.leave_can_decide_step2(b.organisation_id, b.worker_id),
    b.status in ('pending_line_manager', 'pending_hr', 'approved') and v_full
      and b.worker_id not in (select private.my_worker_ids())
  from base b
  join public.workers w on w.organisation_id = b.organisation_id and w.id = b.worker_id
  join public.leave_types t on t.organisation_id = b.organisation_id and t.id = b.leave_type_id
  left join public.departments d on d.organisation_id = w.organisation_id and d.id = w.department_id
  left join public.workers lmw
    on lmw.organisation_id = w.organisation_id and lmw.id = w.line_manager_worker_id
  left join public.memberships lmm
    on lmm.organisation_id = w.organisation_id and lmm.id = w.line_manager_membership_id
  left join public.profiles lmp on lmp.user_id = lmm.user_id
  left join public.leave_decisions lmd on lmd.request_id = b.id and lmd.step = 'line_manager'
  left join public.profiles lmdp on lmdp.user_id = lmd.actor
  left join public.leave_decisions hrd on hrd.request_id = b.id and hrd.step = 'hr'
  left join public.profiles hrdp on hrdp.user_id = hrd.actor
  order by b.start_date, w.last_name, w.first_name, b.id
  limit 500;
end;
$$;

revoke all on function private.leave_request_list(uuid, text[], date, date, uuid) from public, anon;
grant execute on function private.leave_request_list(uuid, text[], date, date, uuid) to authenticated;

create function public.leave_request_list(
  p_organisation_id uuid,
  p_statuses text[] default null,
  p_from date default null,
  p_to date default null,
  p_request_id uuid default null
)
returns table (
  id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  department_name text,
  leave_type_id uuid,
  leave_type_name text,
  counting text,
  needs_certificate boolean,
  start_date date,
  end_date date,
  leave_year integer,
  days integer,
  reason text,
  status text,
  certificate_seen boolean,
  pay_percent integer,
  pay_below_service boolean,
  created_at timestamptz,
  decided_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  line_manager_name text,
  has_line_manager boolean,
  lm_decision text,
  lm_note text,
  lm_decided_at timestamptz,
  lm_actor_name text,
  hr_decision text,
  hr_note text,
  hr_decided_at timestamptz,
  hr_actor_name text,
  can_decide_step1 boolean,
  can_decide_step2 boolean,
  can_cancel boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.leave_request_list(p_organisation_id, p_statuses, p_from, p_to, p_request_id)
$$;

revoke all on function public.leave_request_list(uuid, text[], date, date, uuid) from public, anon;
grant execute on function public.leave_request_list(uuid, text[], date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Writes
-- ---------------------------------------------------------------------------

-- The worker asks for leave, as themselves (worker app). Refuses: a type not active or not in the
-- company, a past start, a range across the new year or in a year not started, a type before its
-- minimum service, no days to count, an overlap with another live request, and (on a type whose
-- version gives days a year) fewer days available than asked. Returns {id, days, shifts,
-- site_names, status, pay_below_service}.
create function private.request_leave(
  p_organisation_id uuid,
  p_leave_type_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker uuid := private.my_worker_in(p_organisation_id);
  v_today date := private.org_today(p_organisation_id);
  v_type public.leave_types%rowtype;
  v_version public.leave_entitlements%rowtype;
  v_start date;
  v_reason text := private.leave_clean_text(p_reason, 500);
  v_count record;
  v_overlap record;
  v_year integer;
  v_available integer;
  v_id uuid;
begin
  perform set_config('metalira.audit_channel', 'worker_app', true);
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Choose a from date on or before the to date.' using errcode = '22023';
  end if;
  if p_reason is not null and btrim(p_reason) <> '' and v_reason is null then
    raise exception 'Keep the reason to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;
  if p_start_date < v_today then
    raise exception 'Leave starts today or later.' using errcode = 'MLLQ8';
  end if;
  if extract(year from p_start_date) <> extract(year from p_end_date) then
    raise exception 'Leave across the new year is two requests: up to 31 Dec, then from 1 Jan.'
      using errcode = 'MLLQ8';
  end if;
  v_year := extract(year from p_start_date)::integer;
  if v_year > extract(year from v_today)::integer then
    raise exception 'Leave for % opens on 1 Jan %.', v_year, v_year using errcode = 'MLLQ8';
  end if;

  select t.* into v_type
  from public.leave_types t
  where t.organisation_id = p_organisation_id and t.id = p_leave_type_id and t.status = 'active';
  if v_type.id is null then
    raise exception 'That leave type wasn''t found.' using errcode = 'P0002';
  end if;

  -- One request at a time per worker, so two taps can't both pass the checks.
  perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_worker::text, 0));

  select w.start_date into v_start from public.workers w where w.id = v_worker;
  if v_type.min_service_months > 0
    and private.leave_service_months(v_start, p_start_date) < v_type.min_service_months then
    raise exception '% leave opens after % months'' service, from %.', v_type.name,
      v_type.min_service_months,
      to_char((v_start + make_interval(months => v_type.min_service_months))::date, 'FMDD Mon YYYY')
      using errcode = 'MLLQ3';
  end if;

  select c.* into v_count
  from private.leave_count_days(p_organisation_id, v_worker, v_type.counting, p_start_date, p_end_date) c;
  if coalesce(v_count.days, 0) = 0 then
    raise exception 'Those dates have no working days for you.' using errcode = 'MLLQ7';
  end if;

  select r.start_date, r.end_date into v_overlap
  from public.leave_requests r
  where r.worker_id = v_worker
    and r.status in ('pending_line_manager', 'pending_hr', 'approved')
    and r.start_date <= p_end_date and r.end_date >= p_start_date
  limit 1;
  if v_overlap.start_date is not null then
    raise exception 'You already asked for leave on %.', private.leave_range_label(v_overlap.start_date, v_overlap.end_date)
      using errcode = 'MLLQ1';
  end if;

  v_version := private.leave_version_on(v_type.id, p_start_date);
  if v_version.id is null then
    raise exception '% leave has no days set for that date. Ask HR.', v_type.name
      using errcode = 'MLLQ2';
  end if;

  perform private.leave_ensure_year_core(p_organisation_id, v_year, array[v_worker]);
  if v_version.days_per_year > 0 then
    v_available := private.leave_balance(p_organisation_id, v_worker, v_type.id, v_year)
      - private.leave_pending_days(p_organisation_id, v_worker, v_type.id, v_year, null);
    if v_available < v_count.days then
      raise exception 'You have % % % left, after requests waiting for a decision.',
        greatest(v_available, 0), lower(v_type.name),
        case when greatest(v_available, 0) = 1 then 'day' else 'days' end
        using errcode = 'MLLQ2';
    end if;
  end if;

  insert into public.leave_requests (
    organisation_id, worker_id, leave_type_id, leave_year, start_date, end_date, days, reason,
    pay_percent, pay_below_service
  )
  values (
    p_organisation_id, v_worker, v_type.id, v_year, p_start_date, p_end_date, v_count.days,
    v_reason,
    case when v_type.paid then v_version.pay_percent else 0 end,
    coalesce(
      v_version.pay_min_service_months is not null
        and private.leave_service_months(v_start, p_start_date) < v_version.pay_min_service_months,
      false
    )
  )
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'days', v_count.days,
    'shifts', v_count.shifts,
    'site_names', to_jsonb(v_count.site_names),
    'status', 'pending_line_manager',
    'pay_below_service', coalesce(
      v_version.pay_min_service_months is not null
        and private.leave_service_months(v_start, p_start_date) < v_version.pay_min_service_months,
      false
    )
  );
end;
$$;

revoke all on function private.request_leave(uuid, uuid, date, date, text) from public, anon;
grant execute on function private.request_leave(uuid, uuid, date, date, text) to authenticated;

create function public.request_leave(
  p_organisation_id uuid,
  p_leave_type_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.request_leave(p_organisation_id, p_leave_type_id, p_start_date, p_end_date, p_reason)
$$;

revoke all on function public.request_leave(uuid, uuid, date, date, text) from public, anon;
grant execute on function public.request_leave(uuid, uuid, date, date, text) to authenticated;

-- Step 1. The line manager (or, for a worker with none, an owner, admin or ops_manager) approves
-- or declines a request waiting for them. A decline needs a note for the worker. Approving counts
-- the days again (the roster may have changed) and sends it to HR. Returns {id, status, days,
-- worker_id}.
create function private.decide_leave_line_manager(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests%rowtype;
  v_type public.leave_types%rowtype;
  v_note text := private.leave_clean_text(p_note, 500);
  v_days integer;
  v_status text;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to decide leave.' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'Approve or decline.' using errcode = '22023';
  end if;
  if p_note is not null and btrim(p_note) <> '' and v_note is null then
    raise exception 'Keep the note to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;
  if p_decision = 'declined' and v_note is null then
    raise exception 'Say why, so the worker knows.' using errcode = '22023';
  end if;

  select r.* into v_request
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'That leave request wasn''t found.' using errcode = 'P0002';
  end if;
  if v_request.worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t decide your own leave.' using errcode = 'MLLQ6';
  end if;
  if not private.leave_can_decide_step1(p_organisation_id, v_request.worker_id) then
    raise exception 'Only the worker''s line manager decides this step.' using errcode = '42501';
  end if;
  if v_request.status <> 'pending_line_manager' then
    raise exception 'This request isn''t waiting for the line manager.' using errcode = 'MLLQ4';
  end if;

  select t.* into v_type from public.leave_types t where t.id = v_request.leave_type_id;
  v_days := v_request.days;
  if p_decision = 'approved' then
    select c.days into v_days
    from private.leave_count_days(
      p_organisation_id, v_request.worker_id, v_type.counting, v_request.start_date,
      v_request.end_date
    ) c;
    if coalesce(v_days, 0) = 0 then
      raise exception 'Those dates no longer have working days for the worker. Decline it instead.'
        using errcode = 'MLLQ7';
    end if;
    v_status := 'pending_hr';
  else
    v_status := 'declined';
  end if;

  insert into public.leave_decisions (
    organisation_id, request_id, worker_id, step, decision, note, certificate_seen, days, actor
  )
  values (
    p_organisation_id, v_request.id, v_request.worker_id, 'line_manager', p_decision, v_note,
    coalesce(p_certificate_seen, false) and v_type.needs_certificate, v_days, private.session_uid()
  );

  update public.leave_requests r
  set status = v_status,
      days = v_days,
      certificate_seen = r.certificate_seen
        or (coalesce(p_certificate_seen, false) and v_type.needs_certificate),
      decided_at = case when v_status = 'declined' then now() else r.decided_at end
  where r.id = v_request.id;

  perform private.log_audit_impl(
    p_organisation_id, 'leave.decided_line_manager', 'leave_requests', v_request.id,
    jsonb_build_object('status', v_request.status, 'days', v_request.days),
    jsonb_build_object('status', v_status, 'days', v_days, 'decision', p_decision),
    v_note
  );

  return jsonb_build_object(
    'id', v_request.id, 'status', v_status, 'days', v_days, 'worker_id', v_request.worker_id
  );
end;
$$;

revoke all on function private.decide_leave_line_manager(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function private.decide_leave_line_manager(uuid, uuid, text, text, boolean) to authenticated;

create function public.decide_leave_line_manager(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.decide_leave_line_manager(p_organisation_id, p_request_id, p_decision, p_note, p_certificate_seen)
$$;

revoke all on function public.decide_leave_line_manager(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.decide_leave_line_manager(uuid, uuid, text, text, boolean) to authenticated;

-- Step 2. HR (owner, admin or hr) approves or declines a request the line manager approved. A
-- decline needs a note. Approving counts the days again, checks the balance again on a type with
-- days a year, needs "Certificate seen" on a type that needs one, records the pay fields for
-- Phase 5 and writes the `taken` ledger row: the balance drops only now. Returns {id, status,
-- days, worker_id, balance}.
create function private.decide_leave_hr(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests%rowtype;
  v_type public.leave_types%rowtype;
  v_version public.leave_entitlements%rowtype;
  v_note text := private.leave_clean_text(p_note, 500);
  v_count record;
  v_start date;
  v_available integer;
  v_status text;
  v_certificate boolean;
  v_below boolean;
  v_pay integer;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to decide leave.' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'Approve or decline.' using errcode = '22023';
  end if;
  if p_note is not null and btrim(p_note) <> '' and v_note is null then
    raise exception 'Keep the note to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;
  if p_decision = 'declined' and v_note is null then
    raise exception 'Say why, so the worker knows.' using errcode = '22023';
  end if;

  select r.* into v_request
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'That leave request wasn''t found.' using errcode = 'P0002';
  end if;
  if v_request.worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t decide your own leave.' using errcode = 'MLLQ6';
  end if;
  if not private.leave_can_decide_step2(p_organisation_id, v_request.worker_id) then
    raise exception 'Only HR, an admin or the owner decides this step.' using errcode = '42501';
  end if;
  if v_request.status <> 'pending_hr' then
    raise exception 'This request isn''t waiting for HR.' using errcode = 'MLLQ4';
  end if;

  select t.* into v_type from public.leave_types t where t.id = v_request.leave_type_id;
  select w.start_date into v_start from public.workers w where w.id = v_request.worker_id;
  v_certificate := v_request.certificate_seen
    or (coalesce(p_certificate_seen, false) and v_type.needs_certificate);
  select c.* into v_count
  from private.leave_count_days(
    p_organisation_id, v_request.worker_id, v_type.counting, v_request.start_date,
    v_request.end_date
  ) c;
  v_version := private.leave_version_on(v_type.id, v_request.start_date);
  v_below := coalesce(
    v_version.pay_min_service_months is not null
      and private.leave_service_months(v_start, v_request.start_date) < v_version.pay_min_service_months,
    false
  );
  v_pay := case when v_type.paid then coalesce(v_version.pay_percent, v_request.pay_percent) else 0 end;

  perform private.leave_ensure_year_core(p_organisation_id, v_request.leave_year, array[v_request.worker_id]);
  v_available := private.leave_balance(
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year
    ) - private.leave_pending_days(
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year, v_request.id
    );

  if p_decision = 'approved' then
    if coalesce(v_count.days, 0) = 0 then
      raise exception 'Those dates no longer have working days for the worker. Decline it instead.'
        using errcode = 'MLLQ7';
    end if;
    if v_type.needs_certificate and not v_certificate then
      raise exception 'Tick Certificate seen before approving % leave.', lower(v_type.name)
        using errcode = '22023';
    end if;
    if coalesce(v_version.days_per_year, 0) > 0 and v_available < v_count.days then
      raise exception 'The worker has % % left, fewer than the % asked for.',
        greatest(v_available, 0), case when greatest(v_available, 0) = 1 then 'day' else 'days' end,
        v_count.days
        using errcode = 'MLLQ2';
    end if;
    v_status := 'approved';
  else
    v_status := 'declined';
  end if;

  if coalesce(p_dry_run, false) then
    return jsonb_build_object(
      'id', v_request.id, 'status', v_status, 'days', coalesce(v_count.days, v_request.days),
      'worker_id', v_request.worker_id, 'dry_run', true,
      'balance_before', v_available,
      'balance_after', case when v_status = 'approved' then v_available - v_count.days else v_available end,
      'shifts', coalesce(v_count.shifts, 0), 'site_names', to_jsonb(coalesce(v_count.site_names, '{}'::text[])),
      'pay_below_service', v_below
    );
  end if;

  insert into public.leave_decisions (
    organisation_id, request_id, worker_id, step, decision, note, certificate_seen, days, actor
  )
  values (
    p_organisation_id, v_request.id, v_request.worker_id, 'hr', p_decision, v_note,
    coalesce(p_certificate_seen, false) and v_type.needs_certificate,
    coalesce(v_count.days, 0), private.session_uid()
  );

  update public.leave_requests r
  set status = v_status,
      days = case when v_status = 'approved' then v_count.days else r.days end,
      certificate_seen = v_certificate,
      pay_percent = case when v_status = 'approved' then v_pay else r.pay_percent end,
      pay_below_service = case when v_status = 'approved' then v_below else r.pay_below_service end,
      decided_at = now()
  where r.id = v_request.id;

  if v_status = 'approved' then
    insert into public.leave_ledger (
      organisation_id, worker_id, leave_type_id, leave_year, kind, days, request_id, actor
    )
    values (
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year, 'taken',
      -v_count.days, v_request.id, private.session_uid()
    );
  end if;

  perform private.log_audit_impl(
    p_organisation_id, 'leave.decided_hr', 'leave_requests', v_request.id,
    jsonb_build_object('status', v_request.status, 'days', v_request.days),
    jsonb_build_object(
      'status', v_status, 'days', coalesce(v_count.days, v_request.days), 'decision', p_decision,
      'pay_below_service', v_below
    ),
    v_note
  );

  return jsonb_build_object(
    'id', v_request.id, 'status', v_status, 'days', coalesce(v_count.days, v_request.days),
    'worker_id', v_request.worker_id, 'dry_run', false,
    'balance_before', v_available,
    'balance_after', case when v_status = 'approved' then v_available - v_count.days else v_available end,
    'shifts', coalesce(v_count.shifts, 0), 'site_names', to_jsonb(coalesce(v_count.site_names, '{}'::text[])),
    'pay_below_service', v_below
  );
end;
$$;

revoke all on function private.decide_leave_hr(uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function private.decide_leave_hr(uuid, uuid, text, text, boolean, boolean) to authenticated;

create function public.decide_leave_hr(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false,
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.decide_leave_hr(p_organisation_id, p_request_id, p_decision, p_note, p_certificate_seen, p_dry_run)
$$;

revoke all on function public.decide_leave_hr(uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.decide_leave_hr(uuid, uuid, text, text, boolean, boolean) to authenticated;

-- Cancels a request. The worker cancels their own before the final decision (worker app). HR
-- (owner, admin or hr, never for themselves) cancels any live request, with a reason; cancelling
-- approved leave writes the `returned` ledger row, giving the days back. Returns {id, status,
-- returned, worker_id, by_worker}.
create function private.cancel_leave_request(
  p_organisation_id uuid,
  p_request_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests%rowtype;
  v_reason text := private.leave_clean_text(p_reason, 500);
  v_own uuid;
  v_by_worker boolean;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to cancel leave.' using errcode = '42501';
  end if;
  if p_reason is not null and btrim(p_reason) <> '' and v_reason is null then
    raise exception 'Keep the reason to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;

  select m.worker_id into v_own
  from public.memberships m
  where m.organisation_id = p_organisation_id and m.user_id = private.session_uid()
    and m.role = 'worker' and m.worker_id is not null;

  select r.* into v_request
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'That leave request wasn''t found.' using errcode = 'P0002';
  end if;

  v_by_worker := v_own is not null and v_own = v_request.worker_id;
  if v_by_worker then
    perform set_config('metalira.audit_channel', 'worker_app', true);
    if v_request.status not in ('pending_line_manager', 'pending_hr') then
      raise exception 'This request was already decided. Ask HR to cancel approved leave.'
        using errcode = 'MLLQ4';
    end if;
  else
    if not private.leave_can_decide_step2(p_organisation_id, v_request.worker_id) then
      if v_request.worker_id in (select private.my_worker_ids()) then
        raise exception 'You can''t cancel your own leave here.' using errcode = 'MLLQ6';
      end if;
      raise exception 'Only the worker or HR can cancel leave.' using errcode = '42501';
    end if;
    if v_request.status not in ('pending_line_manager', 'pending_hr', 'approved') then
      raise exception 'This request is already closed.' using errcode = 'MLLQ4';
    end if;
    if v_reason is null then
      raise exception 'Say why it is cancelled, so the worker knows.' using errcode = '22023';
    end if;
  end if;

  update public.leave_requests r
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = private.session_uid(),
      cancel_reason = v_reason
  where r.id = v_request.id;

  if v_request.status = 'approved' then
    insert into public.leave_ledger (
      organisation_id, worker_id, leave_type_id, leave_year, kind, days, request_id, reason, actor
    )
    values (
      p_organisation_id, v_request.worker_id, v_request.leave_type_id, v_request.leave_year,
      'returned', v_request.days, v_request.id, v_reason, private.session_uid()
    );
  end if;

  if not v_by_worker then
    perform private.log_audit_impl(
      p_organisation_id, 'leave.cancelled', 'leave_requests', v_request.id,
      jsonb_build_object('status', v_request.status),
      jsonb_build_object(
        'status', 'cancelled',
        'returned', case when v_request.status = 'approved' then v_request.days else 0 end
      ),
      v_reason
    );
  end if;

  return jsonb_build_object(
    'id', v_request.id, 'status', 'cancelled', 'worker_id', v_request.worker_id,
    'returned', case when v_request.status = 'approved' then v_request.days else 0 end,
    'by_worker', v_by_worker, 'was', v_request.status
  );
end;
$$;

revoke all on function private.cancel_leave_request(uuid, uuid, text) from public, anon;
grant execute on function private.cancel_leave_request(uuid, uuid, text) to authenticated;

create function public.cancel_leave_request(
  p_organisation_id uuid,
  p_request_id uuid,
  p_reason text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.cancel_leave_request(p_organisation_id, p_request_id, p_reason)
$$;

revoke all on function public.cancel_leave_request(uuid, uuid, text) from public, anon;
grant execute on function public.cancel_leave_request(uuid, uuid, text) to authenticated;

-- HR (owner, admin or hr) adds or takes away days for one worker, type and year, with a reason.
-- Refused when it would leave the balance below 0, or for a year not started. Never for the
-- caller's own leave. Returns {balance}.
create function private.adjust_leave_balance(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_leave_type_id uuid,
  p_year integer,
  p_days integer,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := private.leave_clean_text(p_reason, 500);
  v_today date := private.org_today(p_organisation_id);
  v_balance integer;
begin
  perform private.require_leave_setup_role(p_organisation_id);
  if p_worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t change your own leave balance.' using errcode = 'MLLQ6';
  end if;
  if not exists (
    select 1 from public.workers w where w.organisation_id = p_organisation_id and w.id = p_worker_id
  ) then
    raise exception 'That worker wasn''t found.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.leave_types t
    where t.organisation_id = p_organisation_id and t.id = p_leave_type_id and t.status = 'active'
  ) then
    raise exception 'That leave type wasn''t found.' using errcode = 'P0002';
  end if;
  if p_year is null or p_year < 2000 or p_year > extract(year from v_today)::integer then
    raise exception 'Choose this year or an earlier one.' using errcode = 'MLLQ8';
  end if;
  if p_days is null or p_days = 0 or p_days not between -366 and 366 then
    raise exception 'Add or take away a whole number of days, not 0.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || p_worker_id::text, 0));
  perform private.leave_ensure_year_core(p_organisation_id, p_year, array[p_worker_id]);
  v_balance := private.leave_balance(p_organisation_id, p_worker_id, p_leave_type_id, p_year);
  if v_balance + p_days < 0 then
    raise exception 'That leaves % days. The balance is %.', v_balance + p_days, v_balance
      using errcode = 'MLLQ2';
  end if;

  insert into public.leave_ledger (
    organisation_id, worker_id, leave_type_id, leave_year, kind, days, reason, actor
  )
  values (
    p_organisation_id, p_worker_id, p_leave_type_id, p_year, 'adjustment', p_days, v_reason,
    private.session_uid()
  );

  perform private.log_audit_impl(
    p_organisation_id, 'leave.balance_adjusted', 'leave_ledger', null,
    jsonb_build_object('balance', v_balance),
    jsonb_build_object('balance', v_balance + p_days, 'days', p_days, 'year', p_year,
      'worker_id', p_worker_id, 'leave_type_id', p_leave_type_id),
    v_reason
  );

  return jsonb_build_object('balance', v_balance + p_days);
end;
$$;

revoke all on function private.adjust_leave_balance(uuid, uuid, uuid, integer, integer, text) from public, anon;
grant execute on function private.adjust_leave_balance(uuid, uuid, uuid, integer, integer, text) to authenticated;

create function public.adjust_leave_balance(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_leave_type_id uuid,
  p_year integer,
  p_days integer,
  p_reason text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.adjust_leave_balance(p_organisation_id, p_worker_id, p_leave_type_id, p_year, p_days, p_reason)
$$;

revoke all on function public.adjust_leave_balance(uuid, uuid, uuid, integer, integer, text) from public, anon;
grant execute on function public.adjust_leave_balance(uuid, uuid, uuid, integer, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Manager emails inside the shared caps
-- ---------------------------------------------------------------------------

-- Emails sent in the last 24 hours, for one company and overall: worker inbox emails plus every
-- recipient of a manager email. Callers hold the 'inbox_email_cap' lock.
create function private.emails_sent_24h(p_organisation_id uuid)
returns table (company integer, overall integer)
language sql
stable
security definer
set search_path = ''
as $$
  with sent as (
    select i.organisation_id, 1 as n
    from public.inbox_items i
    where i.emailed_at > now() - interval '24 hours'
    union all
    select e.organisation_id, e.recipients
    from public.manager_emails e
    where e.created_at > now() - interval '24 hours'
  )
  select
    coalesce(sum(n) filter (where organisation_id = p_organisation_id), 0)::integer,
    coalesce(sum(n), 0)::integer
  from sent
$$;

revoke all on function private.emails_sent_24h(uuid) from public, anon, authenticated;
grant execute on function private.emails_sent_24h(uuid) to service_role;

-- Slice 3.1's claim, now also counting manager emails (same caps, same lock).
create or replace function public.claim_inbox_email(p_item_id uuid, p_org_cap integer, p_global_cap integer)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
  v_sent record;
begin
  if p_org_cap is null or p_org_cap < 0 or p_global_cap is null or p_global_cap < 0 then
    raise exception 'Caps must be zero or more.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('inbox_email_cap', 0));
  select i.organisation_id into v_org
  from public.inbox_items i
  where i.id = p_item_id and i.emailed_at is null;
  if v_org is null then
    return false;
  end if;
  select * into v_sent from private.emails_sent_24h(v_org);
  if v_sent.company >= p_org_cap or v_sent.overall >= p_global_cap then
    return false;
  end if;
  update public.inbox_items set emailed_at = now() where id = p_item_id;
  return true;
end;
$$;

revoke all on function public.claim_inbox_email(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_inbox_email(uuid, integer, integer) to service_role;

-- Claims one manager email (to p_recipients addresses) about p_ref_id under the caps, for the
-- server only (secret key). Once per kind and record. True when it may be sent now.
create function private.claim_manager_email(
  p_organisation_id uuid,
  p_kind text,
  p_ref_id uuid,
  p_recipients integer,
  p_org_cap integer,
  p_global_cap integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sent record;
begin
  if p_org_cap is null or p_org_cap < 0 or p_global_cap is null or p_global_cap < 0 then
    raise exception 'Caps must be zero or more.' using errcode = '22023';
  end if;
  if p_recipients is null or p_recipients not between 1 and 10 then
    raise exception 'Send to 1 to 10 managers.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('inbox_email_cap', 0));
  if exists (select 1 from public.manager_emails e where e.kind = p_kind and e.ref_id = p_ref_id) then
    return false;
  end if;
  select * into v_sent from private.emails_sent_24h(p_organisation_id);
  if v_sent.company + p_recipients > p_org_cap or v_sent.overall + p_recipients > p_global_cap then
    return false;
  end if;
  insert into public.manager_emails (organisation_id, kind, ref_id, recipients)
  values (p_organisation_id, p_kind, p_ref_id, p_recipients);
  return true;
end;
$$;

revoke all on function private.claim_manager_email(uuid, text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function private.claim_manager_email(uuid, text, uuid, integer, integer, integer)
  to service_role;

create function public.claim_manager_email(
  p_organisation_id uuid,
  p_kind text,
  p_ref_id uuid,
  p_recipients integer,
  p_org_cap integer,
  p_global_cap integer
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.claim_manager_email(p_organisation_id, p_kind, p_ref_id, p_recipients, p_org_cap, p_global_cap)
$$;

revoke all on function public.claim_manager_email(uuid, text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_manager_email(uuid, text, uuid, integer, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 11. Timesheets skip approved leave (slice 4.2's hook)
-- ---------------------------------------------------------------------------

-- Slice 4.2 (migration 20261121120000) made private.timesheet_on_leave a placeholder returning
-- false. The real check: a day inside an approved request gives no timesheet line (leave is its
-- own record). Same signature; 4.2's refresh (a definer) calls it.
create or replace function private.timesheet_on_leave(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_date date
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.leave_requests r
    where r.organisation_id = p_organisation_id
      and r.worker_id = p_worker_id
      and r.status = 'approved'
      and p_date between r.start_date and r.end_date
  )
$$;

revoke all on function private.timesheet_on_leave(uuid, uuid, date) from public, anon, authenticated;
