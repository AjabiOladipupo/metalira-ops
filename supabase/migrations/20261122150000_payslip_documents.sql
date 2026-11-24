-- Slice 5.5: payslips: PDFs, the worker app and notices (docs/PHASE_5.md 5.5, decisions 9 and 14,
-- open question 7; CLAUDE.md rules 4, 5, 8 and 9).
--
-- 1. payslip_documents (insert-only): one row each time the server makes a payslip's PDF, with
--    its object path in the private `payslips` bucket ({organisation_id}/{run_id}/{payslip_id}.pdf,
--    fixed here from the row's ids, never sent), its SHA-256 and size, who made it and when.
--    Making it again (a retry after a failure) adds a new row; the newest row is the document.
--    Only for a payslip of a RELEASED run. No role, not the secret key and not the database owner
--    can update, delete or truncate a row: the guards are ENABLE ALWAYS triggers (as 5.3's), so
--    session_replication_role = replica doesn't skip them, and none reads a session setting.
--    Read by owner, hr and finance (RLS, set-helper form). Written only by
--    record_payslip_document (the secret key, after the server uploaded the PDF).
-- 2. The private bucket `payslips` (PDF only, 5 MB or less). There is no policy on
--    storage.objects for it, so no signed-in role reads, lists, signs or writes its objects
--    directly; the server uploads with the secret key and signs 60-second URLs with it only after
--    open_payslip_document has said yes (and audited the download).
-- 3. inbox_items.payslip_id: the release notice for a payslip, one per payslip (unique), only for
--    a payslip of a released run and only to that payslip's worker (checked on insert). The inbox
--    guard keeps the column fixed. The email that may go with it (src/server/workforce/notify.ts,
--    inside the caps) carries the item's title and body, which hold no amounts (open question 7).
-- 4. Reads:
--    * my_payslips(org): the signed-in worker's own payslips of RELEASED runs, newest first, each
--      with its lines, year-to-date sums (payslips of released runs in the calendar year of its
--      pay date, up to and including it), the rule set's name, the masked bank account
--      and RSA PIN (last 4 only), the PFA, the declared rent the tax used (from the trace) and
--      whether its PDF is made. Drafts, runs in review and approved runs not released yet are
--      never returned. No manager ids, no TIN, NIN, BVN or full numbers.
--    * payslip_pdf_views(org, run, payslip_ids): the same view for the server making the PDFs
--      (the secret key only; released runs only).
--    * open_payslip_document(org, payslip): yes or no to a download, before the server signs a
--      60-second URL: the worker their own payslip of a released run; owner, hr and finance any.
--      Audited (payroll.payslip_downloaded: ids only, never the path or URL).
--
-- Refusals (SQLSTATE):
--   MLPD1 payslip documents are kept as written (update, delete, truncate)
--   MLPD2 the payslip's run isn't released (no PDF, no notice, no download yet)
--   MLPD3 the payslip's PDF isn't made yet
--   MLPD4 a document or notice that doesn't match its payslip (path, run, worker, hash, size)
--   42501 not signed in with a trusted session, or the wrong role; P0002 not found (also what a
--         worker gets for someone else's payslip, so nothing about it is revealed)
-- Money: kobo bigint, read as text. The only maths is the year-to-date sums (bigint).

-- ---------------------------------------------------------------------------
-- 1. payslip_documents
-- ---------------------------------------------------------------------------

create table public.payslip_documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  payslip_id uuid not null,
  run_id uuid not null,
  storage_path text not null,
  sha256 text not null
    constraint payslip_documents_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null
    constraint payslip_documents_size check (size_bytes between 1 and 5242880),
  -- Who released the run (the person whose release made it), or null for a server retry.
  made_by uuid,
  made_at timestamptz not null default now(),
  constraint payslip_documents_organisation_id_id_key unique (organisation_id, id),
  constraint payslip_documents_payslip_fkey foreign key (organisation_id, payslip_id)
    references public.payslips (organisation_id, id),
  constraint payslip_documents_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payslip_documents_path check (
    storage_path = organisation_id::text || '/' || run_id::text || '/' || payslip_id::text || '.pdf'
  )
);

create index payslip_documents_payslip_idx
  on public.payslip_documents (organisation_id, payslip_id, made_at desc);
create index payslip_documents_run_idx on public.payslip_documents (organisation_id, run_id);

comment on table public.payslip_documents is
  'A payslip''s PDF in the private payslips bucket (slice 5.5): path, SHA-256, size, who and when. Insert-only; the newest row per payslip is the document. Released runs only.';

-- BEFORE INSERT/UPDATE/DELETE: a new row is for a payslip of a released run, with the run and
-- path that payslip has; nothing changes or goes afterwards.
create function private.payslip_documents_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_status text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Payslip documents are kept as written.' using errcode = 'MLPD1';
  end if;
  select s.run_id, r.status into v_run, v_status
  from public.payslips s
  join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
  where s.organisation_id = new.organisation_id and s.id = new.payslip_id;
  if v_run is null or v_run <> new.run_id then
    raise exception 'That document doesn''t match its payslip.' using errcode = 'MLPD4';
  end if;
  if v_status is distinct from 'released' then
    raise exception 'Payslip PDFs are made once the run is released.' using errcode = 'MLPD2';
  end if;
  new.storage_path := new.organisation_id::text || '/' || new.run_id::text || '/'
    || new.payslip_id::text || '.pdf';
  new.made_at := now();
  return new;
end;
$$;

revoke all on function private.payslip_documents_guard() from public, anon, authenticated;

create trigger payslip_documents_guard before insert or update or delete on public.payslip_documents
  for each row execute function private.payslip_documents_guard();
-- Audited once, by record_payslip_document (payroll.payslip_pdf_made), the only writer.

create function private.payslip_documents_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Payslip documents are kept as written.' using errcode = 'MLPD1';
end;
$$;

revoke all on function private.payslip_documents_no_truncate() from public, anon, authenticated;

create trigger payslip_documents_no_truncate before truncate on public.payslip_documents
  for each statement execute function private.payslip_documents_no_truncate();

-- ENABLE ALWAYS, as 5.3's payroll guards: replica mode doesn't skip them.
alter table public.payslip_documents enable always trigger payslip_documents_guard;
alter table public.payslip_documents enable always trigger payslip_documents_no_truncate;

alter table public.payslip_documents enable row level security;

create policy payslip_documents_select on public.payslip_documents for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
-- Nobody writes through the Data API (no grants either): explicit refusals, so a later grant
-- can't open a write path by accident.
create policy payslip_documents_no_insert on public.payslip_documents for insert to authenticated
  with check (false);
create policy payslip_documents_no_update on public.payslip_documents for update to authenticated
  using (false) with check (false);
create policy payslip_documents_no_delete on public.payslip_documents for delete to authenticated
  using (false);

revoke all on table public.payslip_documents from anon, authenticated, service_role;
grant select on table public.payslip_documents to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The private bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payslips', 'payslips', false, 5242880, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects policy names this bucket: with RLS on storage.objects, signed-in users can't
-- select (download, list, sign), insert, update or delete its objects. The secret key writes them
-- and signs 60-second URLs (src/server/payroll/payslip-documents.ts) after open_payslip_document.

-- ---------------------------------------------------------------------------
-- 3. Release notices in the inbox
-- ---------------------------------------------------------------------------

alter table public.inbox_items
  add column payslip_id uuid,
  add constraint inbox_items_payslip_fkey foreign key (organisation_id, payslip_id)
    references public.payslips (organisation_id, id);

create unique index inbox_items_payslip_key on public.inbox_items (payslip_id)
  where payslip_id is not null;

-- BEFORE INSERT: a payslip notice goes to that payslip's worker, once its run is released.
create function private.inbox_items_payslip_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_status text;
begin
  if new.payslip_id is null then
    return new;
  end if;
  select s.worker_id, r.status into v_worker, v_status
  from public.payslips s
  join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
  where s.organisation_id = new.organisation_id and s.id = new.payslip_id;
  if v_worker is null or v_worker <> new.worker_id then
    raise exception 'That notice doesn''t match its payslip.' using errcode = 'MLPD4';
  end if;
  if v_status is distinct from 'released' then
    raise exception 'Workers hear about a payslip once the run is released.' using errcode = 'MLPD2';
  end if;
  return new;
end;
$$;

revoke all on function private.inbox_items_payslip_check() from public, anon, authenticated;

create trigger inbox_items_payslip_check before insert on public.inbox_items
  for each row execute function private.inbox_items_payslip_check();
alter table public.inbox_items enable always trigger inbox_items_payslip_check;

-- The inbox guard (slice 3.1, as 3.3 left it in 20261120180000_roster_publications.sql), with
-- payslip_id among the fields that never change.
create or replace function private.inbox_items_guard()
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
    new.created_at, new.roster_publication_id, new.payslip_id
  ) is distinct from (
    old.id, old.organisation_id, old.worker_id, old.kind, old.title, old.body, old.link_path,
    old.created_at, old.roster_publication_id, old.payslip_id
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

-- ---------------------------------------------------------------------------
-- 4. The payslip as a worker reads it
-- ---------------------------------------------------------------------------

-- One payslip as the worker app and the PDF show it: amounts in kobo as text, lines in order,
-- year to date, masked bank account and RSA PIN (last 4 only), the PFA, the rent the tax used
-- (the trace's rent_relief step), the rule set's name and the company's name. No role check:
-- only the definers below call it, after their own checks. No manager ids, no TIN, no NIN.
create function private.payslip_view(p_organisation_id uuid, p_payslip_id uuid)
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
      'bank_name', w.bank_name,
      'bank_account_last4', w.bank_account_last4,
      'rsa_pin_last4', w.rsa_pin_last4
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
    -- approved run not released yet never shows through a released payslip's figures.
    'year_to_date', (
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
    ),
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
  where s.organisation_id = p_organisation_id and s.id = p_payslip_id
$$;

revoke all on function private.payslip_view(uuid, uuid) from public, anon, authenticated, service_role;

-- The signed-in worker's payslips of released runs in the organisation, newest pay date first
-- (at most 36). The worker is the session's own worker record there (private.my_worker_ids), so
-- nobody reads anyone else's; drafts, runs in review and approved runs not released yet never
-- appear. 42501 without a trusted session or a worker record in the organisation.
create function private.my_payslips(p_organisation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_workers uuid[];
  v_result jsonb;
begin
  if v_uid is null or p_organisation_id is null then
    raise exception 'Sign in to the worker app to see your payslips.' using errcode = '42501';
  end if;
  select array_agg(w.id) into v_workers
  from public.workers w
  where w.organisation_id = p_organisation_id
    and w.id in (select private.my_worker_ids());
  if v_workers is null then
    raise exception 'Sign in to the worker app to see your payslips.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(private.payslip_view(p_organisation_id, x.id) order by x.pay_date desc, x.approved_at desc, x.id), '[]'::jsonb)
  into v_result
  from (
    select s.id, r.pay_date, r.approved_at
    from public.payslips s
    join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
    where s.organisation_id = p_organisation_id
      and s.worker_id = any (v_workers)
      and r.status = 'released'
    order by r.pay_date desc, r.approved_at desc, s.id
    limit 36
  ) x;
  return v_result;
end;
$$;

revoke all on function private.my_payslips(uuid) from public, anon;
grant execute on function private.my_payslips(uuid) to authenticated;

create function public.my_payslips(p_organisation_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.my_payslips(p_organisation_id)
$$;

revoke all on function public.my_payslips(uuid) from public, anon;
grant execute on function public.my_payslips(uuid) to authenticated;

-- The views the server renders PDFs from (the secret key only): payslips of a released run, all
-- of them or the ids given. MLPD2 when the run isn't released.
create function private.payslip_pdf_views(
  p_organisation_id uuid,
  p_run_id uuid,
  p_payslip_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'Only the server makes payslip PDFs.' using errcode = '42501';
  end if;
  select r.status into v_status
  from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = p_run_id;
  if v_status is null then
    raise exception 'That payroll run wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status <> 'released' then
    raise exception 'Payslip PDFs are made once the run is released.' using errcode = 'MLPD2';
  end if;
  return coalesce((
    select jsonb_agg(private.payslip_view(p_organisation_id, s.id) order by s.id)
    from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      and (p_payslip_ids is null or s.id = any (p_payslip_ids))
  ), '[]'::jsonb);
end;
$$;

revoke all on function private.payslip_pdf_views(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function private.payslip_pdf_views(uuid, uuid, uuid[]) to service_role;

create function public.payslip_pdf_views(
  p_organisation_id uuid,
  p_run_id uuid,
  p_payslip_ids uuid[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.payslip_pdf_views(p_organisation_id, p_run_id, p_payslip_ids)
$$;

revoke all on function public.payslip_pdf_views(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.payslip_pdf_views(uuid, uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Recording a PDF (the secret key) and opening one (signed-in users)
-- ---------------------------------------------------------------------------

-- The server uploaded a payslip's PDF: record it (insert-only), with the person whose release
-- made it (or null for a retry with no one signed in). Audited. MLPD2 when the run isn't
-- released; MLPD4 when the file isn't in the bucket at the payslip's path.
create function private.record_payslip_document(
  p_organisation_id uuid,
  p_payslip_id uuid,
  p_actor uuid,
  p_sha256 text,
  p_size_bytes integer
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_status text;
  v_path text;
  v_id uuid;
  v_latest public.payslip_documents%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'Only the server records payslip PDFs.' using errcode = '42501';
  end if;
  -- One recording per payslip at a time: two publishes running together record in turn.
  perform pg_advisory_xact_lock(hashtextextended('payslip_documents:' || coalesce(p_payslip_id::text, ''), 0));
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_size_bytes is null or p_size_bytes not between 1 and 5242880 then
    raise exception 'That document doesn''t match its payslip.' using errcode = 'MLPD4';
  end if;
  select s.run_id, r.status into v_run, v_status
  from public.payslips s
  join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
  where s.organisation_id = p_organisation_id and s.id = p_payslip_id;
  if v_run is null then
    raise exception 'That payslip wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status <> 'released' then
    raise exception 'Payslip PDFs are made once the run is released.' using errcode = 'MLPD2';
  end if;
  -- The server uploads first: a row never points at a file that isn't there.
  v_path := p_organisation_id::text || '/' || v_run::text || '/' || p_payslip_id::text || '.pdf';
  -- The file is never replaced (the server uploads without overwriting), and the size recorded
  -- is the size stored.
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'payslips' and o.name = v_path
      and (o.metadata ->> 'size') is not null
      and (o.metadata ->> 'size')::bigint = p_size_bytes
  ) then
    raise exception 'The payslip''s PDF isn''t in storage as recorded.' using errcode = 'MLPD4';
  end if;
  -- The file is already recorded as it is: nothing new to record.
  select d.* into v_latest
  from public.payslip_documents d
  where d.organisation_id = p_organisation_id and d.payslip_id = p_payslip_id
  order by d.made_at desc, d.id desc
  limit 1;
  if v_latest.id is not null and v_latest.sha256 = p_sha256 and v_latest.size_bytes = p_size_bytes then
    return v_latest.id;
  end if;
  perform set_config('metalira.audit_channel', 'system', true);
  insert into public.payslip_documents (
    organisation_id, payslip_id, run_id, storage_path, sha256, size_bytes, made_by
  )
  values (p_organisation_id, p_payslip_id, v_run, v_path, p_sha256, p_size_bytes, p_actor)
  returning id into v_id;
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, p_actor, 'payroll.payslip_pdf_made', 'payslips', p_payslip_id, null,
    jsonb_build_object(
      'document_id', v_id, 'run_id', v_run, 'sha256', p_sha256, 'size_bytes', p_size_bytes
    )
  );
  return v_id;
end;
$$;

revoke all on function private.record_payslip_document(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function private.record_payslip_document(uuid, uuid, uuid, text, integer) to service_role;

create function public.record_payslip_document(
  p_organisation_id uuid,
  p_payslip_id uuid,
  p_actor uuid,
  p_sha256 text,
  p_size_bytes integer
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_payslip_document(p_organisation_id, p_payslip_id, p_actor, p_sha256, p_size_bytes)
$$;

revoke all on function public.record_payslip_document(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.record_payslip_document(uuid, uuid, uuid, text, integer) to service_role;

-- Yes or no to downloading a payslip's PDF, before the server signs a 60-second URL: the
-- worker their own payslip of a released run; owner, hr and finance of the company any payslip
-- with a PDF. A worker asking about someone else's payslip, or one not released, gets P0002, as
-- if it weren't there. Audited (payroll.payslip_downloaded: payslip, document and run ids, and
-- who asked as worker or manager; never the path or URL). Returns the document's id, its path
-- (for the server to sign), the run's period and pay date.
create function private.open_payslip_document(p_organisation_id uuid, p_payslip_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.session_uid();
  v_manager boolean;
  v_worker uuid;
  v_run uuid;
  v_status text;
  v_period_end date;
  v_pay_date date;
  v_doc public.payslip_documents%rowtype;
begin
  if v_uid is null or p_organisation_id is null or p_payslip_id is null then
    raise exception 'Sign in to open payslips.' using errcode = '42501';
  end if;
  v_manager := private.has_role(p_organisation_id, array['owner', 'hr', 'finance']);
  select s.worker_id, s.run_id, r.status, r.period_end, r.pay_date
  into v_worker, v_run, v_status, v_period_end, v_pay_date
  from public.payslips s
  join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
  where s.organisation_id = p_organisation_id and s.id = p_payslip_id;
  if not v_manager then
    if v_worker is null or v_status is distinct from 'released'
      or v_worker not in (select private.my_worker_ids()) then
      raise exception 'That payslip wasn''t found.' using errcode = 'P0002';
    end if;
  elsif v_worker is null then
    raise exception 'That payslip wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status <> 'released' then
    raise exception 'Payslip PDFs are made once the run is released.' using errcode = 'MLPD2';
  end if;
  select d.* into v_doc
  from public.payslip_documents d
  where d.organisation_id = p_organisation_id and d.payslip_id = p_payslip_id
  order by d.made_at desc, d.id desc
  limit 1;
  if v_doc.id is null then
    raise exception 'The PDF isn''t ready yet. Try again in a minute.' using errcode = 'MLPD3';
  end if;
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, v_uid, 'payroll.payslip_downloaded', 'payslips', p_payslip_id, null,
    jsonb_build_object(
      'document_id', v_doc.id, 'run_id', v_run, 'as', case when v_manager then 'manager' else 'worker' end
    )
  );
  return jsonb_build_object(
    'document_id', v_doc.id,
    'storage_path', v_doc.storage_path,
    'period_end', v_period_end,
    'pay_date', v_pay_date
  );
end;
$$;

revoke all on function private.open_payslip_document(uuid, uuid) from public, anon;
grant execute on function private.open_payslip_document(uuid, uuid) to authenticated;

create function public.open_payslip_document(p_organisation_id uuid, p_payslip_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.open_payslip_document(p_organisation_id, p_payslip_id)
$$;

revoke all on function public.open_payslip_document(uuid, uuid) from public, anon;
grant execute on function public.open_payslip_document(uuid, uuid) to authenticated;
