-- Slice 2.6: contract documents.
--
-- 1. Private Storage bucket `contract-docs` (PDF, PNG and JPEG, 10 MB or less), one object per
--    document at {organisation_id}/{contract_id}/{document_id}.{pdf,png,jpg}.
-- 2. `contract_documents`: one row per file (kind, title, original file name, size, type,
--    sha256, who uploaded it and when). Never deleted: a document is marked removed, with who,
--    when and why. The file itself is deleted through the Storage API by the daily sweep
--    (src/server/business/contract-document-sweep.ts) 30 days after removal.
-- 3. The upload, in three steps (the 1.8 pattern):
--    a. the app inserts a `pending` row as the user (owner, admin, ops_manager); the database
--       fixes its storage path from the row's own ids;
--    b. the browser uploads straight to the bucket (no request-size limit in between); Storage
--       takes an object only at the path of a pending row the same user created;
--    c. the server reads the object back as that user, checks its type from its magic bytes,
--       works out its sha256 and calls `confirm_contract_document`, which also checks the object
--       is in Storage with the size and type stated, and marks the row `active`. A file that
--       fails the check is marked `rejected` (`reject_contract_document`) and deleted by the
--       server with the secret key. A pending row an hour old is rejected by the sweep.
-- 4. Reads. The row: owner, admin, finance and ops_manager (contract readers). The file: the
--    same roles, and only while its row is `active` (the uploader also reads their own pending
--    upload, for step c). Files open by 60-second signed URLs made on the server after an
--    RLS-checked read of the row. hr, line managers, workers and other companies see nothing.
-- 5. Writes. No update or delete grants on the table, and no update or delete policies on the
--    bucket: the row moves only through the functions below (private security definers that
--    check the caller's role themselves, behind public invoker wrappers), and the guard trigger
--    refuses any other change for every role, the secret key included, except the sweep
--    recording that a file has gone.
--
-- Refusals (SQLSTATE), mapped to plain English in src/server/business/contract-documents.ts:
--   MLCD1 not found, or not yours to confirm       MLCD2 not pending / not active any more
--   MLCD3 the upload isn't in Storage or doesn't match what was stated
--   MLCD4 a change the guard never allows          MLCD5 too many unfinished uploads

-- ---------------------------------------------------------------------------
-- 1. Bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'contract-docs',
  'contract-docs',
  false,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The organisation a `contract-docs` object belongs to, or null when the name is not exactly
-- {organisation_id}/{contract_id}/{document_id}.pdf, .png or .jpg. Never raises on odd names.
create function private.contract_doc_org_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg)$'
      then split_part(object_name, '/', 1)::uuid
  end
$$;

revoke all on function private.contract_doc_org_id(text) from public, anon;
grant execute on function private.contract_doc_org_id(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. contract_documents
-- ---------------------------------------------------------------------------

create table public.contract_documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  contract_id uuid not null,
  kind text not null
    constraint contract_documents_kind_value check (
      kind in ('signed_contract', 'sla', 'amendment', 'purchase_order', 'insurance', 'other')
    ),
  title text not null
    constraint contract_documents_title_text check (
      title = btrim(title)
      and char_length(title) between 1 and 200
      and title !~ '[\x01-\x1f\x7f-\x9f<>]'
      and title !~* '(://|www\.)'
    ),
  -- The name the file had on the uploader's device, cleaned by the app (no path, no control
  -- characters, no quotes or angle brackets). Shown in the list and used as the download name.
  file_name text not null
    constraint contract_documents_file_name_text check (
      file_name = btrim(file_name)
      and char_length(file_name) between 1 and 120
      and file_name !~ '[\x01-\x1f\x7f-\x9f<>"\\/:*?|]'
      and file_name !~ '^\.'
    ),
  file_ext text not null
    constraint contract_documents_file_ext_value check (file_ext in ('pdf', 'png', 'jpg')),
  mime_type text not null
    constraint contract_documents_mime_type_value check (
      (file_ext = 'pdf' and mime_type = 'application/pdf')
      or (file_ext = 'png' and mime_type = 'image/png')
      or (file_ext = 'jpg' and mime_type = 'image/jpeg')
    ),
  -- Set by the database (contract_documents_guard): {organisation_id}/{contract_id}/{id}.{file_ext}.
  -- The default only lets an insert leave it out; the guard always replaces it.
  storage_path text not null default ''
    constraint contract_documents_storage_path_key unique,
  -- Known once the upload is confirmed.
  size_bytes bigint
    constraint contract_documents_size_range check (size_bytes between 1 and 10485760),
  sha256 text
    constraint contract_documents_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    constraint contract_documents_status_value check (
      status in ('pending', 'active', 'rejected', 'removed')
    ),
  uploaded_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  removed_at timestamptz,
  removed_by uuid,
  removed_reason text
    constraint contract_documents_removed_reason_text check (
      removed_reason = btrim(removed_reason)
      and char_length(removed_reason) between 1 and 500
      and removed_reason !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  -- When the sweep deleted the file from Storage (removed 30 days, or rejected).
  file_deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint contract_documents_organisation_id_id_key unique (organisation_id, id),
  constraint contract_documents_contract_fkey foreign key (organisation_id, contract_id)
    references public.contracts (organisation_id, id),
  constraint contract_documents_storage_path_shape check (
    storage_path = organisation_id::text || '/' || contract_id::text || '/' || id::text || '.' || file_ext
  ),
  constraint contract_documents_state check (
    (status = 'pending' and uploaded_at is null and sha256 is null and size_bytes is null
      and removed_at is null)
    or (status = 'active' and uploaded_at is not null and sha256 is not null
      and size_bytes is not null and removed_at is null and file_deleted_at is null)
    or (status = 'rejected' and uploaded_at is null and removed_at is null)
    or (status = 'removed' and uploaded_at is not null and sha256 is not null
      and size_bytes is not null and removed_at is not null and removed_by is not null
      and removed_reason is not null)
  )
);

create index contract_documents_contract_idx
  on public.contract_documents (organisation_id, contract_id, created_at);
create index contract_documents_sweep_idx
  on public.contract_documents (status, created_at)
  where file_deleted_at is null and status <> 'active';

comment on table public.contract_documents is
  'Files kept against a contract (signed contract, SLA, amendments, purchase orders, insurance). Never deleted: removed rows keep who, when and why; the file is deleted 30 days after removal.';
comment on column public.contract_documents.sha256 is
  'SHA-256 of the file, worked out by the app server from the bytes it read back. confirm_contract_document checks the object''s size, type and owner in Storage, but takes this value from its caller (an owner, admin or ops_manager): not proof of what was uploaded.';
comment on column public.contract_documents.storage_path is
  'Object name in the private contract-docs bucket: {organisation_id}/{contract_id}/{id}.{file_ext}. Opened only by 60-second signed URLs.';

-- BEFORE INSERT/UPDATE/DELETE on contract_documents.
-- Insert: a new row is always pending, uploaded by the caller, at the path the database works
-- out; nothing about the upload is taken from the insert.
-- Update: only pending -> active (confirm), pending -> rejected (reject or the sweep),
-- active -> removed (remove), and the sweep stamping file_deleted_at on a rejected or removed
-- row. Everything that describes the document never changes.
-- Delete: never, for any role.
create function private.contract_documents_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Contract documents are never deleted. Remove the document instead.'
      using errcode = 'MLCD4';
  end if;

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.uploaded_by := coalesce(auth.uid(), new.uploaded_by);
    new.created_at := now();
    new.updated_at := now();
    new.uploaded_at := null;
    new.size_bytes := null;
    new.sha256 := null;
    new.removed_at := null;
    new.removed_by := null;
    new.removed_reason := null;
    new.file_deleted_at := null;
    new.storage_path := new.organisation_id::text || '/' || new.contract_id::text || '/'
      || new.id::text || '.' || new.file_ext;
    if new.uploaded_by is null then
      raise exception 'A document needs the person who uploads it.' using errcode = 'MLCD4';
    end if;
    -- Unconfirmed uploads are swept daily; until then cap how many one person can start, so
    -- the bucket can't be filled with files nobody confirms.
    if (
      select count(*)
      from public.contract_documents d
      where d.uploaded_by = new.uploaded_by
        and d.status = 'pending'
        and d.created_at > now() - interval '1 hour'
    ) >= 10 then
      raise exception 'Too many uploads are still unfinished. Wait an hour and try again.'
        using errcode = 'MLCD5';
    end if;
    return new;
  end if;

  if (
    new.id, new.organisation_id, new.contract_id, new.kind, new.title, new.file_name,
    new.file_ext, new.mime_type, new.storage_path, new.uploaded_by, new.created_at
  ) is distinct from (
    old.id, old.organisation_id, old.contract_id, old.kind, old.title, old.file_name,
    old.file_ext, old.mime_type, old.storage_path, old.uploaded_by, old.created_at
  ) then
    raise exception 'A document''s details never change. Remove it and upload it again.'
      using errcode = 'MLCD4';
  end if;

  if old.file_deleted_at is not null and new.file_deleted_at is distinct from old.file_deleted_at then
    raise exception 'The file has already been deleted.' using errcode = 'MLCD4';
  end if;

  if new.status = old.status then
    -- Only the sweep's stamp on a rejected or removed row, with nothing else changing.
    if old.status not in ('rejected', 'removed')
      or (
        new.size_bytes, new.sha256, new.uploaded_at, new.removed_at, new.removed_by,
        new.removed_reason
      ) is distinct from (
        old.size_bytes, old.sha256, old.uploaded_at, old.removed_at, old.removed_by,
        old.removed_reason
      )
      or new.file_deleted_at is null then
      raise exception 'This document can''t change.' using errcode = 'MLCD4';
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status = 'active' then
    if new.removed_at is not null or new.file_deleted_at is not null then
      raise exception 'This document can''t change.' using errcode = 'MLCD4';
    end if;
    return new;
  end if;
  if old.status = 'pending' and new.status = 'rejected' then
    if (new.size_bytes, new.sha256, new.uploaded_at) is distinct from (null::bigint, null::text, null::timestamptz) then
      raise exception 'This document can''t change.' using errcode = 'MLCD4';
    end if;
    return new;
  end if;
  if old.status = 'active' and new.status = 'removed' then
    if (new.size_bytes, new.sha256, new.uploaded_at) is distinct from (old.size_bytes, old.sha256, old.uploaded_at)
      or new.file_deleted_at is not null then
      raise exception 'This document can''t change.' using errcode = 'MLCD4';
    end if;
    return new;
  end if;

  raise exception 'A % document can''t become %.', old.status, new.status using errcode = 'MLCD2';
end;
$$;

revoke all on function private.contract_documents_guard() from public, anon, authenticated;

create trigger contract_documents_guard
  before insert or update or delete on public.contract_documents
  for each row execute function private.contract_documents_guard();
create trigger contract_documents_set_updated_at before update on public.contract_documents
  for each row execute function private.set_updated_at();
create trigger contract_documents_audit after insert or update or delete on public.contract_documents
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- 3. Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.contract_documents enable row level security;

create policy contract_documents_select on public.contract_documents for select to authenticated
  using (private.has_role(organisation_id, array['owner', 'admin', 'finance', 'ops_manager']));
create policy contract_documents_insert on public.contract_documents for insert to authenticated
  with check (
    private.has_role(organisation_id, array['owner', 'admin', 'ops_manager'])
    and uploaded_by = (select private.session_uid())
  );

revoke all on table public.contract_documents from anon, authenticated;
grant select on table public.contract_documents to authenticated;
-- Everything else is set by the guard (path, status, uploader) or by the functions below.
grant insert (
  organisation_id, contract_id, kind, title, file_name, file_ext, mime_type
) on table public.contract_documents to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Storage policies
-- ---------------------------------------------------------------------------
-- insert: owner, admin or ops_manager, only at the path of a pending row they created.
-- select: owner, admin, finance or ops_manager, only while the row is active (or the
--         uploader's own pending upload, which the server reads back to check).
-- No update policy (an upload is never replaced) and no delete policy (files are deleted by the
-- sweep with the secret key, never by a signed-in user).

create policy contract_docs_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'contract-docs'
    and private.has_role(private.contract_doc_org_id(name), array['owner', 'admin', 'ops_manager'])
    and exists (
      select 1
      from public.contract_documents d
      where d.organisation_id = private.contract_doc_org_id(name)
        and d.storage_path = name
        and d.status = 'pending'
        and d.uploaded_by = (select private.session_uid())
    )
  );

create policy contract_docs_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'contract-docs'
    and private.has_role(
      private.contract_doc_org_id(name), array['owner', 'admin', 'finance', 'ops_manager']
    )
    and exists (
      select 1
      from public.contract_documents d
      where d.organisation_id = private.contract_doc_org_id(name)
        and d.storage_path = name
        and (
          d.status = 'active'
          or (
            d.status = 'pending'
            and d.uploaded_by = (select private.session_uid())
            and d.created_at > now() - interval '1 hour'
          )
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Writes
-- ---------------------------------------------------------------------------

-- The caller's pending row, locked, or a refusal. Role first, so an outsider learns nothing.
create function private.lock_pending_contract_document(
  p_organisation_id uuid,
  p_document_id uuid
)
returns public.contract_documents
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc public.contract_documents;
begin
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t upload contract documents.' using errcode = '42501';
  end if;
  select d.* into v_doc
  from public.contract_documents d
  where d.id = p_document_id
    and d.organisation_id = p_organisation_id
    and d.uploaded_by = private.session_uid()
  for update;
  if v_doc.id is null then
    raise exception 'That upload wasn''t found.' using errcode = 'MLCD1';
  end if;
  if v_doc.status <> 'pending' then
    raise exception 'That upload has already been dealt with.' using errcode = 'MLCD2';
  end if;
  return v_doc;
end;
$$;

revoke all on function private.lock_pending_contract_document(uuid, uuid) from public, anon, authenticated;

-- confirm_contract_document: the server has read the upload back, checked its magic bytes and
-- worked out its sha256. The object must be in Storage at the row's path, uploaded by the
-- caller, with the size given and the row's type; then the row becomes active.
create function private.confirm_contract_document(
  p_organisation_id uuid,
  p_document_id uuid,
  p_size_bytes bigint,
  p_sha256 text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc public.contract_documents;
  v_size bigint;
  v_mime text;
begin
  v_doc := private.lock_pending_contract_document(p_organisation_id, p_document_id);

  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The file''s fingerprint is missing.' using errcode = 'MLCD3';
  end if;

  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype'
  into v_size, v_mime
  from storage.objects o
  where o.bucket_id = 'contract-docs'
    and o.name = v_doc.storage_path
    and o.owner_id = private.session_uid()::text;
  if not found then
    raise exception 'The upload didn''t arrive. Choose the file again.' using errcode = 'MLCD3';
  end if;
  if v_size is distinct from p_size_bytes or v_mime is distinct from v_doc.mime_type
    or p_size_bytes not between 1 and 10485760 then
    raise exception 'The upload doesn''t match the file chosen. Choose it again.'
      using errcode = 'MLCD3';
  end if;

  update public.contract_documents d
  set status = 'active',
      size_bytes = p_size_bytes,
      sha256 = p_sha256,
      uploaded_at = now()
  where d.id = v_doc.id;

  perform private.log_audit_impl(
    p_organisation_id, 'contract_document.uploaded', 'contract_documents', v_doc.id, null,
    jsonb_build_object(
      'contract_id', v_doc.contract_id, 'kind', v_doc.kind, 'title', v_doc.title,
      'file_name', v_doc.file_name, 'mime_type', v_doc.mime_type, 'size_bytes', p_size_bytes,
      'sha256', p_sha256
    ),
    null
  );
end;
$$;

-- reject_contract_document: the upload failed the server's check (or never arrived). The row is
-- kept as `rejected`; the server deletes the object with the secret key.
create function private.reject_contract_document(p_organisation_id uuid, p_document_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc public.contract_documents;
begin
  v_doc := private.lock_pending_contract_document(p_organisation_id, p_document_id);
  update public.contract_documents d set status = 'rejected' where d.id = v_doc.id;
end;
$$;

-- remove_contract_document: marks an active document removed, with the reason. The file stops
-- opening at once (the bucket's select policy needs an active row) and is deleted by the sweep
-- 30 days later.
create function private.remove_contract_document(
  p_organisation_id uuid,
  p_document_id uuid,
  p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc public.contract_documents;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not private.has_role(p_organisation_id, array['owner', 'admin', 'ops_manager']) then
    raise exception 'Your role can''t remove contract documents.' using errcode = '42501';
  end if;
  if char_length(v_reason) not between 1 and 500 then
    raise exception 'Say why the document is being removed.' using errcode = '22023';
  end if;
  select d.* into v_doc
  from public.contract_documents d
  where d.id = p_document_id and d.organisation_id = p_organisation_id
  for update;
  if v_doc.id is null then
    raise exception 'That document wasn''t found.' using errcode = 'MLCD1';
  end if;
  if v_doc.status <> 'active' then
    raise exception 'That document has already been removed.' using errcode = 'MLCD2';
  end if;

  update public.contract_documents d
  set status = 'removed',
      removed_at = now(),
      removed_by = private.session_uid(),
      removed_reason = v_reason
  where d.id = v_doc.id;

  perform private.log_audit_impl(
    p_organisation_id, 'contract_document.removed', 'contract_documents', v_doc.id,
    jsonb_build_object(
      'contract_id', v_doc.contract_id, 'kind', v_doc.kind, 'title', v_doc.title,
      'file_name', v_doc.file_name
    ),
    null,
    v_reason
  );
end;
$$;

revoke all on function private.confirm_contract_document(uuid, uuid, bigint, text) from public, anon;
revoke all on function private.reject_contract_document(uuid, uuid) from public, anon;
revoke all on function private.remove_contract_document(uuid, uuid, text) from public, anon;
grant execute on function private.confirm_contract_document(uuid, uuid, bigint, text) to authenticated;
grant execute on function private.reject_contract_document(uuid, uuid) to authenticated;
grant execute on function private.remove_contract_document(uuid, uuid, text) to authenticated;

create function public.confirm_contract_document(
  p_organisation_id uuid,
  p_document_id uuid,
  p_size_bytes bigint,
  p_sha256 text
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.confirm_contract_document(p_organisation_id, p_document_id, p_size_bytes, p_sha256)
$$;

create function public.reject_contract_document(p_organisation_id uuid, p_document_id uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.reject_contract_document(p_organisation_id, p_document_id)
$$;

create function public.remove_contract_document(
  p_organisation_id uuid,
  p_document_id uuid,
  p_reason text
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.remove_contract_document(p_organisation_id, p_document_id, p_reason)
$$;

revoke all on function public.confirm_contract_document(uuid, uuid, bigint, text) from public, anon;
revoke all on function public.reject_contract_document(uuid, uuid) from public, anon;
revoke all on function public.remove_contract_document(uuid, uuid, text) from public, anon;
grant execute on function public.confirm_contract_document(uuid, uuid, bigint, text) to authenticated;
grant execute on function public.reject_contract_document(uuid, uuid) to authenticated;
grant execute on function public.remove_contract_document(uuid, uuid, text) to authenticated;
