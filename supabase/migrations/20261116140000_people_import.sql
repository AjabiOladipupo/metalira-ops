-- Slice 1.8: people import (CSV and Excel).
--
-- An import is a batch (`import_batches`) of rows (`import_rows`). The flow:
--   1. The server creates a batch (status `uploaded`) and the browser uploads the file to the
--      private Storage bucket `imports` at {organisation_id}/{batch_id}.{csv,xlsx}.
--   2. The server reads the file back, checks it with the slice 1.4 validator and stores every
--      row (status `validated`). The file is then removed from Storage: everything needed to
--      fix and import a row is in import_rows, and the upload was the only place personal data
--      sat in clear.
--   3. One-click fixes patch a held row and the whole batch is checked again.
--   4. Commit (`commit_import_batch`) creates, in one transaction, the new departments,
--      name-only clients, sites and projects, the workers, their first pay rates and their
--      assignments. Held rows stay in the batch to fix and import later. Committing again
--      does nothing for rows already imported (idempotent on batch and row; staff IDs stay
--      unique through workers_staff_id_key).
--
-- Personal data (CLAUDE.md rule 9): a row's NIN, bank account number and RSA PIN never sit in
-- `raw` or `normalised`. They are stripped from the cells and stored encrypted by the server in
-- `nin_enc`, `bank_account_enc` and `rsa_pin_enc` (src/server/crypto/pii.ts, bound to this
-- table, column and row id). At commit the server decrypts them and encrypts them again for
-- the new worker's row. Check constraints refuse a `raw` or `normalised` document carrying
-- those keys, whoever writes it.
--
-- Audit: import_batches changes are audited by the row trigger (upload, check, commit,
-- cancel), commit adds one `people.import_committed` event, and every created worker,
-- department, client, site, project, pay rate and assignment is audited by its own trigger.
-- import_rows is working data for the review screen (up to 5,000 rows a batch, rewritten on
-- every check) and has no row trigger; applying a fix is logged as `people.import_row_fixed`
-- by the server.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

create type public.import_batch_status as enum ('uploaded', 'validated', 'committed', 'cancelled');
create type public.import_row_status as enum ('ready', 'held', 'fixed', 'imported');

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  -- The name of the file as uploaded, for the review screen. Plain text only.
  file_name text not null
    constraint import_batches_file_name_text check (
      file_name = btrim(file_name)
      and char_length(file_name) between 1 and 255
      and file_name !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  file_format text not null constraint import_batches_file_format check (file_format in ('csv', 'xlsx')),
  -- Where the upload goes in the `imports` bucket. Fixed by the batch id.
  file_path text not null,
  -- Set when the server removed the upload from Storage after reading it.
  file_removed_at timestamptz,
  status public.import_batch_status not null default 'uploaded',
  -- Template columns the file has (validator input when the batch is checked again).
  columns text[] not null default '{}',
  -- Notes about the whole file (ignored columns, no pay columns) and, when the file could not
  -- be read at all, the reasons. Plain English; never personal data.
  file_notes jsonb not null default '[]'::jsonb
    constraint import_batches_file_notes_array check (jsonb_typeof(file_notes) = 'array'),
  file_problems jsonb not null default '[]'::jsonb
    constraint import_batches_file_problems_array check (jsonb_typeof(file_problems) = 'array'),
  -- The validator's summary from the last check (counts, found line, new names).
  summary jsonb,
  rows_total integer not null default 0 constraint import_batches_rows_total_range check (rows_total >= 0),
  rows_ready integer not null default 0 constraint import_batches_rows_ready_range check (rows_ready >= 0),
  rows_held integer not null default 0 constraint import_batches_rows_held_range check (rows_held >= 0),
  rows_imported integer not null default 0
    constraint import_batches_rows_imported_range check (rows_imported >= 0),
  validated_at timestamptz,
  committed_at timestamptz,
  committed_by uuid,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint import_batches_organisation_id_id_key unique (organisation_id, id),
  constraint import_batches_file_path_format check (
    file_path = organisation_id::text || '/' || id::text || '.' || file_format
  ),
  constraint import_batches_committed_has_time check (status <> 'committed' or committed_at is not null),
  constraint import_batches_cancelled_has_time check (status <> 'cancelled' or cancelled_at is not null)
);

create index import_batches_organisation_idx on public.import_batches (organisation_id, created_at desc);

comment on table public.import_batches is
  'One uploaded employee file (slice 1.8). Rows are in import_rows; the upload itself is removed from Storage once read.';

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  batch_id uuid not null,
  -- Spreadsheet row number: the header is row 1.
  row_number integer not null constraint import_rows_row_number_range check (row_number between 2 and 1000000),
  -- The row's cells keyed by template column, without nin, bank_account_number and rsa_pin.
  raw jsonb not null
    constraint import_rows_raw_object check (jsonb_typeof(raw) = 'object')
    constraint import_rows_raw_no_personal_data check (
      not (raw ?| array['nin', 'bank_account_number', 'rsa_pin'])
    ),
  -- Those three cells, encrypted for this row by the server. Null when blank.
  nin_enc bytea,
  bank_account_enc bytea,
  rsa_pin_enc bytea,
  -- Validator inputs kept so the batch can be checked again exactly as uploaded.
  numeric_columns text[] not null default '{}',
  extra_values integer not null default 0 constraint import_rows_extra_values_range check (extra_values >= 0),
  -- The validator's normalised worker, pay rate and mapping, without personal data; null when
  -- held. Amounts are strings of whole kobo. For the review screen only: commit checks the
  -- rows again rather than trusting this.
  normalised jsonb
    constraint import_rows_normalised_no_personal_data check (
      normalised is null
      or not (coalesce(normalised -> 'worker', '{}'::jsonb) ?| array['nin', 'bankAccountNumber', 'rsaPin'])
    ),
  -- Problems holding the row back, and warnings (the row imports with something to know).
  errors jsonb not null default '[]'::jsonb
    constraint import_rows_errors_array check (jsonb_typeof(errors) = 'array'),
  warnings jsonb not null default '[]'::jsonb
    constraint import_rows_warnings_array check (jsonb_typeof(warnings) = 'array'),
  -- True when the row is listed for attention although it imports (duplicate phone).
  attention boolean not null default false,
  -- The one-click fixes applied to this row, in order: [{ "label": ..., "at": ... }].
  fixes jsonb not null default '[]'::jsonb
    constraint import_rows_fixes_array check (jsonb_typeof(fixes) = 'array'),
  status public.import_row_status not null,
  worker_id uuid,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_rows_batch_fkey foreign key (organisation_id, batch_id)
    references public.import_batches (organisation_id, id),
  constraint import_rows_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint import_rows_batch_row_key unique (batch_id, row_number),
  constraint import_rows_imported_has_worker check (
    (status = 'imported') = (worker_id is not null)
    and (status = 'imported') = (imported_at is not null)
  )
);

create index import_rows_organisation_idx on public.import_rows (organisation_id);
create index import_rows_worker_idx on public.import_rows (worker_id) where worker_id is not null;

comment on table public.import_rows is
  'Rows of an employee import. Personal data sits only in *_enc columns (AES-256-GCM, src/server/crypto/pii.ts); raw and normalised never carry it.';

-- ---------------------------------------------------------------------------
-- 3. Trigger functions and triggers
-- ---------------------------------------------------------------------------

-- BEFORE UPDATE on import_batches: committed batches never go back, cancelled is final.
create function private.import_batches_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'cancelled' then
    raise exception 'This import was cancelled. Upload the file again.' using errcode = 'MLIM2';
  end if;
  if old.status = 'committed' and new.status <> 'committed' then
    raise exception 'This import has employees in it already and can''t be reopened or cancelled.'
      using errcode = 'MLIM2';
  end if;
  if old.status = 'validated' and new.status = 'uploaded' then
    raise exception 'A checked import can''t go back to uploaded.' using errcode = 'MLIM2';
  end if;
  return new;
end;
$$;

-- BEFORE UPDATE on import_rows: an imported row is history.
create function private.import_rows_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'imported' then
    raise exception 'Row % is already imported.', old.row_number using errcode = 'MLIM3';
  end if;
  return new;
end;
$$;

create trigger import_batches_set_updated_at before update on public.import_batches
  for each row execute function private.set_updated_at();
create trigger import_rows_set_updated_at before update on public.import_rows
  for each row execute function private.set_updated_at();
create trigger import_batches_guard before update on public.import_batches
  for each row execute function private.import_batches_guard();
create trigger import_rows_guard before update on public.import_rows
  for each row execute function private.import_rows_guard();
create trigger import_batches_audit after insert or update or delete on public.import_batches
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and grants
-- ---------------------------------------------------------------------------
-- Owner, admin and hr run imports (docs/PHASE_1.md 1.8). Nobody deletes: a batch is
-- cancelled, and its rows stay as the record of what was checked.

alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;

create policy import_batches_select on public.import_batches for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy import_batches_insert on public.import_batches for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy import_batches_update on public.import_batches for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

create policy import_rows_select on public.import_rows for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy import_rows_insert on public.import_rows for insert to authenticated
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));
create policy import_rows_update on public.import_rows for update to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'hr']))
  with check (private.has_role(organisation_id, array['owner', 'admin', 'hr']));

revoke all on table public.import_batches from anon, authenticated;
grant select on table public.import_batches to authenticated;
grant insert (id, organisation_id, file_name, file_format, file_path)
  on table public.import_batches to authenticated;
grant update (
  status, columns, file_notes, file_problems, summary, rows_total, rows_ready, rows_held,
  rows_imported, validated_at, committed_at, committed_by, cancelled_at, file_removed_at
) on table public.import_batches to authenticated;

revoke all on table public.import_rows from anon, authenticated;
grant select on table public.import_rows to authenticated;
grant insert (
  id, organisation_id, batch_id, row_number, raw, nin_enc, bank_account_enc, rsa_pin_enc,
  numeric_columns, extra_values, normalised, errors, warnings, attention, fixes, status
) on table public.import_rows to authenticated;
grant update (
  raw, nin_enc, bank_account_enc, rsa_pin_enc, normalised, errors, warnings, attention, fixes,
  status, worker_id, imported_at
) on table public.import_rows to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Upload storage
-- ---------------------------------------------------------------------------
-- Private bucket `imports`, one object per batch at {organisation_id}/{batch_id}.{csv,xlsx}.
-- The browser uploads straight to Storage (no request-size limit in between); the server reads
-- the object back as the same user and then removes it. Rules:
--   insert: owner, admin or hr, only for a batch they created that is still `uploaded`, at
--           exactly its file_path;
--   select: the user who uploaded the object (still owner, admin or hr), so an admin, who may
--           not see personal data, can't read someone else's upload;
--   delete: owner, admin or hr of the organisation (removal after reading).
-- No update policy: an upload is never replaced.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imports',
  'imports',
  false,
  5242880,
  array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The organisation an `imports` object belongs to, or null when the name is not exactly
-- {organisation_id}/{batch_id}.csv or .xlsx. Never raises on odd names.
create function private.import_file_org_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(csv|xlsx)$'
      then split_part(object_name, '/', 1)::uuid
  end
$$;

create policy imports_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'imports'
    and private.has_role(private.import_file_org_id(name), array['owner', 'admin', 'hr'])
    and exists (
      select 1
      from public.import_batches b
      where b.organisation_id = private.import_file_org_id(name)
        and b.file_path = name
        and b.status = 'uploaded'
        and b.file_removed_at is null
        and b.created_by = (select auth.uid())
    )
  );

create policy imports_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'imports'
    and owner_id = (select auth.uid())::text
    and private.has_role(private.import_file_org_id(name), array['owner', 'admin', 'hr'])
  );

create policy imports_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'imports'
    and private.has_role(private.import_file_org_id(name), array['owner', 'admin', 'hr'])
  );

-- ---------------------------------------------------------------------------
-- 6. Manager directory for line-manager emails
-- ---------------------------------------------------------------------------
-- A line manager in the file may be a manager-app user who is not a worker, named by the
-- email they sign in with (owner decision 3). Emails live in auth.users, which signed-in users
-- can't read, so this returns them for the organisation's managers, to owner, admin and hr only.

create function private.import_manager_directory(org uuid)
returns table (membership_id uuid, email text, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, lower(u.email)::text, coalesce(p.full_name, '')
  from public.memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.user_id = m.user_id
  where m.organisation_id = org
    and m.worker_id is null
    and m.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
    and u.email is not null
    and private.has_role(org, array['owner', 'admin', 'hr'])
$$;

create function public.list_import_managers(p_organisation_id uuid)
returns table (membership_id uuid, email text, full_name text)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.membership_id, d.email, d.full_name
  from private.import_manager_directory(p_organisation_id) d
$$;

-- ---------------------------------------------------------------------------
-- 7. Saving a check (security invoker: RLS and column grants apply to the caller)
-- ---------------------------------------------------------------------------
-- Stores (or rewrites) checked rows of a batch and refreshes its counts. p_rows is an array of
-- import_rows documents by column name (id included: personal data is encrypted for that row
-- id before the call; bytea values are `\x` hex strings). An existing row keeps its id (a
-- document with another id for the same row number changes nothing, so encrypted values never
-- end up under the wrong row id), and imported rows are never touched. The server sends a
-- large batch in several calls; each one refreshes the counts, so the last call leaves them
-- right. p_check carries the batch fields: columns, file_notes, summary.
create function public.save_import_check(
  p_organisation_id uuid,
  p_batch_id uuid,
  p_check jsonb,
  p_rows jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status public.import_batch_status;
begin
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

  insert into public.import_rows (
    id, organisation_id, batch_id, row_number, raw, nin_enc, bank_account_enc, rsa_pin_enc,
    numeric_columns, extra_values, normalised, errors, warnings, attention, fixes, status
  )
  select
    r.id, p_organisation_id, p_batch_id, r.row_number, r.raw, r.nin_enc, r.bank_account_enc,
    r.rsa_pin_enc, coalesce(r.numeric_columns, '{}'), coalesce(r.extra_values, 0), r.normalised,
    coalesce(r.errors, '[]'::jsonb), coalesce(r.warnings, '[]'::jsonb),
    coalesce(r.attention, false), coalesce(r.fixes, '[]'::jsonb), r.status
  from jsonb_populate_recordset(null::public.import_rows, coalesce(p_rows, '[]'::jsonb)) as r
  on conflict (batch_id, row_number) do update
  set raw = excluded.raw,
      nin_enc = excluded.nin_enc,
      bank_account_enc = excluded.bank_account_enc,
      rsa_pin_enc = excluded.rsa_pin_enc,
      normalised = excluded.normalised,
      errors = excluded.errors,
      warnings = excluded.warnings,
      attention = excluded.attention,
      fixes = excluded.fixes,
      status = excluded.status
  where public.import_rows.status <> 'imported'
    and public.import_rows.id = excluded.id;

  update public.import_batches b
  set columns = coalesce(
        (select array_agg(c) from jsonb_array_elements_text(p_check -> 'columns') as c),
        b.columns
      ),
      file_notes = coalesce(p_check -> 'file_notes', b.file_notes),
      summary = coalesce(p_check -> 'summary', b.summary),
      rows_total = counts.total,
      rows_ready = counts.ready,
      rows_held = counts.held,
      rows_imported = counts.imported,
      validated_at = now(),
      status = case when b.status = 'uploaded' then 'validated'::public.import_batch_status else b.status end
  from (
    select
      count(*)::integer as total,
      count(*) filter (where r.status in ('ready', 'fixed'))::integer as ready,
      count(*) filter (where r.status = 'held')::integer as held,
      count(*) filter (where r.status = 'imported')::integer as imported
    from public.import_rows r
    where r.batch_id = p_batch_id
  ) as counts
  where b.id = p_batch_id and b.organisation_id = p_organisation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Commit (security invoker)
-- ---------------------------------------------------------------------------
-- Creates the employees of a checked batch in one transaction. The server checks the batch
-- again against the account as it is now and sends only rows that import, managers before
-- the people who report to them. p_rows is an array of:
--   {
--     "row_id": uuid of the import_rows row,
--     "worker": workers columns by name, as public.create_worker takes them (id included,
--               personal data encrypted for that worker id; organisation, department and
--               line manager are set here, not taken from this document),
--     "pay_rate": the first pay version, as public.add_pay_rate takes it, or null,
--     "department": { "id": uuid } | { "name": text },
--     "line_manager": { "worker_id": uuid } | { "membership_id": uuid } | null,
--     "client" / "site" / "project": { "id": uuid } | { "name": text } | null
--   }
-- Unknown department, client, site and project names become name-only records ("New names
-- become new clients you can finish later"); an existing name is reused (case-insensitive).
-- Names are resolved once for the whole batch; workers, pay rates and assignments are then
-- inserted row by row, so every table's own triggers (line-manager checks, needs_pay_details,
-- pay-rate rules, audit) run as for a worker added by hand.
--
-- Idempotent: if every row sent is already imported (a double submit), nothing happens and
-- the result says so. If only some are, the batch changed under the caller and the whole call
-- is refused (MLIM1), so the server checks the batch again rather than guessing.
-- Returns { "created", "already_imported", "departments", "clients", "sites", "projects" }.
--
-- statement_timeout: a large file (up to 5,000 rows) takes longer than the 8 seconds signed-in
-- users get by default. PostgREST applies a function's own setting to the call.
create function public.commit_import_batch(
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

  -- The rows named, locked for the rest of the transaction.
  select count(*)::integer into v_sent from jsonb_array_elements(p_rows);
  select count(*)::integer,
         count(*) filter (where r.status = 'imported')::integer,
         count(*) filter (where r.status = 'held')::integer
  into v_found, v_done, v_held
  from (
    select r.status
    from public.import_rows r
    where r.batch_id = p_batch_id
      and r.organisation_id = p_organisation_id
      and r.id in (select (e.item ->> 'row_id')::uuid from jsonb_array_elements(p_rows) as e (item))
    for update
  ) as r;

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
    v_worker_id := public.create_worker(v_worker, null);

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

  update public.import_rows r
  set status = 'imported',
      worker_id = (e.item -> 'worker' ->> 'id')::uuid,
      imported_at = now()
  from jsonb_array_elements(p_rows) as e (item)
  where r.id = (e.item ->> 'row_id')::uuid
    and r.batch_id = p_batch_id
    and r.organisation_id = p_organisation_id;

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
      'projects', v_new_projects
    ),
    null
  );

  return jsonb_build_object(
    'created', v_created,
    'already_imported', 0,
    'departments', v_new_departments,
    'clients', v_new_clients,
    'sites', v_new_sites,
    'projects', v_new_projects
  );
end;
$$;

-- Cancels a batch that has no imported rows yet. Rows stay as the record of what was checked.
create function public.cancel_import_batch(p_organisation_id uuid, p_batch_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.import_batches b
  set status = 'cancelled',
      cancelled_at = now()
  where b.id = p_batch_id
    and b.organisation_id = p_organisation_id
    and b.status in ('uploaded', 'validated')
  returning b.id into v_id;
  if v_id is null then
    raise exception 'That import wasn''t found, or it has employees in it already.'
      using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Function grants
-- ---------------------------------------------------------------------------

revoke all on function private.import_batches_guard() from public, anon, authenticated;
revoke all on function private.import_rows_guard() from public, anon, authenticated;
revoke all on function private.import_file_org_id(text) from public, anon;
revoke all on function private.import_manager_directory(uuid) from public, anon;
grant execute on function private.import_file_org_id(text) to authenticated, service_role;
grant execute on function private.import_manager_directory(uuid) to authenticated, service_role;

revoke all on function public.list_import_managers(uuid) from public, anon;
revoke all on function public.save_import_check(uuid, uuid, jsonb, jsonb) from public, anon;
revoke all on function public.commit_import_batch(uuid, uuid, jsonb) from public, anon;
revoke all on function public.cancel_import_batch(uuid, uuid) from public, anon;
grant execute on function public.list_import_managers(uuid) to authenticated, service_role;
grant execute on function public.save_import_check(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.commit_import_batch(uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function public.cancel_import_batch(uuid, uuid) to authenticated, service_role;
