-- Slice U.2: bulk actions on the other lists (owner-requested UX work, 25 Nov 2026).
--
-- 1. public.bulk_approve_leave(org, request_ids, dry_run): approves the selected leave requests,
--    each at the step the caller may decide (the line manager's step 1, HR's step 2), through the
--    single decisions themselves (private.decide_leave_line_manager and private.decide_leave_hr,
--    their latest versions, 5.7c's), so every request passes exactly the checks a single approval
--    does: never your own, the line manager and supervisor scope, the balance, the certificate
--    and the working-day count. Not all or nothing: a request that would fail, or that needs a
--    look first, is SKIPPED with a code and a reason, and the rest are approved:
--      own                you can't decide your own leave
--      not_yours          not a step the caller decides (scope), no name unless the caller reads it
--      decided            not waiting for a decision
--      certificate        step 2 of a type that needs a certificate nobody has ticked as seen
--      recount            the working days changed since the request (approving would change it)
--      pay_below_service  paid leave the worker's service doesn't yet pay (the single screen flags it)
--      refused            the single decision refused it (its own message, e.g. the balance)
--    Each approval writes the single decision's own rows and audit row; the batch adds one
--    `leave.bulk_approved` row with the counts. p_dry_run works everything out, then rolls it all
--    back (the preview), so the preview and the confirm agree.
-- 2. public.bulk_resend_worker_invites(org, worker_ids, dry_run): emails a fresh invite to each
--    selected worker whose last invite wasn't used, through the single invite
--    (private.create_worker_invites_impl: the open invite is revoked, a new one made; owner,
--    admin or hr). Each email is claimed first under the shared email caps
--    (private.claim_manager_email, kind worker_invite_resend: 30 a company and 80 overall a
--    day); past a cap the worker is skipped, keeps their open invite and is listed. Skipped too:
--    left, no email address, never invited, already signed up. The raw tokens are returned once
--    for the server to email (they exist nowhere else). One `worker_invite.resent` audit row per
--    invite and one `worker_invites.bulk_resent` for the batch (the row triggers also log each
--    invite row).
-- 3. public.bulk_cancel_worker_invites(org, worker_ids, dry_run): revokes each selected worker's
--    open invite, so its link stops working (owner, admin or hr, as the invite itself). Skipped:
--    no open invite, or it already expired. One `worker_invite.cancelled` row per invite and one
--    `worker_invites.bulk_cancelled` for the batch.
-- Timesheets reuse 4.3's public.approve_clean_timesheet_lines (the same skip-not-fail model,
-- dry run and 500 cap), so no function is added for them here.
--
-- Every function: definer with an empty search_path, behind a public invoker wrapper; a trusted
-- session (private.session_uid()) with a role in the organisation the server passes from the
-- verified session, else 42501; only that organisation's rows. No table is added, so no policy.
--
-- Refusals: 42501 role or untrusted session; MLLB1 nothing selected, or more than 500;
-- MLLB2 an id selected isn't in this company (the whole batch is refused and nothing changes).
-- MLLB3 is the server's "the list changed since the preview" (no SQL raises it). MLLBP is the
-- dry run's internal rollback and never leaves a function.

-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------

-- The distinct, non-null ids of a selection, refused when empty or above 500.
create function private.list_bulk_ids(p_ids uuid[])
returns uuid[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(distinct x.id order by x.id), '{}')
  into v_ids
  from unnest(coalesce(p_ids, '{}')) as x (id)
  where x.id is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'Select at least one row.' using errcode = 'MLLB1';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'Select 500 or fewer at a time.' using errcode = 'MLLB1';
  end if;
  return v_ids;
end;
$$;

revoke all on function private.list_bulk_ids(uuid[]) from public, anon, authenticated;

-- The caller may invite workers here: a trusted session with owner, admin or hr (the single
-- create_worker_invites' roles).
create function private.list_bulk_assert_inviter(p_organisation_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(p_organisation_id, array['owner', 'admin', 'hr']) then
    raise exception 'Only the owner, an admin or HR can invite workers.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.list_bulk_assert_inviter(uuid) from public, anon, authenticated;

-- Refuses (MLLB2) unless every id is a worker of this company.
create function private.list_bulk_assert_workers(p_organisation_id uuid, p_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_missing integer;
begin
  select count(*) into v_missing
  from unnest(p_ids) as x (id)
  where not exists (
    select 1 from public.workers w
    where w.organisation_id = p_organisation_id and w.id = x.id
  );
  if v_missing > 0 then
    raise exception 'Nothing was changed: % of the employees selected aren''t in this company.', v_missing
      using errcode = 'MLLB2';
  end if;
end;
$$;

revoke all on function private.list_bulk_assert_workers(uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Bulk approve leave
-- ---------------------------------------------------------------------------

create function private.bulk_approve_leave(
  p_organisation_id uuid,
  p_request_ids uuid[],
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_missing integer;
  v_reader boolean;
  v_row record;
  v_code text;
  v_reason text;
  v_step text;
  v_result jsonb;
  v_count integer;
  v_version public.leave_entitlements%rowtype;
  v_state text;
  v_message text;
  v_approved jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_out jsonb;
begin
  if private.session_uid() is null or p_organisation_id is null
    or not private.has_role(
      p_organisation_id, array['owner', 'admin', 'hr', 'ops_manager', 'line_manager']
    ) then
    raise exception 'Your role can''t decide leave.' using errcode = '42501';
  end if;
  v_ids := private.list_bulk_ids(p_request_ids);

  select count(*) into v_missing
  from unnest(v_ids) as x (id)
  where not exists (
    select 1 from public.leave_requests r
    where r.organisation_id = p_organisation_id and r.id = x.id
  );
  if v_missing > 0 then
    raise exception 'Nothing was approved: % of the requests selected aren''t in this company.', v_missing
      using errcode = 'MLLB2';
  end if;

  -- Who may read every request's name (the leave list's own rule); a line manager reads only
  -- their reportees', so a request outside their scope is skipped without its name.
  v_reader := private.has_role(p_organisation_id, array['owner', 'admin', 'hr', 'ops_manager']);

  begin
    for v_row in
      select r.id, r.worker_id, r.status, r.days, r.start_date, r.end_date, r.certificate_seen,
        t.id as type_id, t.name as type_name, t.counting, t.needs_certificate, t.paid,
        nullif(btrim(concat_ws(' ', w.first_name, w.last_name)), '') as worker_name,
        w.staff_id, w.start_date as worker_start
      from unnest(v_ids) as x (id)
      join public.leave_requests r on r.organisation_id = p_organisation_id and r.id = x.id
      join public.leave_types t on t.id = r.leave_type_id
      join public.workers w on w.organisation_id = r.organisation_id and w.id = r.worker_id
      order by r.start_date, worker_name, r.id
    loop
      v_code := null;
      v_reason := null;
      v_step := null;

      if v_row.worker_id in (select private.my_worker_ids()) then
        v_code := 'own';
      elsif v_row.status = 'pending_line_manager' then
        v_step := 'line_manager';
        if not private.leave_can_decide_step1(p_organisation_id, v_row.worker_id) then
          v_code := 'not_yours';
        end if;
      elsif v_row.status = 'pending_hr' then
        v_step := 'hr';
        if not private.leave_can_decide_step2(p_organisation_id, v_row.worker_id) then
          v_code := 'not_yours';
        elsif v_row.needs_certificate and not v_row.certificate_seen then
          v_code := 'certificate';
        end if;
      else
        v_code := 'decided';
      end if;

      -- Needs a look first: the working days changed, or paid leave the service doesn't pay.
      if v_code is null then
        select c.days into v_count
        from private.leave_count_days(
          p_organisation_id, v_row.worker_id, v_row.counting, v_row.start_date, v_row.end_date
        ) c;
        if coalesce(v_count, 0) <> v_row.days then
          v_code := 'recount';
          v_reason := format('Now %s working days; the request says %s.', coalesce(v_count, 0), v_row.days);
        end if;
      end if;
      if v_code is null and v_step = 'hr' and v_row.paid then
        v_version := private.leave_version_on(v_row.type_id, v_row.start_date);
        if v_version.pay_min_service_months is not null
          and private.leave_service_months(v_row.worker_start, v_row.start_date)
            < v_version.pay_min_service_months then
          v_code := 'pay_below_service';
        end if;
      end if;

      if v_code is null then
        begin
          if v_step = 'line_manager' then
            v_result := private.decide_leave_line_manager(
              p_organisation_id, v_row.id, 'approved', null, false
            );
          else
            v_result := private.decide_leave_hr(
              p_organisation_id, v_row.id, 'approved', null, false, false
            );
          end if;
        exception when others then
          get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
          v_code := 'refused';
          -- The single decisions' own refusals are plain English; anything else gets a fixed text.
          v_reason := case
            when v_state in ('MLLQ2', 'MLLQ4', 'MLLQ6', 'MLLQ7', 'MLTA5', '22023', '42501', 'P0002')
              then v_message
            else 'This request couldn''t be approved here. Open it to decide.'
          end;
        end;
      end if;

      if v_code is not null then
        v_skipped := v_skipped || jsonb_build_object(
          'id', v_row.id,
          'code', v_code,
          'reason', v_reason,
          'worker_name', case when v_code = 'not_yours' and not v_reader then null else v_row.worker_name end,
          'staff_id', case when v_code = 'not_yours' and not v_reader then null else v_row.staff_id end,
          'leave_type', v_row.type_name,
          'start_date', v_row.start_date,
          'end_date', v_row.end_date
        );
        continue;
      end if;

      v_approved := v_approved || jsonb_build_object(
        'id', v_row.id,
        'worker_id', v_row.worker_id,
        'worker_name', v_row.worker_name,
        'staff_id', v_row.staff_id,
        'leave_type', v_row.type_name,
        'start_date', v_row.start_date,
        'end_date', v_row.end_date,
        'step', v_step,
        'status', v_result ->> 'status',
        'days', coalesce((v_result ->> 'days')::integer, v_row.days),
        'balance_after', case when v_step = 'hr' then (v_result ->> 'balance_after')::integer end,
        'opened_shifts', case
          when v_step = 'hr' then coalesce(jsonb_array_length(v_result -> 'open_shifts'), 0)
          else 0
        end
      );
    end loop;

    if not coalesce(p_dry_run, false) and jsonb_array_length(v_approved) > 0 then
      perform private.log_audit_impl(
        p_organisation_id, 'leave.bulk_approved', 'leave_requests', null, null,
        jsonb_build_object(
          'approved', jsonb_array_length(v_approved),
          'skipped', jsonb_array_length(v_skipped),
          'request_ids', (select coalesce(jsonb_agg(a -> 'id'), '[]'::jsonb)
                          from jsonb_array_elements(v_approved) a)
        ),
        null
      );
    end if;
    v_out := jsonb_build_object(
      'dry_run', coalesce(p_dry_run, false), 'approved', v_approved, 'skipped', v_skipped
    );
    if coalesce(p_dry_run, false) then
      -- The preview: undo every write in this block (variables keep their values).
      raise exception 'preview' using errcode = 'MLLBP';
    end if;
  exception when sqlstate 'MLLBP' then
    null;
  end;
  return v_out;
end;
$$;

revoke all on function private.bulk_approve_leave(uuid, uuid[], boolean) from public, anon;
grant execute on function private.bulk_approve_leave(uuid, uuid[], boolean) to authenticated;

create function public.bulk_approve_leave(
  p_organisation_id uuid,
  p_request_ids uuid[],
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.bulk_approve_leave(p_organisation_id, p_request_ids, p_dry_run) $$;

revoke all on function public.bulk_approve_leave(uuid, uuid[], boolean) from public, anon;
grant execute on function public.bulk_approve_leave(uuid, uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Bulk resend worker invites
-- ---------------------------------------------------------------------------

create function private.bulk_resend_worker_invites(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_dry_run boolean default false,
  p_org_cap integer default 30,
  p_global_cap integer default 80
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_row record;
  v_code text;
  v_invite record;
  v_sent jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_out jsonb;
begin
  perform private.list_bulk_assert_inviter(p_organisation_id);
  -- The shared caps (src/lib/inbox.ts INBOX_EMAIL_CAPS) may be passed lower, never higher.
  if p_org_cap is null or p_org_cap not between 0 and 30
    or p_global_cap is null or p_global_cap not between 0 and 80 then
    raise exception 'Caps must be within the shared email caps.' using errcode = '22023';
  end if;
  v_ids := private.list_bulk_ids(p_worker_ids);
  perform private.list_bulk_assert_workers(p_organisation_id, v_ids);

  begin
    for v_row in
      select w.id, w.status, w.email, w.staff_id,
        nullif(btrim(concat_ws(' ', w.first_name, w.last_name)), '') as worker_name,
        (
          select i.used_at is not null
          from public.worker_invites i
          where i.organisation_id = p_organisation_id and i.worker_id = w.id
          order by i.created_at desc, i.id desc
          limit 1
        ) as last_used
      from public.workers w
      where w.organisation_id = p_organisation_id and w.id = any (v_ids)
      order by w.last_name, w.first_name, w.staff_id, w.id
      for update of w
    loop
      v_code := case
        when v_row.status <> 'active' then 'left'
        when v_row.email is null then 'no_email'
        when v_row.last_used is null then 'not_invited'
        when v_row.last_used then 'signed_up'
      end;
      -- One email under the shared caps, claimed before the invite is made (and only for a
      -- worker who passed the checks above): past a cap the worker keeps their open invite and is
      -- listed. Nested, since SQL doesn't promise to skip the claim after a false AND.
      if v_code is null then
        if not private.claim_manager_email(
          p_organisation_id, 'worker_invite_resend', gen_random_uuid(), 1, p_org_cap, p_global_cap
        ) then
          v_code := 'cap';
        end if;
      end if;
      if v_code is not null then
        v_skipped := v_skipped || jsonb_build_object(
          'worker_id', v_row.id, 'name', v_row.worker_name, 'staff_id', v_row.staff_id,
          'code', v_code
        );
        continue;
      end if;

      -- The single invite, unchanged: revokes the open one and makes a new one by email.
      select c.* into v_invite
      from private.create_worker_invites_impl(p_organisation_id, array[v_row.id], 'email') c;
      perform private.log_audit_impl(
        p_organisation_id, 'worker_invite.resent', 'worker_invites', v_invite.invite_id, null,
        jsonb_build_object('worker_id', v_row.id, 'sent_via', 'email', 'bulk', true),
        null
      );
      v_sent := v_sent || jsonb_build_object(
        'worker_id', v_row.id, 'name', v_row.worker_name, 'staff_id', v_row.staff_id,
        'invite_id', v_invite.invite_id, 'expires_at', v_invite.invite_expires_at,
        -- The raw token, once, for the server to email; never stored or logged.
        'token', case when coalesce(p_dry_run, false) then null else v_invite.token end
      );
    end loop;

    if not coalesce(p_dry_run, false) then
      perform private.log_audit_impl(
        p_organisation_id, 'worker_invites.bulk_resent', 'worker_invites', null, null,
        jsonb_build_object(
          'resent', jsonb_array_length(v_sent), 'skipped', jsonb_array_length(v_skipped)
        ),
        null
      );
    end if;
    v_out := jsonb_build_object(
      'dry_run', coalesce(p_dry_run, false), 'sent', v_sent, 'skipped', v_skipped
    );
    if coalesce(p_dry_run, false) then
      raise exception 'preview' using errcode = 'MLLBP';
    end if;
  exception when sqlstate 'MLLBP' then
    null;
  end;
  return v_out;
end;
$$;

revoke all on function private.bulk_resend_worker_invites(uuid, uuid[], boolean, integer, integer)
  from public, anon;
grant execute on function private.bulk_resend_worker_invites(uuid, uuid[], boolean, integer, integer)
  to authenticated;

create function public.bulk_resend_worker_invites(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_dry_run boolean default false,
  p_org_cap integer default 30,
  p_global_cap integer default 80
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bulk_resend_worker_invites(
    p_organisation_id, p_worker_ids, p_dry_run, p_org_cap, p_global_cap
  )
$$;

revoke all on function public.bulk_resend_worker_invites(uuid, uuid[], boolean, integer, integer)
  from public, anon;
grant execute on function public.bulk_resend_worker_invites(uuid, uuid[], boolean, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Bulk cancel worker invites
-- ---------------------------------------------------------------------------

create function private.bulk_cancel_worker_invites(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_row record;
  v_code text;
  v_cancelled jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_out jsonb;
begin
  perform private.list_bulk_assert_inviter(p_organisation_id);
  v_ids := private.list_bulk_ids(p_worker_ids);
  perform private.list_bulk_assert_workers(p_organisation_id, v_ids);

  begin
    for v_row in
      select w.id, w.staff_id,
        nullif(btrim(concat_ws(' ', w.first_name, w.last_name)), '') as worker_name,
        i.id as invite_id, i.expires_at
      from public.workers w
      left join public.worker_invites i
        on i.organisation_id = w.organisation_id
       and i.worker_id = w.id
       and i.used_at is null
       and i.revoked_at is null
      where w.organisation_id = p_organisation_id and w.id = any (v_ids)
      order by w.last_name, w.first_name, w.staff_id, w.id
      for update of w
    loop
      v_code := case
        when v_row.invite_id is null then 'no_open_invite'
        when v_row.expires_at <= now() then 'expired'
      end;
      if v_code is not null then
        v_skipped := v_skipped || jsonb_build_object(
          'worker_id', v_row.id, 'name', v_row.worker_name, 'staff_id', v_row.staff_id,
          'code', v_code
        );
        continue;
      end if;

      update public.worker_invites i
      set revoked_at = now()
      where i.organisation_id = p_organisation_id
        and i.id = v_row.invite_id
        and i.used_at is null
        and i.revoked_at is null;
      perform private.log_audit_impl(
        p_organisation_id, 'worker_invite.cancelled', 'worker_invites', v_row.invite_id,
        jsonb_build_object('revoked_at', null),
        jsonb_build_object('worker_id', v_row.id, 'revoked', true, 'bulk', true),
        null
      );
      v_cancelled := v_cancelled || jsonb_build_object(
        'worker_id', v_row.id, 'name', v_row.worker_name, 'staff_id', v_row.staff_id,
        'invite_id', v_row.invite_id
      );
    end loop;

    if not coalesce(p_dry_run, false) then
      perform private.log_audit_impl(
        p_organisation_id, 'worker_invites.bulk_cancelled', 'worker_invites', null, null,
        jsonb_build_object(
          'cancelled', jsonb_array_length(v_cancelled), 'skipped', jsonb_array_length(v_skipped)
        ),
        null
      );
    end if;
    v_out := jsonb_build_object(
      'dry_run', coalesce(p_dry_run, false), 'cancelled', v_cancelled, 'skipped', v_skipped
    );
    if coalesce(p_dry_run, false) then
      raise exception 'preview' using errcode = 'MLLBP';
    end if;
  exception when sqlstate 'MLLBP' then
    null;
  end;
  return v_out;
end;
$$;

revoke all on function private.bulk_cancel_worker_invites(uuid, uuid[], boolean) from public, anon;
grant execute on function private.bulk_cancel_worker_invites(uuid, uuid[], boolean) to authenticated;

create function public.bulk_cancel_worker_invites(
  p_organisation_id uuid,
  p_worker_ids uuid[],
  p_dry_run boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select private.bulk_cancel_worker_invites(p_organisation_id, p_worker_ids, p_dry_run) $$;

revoke all on function public.bulk_cancel_worker_invites(uuid, uuid[], boolean) from public, anon;
grant execute on function public.bulk_cancel_worker_invites(uuid, uuid[], boolean) to authenticated;
