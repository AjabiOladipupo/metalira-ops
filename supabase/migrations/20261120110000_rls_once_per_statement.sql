-- Slice 3.1: row-level security checks the session once per statement, not once per row.
--
-- Carried forward from Phase 1. Every policy that asked "does the caller hold one of these roles
-- in this row's organisation?" called private.has_role(organisation_id, roles) on each row. It is
-- a security-definer function (so it is never inlined), and each call ran private.session_uid(),
-- which runs private.session_trusted(): it parses the JWT, checks the amr list and, for a
-- password session, reads auth.users. On a 100k-row table that is 100k of each (benchmark in the
-- slice 3.1 pull request).
--
-- The fix keeps every helper's meaning and moves the work out of the row loop:
--
-- 1. private.role_org_ids(roles) returns the organisations where the caller's trusted session
--    holds one of `roles`. Policies call it as an uncorrelated subquery,
--    `organisation_id in (select private.role_org_ids(array[...]))`, which Postgres runs once
--    per statement (a hashed SubPlan) and then checks each row against the set in memory. For any
--    organisation id this is true exactly when private.has_role(organisation_id, roles) is, and
--    null (refused, as a policy treats null) for a null id, where has_role said false. No policy
--    negates a role check, so null and false refuse alike.
-- 2. The three per-row helpers that took a row value become sets computed once:
--    private.managed_user_ids() for manages_member(user_id) (profiles), private.my_line_manager_keys()
--    for is_line_manager_for(...) (workers) and private.my_reportee_ids() for is_reportee(worker_id)
--    (worker_assignments). Each `x in (select private.f())` is an uncorrelated hashed subplan.
-- 3. Every other policy already called the set helpers that way (user_org_ids, my_worker_ids,
--    my_department_ids, my_assignment_target_ids) and `(select private.session_uid())`.
--
-- Nothing is cached between statements or transactions: no settings, no tables. Each statement
-- still asks private.session_trusted() afresh, so the transaction pooler (Supavisor) and
-- PostgREST's per-request transactions see exactly what they saw before. A transaction-local
-- setting was considered and rejected: any SQL caller can set a custom setting, so a cached
-- "trusted" flag could be forged.
--
-- The old helpers stay: security-definer RPCs still call has_role, once per call.
-- tests/rls/policy-speed.test.ts fails if a policy calls a per-row helper again. New policies
-- write role checks the way section 2 does.

-- ---------------------------------------------------------------------------
-- 1. Set helpers, computed once per statement
-- ---------------------------------------------------------------------------

-- The organisations where the caller (trusted session only) holds one of `roles`.
create function private.role_org_ids(roles text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.organisation_id
  from public.memberships m
  where m.user_id = (select private.session_uid())
    and m.role::text = any (roles)
$$;

-- Logins in the organisations where the caller is a manager (private.manages_member as a set).
create function private.managed_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct target.user_id
  from public.memberships me
  join public.memberships target on target.organisation_id = me.organisation_id
  where me.user_id = (select private.session_uid())
    and me.role in ('owner', 'admin', 'hr', 'finance', 'ops_manager', 'line_manager')
$$;

-- The caller's line_manager memberships: (organisation, membership, linked worker or null).
-- A worker row's line manager is the caller when (its organisation, line_manager_membership_id)
-- or (its organisation, line_manager_worker_id) is one of these: private.is_line_manager_for
-- as a set.
create function private.my_line_manager_keys()
returns table (organisation_id uuid, membership_id uuid, worker_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select m.organisation_id, m.id, m.worker_id
  from public.memberships m
  where m.user_id = (select private.session_uid())
    and m.role = 'line_manager'
$$;

-- Workers whose line manager is the caller (private.is_reportee as a set).
create function private.my_reportee_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id
  from private.my_line_manager_keys() k
  join public.workers w
    on w.organisation_id = k.organisation_id
   and (
     w.line_manager_membership_id = k.membership_id
     or (k.worker_id is not null and w.line_manager_worker_id = k.worker_id)
   )
$$;

revoke all on function private.role_org_ids(text[]) from public, anon;
revoke all on function private.managed_user_ids() from public, anon;
revoke all on function private.my_line_manager_keys() from public, anon;
revoke all on function private.my_reportee_ids() from public, anon;
grant execute on function private.role_org_ids(text[]) to authenticated, service_role;
grant execute on function private.managed_user_ids() to authenticated, service_role;
grant execute on function private.my_line_manager_keys() to authenticated, service_role;
grant execute on function private.my_reportee_ids() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Policies: the same conditions, with the role checks out of the row loop
-- ---------------------------------------------------------------------------
-- Generated from pg_policies (every public and storage policy that called has_role,
-- manages_member, is_line_manager_for or is_reportee), with only those calls rewritten.

alter policy audit_log_select on public.audit_log
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids)));

alter policy bank_detail_changes_insert on public.bank_detail_changes
  with check (((requested_by = ( SELECT auth.uid() AS uid)) AND (status = 'pending'::public.bank_detail_change_status) AND ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)) OR (worker_id IN ( SELECT private.my_worker_ids() AS my_worker_ids)))));

alter policy bank_detail_changes_select on public.bank_detail_changes
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text]) AS role_org_ids)) OR (worker_id IN ( SELECT private.my_worker_ids() AS my_worker_ids))));

alter policy bank_detail_changes_update on public.bank_detail_changes
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'hr'::text, 'finance'::text]) AS role_org_ids)) OR (requested_by = ( SELECT private.session_uid() AS session_uid))))
  with check (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'hr'::text, 'finance'::text]) AS role_org_ids)) OR (requested_by = ( SELECT private.session_uid() AS session_uid))));

alter policy client_contacts_insert on public.client_contacts
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy client_contacts_select on public.client_contacts
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy client_contacts_update on public.client_contacts
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy clients_insert on public.clients
  with check (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)) OR ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['hr'::text]) AS role_org_ids)) AND (legal_name IS NULL) AND (rc_number IS NULL) AND (tin IS NULL) AND (billing_address IS NULL) AND (state IS NULL) AND (billing_terms_days IS NULL) AND (notes IS NULL))));

alter policy clients_select on public.clients
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids)) OR (id IN ( SELECT private.my_assignment_target_ids() AS my_assignment_target_ids))));

alter policy clients_update on public.clients
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contract_changes_select on public.contract_changes
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contract_documents_insert on public.contract_documents
  with check (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)) AND (uploaded_by = ( SELECT private.session_uid() AS session_uid))));

alter policy contract_documents_select on public.contract_documents
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contract_sites_delete on public.contract_sites
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contract_sites_insert on public.contract_sites
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contract_sites_select on public.contract_sites
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contracts_insert on public.contracts
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contracts_select on public.contracts
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy contracts_update on public.contracts
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy departments_delete on public.departments
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy departments_insert on public.departments
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy departments_select on public.departments
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids)) OR (id IN ( SELECT private.my_department_ids() AS my_department_ids))));

alter policy departments_update on public.departments
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy headcount_requirements_delete on public.headcount_requirements
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy headcount_requirements_insert on public.headcount_requirements
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy headcount_requirements_select on public.headcount_requirements
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy headcount_requirements_update on public.headcount_requirements
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy import_batches_insert on public.import_batches
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy import_batches_select on public.import_batches
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy import_batches_update on public.import_batches
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy import_rows_select on public.import_rows
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy membership_invites_select on public.membership_invites
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids)));

alter policy memberships_select on public.memberships
  using (((user_id = ( SELECT private.session_uid() AS session_uid)) OR (organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids))));

alter policy organisation_bank_accounts_insert on public.organisation_bank_accounts
  with check (((requested_by = ( SELECT private.session_uid() AS session_uid)) AND ((status = 'pending'::public.org_bank_account_status) OR ((status = 'active'::public.org_bank_account_status) AND single_approver)) AND (organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text]) AS role_org_ids))));

alter policy organisation_bank_accounts_select on public.organisation_bank_accounts
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text]) AS role_org_ids)));

alter policy organisation_bank_accounts_update on public.organisation_bank_accounts
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'finance'::text]) AS role_org_ids)) OR ((requested_by = ( SELECT private.session_uid() AS session_uid)) AND (organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text]) AS role_org_ids)))))
  with check (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'finance'::text]) AS role_org_ids)) OR ((requested_by = ( SELECT private.session_uid() AS session_uid)) AND (organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text]) AS role_org_ids)))));

alter policy organisations_update on public.organisations
  using ((id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids)))
  with check ((id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids)));

alter policy owner_changes_select on public.owner_changes
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids)));

alter policy pay_rates_delete on public.pay_rates
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy pay_rates_insert on public.pay_rates
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy pay_rates_select on public.pay_rates
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)) OR (worker_id IN ( SELECT private.my_worker_ids() AS my_worker_ids))));

alter policy pay_rates_update on public.pay_rates
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy posts_select on public.posts
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids)));

alter policy profiles_select on public.profiles
  using (((user_id = ( SELECT private.session_uid() AS session_uid)) OR (user_id IN ( SELECT private.managed_user_ids() AS managed_user_ids))));

alter policy projects_insert on public.projects
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy projects_select on public.projects
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids)) OR (id IN ( SELECT private.my_assignment_target_ids() AS my_assignment_target_ids))));

alter policy projects_update on public.projects
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy rate_card_lines_select on public.rate_card_lines
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy rate_cards_select on public.rate_cards
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy roster_requirements_select on public.roster_requirements
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids)));

alter policy site_checkpoints_insert on public.site_checkpoints
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy site_checkpoints_select on public.site_checkpoints
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids)) OR (site_id IN ( SELECT private.my_assignment_target_ids() AS my_assignment_target_ids))));

alter policy site_checkpoints_update on public.site_checkpoints
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy sites_insert on public.sites
  with check (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)) OR ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['hr'::text]) AS role_org_ids)) AND (address IS NULL) AND (state IS NULL) AND (landmark IS NULL) AND (centre IS NULL) AND (boundary IS NULL))));

alter policy sites_select on public.sites
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text, 'line_manager'::text]) AS role_org_ids)) OR (id IN ( SELECT private.my_assignment_target_ids() AS my_assignment_target_ids))));

alter policy sites_update on public.sites
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)));

alter policy staff_id_corrections_insert on public.staff_id_corrections
  with check (((requested_by = ( SELECT auth.uid() AS uid)) AND (status = 'pending'::public.staff_id_correction_status) AND (organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids))));

alter policy staff_id_corrections_select on public.staff_id_corrections
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy staff_id_corrections_update on public.staff_id_corrections
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy worker_assignments_delete on public.worker_assignments
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy worker_assignments_insert on public.worker_assignments
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy worker_assignments_select on public.worker_assignments
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)) OR (worker_id IN ( SELECT private.my_worker_ids() AS my_worker_ids)) OR (worker_id IN ( SELECT private.my_reportee_ids() AS my_reportee_ids))));

alter policy worker_assignments_update on public.worker_assignments
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy worker_change_requests_select on public.worker_change_requests
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)) OR (worker_id IN ( SELECT private.my_worker_ids() AS my_worker_ids))));

alter policy worker_change_requests_update on public.worker_change_requests
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy worker_credentials_select on public.worker_credentials
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)) OR (worker_id IN ( SELECT private.my_worker_ids() AS my_worker_ids))));

alter policy worker_invites_select on public.worker_invites
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy workers_insert on public.workers
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy workers_select on public.workers
  using (((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)) OR (id IN ( SELECT private.my_worker_ids() AS my_worker_ids)) OR ((organisation_id, line_manager_membership_id) IN ( SELECT k.organisation_id, k.membership_id FROM private.my_line_manager_keys() k)) OR ((organisation_id, line_manager_worker_id) IN ( SELECT k.organisation_id, k.worker_id FROM private.my_line_manager_keys() k WHERE (k.worker_id IS NOT NULL)))));

alter policy workers_update on public.workers
  using ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)))
  with check ((organisation_id IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)));

alter policy contract_docs_insert on storage.objects
  with check (((bucket_id = 'contract-docs'::text) AND (private.contract_doc_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'ops_manager'::text]) AS role_org_ids)) AND (EXISTS ( SELECT 1
   FROM public.contract_documents d
  WHERE ((d.organisation_id = private.contract_doc_org_id(objects.name)) AND (d.storage_path = objects.name) AND (d.status = 'pending'::text) AND (d.uploaded_by = ( SELECT private.session_uid() AS session_uid)) AND (d.created_at > (now() - '01:00:00'::interval)))))));

alter policy contract_docs_select on storage.objects
  using (((bucket_id = 'contract-docs'::text) AND (private.contract_doc_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'finance'::text, 'ops_manager'::text]) AS role_org_ids)) AND (EXISTS ( SELECT 1
   FROM public.contract_documents d
  WHERE ((d.organisation_id = private.contract_doc_org_id(objects.name)) AND (d.storage_path = objects.name) AND ((d.status = 'active'::text) OR ((d.status = 'pending'::text) AND (d.uploaded_by = ( SELECT private.session_uid() AS session_uid)) AND (d.created_at > (now() - '01:00:00'::interval)))))))));

alter policy imports_delete on storage.objects
  using (((bucket_id = 'imports'::text) AND (private.import_file_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids))));

alter policy imports_insert on storage.objects
  with check (((bucket_id = 'imports'::text) AND (private.import_file_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids)) AND (EXISTS ( SELECT 1
   FROM public.import_batches b
  WHERE ((b.organisation_id = private.import_file_org_id(objects.name)) AND (b.file_path = objects.name) AND (b.status = 'uploaded'::public.import_batch_status) AND (b.file_removed_at IS NULL) AND (b.created_by = ( SELECT auth.uid() AS uid)))))));

alter policy imports_select on storage.objects
  using (((bucket_id = 'imports'::text) AND (owner_id = (( SELECT auth.uid() AS uid))::text) AND (private.import_file_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text, 'hr'::text]) AS role_org_ids))));

alter policy org_assets_delete on storage.objects
  using (((bucket_id = 'org-assets'::text) AND (private.org_asset_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids))));

alter policy org_assets_insert on storage.objects
  with check (((bucket_id = 'org-assets'::text) AND (private.org_asset_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids))));

alter policy org_assets_update on storage.objects
  using (((bucket_id = 'org-assets'::text) AND (private.org_asset_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids))))
  with check (((bucket_id = 'org-assets'::text) AND (private.org_asset_org_id(name) IN ( SELECT private.role_org_ids(ARRAY['owner'::text, 'admin'::text]) AS role_org_ids))));

