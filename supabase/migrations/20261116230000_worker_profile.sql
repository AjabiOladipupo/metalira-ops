-- Slice 1.10: worker app shell and profile.
--
-- The worker app reads everything with the worker's own session (publishable key + RLS). Two
-- things it needs were not reachable that way:
--
-- 1. The name of the worker's line manager. The line manager is another worker (whose row the
--    worker can't read) or a manager-app user (whose membership and profile the worker can't
--    read). private.my_line_manager returns only that one name, only for the caller's own
--    worker record in the organisation asked about.
-- 2. "Request a change" for anything other than bank details (bank details go through
--    bank_detail_changes, slice 1.7). public.worker_change_requests holds what the worker asked
--    for in their own words; HR sees it on the worker page and marks it done or declined after
--    changing the record themselves. A request never changes the worker record by itself.
--
-- Rules for worker_change_requests:
-- * Only the worker raises one, for themselves, while employed; at most 5 open at a time.
-- * Insert-only history: the request's own columns never change and rows are never deleted.
--   Owner, admin and hr move the status open -> done or declined; the trigger fills in who and
--   when.
-- * The text is plain words, never personal numbers: a run of 10 or more digits (a NIN, bank
--   account, RSA PIN or phone number) is refused, so none of them ever lands in the table or
--   in audit_log in clear (CLAUDE.md rule 9). The worker app says why and HR asks in person.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create type public.worker_change_topic as enum (
  'name',
  'phone',
  'email',
  'next_of_kin',
  'nin',
  'tax_pension',
  'work',
  'other'
);

create type public.worker_change_request_status as enum ('open', 'done', 'declined');

create table public.worker_change_requests (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  -- The worker's login that raised it (the trigger sets it from the session). No foreign key,
  -- as on audit_log.
  requested_by uuid not null default auth.uid(),
  topic public.worker_change_topic not null,
  details text not null
    constraint worker_change_requests_details_text check (
      details = btrim(details)
      and char_length(details) between 3 and 500
      -- Plain text: line breaks are allowed, other control characters and < > are not.
      and details !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f<>]'
      -- No personal numbers (NIN, NUBAN, RSA PIN, phone), even split by spaces or dashes.
      and regexp_replace(details, '[\s.()/-]', '', 'g') !~ '[0-9]{10,}'
    ),

  status public.worker_change_request_status not null default 'open',
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text
    constraint worker_change_requests_resolution_note_text check (
      resolution_note = btrim(resolution_note)
      and char_length(resolution_note) between 1 and 500
      and resolution_note !~ '[\x01-\x1f\x7f-\x9f<>]'
      and regexp_replace(resolution_note, '[\s.()/-]', '', 'g') !~ '[0-9]{10,}'
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint worker_change_requests_organisation_id_id_key unique (organisation_id, id),
  constraint worker_change_requests_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint worker_change_requests_status_columns check (
    case status
      when 'open' then num_nonnulls(resolved_by, resolved_at, resolution_note) = 0
      else resolved_at is not null
    end
  )
);

create index worker_change_requests_worker_idx
  on public.worker_change_requests (worker_id, created_at desc);
create index worker_change_requests_open_idx
  on public.worker_change_requests (organisation_id, created_at desc)
  where status = 'open';

comment on table public.worker_change_requests is
  'Changes a worker asks HR to make to their own record from the worker app (slice 1.10), other than bank details (bank_detail_changes). HR changes the record and marks the request done or declined. Insert-only history; never holds personal numbers.';

-- ---------------------------------------------------------------------------
-- 2. Trigger functions
-- ---------------------------------------------------------------------------

-- BEFORE INSERT. A new request is open, raised by the worker for themselves while employed,
-- and the worker has fewer than 5 open. Definer: it reads the caller's memberships and the
-- worker row. The identity check comes first, so nothing about another worker or organisation
-- is revealed.
create function private.worker_change_requests_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_status public.worker_status;
  v_open integer;
begin
  if v_actor is not null then
    if new.worker_id is null or new.worker_id not in (select private.my_worker_ids()) then
      raise exception 'Only the employee can ask for a change to their own details.'
        using errcode = '42501';
    end if;
    new.requested_by := v_actor;
  end if;
  if new.requested_by is null then
    raise exception 'A change request needs the person who raised it.' using errcode = '23502';
  end if;

  -- Lock the worker row so two requests at once can't both get under the limit.
  select w.status into v_status
  from public.workers w
  where w.id = new.worker_id and w.organisation_id = new.organisation_id
  for update;
  if v_status is null then
    raise exception 'That employee wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status = 'ended' then
    raise exception 'This employee has left, so they can''t ask for changes.'
      using errcode = 'MLCR1';
  end if;

  select count(*) into v_open
  from public.worker_change_requests r
  where r.worker_id = new.worker_id and r.status = 'open';
  if v_open >= 5 then
    raise exception 'There are already 5 requests waiting for HR.' using errcode = 'MLCR2';
  end if;

  new.status := 'open';
  new.resolved_by := null;
  new.resolved_at := null;
  new.resolution_note := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

-- BEFORE UPDATE. The request itself is fixed; only the status moves open -> done or declined,
-- by owner, admin or hr (RLS lets nobody else update), and this fills in who and when.
create function private.worker_change_requests_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if (new.id, new.organisation_id, new.worker_id, new.requested_by, new.topic, new.details,
      new.created_at)
    is distinct from
     (old.id, old.organisation_id, old.worker_id, old.requested_by, old.topic, old.details,
      old.created_at) then
    raise exception 'A change request can''t be edited. The employee can raise a new one.'
      using errcode = 'MLCR3';
  end if;

  if v_actor is not null
    and not private.has_role(old.organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Only the owner, an admin or HR can deal with change requests.'
      using errcode = '42501';
  end if;
  if old.status <> 'open' then
    raise exception 'This request has already been dealt with.' using errcode = 'MLCR4';
  end if;
  if new.status = 'open' then
    raise exception 'Mark the request done or declined.' using errcode = 'MLCR4';
  end if;

  new.resolved_by := v_actor;
  new.resolved_at := now();
  return new;
end;
$$;

-- BEFORE DELETE: requests are history.
create function private.worker_change_requests_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Change requests are kept as history and can''t be deleted.'
    using errcode = 'MLCR5';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------

create trigger worker_change_requests_before_insert
  before insert on public.worker_change_requests
  for each row execute function private.worker_change_requests_before_insert();
create trigger worker_change_requests_before_update
  before update on public.worker_change_requests
  for each row execute function private.worker_change_requests_before_update();
create trigger worker_change_requests_set_updated_at
  before update on public.worker_change_requests
  for each row execute function private.set_updated_at();
create trigger worker_change_requests_no_delete
  before delete on public.worker_change_requests
  for each row execute function private.worker_change_requests_no_delete();
create trigger worker_change_requests_audit
  after insert or update or delete on public.worker_change_requests
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants
-- ---------------------------------------------------------------------------
-- Read: owner, admin and hr (who change worker records), and the worker their own requests.
-- Insert: the worker, for themselves. Update (status moves only, checked by trigger): owner,
-- admin and hr. No delete.

alter table public.worker_change_requests enable row level security;

create policy worker_change_requests_select on public.worker_change_requests
  for select to authenticated
  using (
    private.has_role(organisation_id, array['owner', 'admin', 'hr'])
    or worker_id in (select private.my_worker_ids())
  );
create policy worker_change_requests_insert on public.worker_change_requests
  for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and worker_id in (select private.my_worker_ids())
  );
create policy worker_change_requests_update on public.worker_change_requests
  for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

revoke all on table public.worker_change_requests from anon, authenticated;
grant select on table public.worker_change_requests to authenticated;
grant insert (organisation_id, worker_id, topic, details)
  on table public.worker_change_requests to authenticated;
grant update (status, resolution_note) on table public.worker_change_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The worker's line manager, by name only
-- ---------------------------------------------------------------------------
-- For the caller's own worker record in p_organisation_id: whether a line manager is set, and
-- their name (a worker line manager's name, or a manager-app user's profile name, which may be
-- blank). Nothing else about the line manager, and nothing for anyone else's record.

create function private.my_line_manager(p_organisation_id uuid)
returns table (has_line_manager boolean, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (w.line_manager_worker_id is not null or w.line_manager_membership_id is not null),
    case
      when lm.id is not null then lm.first_name || ' ' || lm.last_name
      else nullif(btrim(p.full_name), '')
    end
  from public.workers w
  left join public.workers lm
    on lm.id = w.line_manager_worker_id
    and lm.organisation_id = w.organisation_id
  left join public.memberships ms
    on ms.id = w.line_manager_membership_id
    and ms.organisation_id = w.organisation_id
  left join public.profiles p on p.user_id = ms.user_id
  where w.organisation_id = p_organisation_id
    and w.id in (select private.my_worker_ids())
  limit 1
$$;

create function public.my_line_manager(p_organisation_id uuid)
returns table (has_line_manager boolean, name text)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.has_line_manager, l.name from private.my_line_manager(p_organisation_id) as l
$$;

-- ---------------------------------------------------------------------------
-- 6. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.worker_change_requests_before_insert() from public, anon, authenticated;
revoke all on function private.worker_change_requests_before_update() from public, anon, authenticated;
revoke all on function private.worker_change_requests_no_delete() from public, anon, authenticated;

revoke all on function private.my_line_manager(uuid) from public, anon;
grant execute on function private.my_line_manager(uuid) to authenticated, service_role;
revoke all on function public.my_line_manager(uuid) from public, anon;
grant execute on function public.my_line_manager(uuid) to authenticated, service_role;
