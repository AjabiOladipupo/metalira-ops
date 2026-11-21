-- Slice 4.6: queries (disciplinary and HR queries) and the HR file (docs/PHASE_4.md 4.6, owner
-- decision 10: a query carries a reply-by date and is kept on the HR file).
--
-- 1. `staff_queries`: one per query raised about a worker: kind, subject, body (plain text), the
--    reply-by date, status (awaiting_reply, replied, closed, withdrawn) and, once closed or
--    withdrawn, who, when and the outcome note or reason. Never deleted. The status moves only
--    inside the functions below (no role has UPDATE; the guard refuses anything but the allowed
--    moves, even for the database owner) and each move is audited (the row trigger, plus a
--    log_audit event for a manager's action).
-- 2. `staff_query_replies` (rule 4, insert-only): the worker's reply or a manager's follow-up.
--    No role, not the secret key and not the database owner, can update, delete or truncate a
--    reply: grants are revoked, a row guard refuses update and delete, and a statement guard
--    refuses truncate.
-- 3. Text is plain, as inbox_items: line breaks only in the body, no other control characters,
--    no < or >, no web addresses (no "://", "www." or a word ending in a common domain such as
--    ".com" or ".ng"), no personal numbers (10 or more digits with only spaces or hyphens
--    between them, rule 9), with length limits. private.staff_query_text_ok holds the rule;
--    src/lib/queries.ts mirrors it and tests/unit/queries.test.ts checks the cases.
--
-- Who reads (RLS, set-helper form only; tests/rls/policy-speed.test.ts):
--   owner, admin, hr: every query in the company;
--   the worker's CURRENT line manager (private.my_reportee_ids): their reportees' queries,
--   whoever raised them;
--   the manager who raised it, while they still hold a manager role in the company (owner,
--   admin, hr or line_manager);
--   the worker: their own (private.my_worker_ids).
--   A former line manager who didn't raise the query reads nothing. Ops managers and finance read
--   nothing. Replies follow their query (private.my_staff_query_ids, the same rule as a set).
--
-- Who writes (security-definer functions behind security-invoker wrappers, search_path '', the
-- caller's trusted session only (private.session_uid), the organisation checked against the
-- caller's own membership, never trusted from the row or the request):
--   raise_staff_query     owner, admin, hr for any active worker; a line manager for their
--                         current reportees; never about the caller's own worker record
--   reply_to_staff_query  the worker (their own query, channel worker_app), or a manager who may
--                         read it (a follow-up); only while awaiting_reply or replied, at most 25
--                         worker replies and 5 follow-ups (the insert trigger, for every inserter)
--   close_staff_query     owner, admin, hr, the current line manager or the raiser, with an
--                         outcome note
--   withdraw_staff_query  the raiser only, with a reason
--   claim_staff_query_reminders  the server's daily cron only (secret key): queries whose
--                         reply-by date is tomorrow and still awaiting a reply, each once
-- Overdue is worked out on read (reply_by passed, still awaiting_reply): no column, no cron.
--
-- Work records (slice 1.11's hook): a query is an HR record about the worker, not work done or
-- paid, and it follows the worker by id, not by staff ID, so it does not block a staff ID
-- correction. staff_queries is declared in NOT_WORK_RECORDS (tests/rls/work-records-hook.test.ts)
-- and private.worker_has_work_records is not changed here (slice 4.2 replaces it).
--
-- Refusals (SQLSTATE), mapped to plain English in src/server/people/queries.ts:
--   MLQY0 a change the guards never allow (edit, delete, truncate, a status move outside the
--         functions' rules)
--   MLQY1 text that isn't plain, too short or too long; an unknown kind
--   MLQY2 the caller may not raise, reply to, close or withdraw this query (not their
--         reportee, not the raiser)
--   MLQY3 the worker has left
--   MLQY4 a query about the caller's own worker record
--   MLQY5 the reply-by date is in the past or more than 60 days away
--   MLQY6 the query is closed or withdrawn
--   MLQY7 the query has its 25 replies from the worker, or its 5 follow-ups from managers
--   42501 not signed in with a trusted session, or not a member of the company
--   P0002 the worker or query isn't in the company, or the caller can't read it
-- Nothing here stores money.

-- ---------------------------------------------------------------------------
-- 1. The text rule
-- ---------------------------------------------------------------------------

create function private.staff_query_text_ok(
  p_text text,
  p_min integer,
  p_max integer,
  p_multiline boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_text = btrim(p_text)
    and char_length(p_text) between p_min and p_max
    and case
      when p_multiline then p_text !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f<>]'
      else p_text !~ '[\x01-\x1f\x7f-\x9f<>]'
    end
    and p_text !~* '(://|www\.)'
    and p_text !~* '\m[a-z0-9-]+\.(com|net|org|ng|io|co|info|biz|xyz|app|ly|link|site|online)\M'
    and p_text !~ '[0-9]([ -]*[0-9]){9,}',
    false
  )
$$;

-- Pure, and called by the table's check constraints, so whoever inserts may run it.
revoke all on function private.staff_query_text_ok(text, integer, integer, boolean) from public, anon;
grant execute on function private.staff_query_text_ok(text, integer, integer, boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. staff_queries
-- ---------------------------------------------------------------------------

create table public.staff_queries (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  -- The manager's login, and their name as it was when they raised it (the worker can't read
  -- profiles, and a name change later shouldn't rewrite the HR file).
  raised_by uuid not null,
  raised_by_name text not null
    constraint staff_queries_raised_by_name_length check (char_length(raised_by_name) between 1 and 200),
  kind text not null
    constraint staff_queries_kind_value check (
      kind in ('lateness', 'absence_without_leave', 'conduct', 'performance', 'other')
    ),
  subject text not null
    constraint staff_queries_subject_text check (private.staff_query_text_ok(subject, 3, 120, false)),
  body text not null
    constraint staff_queries_body_text check (private.staff_query_text_ok(body, 3, 2000, true)),
  -- The company's calendar day by which the worker should reply (today or later when raised).
  reply_by date not null,
  status text not null default 'awaiting_reply'
    constraint staff_queries_status_value check (
      status in ('awaiting_reply', 'replied', 'closed', 'withdrawn')
    ),
  raised_at timestamptz not null default now(),
  -- The worker's first reply.
  first_replied_at timestamptz,
  -- The daily reminder the day before reply_by (claim_staff_query_reminders), at most once.
  reminded_at timestamptz,
  -- Closed or withdrawn: when, by whom, and the outcome note (closed) or reason (withdrawn).
  closed_at timestamptz,
  closed_by uuid,
  outcome_note text
    constraint staff_queries_outcome_text check (
      outcome_note is null or private.staff_query_text_ok(outcome_note, 3, 1000, true)
    ),
  constraint staff_queries_organisation_id_id_key unique (organisation_id, id),
  constraint staff_queries_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint staff_queries_closed_fields check (
    (status in ('closed', 'withdrawn'))
      = (closed_at is not null and closed_by is not null and outcome_note is not null)
  ),
  constraint staff_queries_replied_fields check (
    status <> 'replied' or first_replied_at is not null
  )
);

create index staff_queries_worker_idx
  on public.staff_queries (organisation_id, worker_id, raised_at desc);
create index staff_queries_raised_by_idx on public.staff_queries (raised_by);
create index staff_queries_reminder_idx
  on public.staff_queries (reply_by)
  where status = 'awaiting_reply' and reminded_at is null;

comment on table public.staff_queries is
  'Disciplinary and HR queries about one worker, with a reply-by date, kept on the HR file (slice 4.6). Never deleted; the status moves only through raise/reply/close/withdraw_staff_query.';

-- BEFORE INSERT: a new query always starts awaiting a reply, now, with nothing closed.
create function private.staff_queries_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.status := 'awaiting_reply';
  new.raised_at := now();
  new.first_replied_at := null;
  new.reminded_at := null;
  new.closed_at := null;
  new.closed_by := null;
  new.outcome_note := null;
  return new;
end;
$$;

-- BEFORE UPDATE/DELETE: never deleted. What was raised never changes. The status moves
-- awaiting_reply -> replied (with first_replied_at), and awaiting_reply or replied -> closed or
-- withdrawn (with closed_at, closed_by and the note); closed and withdrawn are final. The
-- reminder is stamped once. Whoever runs the update, the database owner included.
create function private.staff_queries_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A query is never deleted. Withdraw or close it instead.' using errcode = 'MLQY0';
  end if;
  if (
    new.id, new.organisation_id, new.worker_id, new.raised_by, new.raised_by_name, new.kind,
    new.subject, new.body, new.reply_by, new.raised_at
  ) is distinct from (
    old.id, old.organisation_id, old.worker_id, old.raised_by, old.raised_by_name, old.kind,
    old.subject, old.body, old.reply_by, old.raised_at
  ) then
    raise exception 'A query is never edited. Add a follow-up instead.' using errcode = 'MLQY0';
  end if;
  if old.status in ('closed', 'withdrawn') then
    raise exception 'This query is closed.' using errcode = 'MLQY0';
  end if;
  if old.reminded_at is not null and new.reminded_at is distinct from old.reminded_at then
    raise exception 'A query is reminded once.' using errcode = 'MLQY0';
  end if;
  if old.reminded_at is null and new.reminded_at is not null then
    new.reminded_at := now();
  end if;
  if new.first_replied_at is distinct from old.first_replied_at
    and not (old.status = 'awaiting_reply' and new.status = 'replied') then
    raise exception 'The first reply time never changes.' using errcode = 'MLQY0';
  end if;

  if new.status = old.status then
    if (new.closed_at, new.closed_by, new.outcome_note)
      is distinct from (old.closed_at, old.closed_by, old.outcome_note) then
      raise exception 'That change isn''t allowed.' using errcode = 'MLQY0';
    end if;
  elsif old.status = 'awaiting_reply' and new.status = 'replied' then
    new.first_replied_at := now();
    if (new.closed_at, new.closed_by, new.outcome_note) is distinct from (null::timestamptz, null::uuid, null::text) then
      raise exception 'That change isn''t allowed.' using errcode = 'MLQY0';
    end if;
  elsif new.status in ('closed', 'withdrawn') then
    if new.closed_by is null or new.outcome_note is null then
      raise exception 'Closing a query needs who closed it and a note.' using errcode = 'MLQY0';
    end if;
    new.closed_at := now();
  else
    raise exception 'That status change isn''t allowed.' using errcode = 'MLQY0';
  end if;
  return new;
end;
$$;

create function private.staff_queries_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Queries are never deleted.' using errcode = 'MLQY0';
end;
$$;

revoke all on function private.staff_queries_before_insert() from public, anon, authenticated;
revoke all on function private.staff_queries_guard() from public, anon, authenticated;
revoke all on function private.staff_queries_no_truncate() from public, anon, authenticated;

create trigger staff_queries_before_insert before insert on public.staff_queries
  for each row execute function private.staff_queries_before_insert();
create trigger staff_queries_guard before update or delete on public.staff_queries
  for each row execute function private.staff_queries_guard();
create trigger staff_queries_no_truncate before truncate on public.staff_queries
  for each statement execute function private.staff_queries_no_truncate();
create trigger staff_queries_audit after insert or update or delete on public.staff_queries
  for each row execute function private.audit_row_change();

alter table public.staff_queries enable row level security;

create policy staff_queries_select on public.staff_queries
  for select to authenticated
  using (
    organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr']))
    or worker_id in (select private.my_reportee_ids())
    or worker_id in (select private.my_worker_ids())
    or (
      raised_by = (select private.session_uid())
      and organisation_id in (
        select private.role_org_ids(array['owner', 'admin', 'hr', 'line_manager'])
      )
    )
  );

comment on policy staff_queries_select on public.staff_queries is
  'Owner, admin and hr read every query; the worker''s current line manager reads their reportees'' queries; the raiser reads theirs while still a manager in the company; the worker reads their own (slice 4.6).';

revoke all on table public.staff_queries from anon, authenticated;
grant select on table public.staff_queries to authenticated;
-- The secret key may insert (the isolation registry seeds rows that way; the insert trigger
-- fixes the status) but never change, delete or truncate a query.
revoke update, delete, truncate on table public.staff_queries from service_role;

-- ---------------------------------------------------------------------------
-- 3. staff_query_replies (insert-only)
-- ---------------------------------------------------------------------------

create table public.staff_query_replies (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  query_id uuid not null,
  author_user_id uuid not null,
  -- The worker the query is about, or a manager adding a follow-up.
  author_role text not null
    constraint staff_query_replies_author_role_value check (author_role in ('worker', 'manager')),
  author_name text not null
    constraint staff_query_replies_author_name_length check (char_length(author_name) between 1 and 200),
  body text not null
    constraint staff_query_replies_body_text check (private.staff_query_text_ok(body, 2, 2000, true)),
  created_at timestamptz not null default now(),
  constraint staff_query_replies_organisation_id_id_key unique (organisation_id, id),
  constraint staff_query_replies_query_fkey foreign key (organisation_id, query_id)
    references public.staff_queries (organisation_id, id)
);

create index staff_query_replies_query_idx
  on public.staff_query_replies (organisation_id, query_id, created_at);

comment on table public.staff_query_replies is
  'Replies to a query: the worker''s reply or a manager''s follow-up (slice 4.6). Insert-only for every role.';

create function private.staff_query_replies_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_count integer;
begin
  if tg_op = 'INSERT' then
    -- Whoever inserts (the functions, the secret key, the database owner): only onto an open
    -- query, and within its caps, so the worker can't use up the managers' follow-ups. The
    -- parent row is locked, so two replies can't both take the last place.
    select q.status into v_status
    from public.staff_queries q
    where q.organisation_id = new.organisation_id and q.id = new.query_id
    for update;
    if v_status is null then
      raise exception 'That query wasn''t found.' using errcode = 'P0002';
    end if;
    if v_status not in ('awaiting_reply', 'replied') then
      raise exception 'This query is closed.' using errcode = 'MLQY6';
    end if;
    select count(*) into v_count
    from public.staff_query_replies r
    where r.organisation_id = new.organisation_id
      and r.query_id = new.query_id
      and r.author_role = new.author_role;
    if new.author_role = 'worker' and v_count >= 25 then
      raise exception 'This query has 25 replies from the employee already.' using errcode = 'MLQY7';
    end if;
    if new.author_role = 'manager' and v_count >= 5 then
      raise exception 'This query has 5 follow-ups already.' using errcode = 'MLQY7';
    end if;
    new.created_at := now();
    return new;
  end if;
  raise exception 'A reply is never edited or deleted. Add another reply instead.' using errcode = 'MLQY0';
end;
$$;

create function private.staff_query_replies_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A reply is never edited or deleted.' using errcode = 'MLQY0';
end;
$$;

revoke all on function private.staff_query_replies_guard() from public, anon, authenticated;
revoke all on function private.staff_query_replies_no_truncate() from public, anon, authenticated;

create trigger staff_query_replies_guard before insert or update or delete on public.staff_query_replies
  for each row execute function private.staff_query_replies_guard();
create trigger staff_query_replies_no_truncate before truncate on public.staff_query_replies
  for each statement execute function private.staff_query_replies_no_truncate();
create trigger staff_query_replies_audit after insert or update or delete on public.staff_query_replies
  for each row execute function private.audit_row_change();

-- The queries the caller may read: the staff_queries_select rule as a set, computed once per
-- statement, for the replies policy.
create function private.my_staff_query_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select q.id
  from public.staff_queries q
  -- Only the caller's own companies are scanned (security review L1), then the read rule.
  where q.organisation_id in (select private.user_org_ids())
    and (
      q.organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr']))
      or q.worker_id in (select private.my_reportee_ids())
      or q.worker_id in (select private.my_worker_ids())
      or (
        q.raised_by = (select private.session_uid())
        and q.organisation_id in (
          select private.role_org_ids(array['owner', 'admin', 'hr', 'line_manager'])
        )
      )
    )
$$;

revoke all on function private.my_staff_query_ids() from public, anon;
grant execute on function private.my_staff_query_ids() to authenticated, service_role;

alter table public.staff_query_replies enable row level security;

create policy staff_query_replies_select on public.staff_query_replies
  for select to authenticated
  using (
    organisation_id in (select private.user_org_ids())
    and query_id in (select private.my_staff_query_ids())
  );

comment on policy staff_query_replies_select on public.staff_query_replies is
  'Whoever may read the query reads its replies (private.my_staff_query_ids; slice 4.6).';

revoke all on table public.staff_query_replies from anon, authenticated;
grant select on table public.staff_query_replies to authenticated;
revoke update, delete, truncate on table public.staff_query_replies from service_role;

-- ---------------------------------------------------------------------------
-- 4. Who the caller is in the company
-- ---------------------------------------------------------------------------

-- The caller's manager role in the company (owner, admin, hr, line_manager), from a trusted
-- session only; null when they hold none.
create function private.staff_query_manager_role(p_organisation_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role::text
  from public.memberships m
  where m.organisation_id = p_organisation_id
    and m.user_id = (select private.session_uid())
    and m.role in ('owner', 'admin', 'hr', 'line_manager')
  order by array_position(array['owner', 'admin', 'hr', 'line_manager'], m.role::text)
  limit 1
$$;

-- The caller's display name in the company: their profile name, else their own worker record's.
create function private.staff_query_actor_name(p_organisation_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select left(nullif(btrim(p.full_name), ''), 200)
       from public.profiles p where p.user_id = (select private.session_uid())),
    (select left(nullif(btrim(w.first_name || ' ' || w.last_name), ''), 200)
       from public.memberships m
       join public.workers w on w.organisation_id = m.organisation_id and w.id = m.worker_id
      where m.organisation_id = p_organisation_id
        and m.user_id = (select private.session_uid())
      limit 1),
    'Your manager'
  )
$$;

-- True when the caller's own worker record in the company is `p_worker_id`.
create function private.staff_query_is_self(p_organisation_id uuid, p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id
      and m.user_id = (select private.session_uid())
      and m.worker_id = p_worker_id
  )
$$;

-- May the caller (with manager role `p_role`) act on query `q` as a manager: owner, admin and
-- hr always; the worker's current line manager; the raiser while still a manager.
create function private.staff_query_manager_may(
  p_role text,
  p_worker_id uuid,
  p_raised_by uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_role is not null and (
    p_role in ('owner', 'admin', 'hr')
    or (p_role = 'line_manager' and p_worker_id in (select private.my_reportee_ids()))
    or p_raised_by = (select private.session_uid())
  )
$$;

revoke all on function private.staff_query_manager_role(uuid) from public, anon, authenticated;
revoke all on function private.staff_query_actor_name(uuid) from public, anon, authenticated;
revoke all on function private.staff_query_is_self(uuid, uuid) from public, anon, authenticated;
revoke all on function private.staff_query_manager_may(text, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. raise_staff_query
-- ---------------------------------------------------------------------------

-- Raises a query about one worker. Returns the new query's id.
create function private.raise_staff_query(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_kind text,
  p_subject text,
  p_body text,
  p_reply_by date
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_role text;
  v_status public.worker_status;
  v_today date;
  v_id uuid;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in again to raise a query.' using errcode = '42501';
  end if;
  v_role := private.staff_query_manager_role(p_organisation_id);
  if v_role is null then
    raise exception 'Your role can''t raise queries.' using errcode = '42501';
  end if;
  select w.status into v_status
  from public.workers w
  where w.organisation_id = p_organisation_id and w.id = p_worker_id;
  if v_status is null then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  if v_role = 'line_manager' and p_worker_id not in (select private.my_reportee_ids()) then
    raise exception 'You can raise queries only for people who report to you.' using errcode = 'MLQY2';
  end if;
  if private.staff_query_is_self(p_organisation_id, p_worker_id) then
    raise exception 'You can''t raise a query about yourself.' using errcode = 'MLQY4';
  end if;
  if v_status = 'ended' then
    raise exception 'This employee has left.' using errcode = 'MLQY3';
  end if;
  if p_kind is null
    or p_kind not in ('lateness', 'absence_without_leave', 'conduct', 'performance', 'other')
    or not private.staff_query_text_ok(p_subject, 3, 120, false)
    or not private.staff_query_text_ok(p_body, 3, 2000, true) then
    raise exception 'Check the query''s type, subject and text.' using errcode = 'MLQY1';
  end if;
  v_today := private.org_today(p_organisation_id);
  if p_reply_by is null or p_reply_by < v_today or p_reply_by > v_today + 60 then
    raise exception 'Choose a reply-by date from today to 60 days ahead.' using errcode = 'MLQY5';
  end if;

  insert into public.staff_queries (
    organisation_id, worker_id, raised_by, raised_by_name, kind, subject, body, reply_by
  )
  values (
    p_organisation_id, p_worker_id, v_uid, private.staff_query_actor_name(p_organisation_id),
    p_kind, p_subject, p_body, p_reply_by
  )
  returning id into v_id;

  perform private.log_audit_impl(
    p_organisation_id,
    'people.query_raised',
    'staff_queries',
    v_id,
    null,
    jsonb_build_object('worker_id', p_worker_id, 'kind', p_kind, 'reply_by', p_reply_by),
    null
  );
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. reply_to_staff_query
-- ---------------------------------------------------------------------------

-- The worker replies to their own query, or a manager who may read it adds a follow-up.
-- Returns {reply_id, query_id, worker_id, author_role, subject}.
create function private.reply_to_staff_query(
  p_organisation_id uuid,
  p_query_id uuid,
  p_body text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_query public.staff_queries%rowtype;
  v_worker_status public.worker_status;
  v_is_worker boolean;
  v_role text;
  v_author_name text;
  v_id uuid;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in again to reply.' using errcode = '42501';
  end if;
  select * into v_query
  from public.staff_queries q
  where q.organisation_id = p_organisation_id and q.id = p_query_id
  for update;
  if v_query.id is null then
    raise exception 'That query wasn''t found.' using errcode = 'P0002';
  end if;

  -- The worker themselves: a login linked to the query's worker record (a worker login, or a
  -- manager who is also an employee and is the one queried).
  v_is_worker := private.staff_query_is_self(p_organisation_id, v_query.worker_id);
  if v_is_worker then
    select w.status, left(btrim(w.first_name || ' ' || w.last_name), 200)
      into v_worker_status, v_author_name
    from public.workers w
    where w.organisation_id = p_organisation_id and w.id = v_query.worker_id;
    if v_worker_status = 'ended' then
      raise exception 'You have left this company.' using errcode = 'MLQY3';
    end if;
    perform set_config('metalira.audit_channel', 'worker_app', true);
  else
    v_role := private.staff_query_manager_role(p_organisation_id);
    if not private.staff_query_manager_may(v_role, v_query.worker_id, v_query.raised_by) then
      -- Someone who can't read the query learns nothing about it.
      raise exception 'That query wasn''t found.' using errcode = 'P0002';
    end if;
    v_author_name := private.staff_query_actor_name(p_organisation_id);
  end if;

  if v_query.status not in ('awaiting_reply', 'replied') then
    raise exception 'This query is closed.' using errcode = 'MLQY6';
  end if;
  if not private.staff_query_text_ok(p_body, 2, 2000, true) then
    raise exception 'Check the reply''s text.' using errcode = 'MLQY1';
  end if;
  -- The caps (25 worker replies, 5 follow-ups) are checked by the replies' insert trigger.

  insert into public.staff_query_replies (
    organisation_id, query_id, author_user_id, author_role, author_name, body
  )
  values (
    p_organisation_id, p_query_id, v_uid, case when v_is_worker then 'worker' else 'manager' end,
    coalesce(nullif(v_author_name, ''), 'Employee'), p_body
  )
  returning id into v_id;

  if v_is_worker and v_query.status = 'awaiting_reply' then
    update public.staff_queries q
    set status = 'replied', first_replied_at = now()
    where q.id = p_query_id;
  end if;
  if not v_is_worker then
    perform private.log_audit_impl(
      p_organisation_id,
      'people.query_followed_up',
      'staff_queries',
      p_query_id,
      null,
      jsonb_build_object('reply_id', v_id),
      null
    );
  end if;

  return jsonb_build_object(
    'reply_id', v_id,
    'query_id', p_query_id,
    'worker_id', v_query.worker_id,
    'author_role', case when v_is_worker then 'worker' else 'manager' end,
    'subject', v_query.subject
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. close_staff_query and withdraw_staff_query
-- ---------------------------------------------------------------------------

-- Closes an open query with an outcome note. Returns the worker's id.
create function private.close_staff_query(
  p_organisation_id uuid,
  p_query_id uuid,
  p_outcome text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_query public.staff_queries%rowtype;
  v_role text;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in again to close a query.' using errcode = '42501';
  end if;
  v_role := private.staff_query_manager_role(p_organisation_id);
  if v_role is null then
    raise exception 'Your role can''t close queries.' using errcode = '42501';
  end if;
  select * into v_query
  from public.staff_queries q
  where q.organisation_id = p_organisation_id and q.id = p_query_id
  for update;
  if v_query.id is null
    or not private.staff_query_manager_may(v_role, v_query.worker_id, v_query.raised_by) then
    raise exception 'That query wasn''t found.' using errcode = 'P0002';
  end if;
  if private.staff_query_is_self(p_organisation_id, v_query.worker_id) then
    raise exception 'You can''t close a query about yourself.' using errcode = 'MLQY4';
  end if;
  if v_query.status not in ('awaiting_reply', 'replied') then
    raise exception 'This query is closed already.' using errcode = 'MLQY6';
  end if;
  if not private.staff_query_text_ok(p_outcome, 3, 1000, true) then
    raise exception 'Write the outcome in plain text.' using errcode = 'MLQY1';
  end if;

  update public.staff_queries q
  set status = 'closed', closed_by = v_uid, outcome_note = p_outcome
  where q.id = p_query_id;

  perform private.log_audit_impl(
    p_organisation_id,
    'people.query_closed',
    'staff_queries',
    p_query_id,
    jsonb_build_object('status', v_query.status),
    jsonb_build_object('status', 'closed'),
    p_outcome
  );
  return v_query.worker_id;
end;
$$;

-- The raiser withdraws their open query, with a reason. Returns the worker's id.
create function private.withdraw_staff_query(
  p_organisation_id uuid,
  p_query_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_query public.staff_queries%rowtype;
  v_role text;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in again to withdraw a query.' using errcode = '42501';
  end if;
  v_role := private.staff_query_manager_role(p_organisation_id);
  if v_role is null then
    raise exception 'Your role can''t withdraw queries.' using errcode = '42501';
  end if;
  select * into v_query
  from public.staff_queries q
  where q.organisation_id = p_organisation_id and q.id = p_query_id
  for update;
  if v_query.id is null
    or not private.staff_query_manager_may(v_role, v_query.worker_id, v_query.raised_by) then
    raise exception 'That query wasn''t found.' using errcode = 'P0002';
  end if;
  if v_query.raised_by <> v_uid then
    raise exception 'Only the person who raised a query can withdraw it.' using errcode = 'MLQY2';
  end if;
  if v_query.status not in ('awaiting_reply', 'replied') then
    raise exception 'This query is closed already.' using errcode = 'MLQY6';
  end if;
  if not private.staff_query_text_ok(p_reason, 3, 1000, true) then
    raise exception 'Write the reason in plain text.' using errcode = 'MLQY1';
  end if;

  update public.staff_queries q
  set status = 'withdrawn', closed_by = v_uid, outcome_note = p_reason
  where q.id = p_query_id;

  perform private.log_audit_impl(
    p_organisation_id,
    'people.query_withdrawn',
    'staff_queries',
    p_query_id,
    jsonb_build_object('status', v_query.status),
    jsonb_build_object('status', 'withdrawn'),
    p_reason
  );
  return v_query.worker_id;
end;
$$;

revoke all on function private.raise_staff_query(uuid, uuid, text, text, text, date) from public, anon;
revoke all on function private.reply_to_staff_query(uuid, uuid, text) from public, anon;
revoke all on function private.close_staff_query(uuid, uuid, text) from public, anon;
revoke all on function private.withdraw_staff_query(uuid, uuid, text) from public, anon;
grant execute on function private.raise_staff_query(uuid, uuid, text, text, text, date) to authenticated;
grant execute on function private.reply_to_staff_query(uuid, uuid, text) to authenticated;
grant execute on function private.close_staff_query(uuid, uuid, text) to authenticated;
grant execute on function private.withdraw_staff_query(uuid, uuid, text) to authenticated;

create function public.raise_staff_query(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_kind text,
  p_subject text,
  p_body text,
  p_reply_by date
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.raise_staff_query(p_organisation_id, p_worker_id, p_kind, p_subject, p_body, p_reply_by)
$$;

create function public.reply_to_staff_query(p_organisation_id uuid, p_query_id uuid, p_body text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.reply_to_staff_query(p_organisation_id, p_query_id, p_body)
$$;

create function public.close_staff_query(p_organisation_id uuid, p_query_id uuid, p_outcome text)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.close_staff_query(p_organisation_id, p_query_id, p_outcome)
$$;

create function public.withdraw_staff_query(p_organisation_id uuid, p_query_id uuid, p_reason text)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.withdraw_staff_query(p_organisation_id, p_query_id, p_reason)
$$;

revoke all on function public.raise_staff_query(uuid, uuid, text, text, text, date) from public, anon;
revoke all on function public.reply_to_staff_query(uuid, uuid, text) from public, anon;
revoke all on function public.close_staff_query(uuid, uuid, text) from public, anon;
revoke all on function public.withdraw_staff_query(uuid, uuid, text) from public, anon;
grant execute on function public.raise_staff_query(uuid, uuid, text, text, text, date) to authenticated;
grant execute on function public.reply_to_staff_query(uuid, uuid, text) to authenticated;
grant execute on function public.close_staff_query(uuid, uuid, text) to authenticated;
grant execute on function public.withdraw_staff_query(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Daily reminders (server only)
-- ---------------------------------------------------------------------------

-- Claims up to `p_limit` queries due a reminder and stamps reminded_at, so each is reminded
-- once: still awaiting a reply, reply-by date tomorrow in the company's time zone, raised more
-- than 12 hours ago (a query raised this morning was just sent), the worker still employed.
-- For the daily cron with the secret key only; the server tells each worker (inbox, and email
-- within the caps). Returns what the notice needs, and no body text.
create function private.claim_staff_query_reminders(p_limit integer)
returns table (
  query_id uuid,
  organisation_id uuid,
  worker_id uuid,
  subject text,
  reply_by date
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Claim between 1 and 500 reminders.' using errcode = '22023';
  end if;
  return query
  with due as materialized (
    select q.id
    from public.staff_queries q
    join public.workers w on w.organisation_id = q.organisation_id and w.id = q.worker_id
    where q.status = 'awaiting_reply'
      and q.reminded_at is null
      and q.reply_by = private.org_today(q.organisation_id) + 1
      and q.raised_at < now() - interval '12 hours'
      and w.status = 'active'
    order by q.reply_by, q.id
    limit p_limit
    for update of q skip locked
  )
  , claimed as (
    update public.staff_queries q
    set reminded_at = now()
    from due
    where q.id = due.id
    returning q.id, q.organisation_id, q.worker_id, q.subject, q.reply_by
  )
  select c.id, c.organisation_id, c.worker_id, c.subject, c.reply_by from claimed c;
end;
$$;

revoke all on function private.claim_staff_query_reminders(integer) from public, anon, authenticated;
grant execute on function private.claim_staff_query_reminders(integer) to service_role;

create function public.claim_staff_query_reminders(p_limit integer)
returns table (
  query_id uuid,
  organisation_id uuid,
  worker_id uuid,
  subject text,
  reply_by date
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from private.claim_staff_query_reminders(p_limit)
$$;

revoke all on function public.claim_staff_query_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_staff_query_reminders(integer) to service_role;

comment on function public.claim_staff_query_reminders(integer) is
  'Server only (secret key): claims queries whose reply-by date is tomorrow and still awaiting a reply, each once, for the daily reminder (slice 4.6).';
