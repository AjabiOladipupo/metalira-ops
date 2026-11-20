-- Slice 3.1: worker consents (location and selfie) and the worker inbox.
--
-- 1. `worker_consents`: one row each time a worker agrees to a notice (location or selfie) in the
--    worker app, with the notice version they saw. History is insert-only: a consent is never
--    edited or deleted. Withdrawing sets `withdrawn_at` on the open row, once, through
--    public.withdraw_worker_consent only (a definer function; the table grants no UPDATE). Agreeing
--    again adds a new row. At most one open row per worker and kind. Every insert and the
--    withdrawal are logged by the audit trigger with channel `worker_app`.
--    Chosen over "withdrawing adds a row" so the current state is one indexed row, and the
--    history still reads as accepted -> withdrawn -> accepted again.
-- 2. Notice versions are "major.minor" and only known versions are accepted
--    (private.consent_notice_known, kept in step with src/lib/messages/consent.ts). A wording fix
--    bumps the minor and keeps every consent; a change of meaning bumps the major
--    (private.consent_notice_major) and workers are asked again (owner's default, pending their
--    answer, 20 Nov 2026).
--    private.worker_has_consent(org, worker, kind): true while the worker has an open consent of
--    that kind under the current major version. Slice 3.5's punch function calls it. A worker who
--    declines or withdraws is clocked in by their supervisor (owner decision, 20 Nov 2026).
-- 3. `inbox_items`: messages to one worker (kind, title, plain-text body with no web addresses
--    and no personal numbers, an optional internal /m link). Only the server (secret key) or SQL functions add them. The
--    worker reads their own and can only set `read_at` (a column grant; the guard sets it to
--    now() and never clears it). Owner, admin and HR may read a worker's items, read-only, to
--    answer "did they get the notice?": every item is something the company itself sent. Other
--    managers can't. `emailed_at` records the email nudge (src/server/workforce/notify.ts) and
--    feeds the email caps in public.claim_inbox_email.
--
-- Refusals (SQLSTATE), mapped to plain English in src/server/workforce/consents.ts:
--   MLCN1 no worker record for this login in this company
--   MLCN2 the worker has left
--   MLCN3 unknown kind or notice version, or a change to a consent other than withdrawing it
--   MLIB1 inbox item change refused (only read_at, once)

-- ---------------------------------------------------------------------------
-- 1. worker_consents
-- ---------------------------------------------------------------------------

create table public.worker_consents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  kind text not null
    constraint worker_consents_kind_value check (kind in ('location', 'selfie')),
  -- The version of the notice the worker saw, "major.minor" (src/lib/messages/consent.ts).
  notice_version text not null
    constraint worker_consents_notice_version_format check (
      notice_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'
    ),
  accepted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  -- Where the worker agreed. Only the worker app records consent today.
  channel text not null default 'worker_app'
    constraint worker_consents_channel_value check (channel in ('worker_app')),
  created_by uuid default auth.uid(),
  constraint worker_consents_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint worker_consents_withdrawn_after check (withdrawn_at >= accepted_at)
);

create unique index worker_consents_one_open_key
  on public.worker_consents (worker_id, kind) where withdrawn_at is null;
create index worker_consents_worker_idx on public.worker_consents (organisation_id, worker_id, kind);

comment on table public.worker_consents is
  'Consents a worker gave in the worker app (location, selfie), with the notice version. Insert-only history; withdrawing sets withdrawn_at once (public.withdraw_worker_consent). At most one open row per worker and kind.';

-- BEFORE UPDATE/DELETE: never deleted; the only change is setting withdrawn_at once.
create function private.worker_consents_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Consents are never deleted.' using errcode = 'MLCN3';
  end if;
  if (
    new.id, new.organisation_id, new.worker_id, new.kind, new.notice_version, new.accepted_at,
    new.channel, new.created_by
  ) is distinct from (
    old.id, old.organisation_id, old.worker_id, old.kind, old.notice_version, old.accepted_at,
    old.channel, old.created_by
  ) or old.withdrawn_at is not null or new.withdrawn_at is null then
    raise exception 'A consent is never edited; it can only be withdrawn once.' using errcode = 'MLCN3';
  end if;
  return new;
end;
$$;

revoke all on function private.worker_consents_guard() from public, anon, authenticated;

create trigger worker_consents_guard before update or delete on public.worker_consents
  for each row execute function private.worker_consents_guard();
create trigger worker_consents_audit after insert or update or delete on public.worker_consents
  for each row execute function private.audit_row_change();

alter table public.worker_consents enable row level security;

create policy worker_consents_select on public.worker_consents
  for select to authenticated
  using (
    worker_id in (select private.my_worker_ids())
    or organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr']))
  );

revoke all on table public.worker_consents from anon, authenticated;
grant select on table public.worker_consents to authenticated;
-- Not even the server's secret key records or changes a consent: only the worker, through
-- accept_worker_consent and withdraw_worker_consent (security review, slice 3.1).
revoke insert, update, delete, truncate on table public.worker_consents from service_role;

-- The notice versions a worker may agree to. Add a row here in the same pull request as new
-- wording in src/lib/messages/consent.ts (tests/rls/worker-consents-inbox.test.ts checks both).
create function private.consent_notice_known(p_kind text, p_version text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_kind, p_version) in (values
    ('location', '1.0'),
    ('selfie', '1.0')
  )
$$;

-- The current major version of each notice: consents under an older major no longer count.
create function private.consent_notice_major(p_kind text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_kind when 'location' then 1 when 'selfie' then 1 end
$$;

-- The major part of "major.minor".
create function private.consent_version_major(p_version text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$' then split_part(p_version, '.', 1)::integer end
$$;

revoke all on function private.consent_notice_known(text, text) from public, anon, authenticated;
revoke all on function private.consent_notice_major(text) from public, anon, authenticated;
revoke all on function private.consent_version_major(text) from public, anon, authenticated;

-- The caller's own worker record in `p_organisation_id` (a worker login), or an error.
create function private.my_worker_in(p_organisation_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_status public.worker_status;
begin
  select m.worker_id, w.status into v_worker, v_status
  from public.memberships m
  join public.workers w on w.organisation_id = m.organisation_id and w.id = m.worker_id
  where m.organisation_id = p_organisation_id
    and m.user_id = (select private.session_uid())
    and m.role = 'worker'
    and m.worker_id is not null;
  if v_worker is null then
    raise exception 'Only the worker can do this, signed in to the worker app.' using errcode = 'MLCN1';
  end if;
  if v_status = 'ended' then
    raise exception 'You have left this company.' using errcode = 'MLCN2';
  end if;
  return v_worker;
end;
$$;

revoke all on function private.my_worker_in(uuid) from public, anon, authenticated;

-- The worker agrees to the `p_kind` notice they were shown, a known version only. Idempotent: an
-- open consent under the current major version is kept as it is and returned. An open consent
-- under an older major is closed (withdrawn_at) and a new row added.
create function private.accept_worker_consent(
  p_organisation_id uuid,
  p_kind text,
  p_notice_version text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_id uuid;
begin
  if p_kind is null or p_notice_version is null
    or not private.consent_notice_known(p_kind, p_notice_version) then
    raise exception 'Unknown consent or notice.' using errcode = 'MLCN3';
  end if;
  v_worker := private.my_worker_in(p_organisation_id);
  perform set_config('metalira.audit_channel', 'worker_app', true);
  -- Serialise this worker's consent changes, so two taps can't race the one-open rule.
  perform pg_advisory_xact_lock(hashtextextended('worker_consents:' || v_worker::text, 0));

  select c.id into v_id
  from public.worker_consents c
  where c.worker_id = v_worker and c.kind = p_kind and c.withdrawn_at is null
    and private.consent_version_major(c.notice_version) = private.consent_notice_major(p_kind);
  if v_id is not null then
    return v_id;
  end if;
  -- An open consent to an older meaning of the notice is closed before the new one starts.
  update public.worker_consents c
  set withdrawn_at = greatest(now(), c.accepted_at)
  where c.worker_id = v_worker and c.kind = p_kind and c.withdrawn_at is null;

  insert into public.worker_consents (organisation_id, worker_id, kind, notice_version, created_by)
  values (p_organisation_id, v_worker, p_kind, p_notice_version, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- The worker withdraws their open `p_kind` consent. Returns false when there was none.
create function private.withdraw_worker_consent(p_organisation_id uuid, p_kind text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_count integer;
begin
  if p_kind is null or p_kind not in ('location', 'selfie') then
    raise exception 'Unknown consent.' using errcode = 'MLCN3';
  end if;
  -- A worker who has left may still withdraw: withdrawing only ever narrows what is collected.
  select m.worker_id into v_worker
  from public.memberships m
  where m.organisation_id = p_organisation_id
    and m.user_id = (select private.session_uid())
    and m.role = 'worker'
    and m.worker_id is not null;
  if v_worker is null then
    raise exception 'Only the worker can do this, signed in to the worker app.' using errcode = 'MLCN1';
  end if;
  perform set_config('metalira.audit_channel', 'worker_app', true);
  perform pg_advisory_xact_lock(hashtextextended('worker_consents:' || v_worker::text, 0));

  update public.worker_consents c
  set withdrawn_at = greatest(now(), c.accepted_at)
  where c.worker_id = v_worker and c.kind = p_kind and c.withdrawn_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function private.accept_worker_consent(uuid, text, text) from public, anon;
revoke all on function private.withdraw_worker_consent(uuid, text) from public, anon;
grant execute on function private.accept_worker_consent(uuid, text, text) to authenticated;
grant execute on function private.withdraw_worker_consent(uuid, text) to authenticated;

create function public.accept_worker_consent(
  p_organisation_id uuid,
  p_kind text,
  p_notice_version text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.accept_worker_consent(p_organisation_id, p_kind, p_notice_version)
$$;

create function public.withdraw_worker_consent(p_organisation_id uuid, p_kind text)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.withdraw_worker_consent(p_organisation_id, p_kind)
$$;

revoke all on function public.accept_worker_consent(uuid, text, text) from public, anon;
revoke all on function public.withdraw_worker_consent(uuid, text) from public, anon;
grant execute on function public.accept_worker_consent(uuid, text, text) to authenticated;
grant execute on function public.withdraw_worker_consent(uuid, text) to authenticated;

-- For slice 3.5's punch function (runs as the caller, inside a definer function): does the
-- worker have an open consent of this kind under the current major notice version? Not
-- callable from the Data API.
create function private.worker_has_consent(p_organisation_id uuid, p_worker_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.worker_consents c
    where c.organisation_id = p_organisation_id
      and c.worker_id = p_worker_id
      and c.kind = p_kind
      and c.withdrawn_at is null
      and private.consent_version_major(c.notice_version) = private.consent_notice_major(p_kind)
  )
$$;

revoke all on function private.worker_has_consent(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. inbox_items
-- ---------------------------------------------------------------------------

create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  -- What it is about, for icons and filters later: "shift_published", "consent".
  kind text not null
    constraint inbox_items_kind_format check (kind ~ '^[a-z][a-z_]{1,39}$'),
  title text not null
    constraint inbox_items_title_text check (
      title = btrim(title)
      and char_length(title) between 1 and 120
      and title !~ '[\x01-\x1f\x7f-\x9f<>]'
      and title !~* '(://|www\.)'
      and title !~ '[0-9]([ -]*[0-9]){9,}'
    ),
  -- Plain text: line breaks allowed, no other control characters, no web addresses.
  body text not null
    constraint inbox_items_body_text check (
      body = btrim(body)
      and char_length(body) between 1 and 1000
      and body !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f<>]'
      and body !~* '(://|www\.)'
      -- No personal numbers (rule 9): 10 or more digits with only spaces or hyphens between them
      -- (src/lib/inbox.ts hasPersonalNumberRun, the same rule). Dates and times stay allowed.
      and body !~ '[0-9]([ -]*[0-9]){9,}'
    ),
  -- An internal worker-app path ("/m/shifts"), never a full address (src/lib/inbox.ts).
  link_path text
    constraint inbox_items_link_path_format check (
      char_length(link_path) <= 200 and link_path ~ '^/m(/[A-Za-z0-9_-]+)*$'
    ),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  -- When the email nudge was claimed under the caps (public.claim_inbox_email); null if none.
  emailed_at timestamptz,
  constraint inbox_items_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id)
);

create index inbox_items_worker_idx on public.inbox_items (worker_id, created_at desc);
create index inbox_items_unread_idx on public.inbox_items (worker_id) where read_at is null;
create index inbox_items_emailed_idx on public.inbox_items (organisation_id, emailed_at)
  where emailed_at is not null;

comment on table public.inbox_items is
  'Messages to one worker in the worker app. Added only by the server or SQL functions; the worker can only mark them read. Owner, admin and HR may read them.';

-- BEFORE UPDATE/DELETE: never deleted; the worker's only change is marking read (set to now(),
-- never cleared); the server may stamp emailed_at once.
create function private.inbox_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Inbox items are never deleted.' using errcode = 'MLIB1';
  end if;
  if (
    new.id, new.organisation_id, new.worker_id, new.kind, new.title, new.body, new.link_path,
    new.created_at
  ) is distinct from (
    old.id, old.organisation_id, old.worker_id, old.kind, old.title, old.body, old.link_path,
    old.created_at
  ) then
    raise exception 'An inbox item never changes.' using errcode = 'MLIB1';
  end if;
  if old.read_at is not null then
    new.read_at := old.read_at;
  elsif new.read_at is not null then
    new.read_at := now();
  end if;
  if old.emailed_at is not null and new.emailed_at is distinct from old.emailed_at then
    raise exception 'An inbox item is emailed once.' using errcode = 'MLIB1';
  end if;
  if old.emailed_at is null and new.emailed_at is not null then
    new.emailed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.inbox_items_guard() from public, anon, authenticated;

create trigger inbox_items_guard before update or delete on public.inbox_items
  for each row execute function private.inbox_items_guard();
create trigger inbox_items_audit after insert or update or delete on public.inbox_items
  for each row execute function private.audit_row_change();

alter table public.inbox_items enable row level security;

create policy inbox_items_select on public.inbox_items
  for select to authenticated
  using (
    worker_id in (select private.my_worker_ids())
    or organisation_id in (select private.role_org_ids(array['owner', 'admin', 'hr']))
  );

-- The worker marks their own items read; nobody else updates through the Data API.
create policy inbox_items_mark_read on public.inbox_items
  for update to authenticated
  using (worker_id in (select private.my_worker_ids()))
  with check (worker_id in (select private.my_worker_ids()));

revoke all on table public.inbox_items from anon, authenticated;
grant select on table public.inbox_items to authenticated;
grant update (read_at) on table public.inbox_items to authenticated;

-- Adds an inbox item from SQL (slice 3.3's roster publish and later). Not callable from the
-- Data API; the server adds items with the secret key (src/server/workforce/notify.ts).
create function private.add_inbox_item(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_link_path text default null
)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.inbox_items (organisation_id, worker_id, kind, title, body, link_path)
  values (p_organisation_id, p_worker_id, p_kind, p_title, p_body, p_link_path)
  returning id
$$;

revoke all on function private.add_inbox_item(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;

-- Claims the email nudge for one item under the caps, for the server only (secret key): at most
-- `p_org_cap` emails per company and `p_global_cap` across all companies in the last 24 hours
-- (Resend Free sends 100 a day for the whole account; the server keeps headroom for invites and
-- other mail). Serialised with a transaction lock, so two sends can't both take the last place.
-- Returns true when the item may be emailed now (and stamps emailed_at), false otherwise.
create function public.claim_inbox_email(p_item_id uuid, p_org_cap integer, p_global_cap integer)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
  v_org_sent integer;
  v_all_sent integer;
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
  select count(*) filter (where i.organisation_id = v_org), count(*)
  into v_org_sent, v_all_sent
  from public.inbox_items i
  where i.emailed_at > now() - interval '24 hours';
  if v_org_sent >= p_org_cap or v_all_sent >= p_global_cap then
    return false;
  end if;
  update public.inbox_items set emailed_at = now() where id = p_item_id;
  return true;
end;
$$;

revoke all on function public.claim_inbox_email(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_inbox_email(uuid, integer, integer) to service_role;
