-- Slice 0.4: identity hardening (review of PR #8).
--
-- 1. Names are plain text whatever the entry point. Company and full names reach emails sent
--    from Metalira's domain, and user_metadata can be written by anyone holding the publishable
--    key, so the database refuses control characters, < and >, and web addresses in
--    organisations.name and profiles.full_name. The app checks the same rules first
--    (src/server/identity/names.ts).
-- 2. private.create_first_organisation_impl: the sign-up step that creates the owner's first
--    organisation, made atomic per user with an advisory lock, so two confirmed sign-ins racing
--    (the email link and a password sign-in, or two tabs) create one organisation, not two.
-- 3. private.audit_redact also drops plain-text personal data keys (nin, bvn, rsa_pin,
--    account_number, ...) and credentials, mirroring src/server/identity/audit.ts (rule 9).

-- ---------------------------------------------------------------------------
-- 1. Plain-text names
-- ---------------------------------------------------------------------------
-- The same two tests appear below in plain SQL rather than through a helper function, so the
-- check constraints need no extra function grants for the roles that write these tables.
--   no control characters (C0, DEL, C1), no < or >:  value !~ '[\x01-\x1f\x7f-\x9f<>]'
--   no web address:                                  value !~* '(://|www\.)'

alter table public.organisations
  add constraint organisations_name_plain_text
  check (name !~ '[\x01-\x1f\x7f-\x9f<>]' and name !~* '(://|www\.)');

alter table public.profiles
  add constraint profiles_full_name_plain_text
  check (full_name !~ '[\x01-\x1f\x7f-\x9f<>]' and full_name !~* '(://|www\.)');

-- AFTER INSERT on auth.users: one profile per login, full name from sign-up metadata. A name
-- that is not plain text is dropped (the profile keeps no name) rather than failing the
-- sign-up, which would tell the caller nothing useful.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 200), '');
begin
  if v_name is not null and (v_name ~ '[\x01-\x1f\x7f-\x9f<>]' or v_name ~* '(://|www\.)') then
    v_name := null;
  end if;

  insert into public.profiles (user_id, full_name)
  values (new.id, v_name)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Creates an organisation and the caller's owner membership atomically. The audit triggers log
-- both rows with the caller as actor.
create or replace function private.create_organisation_impl(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_name text := btrim(p_name);
  org_id uuid;
begin
  if uid is null then
    raise exception 'sign in to create an organisation' using errcode = '42501';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 200 then
    raise exception 'organisation name must be 1 to 200 characters' using errcode = '22023';
  end if;
  if v_name ~ '[\x01-\x1f\x7f-\x9f<>]' or v_name ~* '(://|www\.)' then
    raise exception 'organisation name must be plain text, without < or > or a web address'
      using errcode = '22023';
  end if;

  insert into public.organisations (name, created_by)
  values (v_name, uid)
  returning id into org_id;

  insert into public.memberships (organisation_id, user_id, role, created_by)
  values (org_id, uid, 'owner', uid);

  return org_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. First organisation at sign-up, once per user
-- ---------------------------------------------------------------------------
-- Creates the caller's organisation only when the caller belongs to none yet, and returns its
-- id; returns null when the caller already has a membership. The transaction-scoped advisory
-- lock on the caller's id serialises concurrent calls: the second waits for the first to
-- commit, then sees its membership and returns null.
create function private.create_first_organisation_impl(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in to create an organisation' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_first_organisation:' || uid::text, 0));

  if exists (select 1 from public.memberships m where m.user_id = uid) then
    return null;
  end if;

  return private.create_organisation_impl(p_name);
end;
$$;

create function public.create_first_organisation(p_name text)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.create_first_organisation_impl(p_name)
$$;

revoke all on function private.create_first_organisation_impl(text) from public, anon;
grant execute on function private.create_first_organisation_impl(text) to authenticated;
revoke all on function public.create_first_organisation(text) from public, anon;
grant execute on function public.create_first_organisation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Audit redaction
-- ---------------------------------------------------------------------------
-- True when a JSON key must never reach audit_log. The key is normalised first (camelCase to
-- snake_case, other separators to `_`, lower case), then matched against:
--   * anywhere: `password`, `secret`, and the `_enc` suffix of column-encrypted personal data;
--   * whole `_`-separated parts: personal data in plain text (nin, bvn, rsa_pin, pin,
--     account_number, account_no, bank_account, nuban) and credentials (passwd, passcode,
--     token, token_hash, pin_hash, api_key, apikey, otp).
-- Keep in step with isAuditSecretKey in src/server/identity/audit.ts.
create function private.audit_secret_key(k text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with n as (
    select lower(
      regexp_replace(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'), '[^a-zA-Z0-9]+', '_', 'g')
    ) as key
  )
  select n.key ~ '(_enc$|password|secret)'
    or n.key ~ '(^|_)(nin|bvn|pin|pin_hash|rsa_pin|passwd|passcode|token|token_hash|api_key|apikey|account_number|account_no|bank_account|nuban|otp)(_|$)'
  from n
$$;

revoke all on function private.audit_secret_key(text) from public, anon, authenticated;

-- Removes secrets and personal data from a JSON document before it reaches audit_log, at any
-- depth (private.audit_secret_key decides which keys).
create or replace function private.audit_redact(doc jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  result jsonb;
  k text;
  v jsonb;
begin
  if doc is null then
    return null;
  end if;

  case jsonb_typeof(doc)
    when 'object' then
      result := '{}'::jsonb;
      for k, v in select e.key, e.value from jsonb_each(doc) as e loop
        if private.audit_secret_key(k) then
          continue;
        end if;
        result := result || jsonb_build_object(k, private.audit_redact(v));
      end loop;
      return result;
    when 'array' then
      return coalesce(
        (
          select jsonb_agg(private.audit_redact(t.elem) order by t.ord)
          from jsonb_array_elements(doc) with ordinality as t (elem, ord)
        ),
        '[]'::jsonb
      );
    else
      return doc;
  end case;
end;
$$;
