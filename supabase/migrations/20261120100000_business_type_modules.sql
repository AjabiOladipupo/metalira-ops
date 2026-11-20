-- Slice 3.0: business type and module switches.
--
-- 1. organisations.business_type: 'workforce' (runs staff at client sites, the default and every
--    company created before this migration) or 'services' (delivers services or projects to
--    clients: agencies, consultants, freelancers and sole proprietors).
-- 2. Three module switches: shifts_enabled (Roster, Live attendance, clock-in on the worker app),
--    people_enabled (People, My team, Leave, Timesheets) and payroll_enabled (Payroll run). Every
--    existing company keeps all three on. Payroll needs People and Shifts need People (checks).
-- 3. Two new industries: digital_services and professional_services.
-- 4. The switches change only through public.set_company_modules (owner or admin, trusted
--    session, audited). The business type changes only through public.set_company_business_type
--    (the Business details form); while setup is unfinished, choosing a type also sets the
--    switches to that type's defaults (services: all off; workforce: all on).
-- 5. Neither the switches nor the type are granted to signed-in users for direct update, so no
--    role (owner and admin included) can skip the functions through the Data API. The
--    organisations_update policy already limits direct updates to owner and admin.
--
-- Audit: each change writes two audit_log rows on purpose. The organisations_audit row trigger
-- records the generic row change (organisations.update with the full before and after), as for
-- every write to the table; the functions also log a named event (company.modules_changed,
-- company.business_type_set) with just the switches, so the log and later Lira read the intent
-- without diffing whole rows.
--
-- Turning a module off never deletes or changes data: the pages are hidden and refused, and
-- everything shows again when it is turned back on.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.organisations
  add column business_type text not null default 'workforce'
    constraint organisations_business_type_value check (business_type in ('workforce', 'services')),
  add column shifts_enabled boolean not null default true,
  add column people_enabled boolean not null default true,
  add column payroll_enabled boolean not null default true,
  add constraint organisations_payroll_needs_people check (people_enabled or not payroll_enabled),
  add constraint organisations_shifts_need_people check (people_enabled or not shifts_enabled);

comment on column public.organisations.business_type is
  'workforce (runs staff at client sites) or services (delivers services or projects to clients). Set through set_company_business_type; drives the setup steps and the default module switches.';
comment on column public.organisations.shifts_enabled is
  'Roster, Live attendance and clock-in on the worker app. Needs people_enabled. Changed only through set_company_modules; turning it off deletes nothing.';
comment on column public.organisations.people_enabled is
  'People, My team, Leave and Timesheets. Changed only through set_company_modules; turning it off deletes nothing.';
comment on column public.organisations.payroll_enabled is
  'Payroll run. Needs people_enabled. Changed only through set_company_modules; turning it off deletes nothing.';

alter table public.organisations
  drop constraint organisations_industry_value,
  add constraint organisations_industry_value check (
    industry in (
      'security_facility', 'cleaning', 'staffing', 'field_sales', 'logistics',
      'digital_services', 'professional_services', 'other'
    )
  );

-- Belt and braces: the table-level update privilege was revoked in 20261115224728 and only named
-- columns granted since, so these columns were never updatable. Said out loud so a later column
-- grant can't widen it by accident.
revoke update (business_type, shifts_enabled, people_enabled, payroll_enabled)
  on table public.organisations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Phase 3 hook: may shifts be switched off?
-- ---------------------------------------------------------------------------
-- PHASE 3 HOOK (slices 3.2 and 3.3): once shifts and roster publications exist, replace this
-- body so it refuses (SQLSTATE 'MLMO3') while the company has published shifts that start in the
-- future, with a message naming how many and from when ("12 published shifts from 24 Nov 2026
-- are still on the roster. Remove them first."). Until then there is nothing to protect, so it
-- allows every call. set_company_modules calls it only when shifts go from on to off.
create function private.assert_shifts_can_be_switched_off(p_organisation_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Nothing to check until slice 3.2 adds shifts. Keep the signature: 3.2/3.3 replace the body.
  perform p_organisation_id;
end;
$$;

revoke all on function private.assert_shifts_can_be_switched_off(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. set_company_modules (definer impl in private, invoker wrapper in public)
-- ---------------------------------------------------------------------------
-- Refusals: 42501 not owner or admin (or an untrusted session), 22023 a missing value,
-- MLMO1 payroll without people, MLMO2 shifts without people, MLMO3 (Phase 3) shifts still
-- published. Calling it with the current values changes nothing and writes no audit row.
create function private.set_company_modules(
  p_organisation_id uuid,
  p_shifts_enabled boolean,
  p_people_enabled boolean,
  p_payroll_enabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org public.organisations%rowtype;
  v_before jsonb;
  v_after jsonb;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin']) then
    raise exception 'Only an owner or an admin can switch parts of the app on or off.'
      using errcode = '42501';
  end if;
  if p_shifts_enabled is null or p_people_enabled is null or p_payroll_enabled is null then
    raise exception 'Choose on or off for each part.' using errcode = '22023';
  end if;
  if p_payroll_enabled and not p_people_enabled then
    raise exception 'Payroll needs People. Turn People on, or turn Payroll off.'
      using errcode = 'MLMO1';
  end if;
  if p_shifts_enabled and not p_people_enabled then
    raise exception 'Shifts need People. Turn People on, or turn Shifts off.'
      using errcode = 'MLMO2';
  end if;

  select o.* into v_org
  from public.organisations o
  where o.id = p_organisation_id
  for update;

  v_before := jsonb_build_object(
    'shifts_enabled', v_org.shifts_enabled,
    'people_enabled', v_org.people_enabled,
    'payroll_enabled', v_org.payroll_enabled
  );
  v_after := jsonb_build_object(
    'shifts_enabled', p_shifts_enabled,
    'people_enabled', p_people_enabled,
    'payroll_enabled', p_payroll_enabled
  );
  if v_before = v_after then
    return v_after || jsonb_build_object('changed', false);
  end if;

  if v_org.shifts_enabled and not p_shifts_enabled then
    perform private.assert_shifts_can_be_switched_off(p_organisation_id);
  end if;

  -- Only the switches change. No data in any module is touched.
  update public.organisations o
  set shifts_enabled = p_shifts_enabled,
      people_enabled = p_people_enabled,
      payroll_enabled = p_payroll_enabled
  where o.id = p_organisation_id;

  perform private.log_audit_impl(
    p_organisation_id, 'company.modules_changed', 'organisations', p_organisation_id,
    v_before, v_after, null
  );
  return v_after || jsonb_build_object('changed', true);
end;
$$;

revoke all on function private.set_company_modules(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function private.set_company_modules(uuid, boolean, boolean, boolean) to authenticated;

create function public.set_company_modules(
  p_organisation_id uuid,
  p_shifts_enabled boolean,
  p_people_enabled boolean,
  p_payroll_enabled boolean
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_company_modules(
    p_organisation_id, p_shifts_enabled, p_people_enabled, p_payroll_enabled
  )
$$;

revoke all on function public.set_company_modules(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_company_modules(uuid, boolean, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. set_company_business_type
-- ---------------------------------------------------------------------------
-- Sets the business type. While setup is unfinished and the type changes, the module switches
-- move to that type's defaults (services: all off; workforce: all on), audited with the type.
-- After setup the switches are left alone: the owner changes them under Settings > Company >
-- Modules. Same caller rule as set_company_modules.
create function private.set_company_business_type(
  p_organisation_id uuid,
  p_business_type text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org public.organisations%rowtype;
  v_default boolean;
  v_reset boolean;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin']) then
    raise exception 'Only an owner or an admin can change what the business does.'
      using errcode = '42501';
  end if;
  if p_business_type is null or p_business_type not in ('workforce', 'services') then
    raise exception 'Choose what your business does.' using errcode = '22023';
  end if;

  select o.* into v_org
  from public.organisations o
  where o.id = p_organisation_id
  for update;

  if v_org.business_type = p_business_type then
    return jsonb_build_object('business_type', p_business_type, 'changed', false, 'modules_reset', false);
  end if;

  v_reset := v_org.setup_completed_at is null;
  v_default := p_business_type = 'workforce';

  if v_reset and v_org.shifts_enabled and not v_default then
    perform private.assert_shifts_can_be_switched_off(p_organisation_id);
  end if;

  update public.organisations o
  set business_type = p_business_type,
      shifts_enabled = case when v_reset then v_default else o.shifts_enabled end,
      people_enabled = case when v_reset then v_default else o.people_enabled end,
      payroll_enabled = case when v_reset then v_default else o.payroll_enabled end
  where o.id = p_organisation_id;

  perform private.log_audit_impl(
    p_organisation_id, 'company.business_type_set', 'organisations', p_organisation_id,
    jsonb_build_object(
      'business_type', v_org.business_type,
      'shifts_enabled', v_org.shifts_enabled,
      'people_enabled', v_org.people_enabled,
      'payroll_enabled', v_org.payroll_enabled
    ),
    jsonb_build_object(
      'business_type', p_business_type,
      'shifts_enabled', case when v_reset then v_default else v_org.shifts_enabled end,
      'people_enabled', case when v_reset then v_default else v_org.people_enabled end,
      'payroll_enabled', case when v_reset then v_default else v_org.payroll_enabled end
    ),
    null
  );
  return jsonb_build_object('business_type', p_business_type, 'changed', true, 'modules_reset', v_reset);
end;
$$;

revoke all on function private.set_company_business_type(uuid, text) from public, anon;
grant execute on function private.set_company_business_type(uuid, text) to authenticated;

create function public.set_company_business_type(
  p_organisation_id uuid,
  p_business_type text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_company_business_type(p_organisation_id, p_business_type)
$$;

revoke all on function public.set_company_business_type(uuid, text) from public, anon;
grant execute on function public.set_company_business_type(uuid, text) to authenticated;
