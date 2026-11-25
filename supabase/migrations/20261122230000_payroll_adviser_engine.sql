-- Slice 5.9a: the payroll tax engine per the tax adviser (answers of 24 Nov 2026, citing NTA 2025,
-- NTAA 2025, PRA 2014, the NHF Act, ECA 2010, the ITF Act and the Labour Act; the owner approved
-- applying them). The TypeScript engine applies the rules (decision 5); this migration stores the
-- figures and the records the engine reads, and checks what approval relies on.
--
-- 1. Rule sets. `rules` may carry an `adviser` part (minimum wage, pension from 3 employees, daily
--    pay in the pension base, NHF conditions, NSITF on regular pay, the one-third deduction cap,
--    clawbacks, reliefs on verified proof). NTA 2025 v2 (v1 plus the adviser's part, daily
--    workers no longer exempt) is the starting version from 1 Jan 2026 for every company that
--    gets its rule set from now on; a company already holding v1 in force gets v2 as a new
--    version from its tomorrow (v1 is in force and is never edited: it closes today, through
--    5.8's closing record). The adviser's confirmation needs an owner (confirm_tax_rule_set
--    records the person), so it is left for the owner.
-- 2. payroll_opening_balances: a worker's tax year before go-live (gross, chargeable pay, PAYE,
--    pension, to an as-of month), insert-only, corrected by a superseding row; owner and hr write,
--    owner, hr and finance read; audited.
-- 3. Relief declarations (rent, NHIS or NHIA, life assurance or deferred annuity) per worker and
--    tax year, insert-only and superseded like opening balances; proofs in the private bucket
--    payroll-relief-proofs (checked by the server like 5.6 receipts); a declaration counts only
--    once owner or hr verify it (insert-only verifications, the latest decides).
-- 4. NHF numbers on file (payroll_nhf_numbers, insert-only, the latest row per worker counts;
--    owner, hr and finance read) and the company's ITF turnover switch
--    (organisations.itf_turnover_over_50m: ITF applies at 5 employees OR with the switch on).
-- 5. payroll_tax_context: the one read the engine needs beyond 5.1's inputs (headcount on the pay
--    date, the ITF switch, go-live month, and per worker: NHF number on file, rent declared, the
--    opening balance in force, verified reliefs).
-- 6. Payslip lines: the code `clawback` (a pre-tax correction of an overpaid earning, negative)
--    and the derived `regular` flag (NSITF's base). A deduction correction may be pensionable (the
--    pension base it reduces). save_payroll_results (5.7c's, copied with only the clawback
--    additions marked "Slice 5.9a") and the off-cycle line guard accept clawback lines.
-- 7. add_payroll_correction (5.7a's, its only version) refuses a deduction of an overpayment
--    older than the rule set's limit (3 months, Labour Act s.5(5)) with MLYA1, and keeps the
--    pensionable flag on a deduction.
-- 8. approve_payroll_run (5.8's, its only later version) extends its month checks to the tax
--    year: a lock per (company, worker, tax year) in worker order after the leave locks; refused
--    (MLPRF) when another same-worker same-year payslip was approved after the read began, or
--    when the year's standing payslips, the opening balance in force or the verified reliefs
--    aren't the ones each payslip's PAYE counted (its trace's year_to_date step). Writers of
--    opening balances and reliefs take the same year lock.
-- 9. Anomaly severities: deduction_capped, paye_overwithheld, nhf_not_deducted and
--    rent_relief_unverified are warnings.
--
-- Refusal codes (MLYA, slice 5.9a):
--   MLYA1 an overpayment older than the limit can't be deducted (use a manual route)
--   MLYA2 a record of this worker and tax year already stands: supersede it (or the one named
--         isn't the one in force)
--   MLYA3 posted payslips already cover the opening balance's months
--   MLYA4 a relief can be verified only with a proof on file, and only while it stands
--   MLYA5 records are kept as written (no update, delete or truncate)
--   22023 bad input; 42501 the wrong role or an untrusted session; P0002 not in the company

-- ---------------------------------------------------------------------------
-- 1. Rule sets: the adviser's part, NTA 2025 v2
-- ---------------------------------------------------------------------------

-- 5.0's check of the `rules` document (private.tax_rules_valid as it was), unchanged but
-- for its name: the shape without the adviser's part.
create function private.tax_rules_base_valid(p_rules jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bands jsonb;
  v_band jsonb;
  v_n integer;
  i integer;
begin
  if not private.tax_keys_are(p_rules, array[
    'paye_bands', 'rent_relief', 'pension', 'nhf', 'nsitf', 'itf', 'daily_workers_exempt'
  ]) then
    return false;
  end if;

  v_bands := p_rules -> 'paye_bands';
  if jsonb_typeof(v_bands) <> 'array' then
    return false;
  end if;
  v_n := jsonb_array_length(v_bands);
  if v_n not between 1 and 12 then
    return false;
  end if;
  for i in 0 .. v_n - 1 loop
    v_band := v_bands -> i;
    if not private.tax_keys_are(v_band, array['width_kobo', 'rate_bps'])
      or not private.tax_int_ok(v_band -> 'rate_bps', 0, 10000) then
      return false;
    end if;
    -- Only the last band is open (null width); every other has a width above 0.
    if i = v_n - 1 then
      if jsonb_typeof(v_band -> 'width_kobo') <> 'null' then
        return false;
      end if;
    elsif not private.tax_kobo_ok(v_band -> 'width_kobo', true) then
      return false;
    end if;
  end loop;

  if not private.tax_keys_are(p_rules -> 'rent_relief', array['rate_bps', 'cap_kobo'])
    or not private.tax_int_ok(p_rules #> '{rent_relief,rate_bps}', 0, 10000)
    or not private.tax_kobo_ok(p_rules #> '{rent_relief,cap_kobo}', false) then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'pension', array['employee_bps', 'employer_bps', 'base'])
    or not private.tax_int_ok(p_rules #> '{pension,employee_bps}', 0, 10000)
    or not private.tax_int_ok(p_rules #> '{pension,employer_bps}', 0, 10000)
    or not private.tax_base_ok(p_rules #> '{pension,base}') then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'nhf', array['rate_bps', 'base'])
    or not private.tax_int_ok(p_rules #> '{nhf,rate_bps}', 0, 10000)
    or not private.tax_base_ok(p_rules #> '{nhf,base}') then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'nsitf', array['rate_bps'])
    or not private.tax_int_ok(p_rules #> '{nsitf,rate_bps}', 0, 10000) then
    return false;
  end if;
  if not private.tax_keys_are(p_rules -> 'itf', array['rate_bps', 'min_staff'])
    or not private.tax_int_ok(p_rules #> '{itf,rate_bps}', 0, 10000)
    or not private.tax_int_ok(p_rules #> '{itf,min_staff}', 1, 100000) then
    return false;
  end if;
  return jsonb_typeof(p_rules -> 'daily_workers_exempt') = 'boolean';
end;
$$;

revoke all on function private.tax_rules_base_valid(jsonb) from public, anon;
grant execute on function private.tax_rules_base_valid(jsonb) to authenticated, service_role;

-- The adviser's part of `rules` (src/lib/payroll/rule-set.ts adviserJsonSchema checks the same).
create function private.tax_adviser_valid(p_adviser jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not private.tax_keys_are(p_adviser, array[
    'paye_method', 'minimum_wage_monthly_kobo', 'pension_min_employees', 'daily_pay_pensionable',
    'nhf_needs_number_and_minimum_wage', 'nsitf_regular_only', 'deduction_cap', 'clawback',
    'reliefs'
  ]) then
    return false;
  end if;
  -- The PAYE method (slice 5.9a): cumulative year to date, the flag 5.9c's guard reads.
  if p_adviser ->> 'paye_method' is distinct from 'cumulative_ytd'
    or jsonb_typeof(p_adviser -> 'paye_method') <> 'string' then
    return false;
  end if;
  if not private.tax_kobo_ok(p_adviser -> 'minimum_wage_monthly_kobo', false)
    or not private.tax_int_ok(p_adviser -> 'pension_min_employees', 1, 100000)
    or jsonb_typeof(p_adviser -> 'daily_pay_pensionable') <> 'boolean'
    or jsonb_typeof(p_adviser -> 'nhf_needs_number_and_minimum_wage') <> 'boolean'
    or jsonb_typeof(p_adviser -> 'nsitf_regular_only') <> 'boolean' then
    return false;
  end if;
  if not private.tax_keys_are(p_adviser -> 'deduction_cap', array['numerator', 'denominator'])
    or not private.tax_int_ok(p_adviser #> '{deduction_cap,numerator}', 1, 100)
    or not private.tax_int_ok(p_adviser #> '{deduction_cap,denominator}', 1, 100)
    or (p_adviser #>> '{deduction_cap,numerator}')::integer
      > (p_adviser #>> '{deduction_cap,denominator}')::integer then
    return false;
  end if;
  if not private.tax_keys_are(p_adviser -> 'clawback', array['pre_tax_same_tax_year', 'max_age_months'])
    or jsonb_typeof(p_adviser #> '{clawback,pre_tax_same_tax_year}') <> 'boolean'
    or not private.tax_int_ok(p_adviser #> '{clawback,max_age_months}', 1, 120) then
    return false;
  end if;
  return private.tax_keys_are(p_adviser -> 'reliefs', array['rent_proof_required', 'nhis', 'life_assurance'])
    and jsonb_typeof(p_adviser #> '{reliefs,rent_proof_required}') = 'boolean'
    and jsonb_typeof(p_adviser #> '{reliefs,nhis}') = 'boolean'
    and jsonb_typeof(p_adviser #> '{reliefs,life_assurance}') = 'boolean';
end;
$$;

-- The `rules` document: 5.0's shape, optionally with the adviser's part (slice 5.9a). Existing
-- versions keep passing (5.0's shape is unchanged).
create or replace function private.tax_rules_valid(p_rules jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then
    return false;
  end if;
  if p_rules ? 'adviser' then
    return private.tax_rules_base_valid(p_rules - 'adviser')
      and private.tax_adviser_valid(p_rules -> 'adviser');
  end if;
  return private.tax_rules_base_valid(p_rules);
end;
$$;

-- NTA 2025 v2's `rules`. Pure.
create function private.tax_rules_nta_2025_v2()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'paye_bands', jsonb_build_array(
      jsonb_build_object('width_kobo', '80000000', 'rate_bps', 0),
      jsonb_build_object('width_kobo', '220000000', 'rate_bps', 1500),
      jsonb_build_object('width_kobo', '900000000', 'rate_bps', 1800),
      jsonb_build_object('width_kobo', '1300000000', 'rate_bps', 2100),
      jsonb_build_object('width_kobo', '2500000000', 'rate_bps', 2300),
      jsonb_build_object('width_kobo', null, 'rate_bps', 2500)
    ),
    'rent_relief', jsonb_build_object('rate_bps', 2000, 'cap_kobo', '50000000'),
    'pension', jsonb_build_object(
      'employee_bps', 800, 'employer_bps', 1000,
      'base', jsonb_build_array('basic', 'housing', 'transport')
    ),
    'nhf', jsonb_build_object('rate_bps', 250, 'base', jsonb_build_array('basic')),
    'nsitf', jsonb_build_object('rate_bps', 100),
    'itf', jsonb_build_object('rate_bps', 100, 'min_staff', 5),
    'daily_workers_exempt', false,
    'adviser', jsonb_build_object(
      'paye_method', 'cumulative_ytd',
      'minimum_wage_monthly_kobo', '7000000',
      'pension_min_employees', 3,
      'daily_pay_pensionable', true,
      'nhf_needs_number_and_minimum_wage', true,
      'nsitf_regular_only', true,
      'deduction_cap', jsonb_build_object('numerator', 1, 'denominator', 3),
      'clawback', jsonb_build_object('pre_tax_same_tax_year', true, 'max_age_months', 3),
      'reliefs', jsonb_build_object('rent_proof_required', true, 'nhis', true, 'life_assurance', true)
    )
  )
$$;

-- NTA 2025 v2: v1 with the tax adviser's answers of 24 Nov 2026 (the owner approved them). Mirrors
-- src/lib/payroll/rule-set.ts NTA_2025_V2 (tests/rls/tax-rule-sets.test.ts compares them). The
-- starting version from 1 Jan 2026 for a company that gets its rule set from now on.
create or replace function private.tax_rule_set_template()
returns table (
  name text,
  effective_from date,
  rules jsonb,
  policy jsonb,
  source_label text
)
language sql
immutable
set search_path = ''
as $$
  select
    'NTA 2025 v2'::text,
    '2026-01-01'::date,
    private.tax_rules_nta_2025_v2(),
    jsonb_build_object(
      'overtime_multiplier_bps', 10000,
      'off_day_paid_minutes', 480,
      'public_holiday_mode', 'worked_minutes_at_overtime_rate'
    ),
    'Tax adviser''s answers of 24 Nov 2026: NTA 2025, NTAA 2025, PRA 2014, NHF Act, ECA 2010, ITF Act, Labour Act'::text
$$;

revoke all on function private.tax_rules_nta_2025_v2() from public, anon;
grant execute on function private.tax_rules_nta_2025_v2() to authenticated, service_role;
revoke all on function private.tax_rule_set_template() from public, anon;
grant execute on function private.tax_rule_set_template() to authenticated, service_role;

-- A company already holding a version without the adviser's part, in force today and open-ended
-- with nothing scheduled after it, gets NTA 2025 v2 from its tomorrow: the old version closes
-- today through 5.8's closing record (the guard's only way to close a version), and the new one
-- is inserted as add_tax_rule_set_version would. A company with a later version scheduled is left
-- for its owner (nothing found today). Never edits a past version's figures.
do $$
declare
  v_row record;
  v_today date;
begin
  for v_row in
    select t.id, t.organisation_id, t.effective_from
    from public.tax_rule_sets t
    where t.effective_to is null and not (t.rules ? 'adviser')
    order by t.organisation_id
  loop
    v_today := private.org_today(v_row.organisation_id);
    if v_row.effective_from > v_today then
      continue;
    end if;
    insert into private.tax_rule_set_closings (rule_set_id, effective_to)
    values (v_row.id, v_today);
    update public.tax_rule_sets t set effective_to = v_today where t.id = v_row.id;
    insert into public.tax_rule_sets (
      organisation_id, name, effective_from, rules, policy, source_label, reason
    )
    select v_row.organisation_id, tpl.name, v_today + 1, tpl.rules, t.policy, tpl.source_label,
      'The tax adviser''s answers of 24 Nov 2026, approved by the owner (slice 5.9a)'
    from private.tax_rule_set_template() tpl
    cross join public.tax_rule_sets t
    where t.id = v_row.id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables: opening balances, reliefs and their proofs, NHF numbers, the ITF switch
-- ---------------------------------------------------------------------------

-- The company's ITF switch (tax adviser, ITF Act): liable at 5 employees OR with a turnover of
-- N50 million or more, which the app can't know, so the company says so.
alter table public.organisations
  add column itf_turnover_over_50m boolean not null default false;

comment on column public.organisations.itf_turnover_over_50m is
  'The company says its turnover is N50 million or more, so ITF applies whatever its headcount (slice 5.9a, tax adviser: ITF Act). Set by owner or hr with a reason, audited.';

-- A text a person typed: trimmed, 1 to p_max characters, no control characters, < >, web
-- addresses or personal numbers. Null when it isn't one.
create function private.payroll_tax_text(p_text text, p_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_text, ''));
begin
  if char_length(v) not between 1 and p_max or v ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v ~* '(://|www\.)' or private.has_personal_number(v) then
    return null;
  end if;
  return v;
end;
$$;

revoke all on function private.payroll_tax_text(text, integer) from public, anon;
-- Pure, and used in column checks, so every role that may insert can evaluate it.
grant execute on function private.payroll_tax_text(text, integer) to authenticated, service_role;

create table public.payroll_opening_balances (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  tax_year integer not null
    constraint payroll_opening_balances_year check (tax_year between 2000 and 2100),
  -- The last month the balance covers (its first day), inside the tax year.
  as_of_month date not null,
  ytd_gross_kobo bigint not null
    constraint payroll_opening_balances_gross check (ytd_gross_kobo between 0 and 100000000000000),
  ytd_chargeable_kobo bigint not null
    constraint payroll_opening_balances_chargeable check (ytd_chargeable_kobo between 0 and 100000000000000),
  ytd_paye_kobo bigint not null
    constraint payroll_opening_balances_paye check (ytd_paye_kobo between 0 and 100000000000000),
  ytd_pension_kobo bigint not null
    constraint payroll_opening_balances_pension check (ytd_pension_kobo between 0 and 100000000000000),
  currency text not null default 'NGN'
    constraint payroll_opening_balances_currency check (currency = 'NGN'),
  -- The row this one corrects (insert-only: a correction is a new row).
  supersedes_id uuid,
  reason text not null
    constraint payroll_opening_balances_reason check (private.payroll_tax_text(reason, 500) = reason),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_opening_balances_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_opening_balances_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payroll_opening_balances_supersedes_fkey foreign key (organisation_id, supersedes_id)
    references public.payroll_opening_balances (organisation_id, id),
  constraint payroll_opening_balances_month check (
    as_of_month = date_trunc('month', as_of_month)::date
    and extract(year from as_of_month)::integer = tax_year
  ),
  constraint payroll_opening_balances_paye_le_gross check (ytd_paye_kobo <= ytd_gross_kobo)
);

-- A chain per worker and tax year: one first row, each row superseded at most once.
create unique index payroll_opening_balances_first_key
  on public.payroll_opening_balances (organisation_id, worker_id, tax_year)
  where supersedes_id is null;
create unique index payroll_opening_balances_supersedes_key
  on public.payroll_opening_balances (supersedes_id)
  where supersedes_id is not null;
create index payroll_opening_balances_worker_idx
  on public.payroll_opening_balances (organisation_id, worker_id, tax_year);

comment on table public.payroll_opening_balances is
  'A worker''s tax year before the company''s first payroll in the app (slice 5.9a): gross, chargeable pay, PAYE and pension to an as-of month, entered or imported by HR at go-live. Insert-only; a correction supersedes the row. The row nobody superseded is the one in force.';

create table public.payroll_relief_declarations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  tax_year integer not null
    constraint payroll_relief_declarations_year check (tax_year between 2000 and 2100),
  kind text not null
    constraint payroll_relief_declarations_kind check (kind in ('rent', 'nhis', 'life_assurance')),
  -- Rent: the declared annual rent (relief is 20% of it, capped). NHIS and life assurance: the
  -- year's contributions or premiums (the relief itself).
  annual_amount_kobo bigint not null
    constraint payroll_relief_declarations_amount check (annual_amount_kobo between 0 and 100000000000000),
  currency text not null default 'NGN'
    constraint payroll_relief_declarations_currency check (currency = 'NGN'),
  supersedes_id uuid,
  reason text not null
    constraint payroll_relief_declarations_reason check (private.payroll_tax_text(reason, 500) = reason),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_relief_declarations_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_relief_declarations_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payroll_relief_declarations_supersedes_fkey foreign key (organisation_id, supersedes_id)
    references public.payroll_relief_declarations (organisation_id, id)
);

create unique index payroll_relief_declarations_first_key
  on public.payroll_relief_declarations (organisation_id, worker_id, tax_year, kind)
  where supersedes_id is null;
create unique index payroll_relief_declarations_supersedes_key
  on public.payroll_relief_declarations (supersedes_id)
  where supersedes_id is not null;
create index payroll_relief_declarations_worker_idx
  on public.payroll_relief_declarations (organisation_id, worker_id, tax_year);

comment on table public.payroll_relief_declarations is
  'Reliefs a worker declares for a tax year (slice 5.9a, tax adviser): rent, NHIS or NHIA contributions, life assurance or deferred annuity premiums. Insert-only; a correction supersedes the row. Counts only once owner or hr verify its proof.';

create table public.payroll_relief_proofs (
  id uuid primary key,
  organisation_id uuid not null references public.organisations (id),
  declaration_id uuid not null,
  worker_id uuid not null,
  document_kind text not null
    constraint payroll_relief_proofs_document check (document_kind in (
      'tenancy_agreement', 'rent_receipt', 'payment_record', 'contribution_statement',
      'policy_document', 'premium_receipt', 'other'
    )),
  file_ext text not null constraint payroll_relief_proofs_ext check (file_ext in ('pdf', 'png', 'jpg')),
  mime_type text not null
    constraint payroll_relief_proofs_mime check (mime_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null constraint payroll_relief_proofs_size check (size_bytes between 1 and 10485760),
  sha256 text not null constraint payroll_relief_proofs_sha check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null,
  -- The person the server checked (owner or hr of the company).
  checked_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_relief_proofs_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_relief_proofs_path_key unique (storage_path),
  constraint payroll_relief_proofs_declaration_fkey foreign key (organisation_id, declaration_id)
    references public.payroll_relief_declarations (organisation_id, id),
  constraint payroll_relief_proofs_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payroll_relief_proofs_path check (
    storage_path = organisation_id::text || '/' || worker_id::text || '/' || declaration_id::text
      || '/' || id::text || '.' || file_ext
  ),
  constraint payroll_relief_proofs_type_matches check (
    (file_ext = 'pdf' and mime_type = 'application/pdf')
    or (file_ext = 'png' and mime_type = 'image/png')
    or (file_ext = 'jpg' and mime_type = 'image/jpeg')
  )
);

create index payroll_relief_proofs_declaration_idx
  on public.payroll_relief_proofs (organisation_id, declaration_id);

comment on table public.payroll_relief_proofs is
  'Proof files for a relief declaration (slice 5.9a): tenancy agreement, receipts, payment record, statements, policy documents. Checked by the server from their magic bytes, in the private payroll-relief-proofs bucket. Written with the secret key only; insert-only.';

create table public.payroll_relief_verifications (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  declaration_id uuid not null,
  worker_id uuid not null,
  decision text not null
    constraint payroll_relief_verifications_decision check (decision in ('verified', 'rejected')),
  note text
    constraint payroll_relief_verifications_note check (note is null or private.payroll_tax_text(note, 500) = note),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_relief_verifications_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_relief_verifications_declaration_fkey foreign key (organisation_id, declaration_id)
    references public.payroll_relief_declarations (organisation_id, id),
  constraint payroll_relief_verifications_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payroll_relief_verifications_rejected_note check (decision = 'verified' or note is not null)
);

create index payroll_relief_verifications_declaration_idx
  on public.payroll_relief_verifications (organisation_id, declaration_id, created_at desc);

comment on table public.payroll_relief_verifications is
  'Owner or hr checked a relief declaration''s proof (slice 5.9a): verified or rejected with a note. Insert-only; the latest decides. A declaration counts only while its latest is verified.';

create table public.payroll_nhf_numbers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  worker_id uuid not null,
  -- Null records that the number was removed.
  nhf_number text
    constraint payroll_nhf_numbers_format check (nhf_number is null or nhf_number ~ '^[A-Za-z0-9/-]{4,20}$'),
  reason text not null
    constraint payroll_nhf_numbers_reason check (private.payroll_tax_text(reason, 500) = reason),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint payroll_nhf_numbers_organisation_id_id_key unique (organisation_id, id),
  constraint payroll_nhf_numbers_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id)
);

create index payroll_nhf_numbers_worker_idx
  on public.payroll_nhf_numbers (organisation_id, worker_id, created_at desc);

comment on table public.payroll_nhf_numbers is
  'A worker''s NHF number on file (slice 5.9a, tax adviser: NHF is taken only with a number on file). Insert-only; the latest row per worker counts (null: removed). Owner, hr and finance read it.';

-- Insert-only, stamped now, for every role, the secret key and the database owner. An opening
-- balance or relief that supersedes another names one of the same worker and tax year (and kind).
create function private.payroll_tax_records_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'These payroll records are kept as written. Add a new one instead.'
      using errcode = 'MLYA5';
  end if;
  new.created_at := now();
  -- One branch per table, each in its own block: PL/pgSQL can't name a column the row lacks.
  if tg_table_name = 'payroll_opening_balances' then
    if new.supersedes_id is not null and not exists (
      select 1 from public.payroll_opening_balances b
      where b.organisation_id = new.organisation_id and b.id = new.supersedes_id
        and b.worker_id = new.worker_id and b.tax_year = new.tax_year
    ) then
      raise exception 'A correction names an opening balance of the same worker and tax year.'
        using errcode = 'MLYA2';
    end if;
  elsif tg_table_name = 'payroll_relief_declarations' then
    if new.supersedes_id is not null and not exists (
      select 1 from public.payroll_relief_declarations d
      where d.organisation_id = new.organisation_id and d.id = new.supersedes_id
        and d.worker_id = new.worker_id and d.tax_year = new.tax_year and d.kind = new.kind
    ) then
      raise exception 'A correction names a declaration of the same worker, tax year and relief.'
        using errcode = 'MLYA2';
    end if;
  elsif tg_table_name in ('payroll_relief_proofs', 'payroll_relief_verifications') then
    if not exists (
      select 1 from public.payroll_relief_declarations d
      where d.organisation_id = new.organisation_id and d.id = new.declaration_id
        and d.worker_id = new.worker_id
    ) then
      raise exception 'That declaration isn''t this worker''s.' using errcode = 'MLYA2';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.payroll_tax_records_guard() from public, anon, authenticated;

create function private.payroll_tax_records_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'These payroll records are kept as written.' using errcode = 'MLYA5';
end;
$$;

revoke all on function private.payroll_tax_records_no_truncate() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'payroll_opening_balances', 'payroll_relief_declarations', 'payroll_relief_proofs',
    'payroll_relief_verifications', 'payroll_nhf_numbers'
  ] loop
    execute format(
      'create trigger %I before insert or update or delete on public.%I '
      'for each row execute function private.payroll_tax_records_guard()',
      v_table || '_guard', v_table
    );
    execute format(
      'create trigger %I before truncate on public.%I '
      'for each statement execute function private.payroll_tax_records_no_truncate()',
      v_table || '_no_truncate', v_table
    );
    execute format('alter table public.%I enable always trigger %I', v_table, v_table || '_guard');
    execute format('alter table public.%I enable always trigger %I', v_table, v_table || '_no_truncate');
    execute format('alter table public.%I enable row level security', v_table);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      'organisation_id in (select private.role_org_ids(array[''owner'', ''hr'', ''finance''])))',
      v_table || '_select', v_table
    );
    execute format('revoke all on table public.%I from anon, authenticated, service_role', v_table);
    execute format('grant select on table public.%I to authenticated, service_role', v_table);
  end loop;
end;
$$;

-- Row audits (who, what): the writers below are definer functions acting for the signed-in user,
-- so the row trigger names them. Proofs are written with the secret key, so
-- record_payroll_relief_proof writes their event with its actor instead.
create trigger payroll_opening_balances_audit after insert on public.payroll_opening_balances
  for each row execute function private.audit_row_change();
create trigger payroll_relief_declarations_audit after insert on public.payroll_relief_declarations
  for each row execute function private.audit_row_change();
create trigger payroll_relief_verifications_audit after insert on public.payroll_relief_verifications
  for each row execute function private.audit_row_change();
create trigger payroll_nhf_numbers_audit after insert on public.payroll_nhf_numbers
  for each row execute function private.audit_row_change();

-- Proofs: PDF, PNG and JPEG, 10 MB or less. No storage policy: signed-in users can't list, read,
-- write or delete objects; the server writes through a signed upload token for one path and opens
-- files by 60-second signed URLs after an RLS-checked read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payroll-relief-proofs',
  'payroll-relief-proofs',
  false,
  10485760,
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. Functions: writers of the new records, and the engine's read
-- ---------------------------------------------------------------------------

-- The lock approval takes per (company, worker, tax year), in worker order after the leave
-- locks. Writers of a worker's opening balance or reliefs take it too (one lock each, so no
-- cycle). No role check: only definers call it.
create function private.payroll_year_lock(p_organisation_id uuid, p_worker_id uuid, p_year integer)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended(
    'payroll_year:' || p_organisation_id::text || ':' || p_worker_id::text || ':' || p_year::text,
    0
  ))
$$;

revoke all on function private.payroll_year_lock(uuid, uuid, integer) from public, anon, authenticated;

-- Owner or hr of the organisation, in a trusted session. Returns the user.
create function private.require_payroll_tax_writer(p_organisation_id uuid)
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
    or not private.has_role(p_organisation_id, array['owner', 'hr']) then
    raise exception 'Only an owner or HR can change payroll tax records.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function private.require_payroll_tax_writer(uuid) from public, anon, authenticated;

-- Whole kobo from a string of digits, 0 to N1 trillion; null when it isn't.
create function private.payroll_tax_kobo(p_text text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p_text ~ '^[0-9]{1,15}$' and p_text::numeric <= 100000000000000
    then p_text::bigint end
$$;

revoke all on function private.payroll_tax_kobo(text) from public, anon, authenticated;

-- The opening balance in force for a worker and tax year: the row nobody superseded.
create function private.payroll_opening_in_force(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_year integer
)
returns public.payroll_opening_balances
language sql
stable
security definer
set search_path = ''
as $$
  select b.*
  from public.payroll_opening_balances b
  where b.organisation_id = p_organisation_id and b.worker_id = p_worker_id
    and b.tax_year = p_year
    and not exists (
      select 1 from public.payroll_opening_balances x
      where x.organisation_id = b.organisation_id and x.supersedes_id = b.id
    )
  limit 1
$$;

revoke all on function private.payroll_opening_in_force(uuid, uuid, integer) from public, anon, authenticated;

-- The worker's verified relief declarations in force for a tax year (nobody superseded them and
-- their latest verification is `verified`), by id in byte order.
create function private.payroll_verified_reliefs(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_year integer
)
returns table (id uuid, kind text, annual_amount_kobo bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.kind, d.annual_amount_kobo
  from public.payroll_relief_declarations d
  where d.organisation_id = p_organisation_id and d.worker_id = p_worker_id
    and d.tax_year = p_year
    and not exists (
      select 1 from public.payroll_relief_declarations x
      where x.organisation_id = d.organisation_id and x.supersedes_id = d.id
    )
    and (
      select v.decision from public.payroll_relief_verifications v
      where v.organisation_id = d.organisation_id and v.declaration_id = d.id
      order by v.created_at desc, v.id desc
      limit 1
    ) = 'verified'
  order by d.id::text collate "C"
$$;

revoke all on function private.payroll_verified_reliefs(uuid, uuid, integer) from public, anon, authenticated;

-- The ids above as one comma-joined text (what the trace's year_to_date step records).
create function private.payroll_verified_relief_ids(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_year integer
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(string_agg(r.id::text, ',' order by r.id::text collate "C"), '')
  from private.payroll_verified_reliefs(p_organisation_id, p_worker_id, p_year) r
$$;

revoke all on function private.payroll_verified_relief_ids(uuid, uuid, integer) from public, anon, authenticated;

-- Records an opening balance (owner or hr): a worker's tax year to p_as_of_month before the
-- company's payroll in the app. The first for a worker and year names no row; a correction names
-- the one in force (MLYA2 otherwise). Refused when posted payslips of that year already cover a
-- month it covers (MLYA3). Kobo as strings of digits. Returns the id. Audited (the row trigger
-- and payroll.opening_balance_recorded).
create function private.record_payroll_opening_balance(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_tax_year integer,
  p_as_of_month date,
  p_gross_kobo text,
  p_chargeable_kobo text,
  p_paye_kobo text,
  p_pension_kobo text,
  p_reason text,
  p_supersedes_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_tax_writer(p_organisation_id);
  v_reason text := private.payroll_tax_text(p_reason, 500);
  v_gross bigint := private.payroll_tax_kobo(p_gross_kobo);
  v_chargeable bigint := private.payroll_tax_kobo(p_chargeable_kobo);
  v_paye bigint := private.payroll_tax_kobo(p_paye_kobo);
  v_pension bigint := private.payroll_tax_kobo(p_pension_kobo);
  v_current public.payroll_opening_balances%rowtype;
  v_id uuid;
begin
  if p_worker_id is null or p_tax_year is null or p_tax_year not between 2000 and 2100
    or p_as_of_month is null or p_as_of_month <> date_trunc('month', p_as_of_month)::date
    or extract(year from p_as_of_month)::integer <> p_tax_year then
    raise exception 'Choose the worker, the tax year and the last month the balance covers (in that year).'
      using errcode = '22023';
  end if;
  if v_gross is null or v_chargeable is null or v_paye is null or v_pension is null
    or v_paye > v_gross then
    raise exception 'Amounts are whole kobo from 0, and PAYE is no more than gross pay.'
      using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  ) then
    raise exception 'That worker wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.payroll_year_lock(p_organisation_id, p_worker_id, p_tax_year);
  v_current := private.payroll_opening_in_force(p_organisation_id, p_worker_id, p_tax_year);
  if v_current.id is distinct from p_supersedes_id then
    raise exception 'An opening balance for this worker and year is already on file. Correct the one in force.'
      using errcode = 'MLYA2';
  end if;
  if exists (
    select 1
    from public.payslips s
    join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
    where s.organisation_id = p_organisation_id and s.worker_id = p_worker_id
      and r.status in ('approved', 'released') and r.kind <> 'reversal'
      and r.pay_date >= make_date(p_tax_year, 1, 1)
      and r.pay_date < (p_as_of_month + interval '1 month')::date
  ) then
    raise exception 'Payroll in the app already paid this worker in a month the balance covers. Choose an earlier month.'
      using errcode = 'MLYA3';
  end if;
  insert into public.payroll_opening_balances (
    organisation_id, worker_id, tax_year, as_of_month, ytd_gross_kobo, ytd_chargeable_kobo,
    ytd_paye_kobo, ytd_pension_kobo, supersedes_id, reason, created_by
  )
  values (
    p_organisation_id, p_worker_id, p_tax_year, p_as_of_month, v_gross, v_chargeable, v_paye,
    v_pension, p_supersedes_id, v_reason, v_uid
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.opening_balance_recorded', 'payroll_opening_balances', v_id,
    case when v_current.id is null then null else jsonb_build_object(
      'id', v_current.id, 'as_of_month', v_current.as_of_month,
      'gross_kobo', v_current.ytd_gross_kobo::text,
      'chargeable_kobo', v_current.ytd_chargeable_kobo::text,
      'paye_kobo', v_current.ytd_paye_kobo::text, 'pension_kobo', v_current.ytd_pension_kobo::text
    ) end,
    jsonb_build_object(
      'worker_id', p_worker_id, 'tax_year', p_tax_year, 'as_of_month', p_as_of_month,
      'gross_kobo', v_gross::text, 'chargeable_kobo', v_chargeable::text,
      'paye_kobo', v_paye::text, 'pension_kobo', v_pension::text
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.record_payroll_opening_balance(uuid, uuid, integer, date, text, text, text, text, text, uuid)
  from public, anon;
grant execute on function private.record_payroll_opening_balance(uuid, uuid, integer, date, text, text, text, text, text, uuid)
  to authenticated;

create function public.record_payroll_opening_balance(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_tax_year integer,
  p_as_of_month date,
  p_gross_kobo text,
  p_chargeable_kobo text,
  p_paye_kobo text,
  p_pension_kobo text,
  p_reason text,
  p_supersedes_id uuid default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_payroll_opening_balance(
    p_organisation_id, p_worker_id, p_tax_year, p_as_of_month, p_gross_kobo, p_chargeable_kobo,
    p_paye_kobo, p_pension_kobo, p_reason, p_supersedes_id
  )
$$;

revoke all on function public.record_payroll_opening_balance(uuid, uuid, integer, date, text, text, text, text, text, uuid)
  from public, anon;
grant execute on function public.record_payroll_opening_balance(uuid, uuid, integer, date, text, text, text, text, text, uuid)
  to authenticated;

-- Imports opening balances at go-live (owner or hr): p_rows is [{worker_id, gross_kobo,
-- chargeable_kobo, paye_kobo, pension_kobo}], 1 to 2,000 rows, one tax year and as-of month, one
-- transaction. A worker with a balance in force for the year gets a superseding row. Returns the
-- number recorded.
create function private.import_payroll_opening_balances(
  p_organisation_id uuid,
  p_tax_year integer,
  p_as_of_month date,
  p_rows jsonb,
  p_reason text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_tax_writer(p_organisation_id);
  v_row jsonb;
  v_worker uuid;
  v_current public.payroll_opening_balances%rowtype;
  v_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) not between 1 and 2000 then
    raise exception 'Import 1 to 2,000 rows at a time.' using errcode = '22023';
  end if;
  if (select count(distinct e ->> 'worker_id') from jsonb_array_elements(p_rows) e)
    <> jsonb_array_length(p_rows) then
    raise exception 'Each worker appears once in an import.' using errcode = '22023';
  end if;
  for v_row in
    select e from jsonb_array_elements(p_rows) e order by e ->> 'worker_id'
  loop
    begin
      v_worker := (v_row ->> 'worker_id')::uuid;
    exception when others then
      raise exception 'A row names no worker.' using errcode = '22023';
    end;
    perform private.payroll_year_lock(p_organisation_id, v_worker, p_tax_year);
    v_current := private.payroll_opening_in_force(p_organisation_id, v_worker, p_tax_year);
    perform private.record_payroll_opening_balance(
      p_organisation_id, v_worker, p_tax_year, p_as_of_month, v_row ->> 'gross_kobo',
      v_row ->> 'chargeable_kobo', v_row ->> 'paye_kobo', v_row ->> 'pension_kobo', p_reason,
      v_current.id
    );
    v_count := v_count + 1;
  end loop;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.opening_balances_imported', 'organisations', p_organisation_id,
    null,
    jsonb_build_object('tax_year', p_tax_year, 'as_of_month', p_as_of_month, 'rows', v_count),
    private.payroll_tax_text(p_reason, 500)
  );
  return v_count;
end;
$$;

revoke all on function private.import_payroll_opening_balances(uuid, integer, date, jsonb, text) from public, anon;
grant execute on function private.import_payroll_opening_balances(uuid, integer, date, jsonb, text) to authenticated;

create function public.import_payroll_opening_balances(
  p_organisation_id uuid,
  p_tax_year integer,
  p_as_of_month date,
  p_rows jsonb,
  p_reason text
)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.import_payroll_opening_balances(
    p_organisation_id, p_tax_year, p_as_of_month, p_rows, p_reason
  )
$$;

revoke all on function public.import_payroll_opening_balances(uuid, integer, date, jsonb, text) from public, anon;
grant execute on function public.import_payroll_opening_balances(uuid, integer, date, jsonb, text) to authenticated;

-- Declares a relief for a worker and tax year (owner or hr): rent (the annual rent), NHIS or
-- NHIA contributions, or life assurance or deferred annuity premiums (the year's amount). The
-- first names no row; a correction names the one in force (MLYA2). It counts only once verified.
-- Returns the id.
create function private.declare_payroll_relief(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_tax_year integer,
  p_kind text,
  p_annual_kobo text,
  p_reason text,
  p_supersedes_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_tax_writer(p_organisation_id);
  v_reason text := private.payroll_tax_text(p_reason, 500);
  v_amount bigint := private.payroll_tax_kobo(p_annual_kobo);
  v_current uuid;
  v_id uuid;
begin
  if p_worker_id is null or p_tax_year is null or p_tax_year not between 2000 and 2100
    or p_kind is null or p_kind not in ('rent', 'nhis', 'life_assurance') then
    raise exception 'Choose the worker, the tax year and the relief.' using errcode = '22023';
  end if;
  if v_amount is null then
    raise exception 'The amount is whole kobo from 0.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  ) then
    raise exception 'That worker wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.payroll_year_lock(p_organisation_id, p_worker_id, p_tax_year);
  select d.id into v_current
  from public.payroll_relief_declarations d
  where d.organisation_id = p_organisation_id and d.worker_id = p_worker_id
    and d.tax_year = p_tax_year and d.kind = p_kind
    and not exists (
      select 1 from public.payroll_relief_declarations x
      where x.organisation_id = d.organisation_id and x.supersedes_id = d.id
    );
  if v_current is distinct from p_supersedes_id then
    raise exception 'This relief is already declared for the year. Correct the one in force.'
      using errcode = 'MLYA2';
  end if;
  insert into public.payroll_relief_declarations (
    organisation_id, worker_id, tax_year, kind, annual_amount_kobo, supersedes_id, reason,
    created_by
  )
  values (
    p_organisation_id, p_worker_id, p_tax_year, p_kind, v_amount, p_supersedes_id, v_reason, v_uid
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.relief_declared', 'payroll_relief_declarations', v_id, null,
    jsonb_build_object(
      'worker_id', p_worker_id, 'tax_year', p_tax_year, 'kind', p_kind,
      'annual_kobo', v_amount::text, 'supersedes_id', p_supersedes_id
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.declare_payroll_relief(uuid, uuid, integer, text, text, text, uuid) from public, anon;
grant execute on function private.declare_payroll_relief(uuid, uuid, integer, text, text, text, uuid) to authenticated;

create function public.declare_payroll_relief(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_tax_year integer,
  p_kind text,
  p_annual_kobo text,
  p_reason text,
  p_supersedes_id uuid default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.declare_payroll_relief(
    p_organisation_id, p_worker_id, p_tax_year, p_kind, p_annual_kobo, p_reason, p_supersedes_id
  )
$$;

revoke all on function public.declare_payroll_relief(uuid, uuid, integer, text, text, text, uuid) from public, anon;
grant execute on function public.declare_payroll_relief(uuid, uuid, integer, text, text, text, uuid) to authenticated;

-- Records a proof file the server checked (the secret key only, no signed-in user), as 5.6's
-- receipts: it read the object back from payroll-relief-proofs, checked its type from its magic
-- bytes and its size, and worked out its sha256. The object must be at the proof's own path with
-- that size and type; the actor must be an owner or hr member. Returns the id.
create function private.record_payroll_relief_proof(
  p_organisation_id uuid,
  p_declaration_id uuid,
  p_proof_id uuid,
  p_actor uuid,
  p_document_kind text,
  p_file_ext text,
  p_size_bytes integer,
  p_sha256 text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_decl public.payroll_relief_declarations%rowtype;
  v_path text;
  v_mime text;
  v_size bigint;
  v_type text;
begin
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'Only the server checks proof files.' using errcode = '42501';
  end if;
  if p_organisation_id is null or p_declaration_id is null or p_proof_id is null
    or p_actor is null then
    raise exception 'Name the company, the declaration, the file and who uploaded it.'
      using errcode = '22023';
  end if;
  if p_file_ext is null or p_file_ext not in ('pdf', 'png', 'jpg')
    or p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_document_kind is null or p_document_kind not in (
      'tenancy_agreement', 'rent_receipt', 'payment_record', 'contribution_statement',
      'policy_document', 'premium_receipt', 'other'
    ) then
    raise exception 'A proof is a PDF, PNG or JPEG of 10 MB or less, of a listed kind.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id and m.user_id = p_actor
      and m.role in ('owner', 'hr')
  ) then
    raise exception 'Only an owner or HR can add proof files.' using errcode = '42501';
  end if;
  select d.* into v_decl
  from public.payroll_relief_declarations d
  where d.organisation_id = p_organisation_id and d.id = p_declaration_id;
  if v_decl.id is null then
    raise exception 'That declaration wasn''t found.' using errcode = 'P0002';
  end if;
  v_mime := case p_file_ext
    when 'pdf' then 'application/pdf' when 'png' then 'image/png' else 'image/jpeg'
  end;
  v_path := p_organisation_id::text || '/' || v_decl.worker_id::text || '/' || v_decl.id::text
    || '/' || p_proof_id::text || '.' || p_file_ext;
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype'
  into v_size, v_type
  from storage.objects o
  where o.bucket_id = 'payroll-relief-proofs' and o.name = v_path;
  if not found or v_size is distinct from p_size_bytes::bigint or v_type is distinct from v_mime then
    raise exception 'The file didn''t arrive as chosen. Choose it again.' using errcode = '22023';
  end if;
  perform set_config('metalira.audit_channel', 'web', true);
  insert into public.payroll_relief_proofs (
    id, organisation_id, declaration_id, worker_id, document_kind, file_ext, mime_type,
    size_bytes, sha256, storage_path, checked_by
  )
  values (
    p_proof_id, p_organisation_id, v_decl.id, v_decl.worker_id, p_document_kind, p_file_ext,
    v_mime, p_size_bytes, p_sha256, v_path, p_actor
  );
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, p_actor, 'payroll.relief_proof_checked', 'payroll_relief_declarations',
    v_decl.id, null,
    jsonb_build_object(
      'proof_id', p_proof_id, 'document_kind', p_document_kind, 'mime_type', v_mime,
      'size_bytes', p_size_bytes, 'sha256', p_sha256
    )
  );
  return p_proof_id;
end;
$$;

revoke all on function private.record_payroll_relief_proof(uuid, uuid, uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function private.record_payroll_relief_proof(uuid, uuid, uuid, uuid, text, text, integer, text)
  to service_role;

create function public.record_payroll_relief_proof(
  p_organisation_id uuid,
  p_declaration_id uuid,
  p_proof_id uuid,
  p_actor uuid,
  p_document_kind text,
  p_file_ext text,
  p_size_bytes integer,
  p_sha256 text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_payroll_relief_proof(
    p_organisation_id, p_declaration_id, p_proof_id, p_actor, p_document_kind, p_file_ext,
    p_size_bytes, p_sha256
  )
$$;

revoke all on function public.record_payroll_relief_proof(uuid, uuid, uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_payroll_relief_proof(uuid, uuid, uuid, uuid, text, text, integer, text)
  to service_role;

-- Verifies or rejects a relief declaration (owner or hr): only one in force, and `verified` only
-- with a proof on file (MLYA4). Rejecting needs a note. Returns the verification's id.
create function private.verify_payroll_relief(
  p_organisation_id uuid,
  p_declaration_id uuid,
  p_decision text,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_tax_writer(p_organisation_id);
  v_note text := case when p_note is null or btrim(p_note) = '' then null
    else private.payroll_tax_text(p_note, 500) end;
  v_decl public.payroll_relief_declarations%rowtype;
  v_id uuid;
begin
  if p_decision is null or p_decision not in ('verified', 'rejected') then
    raise exception 'Verify or reject the proof.' using errcode = '22023';
  end if;
  if p_note is not null and btrim(p_note) <> '' and v_note is null then
    raise exception 'A note is up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  if p_decision = 'rejected' and v_note is null then
    raise exception 'Say why the proof is rejected.' using errcode = '22023';
  end if;
  select d.* into v_decl
  from public.payroll_relief_declarations d
  where d.organisation_id = p_organisation_id and d.id = p_declaration_id;
  if v_decl.id is null then
    raise exception 'That declaration wasn''t found.' using errcode = 'P0002';
  end if;
  perform private.payroll_year_lock(p_organisation_id, v_decl.worker_id, v_decl.tax_year);
  if exists (
    select 1 from public.payroll_relief_declarations x
    where x.organisation_id = p_organisation_id and x.supersedes_id = v_decl.id
  ) then
    raise exception 'A later declaration replaced this one. Verify that one instead.'
      using errcode = 'MLYA4';
  end if;
  if p_decision = 'verified' and not exists (
    select 1 from public.payroll_relief_proofs p
    where p.organisation_id = p_organisation_id and p.declaration_id = v_decl.id
  ) then
    raise exception 'Add the proof (tenancy agreement, receipts, payment record or statement) before verifying.'
      using errcode = 'MLYA4';
  end if;
  insert into public.payroll_relief_verifications (
    organisation_id, declaration_id, worker_id, decision, note, created_by
  )
  values (p_organisation_id, v_decl.id, v_decl.worker_id, p_decision, v_note, v_uid)
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.relief_' || p_decision, 'payroll_relief_declarations', v_decl.id,
    null,
    jsonb_build_object(
      'verification_id', v_id, 'worker_id', v_decl.worker_id, 'tax_year', v_decl.tax_year,
      'kind', v_decl.kind
    ),
    v_note
  );
  return v_id;
end;
$$;

revoke all on function private.verify_payroll_relief(uuid, uuid, text, text) from public, anon;
grant execute on function private.verify_payroll_relief(uuid, uuid, text, text) to authenticated;

create function public.verify_payroll_relief(
  p_organisation_id uuid,
  p_declaration_id uuid,
  p_decision text,
  p_note text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.verify_payroll_relief(p_organisation_id, p_declaration_id, p_decision, p_note)
$$;

revoke all on function public.verify_payroll_relief(uuid, uuid, text, text) from public, anon;
grant execute on function public.verify_payroll_relief(uuid, uuid, text, text) to authenticated;

-- Records a worker's NHF number, or its removal with null (owner or hr). The audit row says only
-- whether a number is on file and its last 4 characters.
create function private.set_payroll_nhf_number(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_nhf_number text,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_tax_writer(p_organisation_id);
  v_reason text := private.payroll_tax_text(p_reason, 500);
  v_number text := nullif(btrim(coalesce(p_nhf_number, '')), '');
  v_id uuid;
begin
  if v_number is not null and v_number !~ '^[A-Za-z0-9/-]{4,20}$' then
    raise exception 'An NHF number is 4 to 20 letters, digits, / or -.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = p_worker_id
  ) then
    raise exception 'That worker wasn''t found.' using errcode = 'P0002';
  end if;
  insert into public.payroll_nhf_numbers (organisation_id, worker_id, nhf_number, reason, created_by)
  values (p_organisation_id, p_worker_id, v_number, v_reason, v_uid)
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.nhf_number_set', 'payroll_nhf_numbers', v_id, null,
    jsonb_build_object(
      'worker_id', p_worker_id, 'on_file', v_number is not null,
      'last4', case when v_number is null then null else right(v_number, 4) end
    ),
    v_reason
  );
  return v_id;
end;
$$;

revoke all on function private.set_payroll_nhf_number(uuid, uuid, text, text) from public, anon;
grant execute on function private.set_payroll_nhf_number(uuid, uuid, text, text) to authenticated;

create function public.set_payroll_nhf_number(
  p_organisation_id uuid,
  p_worker_id uuid,
  p_nhf_number text,
  p_reason text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_payroll_nhf_number(p_organisation_id, p_worker_id, p_nhf_number, p_reason)
$$;

revoke all on function public.set_payroll_nhf_number(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_payroll_nhf_number(uuid, uuid, text, text) to authenticated;

-- Sets the company's ITF turnover switch (owner or hr, with a reason, audited).
create function private.set_itf_turnover_flag(
  p_organisation_id uuid,
  p_value boolean,
  p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_tax_writer(p_organisation_id);
  v_reason text := private.payroll_tax_text(p_reason, 500);
  v_before boolean;
begin
  if p_value is null then
    raise exception 'Say whether the turnover is N50 million or more.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses or personal numbers.'
      using errcode = '22023';
  end if;
  select o.itf_turnover_over_50m into v_before
  from public.organisations o
  where o.id = p_organisation_id
  for update;
  update public.organisations o set itf_turnover_over_50m = p_value where o.id = p_organisation_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.itf_turnover_set', 'organisations', p_organisation_id,
    jsonb_build_object('itf_turnover_over_50m', v_before),
    jsonb_build_object('itf_turnover_over_50m', p_value, 'actor', v_uid),
    v_reason
  );
end;
$$;

revoke all on function private.set_itf_turnover_flag(uuid, boolean, text) from public, anon;
grant execute on function private.set_itf_turnover_flag(uuid, boolean, text) to authenticated;

create function public.set_itf_turnover_flag(
  p_organisation_id uuid,
  p_value boolean,
  p_reason text
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_itf_turnover_flag(p_organisation_id, p_value, p_reason)
$$;

revoke all on function public.set_itf_turnover_flag(uuid, boolean, text) from public, anon;
grant execute on function public.set_itf_turnover_flag(uuid, boolean, text) to authenticated;

-- What the engine needs beyond 5.1's inputs for a pay date (owner, hr, finance or the secret
-- key): {version, headcount (workers employed on the pay date, daily workers included),
-- itf_turnover_over_50m, go_live_month (the first month of the earliest pay date of a posted
-- run, reversals left out; null before the first), workers: [{worker_id, has_nhf_number,
-- rent_declared_kobo, opening: {id, as_of_month, gross_kobo, chargeable_kobo, paye_kobo,
-- pension_kobo} | null, reliefs: [{id, kind, annual_kobo}]}]}, workers in id order. No personal
-- numbers (an NHF number only as on file or not).
create function private.payroll_tax_context(
  p_organisation_id uuid,
  p_pay_date date,
  p_worker_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_year integer := extract(year from p_pay_date)::integer;
begin
  perform private.require_payroll_reader(p_organisation_id);
  if p_pay_date is null then
    raise exception 'Choose the pay date.' using errcode = '22023';
  end if;
  if p_worker_ids is null or cardinality(p_worker_ids) > 5000 then
    raise exception 'Name up to 5,000 workers.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'version', 1,
    'headcount', (
      select count(*)::integer from public.workers w
      where w.organisation_id = p_organisation_id
        and w.start_date <= p_pay_date and (w.end_date is null or w.end_date >= p_pay_date)
    ),
    'itf_turnover_over_50m', (
      select o.itf_turnover_over_50m from public.organisations o where o.id = p_organisation_id
    ),
    'go_live_month', (
      select to_char(date_trunc('month', min(r.pay_date)), 'YYYY-MM-DD')
      from public.payroll_runs r
      where r.organisation_id = p_organisation_id and r.kind <> 'reversal'
        and r.status in ('approved', 'released', 'reversed')
    ),
    'workers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'worker_id', w.id,
          'has_nhf_number', coalesce((
            select n.nhf_number is not null from public.payroll_nhf_numbers n
            where n.organisation_id = w.organisation_id and n.worker_id = w.id
            order by n.created_at desc, n.id desc
            limit 1
          ), false),
          'rent_declared_kobo', coalesce(w.annual_rent_declared_kobo, 0)::text,
          'opening', (
            select jsonb_build_object(
              'id', b.id, 'as_of_month', b.as_of_month,
              'gross_kobo', b.ytd_gross_kobo::text,
              'chargeable_kobo', b.ytd_chargeable_kobo::text,
              'paye_kobo', b.ytd_paye_kobo::text, 'pension_kobo', b.ytd_pension_kobo::text
            )
            from private.payroll_opening_in_force(w.organisation_id, w.id, v_year) b
            where b.id is not null
          ),
          'reliefs', coalesce((
            select jsonb_agg(
              jsonb_build_object('id', r.id, 'kind', r.kind, 'annual_kobo', r.annual_amount_kobo::text)
              order by r.id::text collate "C"
            )
            from private.payroll_verified_reliefs(w.organisation_id, w.id, v_year) r
          ), '[]'::jsonb)
        )
        order by w.id::text collate "C"
      )
      from public.workers w
      where w.organisation_id = p_organisation_id and w.id = any (p_worker_ids)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function private.payroll_tax_context(uuid, date, uuid[]) from public, anon;
grant execute on function private.payroll_tax_context(uuid, date, uuid[]) to authenticated, service_role;

create function public.payroll_tax_context(
  p_organisation_id uuid,
  p_pay_date date,
  p_worker_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.payroll_tax_context(p_organisation_id, p_pay_date, p_worker_ids)
$$;

revoke all on function public.payroll_tax_context(uuid, date, uuid[]) from public, anon;
grant execute on function public.payroll_tax_context(uuid, date, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Payslip lines: pre-tax clawbacks and the regular flag
-- ---------------------------------------------------------------------------

alter table public.payslip_lines drop constraint if exists payslip_lines_code_value;
alter table public.payslip_lines
  add constraint payslip_lines_code_value check (code in (
    'basic', 'housing', 'transport', 'other_allowances', 'daily_pay', 'hourly_pay', 'overtime',
    'off_day', 'public_holiday', 'leave_deduction', 'adjustment_earning', 'arrears', 'paye',
    'pension_employee', 'nhf', 'deduction', 'carried_deduction', 'pension_employer', 'nsitf',
    'itf', 'leave_refund', 'leave_arrears', 'clawback'
  ));

-- Earnings as earned: a leave deduction and a pre-tax clawback are the only negative lines.
alter table public.payslip_lines drop constraint if exists payslip_lines_sign;
alter table public.payslip_lines
  add constraint payslip_lines_sign check (
    case when code in ('leave_deduction', 'clawback') then amount_kobo <= 0 else amount_kobo >= 0 end
  );

-- Regular monthly pay (tax adviser, NSITF): derived from the code, as
-- src/lib/payroll/contract.ts REGULAR_EARNING_CODES. Overtime, off-day and public-holiday pay,
-- adjustments (bonuses, one-offs), arrears, refunds and clawbacks are irregular.
alter table public.payslip_lines
  add column regular boolean generated always as (
    code in ('basic', 'housing', 'transport', 'other_allowances', 'daily_pay', 'hourly_pay',
      'leave_deduction')
  ) stored;

comment on column public.payslip_lines.regular is
  'Regular monthly pay, which NSITF is taken on (slice 5.9a, tax adviser); derived from the code.';

-- A deduction correcting an overpaid earning may carry the pensionable flag of the earning it
-- claws back (the pension base it reduces before tax in the same tax year). Other deductions stay
-- neither taxable nor pensionable.
alter table public.payroll_adjustments drop constraint payroll_adjustments_deduction_flags;
alter table public.payroll_adjustments
  add constraint payroll_adjustments_deduction_flags check (
    kind = 'earning' or (not taxable and (not pensionable or corrects_payslip_id is not null))
  );

-- 5.7b's off-cycle line guard (its only version), with clawback lines allowed on correction and
-- one-off runs (a deduction correction recovered before tax).
create or replace function private.payslip_lines_off_cycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype := private.payroll_off_cycle_run(new.organisation_id, new.run_id);
begin
  if v_run.id is not null and (
    (v_run.off_cycle_reason = 'one_off' and new.code not in (
      'adjustment_earning', 'deduction', 'paye', 'pension_employee', 'nhf', 'pension_employer',
      'nsitf', 'itf', 'clawback'
    ))
    -- A correction may also pay unpaid timesheet days and leave (money review M2), never salary
    -- components or a carried deduction.
    or (v_run.off_cycle_reason = 'correction' and new.code not in (
      'adjustment_earning', 'deduction', 'paye', 'pension_employee', 'nhf', 'pension_employer',
      'nsitf', 'itf', 'daily_pay', 'hourly_pay', 'overtime', 'off_day', 'public_holiday',
      'arrears', 'leave_deduction', 'clawback'
    ))
  ) then
    raise exception 'A correction pays one-off items and unpaid days only; a one-off run pays its items only.'
      using errcode = 'MLOC9';
  end if;
  return new;
end;
$$;

revoke all on function private.payslip_lines_off_cycle_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Corrections: the overpayment limit and pensionable clawbacks
-- ---------------------------------------------------------------------------

-- 5.7a's add_payroll_correction (its only version), with two changes marked "Slice 5.9a": an
-- overpayment older than the run's rule set's limit can't be deducted (MLYA1), and a deduction
-- keeps the pensionable flag of the earning it corrects (the pension base a same-year clawback
-- reduces). The grants stand (create or replace keeps them).
create or replace function private.add_payroll_correction(
  p_organisation_id uuid,
  p_run_id uuid,
  p_payslip_id uuid,
  p_kind text,
  p_label text,
  p_amount_kobo text,
  p_pensionable boolean,
  p_reason text,
  p_repeat boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_preparer(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_label text := private.tax_clean_text(p_label, 80);
  v_reason text := private.tax_clean_text(p_reason, 500);
  v_id uuid := gen_random_uuid();
  v_amount bigint;
  v_worker uuid;
  v_paid_on date;
  v_max_months integer;
begin
  if p_amount_kobo is null or p_amount_kobo !~ '^[0-9]{1,12}$' then
    raise exception 'The amount is whole kobo, above ₦0 and at most ₦1,000,000,000.' using errcode = '22023';
  end if;
  v_amount := p_amount_kobo::bigint;
  if p_kind is null or p_kind not in ('earning', 'deduction') then
    raise exception 'Choose an earning or a deduction.' using errcode = '22023';
  end if;
  if v_label is null then
    raise exception 'Name the item in up to 80 characters, with no web addresses.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Give a reason of up to 500 characters, with no web addresses.' using errcode = '22023';
  end if;
  if v_amount <= 0 or v_amount > 100000000000 then
    raise exception 'The amount is above ₦0 and at most ₦1,000,000,000.' using errcode = '22023';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Adjustments change only while the run is a draft.' using errcode = 'MLPRD';
  end if;
  select s.worker_id, r.pay_date into v_worker, v_paid_on
  from public.payslips s
  join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
  where s.organisation_id = p_organisation_id and s.id = p_payslip_id;
  if v_worker is null then
    raise exception 'That payslip wasn''t found.' using errcode = 'P0002';
  end if;
  -- Slice 5.9a (Labour Act s.5(5), tax adviser): an overpayment older than the rule set's limit
  -- (3 months) at discovery can't be deducted from wages; it needs a manual route.
  select (t.rules #>> '{adviser,clawback,max_age_months}')::integer into v_max_months
  from public.tax_rule_sets t
  where t.organisation_id = p_organisation_id and t.id = v_run.rule_set_id
    and (t.rules #>> '{adviser,clawback,max_age_months}') ~ '^[0-9]{1,3}$';
  if p_kind = 'deduction' and v_max_months is not null
    and v_paid_on < (private.org_today(p_organisation_id) - make_interval(months => v_max_months))::date then
    raise exception 'This overpayment was paid more than % months ago, so it can''t be deducted from wages (Labour Act s.5(5)). Recover it another way, outside payroll.',
      v_max_months using errcode = 'MLYA1';
  end if;
  if not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = v_worker
      and w.start_date <= v_run.period_end
      and (w.end_date is null or w.end_date >= v_run.period_start)
  ) then
    raise exception 'That worker isn''t employed in this pay period.' using errcode = '22023';
  end if;
  -- Money review M4a: a payslip already corrected in another run that stands needs the explicit
  -- statement that this is a further correction, not the same one twice.
  if not coalesce(p_repeat, false) and exists (
    select 1
    from public.payroll_adjustments a
    join public.payroll_runs r on r.organisation_id = a.organisation_id and r.id = a.run_id
    where a.organisation_id = p_organisation_id and a.corrects_payslip_id = p_payslip_id
      and a.run_id <> p_run_id and r.status <> 'reversed'
  ) then
    raise exception 'That payslip was already corrected in another run. Confirm this is a further correction.'
      using errcode = 'MLRVC';
  end if;

  -- Slice 5.9a: a deduction keeps the pensionable flag (payroll_adjustments_deduction_flags allows
  -- it on corrections only).
  insert into public.payroll_adjustments (
    id, organisation_id, run_id, worker_id, kind, label, amount_kobo, pensionable, taxable,
    series_id, instalment_number, instalment_count, reason, created_by, corrects_payslip_id
  )
  values (
    v_id, p_organisation_id, p_run_id, v_worker, p_kind, v_label, v_amount,
    coalesce(p_pensionable, false), p_kind = 'earning',
    v_id, 1, 1, v_reason, v_uid, p_payslip_id
  );
  update public.payroll_runs r set needs_recalculation = true where r.id = p_run_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.correction_added', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'adjustment_id', v_id, 'worker_id', v_worker, 'kind', p_kind, 'label', v_label,
      'amount_kobo', v_amount::text, 'corrects_payslip_id', p_payslip_id,
      'further_correction', coalesce(p_repeat, false)
    ),
    v_reason
  );
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Saving results: clawback lines
-- ---------------------------------------------------------------------------

-- 5.7c's private.save_payroll_results (migration 20261122200000, its latest version), copied
-- exactly except for the three additions marked "Slice 5.9a" (clawback lines). The grants
-- stand.
create or replace function private.save_payroll_results(
  p_organisation_id uuid,
  p_run_id uuid,
  p_actor uuid,
  p_results jsonb,
  p_inputs_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run public.payroll_runs%rowtype;
  v_slip jsonb;
  v_line jsonb;
  v_src jsonb;
  v_anomaly jsonb;
  v_slip_id uuid;
  v_worker uuid;
  v_pos integer;
  v_kind text;
  v_code text;
  v_amount bigint;
  v_from date;
  v_to date;
  v_src_id uuid;
  v_src_kind text;
  v_amounts jsonb;
  v_gross bigint; v_paye bigint; v_pee bigint; v_nhf bigint; v_other bigint; v_net bigint;
  v_carried bigint; v_per bigint; v_nsitf bigint; v_itf bigint; v_cost bigint;
  v_sum_earn bigint; v_sum_paye bigint; v_sum_pee bigint; v_sum_nhf bigint; v_sum_ded bigint;
  v_sum_per bigint; v_sum_nsitf bigint; v_sum_itf bigint;
  v_old_acks jsonb;
  v_before jsonb;
  v_totals record;
  v_anomaly_count integer := 0;
  v_ack_by uuid;
  v_ack_at timestamptz;
  v_detail jsonb;
  v_text text;
  v_slip_count integer := 0;
  v_sources jsonb;
  v_key text;
  v_severity text;
  v_adj public.payroll_adjustments%rowtype;
  -- Slice 5.7c: a leave refund pays back exactly what the leave deduction took.
  v_refund bigint;
  v_owed bigint;
  v_mismatch boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'Only the server saves payroll results.' using errcode = '42501';
  end if;
  if p_organisation_id is null or p_run_id is null or p_actor is null then
    raise exception 'Name the company, the run and who recalculated it.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organisation_id = p_organisation_id and m.user_id = p_actor
      and m.role in ('owner', 'hr')
  ) then
    raise exception 'Only an owner or HR can recalculate payroll.' using errcode = '42501';
  end if;
  if p_inputs_sha256 is null or p_inputs_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The inputs hash isn''t a SHA-256.' using errcode = 'MLPR6';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'object'
    or jsonb_typeof(p_results -> 'payslips') <> 'array'
    or jsonb_typeof(p_results -> 'anomalies') <> 'array'
    or jsonb_typeof(p_results -> 'totals') <> 'object'
    or jsonb_typeof(p_results -> 'itf_applies') <> 'boolean' then
    raise exception 'The results aren''t in the expected shape.' using errcode = 'MLPR6';
  end if;
  if jsonb_array_length(p_results -> 'payslips') > 5000
    or jsonb_array_length(p_results -> 'anomalies') > 20000 then
    raise exception 'The results are too large.' using errcode = 'MLPR6';
  end if;

  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'draft' then
    raise exception 'Only a draft run is recalculated.' using errcode = 'MLPRD';
  end if;
  perform set_config('metalira.audit_channel', 'web', true);

  v_before := jsonb_build_object(
    'gross_kobo', v_run.gross_kobo::text, 'net_kobo', v_run.net_kobo::text,
    'worker_count', v_run.worker_count, 'inputs_sha256', v_run.inputs_sha256
  );

  -- Acknowledged warnings, to carry over to identical anomalies.
  select coalesce(jsonb_agg(jsonb_build_object(
    'worker_id', a.worker_id, 'code', a.code, 'detail', a.detail,
    'by', a.acknowledged_by, 'at', a.acknowledged_at
  )), '[]'::jsonb) into v_old_acks
  from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id
    and a.acknowledged_at is not null;

  delete from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;
  delete from public.payslips s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id;

  for v_slip in select e from jsonb_array_elements(p_results -> 'payslips') e loop
    if jsonb_typeof(v_slip) <> 'object' or jsonb_typeof(v_slip -> 'lines') <> 'array'
      or jsonb_typeof(v_slip -> 'days') <> 'object'
      or jsonb_typeof(v_slip -> 'pay_rate_ids') <> 'array' then
      raise exception 'A payslip isn''t in the expected shape.' using errcode = 'MLPR6';
    end if;
    begin
      v_worker := (v_slip ->> 'worker_id')::uuid;
    exception when others then
      raise exception 'A payslip names no worker.' using errcode = 'MLPR6';
    end;
    if v_worker is null or not exists (
      select 1 from public.workers w
      where w.organisation_id = p_organisation_id and w.id = v_worker
    ) then
      raise exception 'A payslip names a worker outside the company.' using errcode = 'MLPR6';
    end if;

    v_gross := private.payroll_kobo(v_slip -> 'gross_kobo', false, 'gross pay');
    v_paye := private.payroll_kobo(v_slip -> 'paye_kobo', false, 'PAYE');
    v_pee := private.payroll_kobo(v_slip -> 'pension_employee_kobo', false, 'employee pension');
    v_nhf := private.payroll_kobo(v_slip -> 'nhf_kobo', false, 'NHF');
    v_other := private.payroll_kobo(v_slip -> 'other_deductions_kobo', false, 'other deductions');
    v_net := private.payroll_kobo(v_slip -> 'net_kobo', false, 'net pay');
    v_carried := private.payroll_kobo(v_slip -> 'carried_forward_kobo', false, 'the carried deduction');
    v_per := private.payroll_kobo(v_slip -> 'pension_employer_kobo', false, 'employer pension');
    v_nsitf := private.payroll_kobo(v_slip -> 'nsitf_kobo', false, 'NSITF');
    v_itf := private.payroll_kobo(v_slip -> 'itf_kobo', false, 'ITF');
    v_cost := private.payroll_kobo(v_slip -> 'employer_cost_kobo', false, 'employer cost');

    if v_net <> v_gross - v_paye - v_pee - v_nhf - v_other then
      raise exception 'A payslip''s net pay isn''t gross less its deductions.' using errcode = 'MLPR6';
    end if;
    if v_cost <> v_gross + v_per + v_nsitf + v_itf then
      raise exception 'A payslip''s employer cost isn''t gross plus employer pension and levies.'
        using errcode = 'MLPR6';
    end if;
    if not (v_slip ->> 'employment_type') in ('permanent', 'contract', 'casual', 'daily') then
      raise exception 'A payslip has no employment type.' using errcode = 'MLPR6';
    end if;
    begin
      if exists (
        select 1 from jsonb_array_elements_text(v_slip -> 'pay_rate_ids') x
        where not exists (
          select 1 from public.pay_rates r
          where r.organisation_id = p_organisation_id and r.worker_id = v_worker
            and r.id = x::uuid
        )
      ) then
        raise exception 'A payslip names a pay rate that isn''t this worker''s.' using errcode = 'MLPR6';
      end if;
    exception when invalid_text_representation then
      raise exception 'A payslip names a pay rate that isn''t an id.' using errcode = 'MLPR6';
    end;

    begin
      insert into public.payslips (
        organisation_id, run_id, worker_id, gross_kobo, paye_kobo, pension_employee_kobo,
        pension_employer_kobo, nhf_kobo, other_deductions_kobo, net_kobo, carried_forward_kobo,
        nsitf_kobo, itf_kobo, employer_cost_kobo, rule_set_id, pay_rate_ids, employment_type,
        tax_state, pfa_name, cycle_days, rostered_days, employed_rostered_days,
        leave_deducted_days, trace, trace_version
      )
      values (
        p_organisation_id, p_run_id, v_worker, v_gross, v_paye, v_pee, v_per, v_nhf, v_other,
        v_net, v_carried, v_nsitf, v_itf, v_cost, v_run.rule_set_id,
        (select coalesce(array_agg(x::uuid), '{}') from jsonb_array_elements_text(v_slip -> 'pay_rate_ids') x),
        v_slip ->> 'employment_type',
        nullif(btrim(v_slip ->> 'tax_state'), ''),
        nullif(btrim(v_slip ->> 'pfa_name'), ''),
        (v_slip -> 'days' ->> 'cycle')::integer,
        (v_slip -> 'days' ->> 'rostered')::integer,
        (v_slip -> 'days' ->> 'employed_rostered')::integer,
        (v_slip -> 'days' ->> 'leave_deducted')::integer,
        v_slip -> 'trace',
        (v_slip -> 'trace' ->> 'trace_version')::integer
      )
      returning id into v_slip_id;
    exception
      when unique_violation then
        raise exception 'A worker has two payslips in the results.' using errcode = 'MLPR6';
      when check_violation or not_null_violation or invalid_text_representation
        or numeric_value_out_of_range or foreign_key_violation then
        raise exception 'A payslip breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
    end;
    v_slip_count := v_slip_count + 1;

    v_sum_earn := 0; v_sum_paye := 0; v_sum_pee := 0; v_sum_nhf := 0; v_sum_ded := 0;
    v_sum_per := 0; v_sum_nsitf := 0; v_sum_itf := 0;
    v_pos := 0;
    v_sources := '{}'::jsonb;
    for v_line in select e from jsonb_array_elements(v_slip -> 'lines') e loop
      v_pos := v_pos + 1;
      v_code := v_line ->> 'code';
      v_kind := v_line ->> 'kind';
      -- Slice 5.9a: a pre-tax clawback is negative, as a leave deduction.
      v_amount := private.payroll_kobo(
        v_line -> 'amount_kobo', v_code in ('leave_deduction', 'clawback'), 'a line''s amount'
      );
      if jsonb_typeof(v_line -> 'pensionable') <> 'boolean'
        or jsonb_typeof(v_line -> 'taxable') <> 'boolean'
        or jsonb_typeof(v_line -> 'sources') <> 'array' then
        raise exception 'A payslip line isn''t in the expected shape.' using errcode = 'MLPR6';
      end if;
      begin
        insert into public.payslip_lines (
          organisation_id, payslip_id, run_id, position, code, kind, label, amount_kobo,
          pensionable, taxable
        )
        values (
          p_organisation_id, v_slip_id, p_run_id, v_pos, v_code, v_kind, v_line ->> 'label',
          v_amount, (v_line ->> 'pensionable')::boolean, (v_line ->> 'taxable')::boolean
        );
      exception
        when check_violation or not_null_violation then
          raise exception 'A payslip line breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
      end;
      case
        when v_kind = 'earning' then v_sum_earn := v_sum_earn + v_amount;
        when v_code = 'paye' then v_sum_paye := v_sum_paye + v_amount;
        when v_code = 'pension_employee' then v_sum_pee := v_sum_pee + v_amount;
        when v_code = 'nhf' then v_sum_nhf := v_sum_nhf + v_amount;
        when v_kind = 'deduction' then v_sum_ded := v_sum_ded + v_amount;
        when v_code = 'pension_employer' then v_sum_per := v_sum_per + v_amount;
        when v_code = 'nsitf' then v_sum_nsitf := v_sum_nsitf + v_amount;
        when v_code = 'itf' then v_sum_itf := v_sum_itf + v_amount;
      end case;

      -- Slice 5.9a: a clawback line pays exactly one adjustment too.
      if v_code in ('adjustment_earning', 'deduction', 'clawback') and not (
        jsonb_array_length(v_line -> 'sources') = 1
        and v_line -> 'sources' -> 0 ->> 'kind' = 'adjustment'
      ) then
        raise exception 'An adjustment line pays exactly one adjustment.' using errcode = 'MLPR6';
      end if;
      -- Slice 5.7c: a leave refund line pays exactly one refund, and only refund lines pay one.
      if v_code = 'leave_refund' and not (
        jsonb_array_length(v_line -> 'sources') = 1
        and v_line -> 'sources' -> 0 ->> 'kind' = 'leave_refund'
      ) then
        raise exception 'A leave refund line pays exactly one refund.' using errcode = 'MLPR6';
      end if;
      if v_code <> 'leave_refund' and exists (
        select 1 from jsonb_array_elements(v_line -> 'sources') x where x ->> 'kind' = 'leave_refund'
      ) then
        raise exception 'Only a leave refund line pays a refund.' using errcode = 'MLPR6';
      end if;
      for v_src in select e from jsonb_array_elements(v_line -> 'sources') e loop
        v_src_kind := v_src ->> 'kind';
        begin
          v_src_id := (v_src ->> 'id')::uuid;
          v_from := (v_src ->> 'from')::date;
          v_to := (v_src ->> 'to')::date;
        exception when others then
          raise exception 'A payslip source isn''t in the expected shape.' using errcode = 'MLPR6';
        end;
        if v_src_id is null or v_from is null or v_to is null or v_to < v_from then
          raise exception 'A payslip source isn''t in the expected shape.' using errcode = 'MLPR6';
        end if;
        if not (case v_src_kind
          when 'timesheet_line' then v_from = v_to and exists (
            select 1 from public.timesheet_lines l
            where l.organisation_id = p_organisation_id and l.id = v_src_id
              and l.worker_id = v_worker and l.status = 'approved' and l.work_date = v_from
          )
          when 'leave_request' then exists (
            select 1 from public.leave_requests q
            where q.organisation_id = p_organisation_id and q.id = v_src_id
              and q.worker_id = v_worker and q.status = 'approved'
              and q.start_date <= v_from and q.end_date >= v_to
          )
          when 'pay_rate' then exists (
            select 1 from public.pay_rates r
            where r.organisation_id = p_organisation_id and r.id = v_src_id
              and r.worker_id = v_worker
              and r.effective_from <= v_from and (r.effective_to is null or r.effective_to >= v_to)
          )
          when 'adjustment' then exists (
            select 1 from public.payroll_adjustments a
            where a.organisation_id = p_organisation_id and a.id = v_src_id
              and a.run_id = p_run_id and a.worker_id = v_worker
          ) and v_from = v_run.period_start and v_to = v_run.period_end
          -- Slice 5.7c: leave cancelled after a posted payslip deducted these days; the refund
          -- names the deduction's exact days.
          when 'leave_refund' then exists (
            select 1 from public.leave_requests q
            where q.organisation_id = p_organisation_id and q.id = v_src_id
              and q.worker_id = v_worker and q.status = 'cancelled'
          ) and exists (
            select 1
            from public.payslip_sources o
            join public.payroll_runs orun
              on orun.organisation_id = o.organisation_id and orun.id = o.run_id
            where o.organisation_id = p_organisation_id and o.source_kind = 'leave_request'
              and o.source_id = v_src_id and o.worker_id = v_worker and o.stands
              and o.run_id <> p_run_id and orun.status in ('approved', 'released')
              and orun.kind = 'regular'
              and o.from_date = v_from and o.to_date = v_to
          )
          else false
        end) then
          raise exception 'A payslip pays a source that isn''t this worker''s to pay (%).', v_src_kind
            using errcode = 'MLPR6';
        end if;
        if v_src_kind = 'adjustment' then
          select a.* into v_adj from public.payroll_adjustments a
          where a.organisation_id = p_organisation_id and a.id = v_src_id;
          if not (
            (v_code = 'adjustment_earning' and v_adj.kind = 'earning' and v_amount = v_adj.amount_kobo)
            or (v_code = 'deduction' and v_adj.kind = 'deduction' and v_amount <= v_adj.amount_kobo)
            -- Slice 5.9a: a deduction correcting an earning of the same tax year, recovered before
            -- tax in full, with the correction's pensionable flag.
            or (v_code = 'clawback' and v_adj.kind = 'deduction'
              and v_adj.corrects_payslip_id is not null and v_amount = -v_adj.amount_kobo
              and (v_line ->> 'pensionable')::boolean = v_adj.pensionable
              and (v_line ->> 'taxable')::boolean)
          ) then
            raise exception 'A payslip line doesn''t pay its adjustment''s amount.' using errcode = 'MLPR6';
          end if;
        end if;
        -- Slice 5.7c (money review H1): keyed by kind, id and days, so one leave request can back
        -- this period's leave and an earlier period's arrears on one payslip.
        v_key := v_src_kind || ':' || v_src_id::text || ':' || v_from::text || ':' || v_to::text;
        if v_src_kind = 'adjustment' and v_sources ? v_key then
          raise exception 'An adjustment is paid on two lines.' using errcode = 'MLPR6';
        end if;
        if v_sources ? v_key then
          v_sources := jsonb_set(
            v_sources, array[v_key],
            (v_sources -> v_key)
              || jsonb_build_object(
                'positions', (v_sources -> v_key -> 'positions') || to_jsonb(v_pos),
                'off_day', (v_sources -> v_key ->> 'off_day')::boolean
                  or coalesce((v_src ->> 'off_day')::boolean, false)
              )
          );
        else
          v_sources := v_sources || jsonb_build_object(v_key, jsonb_build_object(
            'kind', v_src_kind, 'id', v_src_id, 'from', v_from, 'to', v_to,
            'off_day', coalesce((v_src ->> 'off_day')::boolean, false),
            'positions', jsonb_build_array(v_pos)
          ));
        end if;
      end loop;
    end loop;

    -- One row per source per payslip, naming every line it backs.
    for v_src in select e.value from jsonb_each(v_sources) e loop
      -- Slice 5.7c: a refund is exactly what the deduction took, never more.
      if v_src ->> 'kind' = 'leave_refund' then
        -- Line by line (money review L3): the refund's lines, in order, pay back the posted lines
        -- in order; a leave deduction's earning line with its own taxable and pensionable flags, an
        -- after-tax leave arrears line outside tax and pension.
        with mine as (
          select l.amount_kobo, l.taxable, l.pensionable,
            row_number() over (order by l.position) as n
          from public.payslip_lines l
          where l.organisation_id = p_organisation_id and l.payslip_id = v_slip_id
            and l.position in (select x::integer from jsonb_array_elements_text(v_src -> 'positions') x)
        ),
        theirs as (
          select
            case
              when ol.code = 'leave_arrears'
                then coalesce(
                  private.leave_arrears_wanted(ol.organisation_id, ol.payslip_id, ol.label),
                  ol.amount_kobo
                )
              else -ol.amount_kobo
            end as amount_kobo,
            case when ol.code = 'leave_arrears' then false else ol.taxable end as taxable,
            case when ol.code = 'leave_arrears' then false else ol.pensionable end as pensionable,
            row_number() over (order by ol.position) as n
          from public.payslip_sources o
          join public.payroll_runs orun
            on orun.organisation_id = o.organisation_id and orun.id = o.run_id
          join public.payslip_lines ol
            on ol.organisation_id = o.organisation_id and ol.payslip_id = o.payslip_id
              and ol.position = any (o.line_positions)
              and ol.code in ('leave_deduction', 'leave_arrears')
          where o.organisation_id = p_organisation_id and o.source_kind = 'leave_request'
            and o.source_id = (v_src ->> 'id')::uuid and o.worker_id = v_worker and o.stands
            and o.run_id <> p_run_id and orun.status in ('approved', 'released')
            and orun.kind = 'regular'
            and o.from_date = (v_src ->> 'from')::date and o.to_date = (v_src ->> 'to')::date
            and (case
              when ol.code = 'leave_arrears'
                then coalesce(
                  private.leave_arrears_wanted(ol.organisation_id, ol.payslip_id, ol.label),
                  ol.amount_kobo
                )
              else -ol.amount_kobo
            end) > 0
        )
        -- One statement: the CTEs above are visible to it alone.
        select coalesce((select sum(amount_kobo) from mine), 0),
               coalesce((select sum(amount_kobo) from theirs), 0),
               exists (
                 select 1 from mine m full join theirs t on t.n = m.n
                 where m.n is null or t.n is null
                   or m.amount_kobo <> t.amount_kobo
                   or m.taxable <> t.taxable or m.pensionable <> t.pensionable
               )
        into v_refund, v_owed, v_mismatch;
        if v_refund <= 0 or v_refund <> v_owed or v_mismatch then
          raise exception 'A leave refund isn''t what the leave deduction took.' using errcode = 'MLPR6';
        end if;
      end if;
      begin
        insert into public.payslip_sources (
          organisation_id, payslip_id, run_id, worker_id, source_kind, source_id, from_date,
          to_date, off_day, line_positions
        )
        values (
          p_organisation_id, v_slip_id, p_run_id, v_worker, v_src ->> 'kind',
          (v_src ->> 'id')::uuid, (v_src ->> 'from')::date, (v_src ->> 'to')::date,
          (v_src ->> 'off_day')::boolean,
          (select array_agg(x::integer order by x::integer)
           from jsonb_array_elements_text(v_src -> 'positions') x)
        );
      exception
        when exclusion_violation then
          raise exception 'A source in these results is already paid by another payslip.'
            using errcode = 'MLPRC';
        when check_violation then
          raise exception 'A payslip source breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
      end;
    end loop;

    if v_sum_earn <> v_gross or v_sum_paye <> v_paye or v_sum_pee <> v_pee or v_sum_nhf <> v_nhf
      or v_sum_ded <> v_other or v_sum_per <> v_per or v_sum_nsitf <> v_nsitf
      or v_sum_itf <> v_itf then
      raise exception 'A payslip''s lines don''t add up to its totals.' using errcode = 'MLPR6';
    end if;
  end loop;

  select
    coalesce(sum(s.gross_kobo), 0) as gross, coalesce(sum(s.paye_kobo), 0) as paye,
    coalesce(sum(s.pension_employee_kobo), 0) as pee, coalesce(sum(s.pension_employer_kobo), 0) as per,
    coalesce(sum(s.nhf_kobo), 0) as nhf, coalesce(sum(s.other_deductions_kobo), 0) as other,
    coalesce(sum(s.net_kobo), 0) as net, coalesce(sum(s.nsitf_kobo), 0) as nsitf,
    coalesce(sum(s.itf_kobo), 0) as itf, coalesce(sum(s.employer_cost_kobo), 0) as cost,
    coalesce(sum(s.carried_forward_kobo), 0) as carried, count(*)::integer as n
  into v_totals
  from public.payslips s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id;

  v_amounts := p_results -> 'totals';
  if private.payroll_kobo(v_amounts -> 'gross_kobo', false, 'total gross') <> v_totals.gross
    or private.payroll_kobo(v_amounts -> 'paye_kobo', false, 'total PAYE') <> v_totals.paye
    or private.payroll_kobo(v_amounts -> 'pension_employee_kobo', false, 'total employee pension') <> v_totals.pee
    or private.payroll_kobo(v_amounts -> 'pension_employer_kobo', false, 'total employer pension') <> v_totals.per
    or private.payroll_kobo(v_amounts -> 'nhf_kobo', false, 'total NHF') <> v_totals.nhf
    or private.payroll_kobo(v_amounts -> 'other_deductions_kobo', false, 'total other deductions') <> v_totals.other
    or private.payroll_kobo(v_amounts -> 'net_kobo', false, 'total net') <> v_totals.net
    or private.payroll_kobo(v_amounts -> 'nsitf_kobo', false, 'total NSITF') <> v_totals.nsitf
    or private.payroll_kobo(v_amounts -> 'itf_kobo', false, 'total ITF') <> v_totals.itf
    or private.payroll_kobo(v_amounts -> 'employer_cost_kobo', false, 'total employer cost') <> v_totals.cost
    or private.payroll_kobo(v_amounts -> 'carried_forward_kobo', false, 'total carried') <> v_totals.carried
    or (v_amounts ->> 'worker_count') is distinct from v_totals.n::text then
    raise exception 'The run''s totals don''t reconcile with its payslips.' using errcode = 'MLPR6';
  end if;

  for v_anomaly in select e from jsonb_array_elements(p_results -> 'anomalies') e loop
    v_detail := coalesce(v_anomaly -> 'detail', '{}'::jsonb);
    v_worker := null;
    if v_anomaly ? 'worker_id' and jsonb_typeof(v_anomaly -> 'worker_id') = 'string' then
      begin
        v_worker := (v_anomaly ->> 'worker_id')::uuid;
      exception when others then
        raise exception 'An anomaly names no worker.' using errcode = 'MLPR6';
      end;
    end if;
    v_ack_by := null;
    v_ack_at := null;
    v_severity := private.payroll_anomaly_severity(v_anomaly ->> 'code');
    if v_severity is null then
      raise exception 'An anomaly has a code payroll doesn''t know.' using errcode = 'MLPR6';
    end if;
    if v_severity = 'warning' then
      select (o ->> 'by')::uuid, (o ->> 'at')::timestamptz into v_ack_by, v_ack_at
      from jsonb_array_elements(v_old_acks) o
      where (o ->> 'worker_id') is not distinct from v_worker::text
        and o ->> 'code' = v_anomaly ->> 'code'
        and o -> 'detail' = v_detail
      limit 1;
    end if;
    begin
      insert into public.payroll_anomalies (
        organisation_id, run_id, worker_id, code, severity, detail, acknowledged_by,
        acknowledged_at
      )
      values (
        p_organisation_id, p_run_id, v_worker, v_anomaly ->> 'code', v_severity,
        v_detail, v_ack_by, v_ack_at
      );
    exception
      when check_violation or not_null_violation or foreign_key_violation then
        raise exception 'An anomaly breaks a payroll rule (%).', sqlerrm using errcode = 'MLPR6';
    end;
    v_anomaly_count := v_anomaly_count + 1;
  end loop;

  -- Every adjustment of the run is paid on its worker's payslip, unless the engine refused that
  -- worker (no payslip and a blocking anomaly naming them): the run can't be submitted then.
  if exists (
    select 1 from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
      and not exists (
        select 1 from public.payslip_sources s
        where s.organisation_id = p_organisation_id and s.run_id = p_run_id
          and s.source_kind = 'adjustment' and s.source_id = a.id and s.worker_id = a.worker_id
      )
      and not (
        not exists (
          select 1 from public.payslips p
          where p.organisation_id = p_organisation_id and p.run_id = p_run_id
            and p.worker_id = a.worker_id
        )
        and exists (
          select 1 from public.payroll_anomalies x
          where x.organisation_id = p_organisation_id and x.run_id = p_run_id
            and x.worker_id = a.worker_id and x.severity = 'blocking'
        )
      )
  ) then
    raise exception 'An adjustment of this run isn''t on its worker''s payslip.' using errcode = 'MLPR6';
  end if;

  update public.payroll_runs r
  set gross_kobo = v_totals.gross, paye_kobo = v_totals.paye,
      pension_employee_kobo = v_totals.pee, pension_employer_kobo = v_totals.per,
      nhf_kobo = v_totals.nhf, other_deductions_kobo = v_totals.other, net_kobo = v_totals.net,
      nsitf_kobo = v_totals.nsitf, itf_kobo = v_totals.itf, employer_cost_kobo = v_totals.cost,
      carried_forward_kobo = v_totals.carried, worker_count = v_totals.n,
      itf_applies = (p_results ->> 'itf_applies')::boolean,
      inputs_sha256 = p_inputs_sha256,
      needs_recalculation = false,
      calculated_at = now(),
      calculated_by = p_actor
  where r.id = p_run_id;

  v_text := 'payroll.results_saved';
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after)
  values (
    p_organisation_id, p_actor, v_text, 'payroll_runs', p_run_id, v_before,
    jsonb_build_object(
      'gross_kobo', v_totals.gross::text, 'net_kobo', v_totals.net::text,
      'paye_kobo', v_totals.paye::text, 'employer_cost_kobo', v_totals.cost::text,
      'worker_count', v_totals.n, 'anomalies', v_anomaly_count,
      'inputs_sha256', p_inputs_sha256
    )
  );

  return jsonb_build_object(
    'payslips', v_slip_count,
    'anomalies', v_anomaly_count,
    'gross_kobo', v_totals.gross::text,
    'net_kobo', v_totals.net::text
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Approval: the tax year's checks
-- ---------------------------------------------------------------------------

-- 5.8's approve_payroll_run (migration 20261122210000, its latest version), with its
-- month-aggregate block replaced by the tax year's (marked "Slice 5.9a"); everything else is
-- as it was. The grants stand.
create or replace function private.approve_payroll_run(p_organisation_id uuid, p_run_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payroll_approver(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_check public.payroll_approval_checks%rowtype;
  v_blocking integer;
  v_open integer;
  v_acked integer;
  v_totals record;
  v_id uuid;
  v_worker uuid;
  v_month_start date;
  v_month_end date;
  v_year_start date;
  v_year_end date;
begin
  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'review' then
    raise exception 'Only a run waiting for approval is approved.' using errcode = 'MLPRD';
  end if;
  if v_uid = any (private.payroll_run_touchers(p_organisation_id, p_run_id)) then
    raise exception 'You prepared or changed this run, so a different person must approve it.'
      using errcode = 'MLPRE';
  end if;
  if v_run.needs_recalculation or v_run.calculated_at is null or v_run.inputs_sha256 is null then
    raise exception 'The run needs recalculating. Return it to HR.' using errcode = 'MLPRD';
  end if;

  -- Decision 7: the approver's own server check, after the latest submission, read in the last
  -- 2 minutes, must have found the inputs the run was worked out from.
  select c.* into v_check
  from public.payroll_approval_checks c
  where c.organisation_id = p_organisation_id and c.run_id = p_run_id and c.actor_id = v_uid
    and c.created_at >= v_run.submitted_at
  order by c.created_at desc, c.id desc
  limit 1;
  if v_check.id is null or v_check.read_started_at < now() - interval '2 minutes' then
    raise exception 'The run''s inputs must be checked again just before approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  if not v_check.matches or v_check.inputs_sha256 <> v_run.inputs_sha256 then
    raise exception 'Something this run was worked out from has changed since (a timesheet day, a pay rate, leave or bank details). Return it to HR to recalculate.'
      using errcode = 'MLPRF';
  end if;

  -- Money review M1: the server's read and this approval are separate transactions, so hold what
  -- the run pays still (the workers' leave locks, as 4.4 takes them, in a fixed order; FOR SHARE on
  -- the paid timesheet days, leave and pay versions, so a reopen, dispute, cancellation or pay
  -- change waits for this transaction), refuse if a paid source isn't approved or there any more,
  -- and refuse if anything in the run's scope was written after the read began.
  for v_worker in
    select distinct s.worker_id from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    order by s.worker_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_worker::text, 0));
  end loop;

  -- Slice 5.9a: cumulative year-to-date PAYE (tax adviser) reads every standing payslip of the
  -- worker in the tax year (the calendar year of the pay date), the opening balance in force and
  -- the verified reliefs; it replaces 5.7b's month aggregate, so 5.8's month lock becomes a tax
  -- year lock. Approvals take one lock per (company, worker, tax year), in worker order, after
  -- the leave locks; writers of a worker's opening balance or reliefs take the same lock (one
  -- each, so no cycle). Then this approval is refused if another run's payslip for one of its
  -- workers in the year was approved after the read began, or if the year's standing payslips,
  -- the opening balance in force or the verified reliefs aren't the ones each payslip's PAYE
  -- counted (its trace's year_to_date step, by the server's rule: with an opening balance, only
  -- payslips paid after its as-of month count). That also covers a write whose transaction began
  -- before the read and committed after it, which a timestamp can't show.
  v_year_start := date_trunc('year', v_run.pay_date)::date;
  v_year_end := (v_year_start + interval '1 year')::date;
  for v_worker in
    select distinct s.worker_id from public.payslips s
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    order by s.worker_id
  loop
    perform private.payroll_year_lock(
      p_organisation_id, v_worker, extract(year from v_run.pay_date)::integer
    );
  end loop;
  if exists (
    select 1
    from public.payslips o
    join public.payroll_runs x on x.organisation_id = o.organisation_id and x.id = o.run_id
    where o.organisation_id = p_organisation_id and o.run_id <> p_run_id
      and o.worker_id in (
        select s.worker_id from public.payslips s
        where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      )
      and x.kind <> 'reversal' and x.status in ('approved', 'released')
      and x.pay_date >= v_year_start and x.pay_date < v_year_end
      and x.approved_at > v_check.read_started_at
  ) or exists (
    with mine as (
      select s.worker_id,
        (
          select st from jsonb_array_elements(
            case when jsonb_typeof(s.trace -> 'steps') = 'array' then s.trace -> 'steps'
              else '[]'::jsonb end
          ) st
          where st ->> 'step' = 'year_to_date'
          limit 1
        ) as ytd
      from public.payslips s
      where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    )
    select 1
    from mine m
    left join lateral (
      select b.id, b.as_of_month
      from private.payroll_opening_in_force(
        p_organisation_id, m.worker_id, extract(year from v_run.pay_date)::integer
      ) b
      where b.id is not null
    ) ob on true
    -- Only payslips the bands ran on (an exempt daily worker's under NTA 2025 v1 has no step).
    where m.ytd is not null and (
      coalesce(m.ytd -> 'inputs' ->> 'opening_balance_id', '') <> coalesce(ob.id::text, '')
      or coalesce(m.ytd -> 'inputs' ->> 'relief_ids', '')
        <> private.payroll_verified_relief_ids(
          p_organisation_id, m.worker_id, extract(year from v_run.pay_date)::integer
        )
      or (case when (m.ytd -> 'inputs' ->> 'payslips') ~ '^[0-9]{1,4}$'
          then (m.ytd -> 'inputs' ->> 'payslips')::integer else -1 end)
        <> (
          select count(*)::integer
          from public.payslips o
          join public.payroll_runs x on x.organisation_id = o.organisation_id and x.id = o.run_id
          where o.organisation_id = p_organisation_id and o.worker_id = m.worker_id
            and o.run_id <> p_run_id
            and x.kind <> 'reversal' and x.status in ('approved', 'released')
            and x.pay_date >= v_year_start and x.pay_date < v_year_end
            and (ob.as_of_month is null
              or x.pay_date >= (ob.as_of_month + interval '1 month')::date)
            -- A daily worker's payslip under a rule set that exempted them isn't in the year (the
            -- server's rule: a later rule set never taxes months a dated rule exempted).
            and not (o.employment_type = 'daily' and exists (
              select 1 from public.tax_rule_sets t
              where t.organisation_id = x.organisation_id and t.id = x.rule_set_id
                and t.rules ->> 'daily_workers_exempt' = 'true'
            ))
        )
    )
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  perform 1
  from public.pay_rates r
  join public.payslip_sources s
    on s.organisation_id = r.organisation_id and s.source_id = r.id
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    and s.source_kind = 'pay_rate'
  for share of r;
  perform 1
  from public.timesheet_lines l
  join public.payslip_sources s
    on s.organisation_id = l.organisation_id and s.source_id = l.id
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    and s.source_kind = 'timesheet_line'
  for share of l;
  perform 1
  from public.leave_requests q
  join public.payslip_sources s
    on s.organisation_id = q.organisation_id and s.source_id = q.id
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id
    and s.source_kind = 'leave_request'
  for share of q;
  if exists (
    select 1
    from public.payslip_sources s
    left join public.timesheet_lines l
      on s.source_kind = 'timesheet_line' and l.organisation_id = s.organisation_id
        and l.id = s.source_id
    left join public.leave_requests q
      on s.source_kind = 'leave_request' and q.organisation_id = s.organisation_id
        and q.id = s.source_id
    left join public.pay_rates r
      on s.source_kind = 'pay_rate' and r.organisation_id = s.organisation_id
        and r.id = s.source_id
    where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      and (
        (s.source_kind = 'timesheet_line' and l.status is distinct from 'approved')
        or (s.source_kind = 'leave_request' and q.status is distinct from 'approved')
        or (s.source_kind = 'pay_rate' and (
          r.id is null or r.worker_id <> s.worker_id
          or r.effective_from > s.from_date
          or (r.effective_to is not null and r.effective_to < s.to_date)
          or greatest(r.created_at, r.updated_at) > v_check.read_started_at
        ))
      )
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;
  if exists (
    with scope as (
      select s.worker_id from public.payslips s
      where s.organisation_id = p_organisation_id and s.run_id = p_run_id
      union
      select a.worker_id from public.payroll_adjustments a
      where a.organisation_id = p_organisation_id and a.run_id = p_run_id
    )
    select 1
    from public.timesheet_decisions d
    join public.timesheet_lines l
      on l.organisation_id = d.organisation_id and l.id = d.line_id
    where d.organisation_id = p_organisation_id
      and d.worker_id in (select worker_id from scope)
      and l.work_date between v_run.period_start - 400 and v_run.period_end
      and d.created_at > v_check.read_started_at
    union all
    select 1
    from public.leave_decisions d
    join public.leave_requests q on q.organisation_id = d.organisation_id and q.id = d.request_id
    where d.organisation_id = p_organisation_id
      and d.worker_id in (select worker_id from scope)
      and q.start_date <= v_run.period_end and q.end_date >= v_run.period_start
      and d.created_at > v_check.read_started_at
    union all
    select 1
    from public.pay_rates r
    where r.organisation_id = p_organisation_id
      and r.worker_id in (select worker_id from scope)
      and greatest(r.created_at, r.updated_at) > v_check.read_started_at
    union all
    select 1
    from public.payroll_adjustments a
    where a.organisation_id = p_organisation_id and a.run_id = p_run_id
      and a.created_at > v_check.read_started_at
  ) then
    raise exception 'Something changed while you were approving. Try again.'
      using errcode = 'MLPRF';
  end if;

  select count(*) filter (where a.severity = 'blocking'),
         count(*) filter (where a.severity = 'warning' and a.acknowledged_at is null),
         count(*) filter (where a.acknowledged_at is not null)
  into v_blocking, v_open, v_acked
  from public.payroll_anomalies a
  where a.organisation_id = p_organisation_id and a.run_id = p_run_id;
  if v_blocking > 0 or v_open > 0 then
    raise exception 'Anomalies on this run block it or aren''t acknowledged. Return it to HR.'
      using errcode = 'MLPR4';
  end if;

  select
    coalesce(sum(s.gross_kobo), 0) as gross, coalesce(sum(s.paye_kobo), 0) as paye,
    coalesce(sum(s.pension_employee_kobo), 0) as pee, coalesce(sum(s.pension_employer_kobo), 0) as per,
    coalesce(sum(s.nhf_kobo), 0) as nhf, coalesce(sum(s.other_deductions_kobo), 0) as other,
    coalesce(sum(s.net_kobo), 0) as net, coalesce(sum(s.nsitf_kobo), 0) as nsitf,
    coalesce(sum(s.itf_kobo), 0) as itf, coalesce(sum(s.employer_cost_kobo), 0) as cost,
    coalesce(sum(s.carried_forward_kobo), 0) as carried, count(*)::integer as n
  into v_totals
  from public.payslips s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id;
  if v_totals.n = 0
    or (v_totals.gross, v_totals.paye, v_totals.pee, v_totals.per, v_totals.nhf, v_totals.other,
        v_totals.net, v_totals.nsitf, v_totals.itf, v_totals.cost, v_totals.carried, v_totals.n)
    is distinct from
       (v_run.gross_kobo, v_run.paye_kobo, v_run.pension_employee_kobo, v_run.pension_employer_kobo,
        v_run.nhf_kobo, v_run.other_deductions_kobo, v_run.net_kobo, v_run.nsitf_kobo,
        v_run.itf_kobo, v_run.employer_cost_kobo, v_run.carried_forward_kobo, v_run.worker_count) then
    raise exception 'The run''s totals don''t reconcile with its payslips.' using errcode = 'MLPR6';
  end if;

  update public.payroll_runs r
  set status = 'approved', approved_at = now(), approved_by = v_uid
  where r.id = p_run_id;
  insert into public.payroll_run_decisions (
    organisation_id, run_id, decision, actor_id, inputs_sha256, gross_kobo, net_kobo, worker_count
  )
  values (
    p_organisation_id, p_run_id, 'approved', v_uid, v_run.inputs_sha256, v_run.gross_kobo,
    v_run.net_kobo, v_run.worker_count
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.run_approved', 'payroll_runs', p_run_id, null,
    jsonb_build_object(
      'decision_id', v_id, 'check_id', v_check.id, 'inputs_sha256', v_run.inputs_sha256,
      'gross_kobo', v_run.gross_kobo::text, 'net_kobo', v_run.net_kobo::text,
      'worker_count', v_run.worker_count, 'anomalies_acknowledged', v_acked,
      'period_start', v_run.period_start, 'period_end', v_run.period_end
    ),
    null
  );
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Anomaly severities
-- ---------------------------------------------------------------------------

-- 5.8's private.payroll_anomaly_severity (its latest version), with four warnings added.
create or replace function private.payroll_anomaly_severity(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_code in (
      'no_pay_rate', 'no_rostered_days', 'no_tax_state', 'calculation_failed',
      'previous_not_posted'
    ) then 'blocking'
    when p_code in (
      'roster_pattern_unknown', 'leave_pay_missing', 'open_timesheet_days', 'no_show_days',
      'bank_missing', 'bank_in_hold', 'bank_not_checked', 'bank_unreadable', 'bank_shared',
      'bank_shared_unchecked', 'first_pay', 'final_pay', 'net_change', 'deduction_cut',
      'no_pension_details', 'recurring_not_carried', 'on_off_cycle_run',
      'leave_correction_pending', 'carry_settled_later', 'refund_uncollected_carry',
      'deduction_capped', 'paye_overwithheld', 'nhf_not_deducted', 'rent_relief_unverified'
    ) then 'warning'
  end
$$;
