-- Slice 5.7c: arrears, leave refunds, supplementary payout files and remittance offsets
-- (docs/PHASE_5.md 5.7 and "As built in 5.7c"; decisions 10 and 11; open question 6; CLAUDE.md
-- rules 1, 4, 5, 6, 9 and 10).
--
-- 1. payroll_runs checks, as the shared 5.7 contract says (identical SQL in 5.7a, 5.7b and 5.7c,
--    so merge order doesn't matter): kind regular, off_cycle or reversal; status draft, review,
--    approved, released or reversed.
-- 2. Leave in posted periods (carried from 5.3): the MLTA5 refusal is lifted from
--    cancel_leave_request, decide_leave_line_manager and decide_leave_hr (each its latest version,
--    5.3's, with only that check removed). Corrections go in the next run instead:
--    * leave approved after its period was posted is deducted in the next run as arrears (unpaid
--      and part-paid leave of a monthly worker, by 5.1's leave rule on the posted period's own
--      rostered days), its days recorded as a leave_request source;
--    * leave cancelled after a posted payslip deducted it is refunded in the next run: exactly
--      what that payslip's leave_deduction lines took, line by line (leave_refund lines), recorded
--      as a leave_refund source naming the deduction's days.
--    Both come from `private.payroll_leave_corrections` (owner, hr, finance or the secret key),
--    which the server reads beside the run's pay inputs and hashes with them (decision 7). A
--    source is paid once: the 5.2 exclusion constraint holds per kind, and a deduction that a
--    later run refunded can't stop standing (a reversal of its run is refused, MLAR1).
-- 3. save_payroll_results (5.2's, its latest version) accepts leave_refund lines and sources and
--    checks each refund equals minus the deduction it names. payslip_lines gains the code
--    leave_refund (an earning, never negative); payslip_sources gains the kind leave_refund.
-- 4. Supplementary payout files (carried from 5.4) for workers a released run's bank file left
--    out: payout_supplements and payout_supplement_items, the same safety model as 5.4's bank
--    file (the plan read as the user first, decryption in memory on the server, the private
--    payroll-files bucket at {organisation_id}/{run_id}/supplementary/{id}.csv, 60-second signed
--    URLs, downloads audited, a reason and the not-uploaded statement before a downloaded file is
--    replaced, confirmation naming the file's id and SHA-256, never by whoever made it or
--    prepared the run, and only after a download). A payslip is paid once across the original
--    file and every supplementary one (partial unique index; the original item must be left out).
--    payroll_files_due sweeps supplementary files too.
-- 5. Remittance refunds and offsets (section 7): a payment recorded against a remittance 5.7a
--    voided is refunded or offset against a later remittance to the same authority.
--
-- Refusals (SQLSTATE), new here:
--   MLAR1 a later run refunded this leave deduction, so it can't stop standing
--   MLAR2 the run or supplementary file isn't in a state that allows this
--   MLAR3 the supplementary file doesn't match the outstanding items ready to pay, or none is ready
--   MLAR4 the supplementary file isn't stored at its path with that size
--   MLAR5 replacing the current supplementary file needs a reason
--   MLAR6 replacing a downloaded supplementary file needs the statement that it wasn't uploaded
--   MLAR7 confirmation named a file that isn't the current one, or its SHA-256 differs
--   MLAR8 the confirmer made the supplementary file
--   MLAR9 the confirmer prepared or changed the run
--   MLARA nobody downloaded the supplementary file yet
--   MLARB a download after confirmation needs a reason
--   MLARC to MLARI: section 7 (remittance refunds and offsets)
-- Reused: 42501 (role, untrusted session), 22023 (bad input), P0002 (not in the company), MLPR6
-- (results break an invariant).
-- No money maths here beyond sums and equality checks: the TypeScript engine works pay out.

-- ---------------------------------------------------------------------------
-- 1. payroll_runs: kinds and statuses (the shared 5.7 contract)
-- ---------------------------------------------------------------------------

alter table public.payroll_runs drop constraint if exists payroll_runs_kind_value;
alter table public.payroll_runs
  add constraint payroll_runs_kind_value check (kind in ('regular', 'off_cycle', 'reversal'));
alter table public.payroll_runs drop constraint if exists payroll_runs_status_value;
alter table public.payroll_runs
  add constraint payroll_runs_status_value
    check (status in ('draft', 'review', 'approved', 'released', 'reversed'));

-- ---------------------------------------------------------------------------
-- 2. Leave in posted periods: MLTA5 lifted (corrections go in the next run)
-- ---------------------------------------------------------------------------

-- Each function below is its latest version (5.3's, migration 20261122130000_payroll_approval.sql),
-- copied exactly except that 5.3's posted-period check (MLTA5) is removed: approving leave whose
-- days fall in a posted period is deducted in the next run as arrears, and cancelling approved
-- leave a posted payslip deducted is refunded in the next run (section 4).
-- private.leave_in_posted_period stays for reads.

create or replace function private.decide_leave_line_manager(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests%rowtype;
  v_type public.leave_types%rowtype;
  v_note text := private.leave_clean_text(p_note, 500);
  v_days integer;
  v_status text;
  v_lock_worker uuid;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to decide leave.' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'Approve or decline.' using errcode = '22023';
  end if;
  if p_note is not null and btrim(p_note) <> '' and v_note is null then
    raise exception 'Keep the note to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;
  if p_decision = 'declined' and v_note is null then
    raise exception 'Say why, so the worker knows.' using errcode = '22023';
  end if;

  -- The worker's leave lock first (as decide_leave_hr, request_leave and adjust_leave_balance
  -- take it), so a step-1 decision and a cancellation or a second decision can't interleave.
  select r.worker_id into v_lock_worker
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id;
  if v_lock_worker is not null then
    perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_lock_worker::text, 0));
  end if;

  select r.* into v_request
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'That leave request wasn''t found.' using errcode = 'P0002';
  end if;
  if v_request.worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t decide your own leave.' using errcode = 'MLLQ6';
  end if;
  if not private.leave_can_decide_step1(p_organisation_id, v_request.worker_id) then
    raise exception 'Only the worker''s line manager decides this step.' using errcode = '42501';
  end if;
  if v_request.status <> 'pending_line_manager' then
    raise exception 'This request isn''t waiting for the line manager.' using errcode = 'MLLQ4';
  end if;

  select t.* into v_type from public.leave_types t where t.id = v_request.leave_type_id;
  v_days := v_request.days;
  if p_decision = 'approved' then
    select c.days into v_days
    from private.leave_count_days(
      p_organisation_id, v_request.worker_id, v_type.counting, v_request.start_date,
      v_request.end_date
    ) c;
    if coalesce(v_days, 0) = 0 then
      raise exception 'Those dates no longer have working days for the worker. Decline it instead.'
        using errcode = 'MLLQ7';
    end if;
    v_status := 'pending_hr';
  else
    v_status := 'declined';
  end if;

  insert into public.leave_decisions (
    organisation_id, request_id, worker_id, step, decision, note, certificate_seen, days, actor
  )
  values (
    p_organisation_id, v_request.id, v_request.worker_id, 'line_manager', p_decision, v_note,
    coalesce(p_certificate_seen, false) and v_type.needs_certificate, v_days, private.session_uid()
  );

  update public.leave_requests r
  set status = v_status,
      days = v_days,
      certificate_seen = r.certificate_seen
        or (coalesce(p_certificate_seen, false) and v_type.needs_certificate),
      decided_at = case when v_status = 'declined' then now() else r.decided_at end
  where r.id = v_request.id;

  -- Written directly: log_audit_impl admits manager roles only, and a worker-supervisor (role
  -- worker) decides step 1 too. The caller was checked above.
  insert into public.audit_log (organisation_id, actor_id, action, entity, entity_id, before, after, reason)
  values (
    p_organisation_id, private.session_uid(), 'leave.decided_line_manager', 'leave_requests',
    v_request.id,
    jsonb_build_object('status', v_request.status, 'days', v_request.days),
    jsonb_build_object('status', v_status, 'days', v_days, 'decision', p_decision),
    v_note
  );

  return jsonb_build_object(
    'id', v_request.id, 'status', v_status, 'days', v_days, 'worker_id', v_request.worker_id
  );
end;
$$;

create or replace function private.decide_leave_hr(
  p_organisation_id uuid,
  p_request_id uuid,
  p_decision text,
  p_note text default null,
  p_certificate_seen boolean default false,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Slice 4.5: the shifts the approval opens, and how many it took the worker off.
  v_open jsonb := '[]'::jsonb;
  v_opened integer := 0;
  v_request public.leave_requests%rowtype;
  v_type public.leave_types%rowtype;
  v_version public.leave_entitlements%rowtype;
  v_note text := private.leave_clean_text(p_note, 500);
  v_count record;
  v_start date;
  v_available integer;
  v_status text;
  v_certificate boolean;
  v_below boolean;
  v_pay integer;
  v_lock_worker uuid;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to decide leave.' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'Approve or decline.' using errcode = '22023';
  end if;
  if p_note is not null and btrim(p_note) <> '' and v_note is null then
    raise exception 'Keep the note to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;
  if p_decision = 'declined' and v_note is null then
    raise exception 'Say why, so the worker knows.' using errcode = '22023';
  end if;

  -- The worker's leave lock first (as request_leave and adjust_leave_balance take it), so two
  -- decisions, or a decision and a request, can't both pass the balance check.
  select r.worker_id into v_lock_worker
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id;
  if v_lock_worker is not null then
    perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_lock_worker::text, 0));
  end if;

  select r.* into v_request
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'That leave request wasn''t found.' using errcode = 'P0002';
  end if;
  if v_request.worker_id in (select private.my_worker_ids()) then
    raise exception 'You can''t decide your own leave.' using errcode = 'MLLQ6';
  end if;
  if not private.leave_can_decide_step2(p_organisation_id, v_request.worker_id) then
    raise exception 'Only HR, an admin or the owner decides this step.' using errcode = '42501';
  end if;
  if v_request.status <> 'pending_hr' then
    raise exception 'This request isn''t waiting for HR.' using errcode = 'MLLQ4';
  end if;

  select t.* into v_type from public.leave_types t where t.id = v_request.leave_type_id;
  select w.start_date into v_start from public.workers w where w.id = v_request.worker_id;
  v_certificate := v_request.certificate_seen
    or (coalesce(p_certificate_seen, false) and v_type.needs_certificate);
  select c.* into v_count
  from private.leave_count_days(
    p_organisation_id, v_request.worker_id, v_type.counting, v_request.start_date,
    v_request.end_date
  ) c;
  v_version := private.leave_version_on(v_type.id, v_request.start_date);
  v_below := coalesce(
    v_version.pay_min_service_months is not null
      and private.leave_service_months(v_start, v_request.start_date) < v_version.pay_min_service_months,
    false
  );
  v_pay := case when v_type.paid then coalesce(v_version.pay_percent, 0) else 0 end;

  perform private.leave_ensure_year_core(p_organisation_id, v_request.leave_year, array[v_request.worker_id]);
  v_available := private.leave_balance(
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year
    ) - private.leave_pending_days(
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year, v_request.id
    );

  if p_decision = 'approved' then
    if coalesce(v_count.days, 0) = 0 then
      raise exception 'Those dates no longer have working days for the worker. Decline it instead.'
        using errcode = 'MLLQ7';
    end if;
    if v_type.needs_certificate and not v_certificate then
      raise exception 'Tick Certificate seen before approving % leave.', lower(v_type.name)
        using errcode = '22023';
    end if;
    if coalesce(v_version.days_per_year, 0) > 0 and v_available < v_count.days then
      raise exception 'The worker has % % left, fewer than the % asked for.',
        greatest(v_available, 0), case when greatest(v_available, 0) = 1 then 'day' else 'days' end,
        v_count.days
        using errcode = 'MLLQ2';
    end if;
    v_status := 'approved';
  else
    v_status := 'declined';
  end if;

  -- Slice 4.5: the worker's assigned shifts in the range that haven't started.
  if v_status = 'approved' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'assignment_id', o.assignment_id, 'shift_date', o.shift_date,
        'starts_at', o.starts_at, 'ends_at', o.ends_at,
        'site_id', o.site_id, 'site_name', o.site_name,
        'post_id', o.post_id, 'post_name', o.post_name
      ) order by o.starts_at, o.assignment_id), '[]'::jsonb)
    into v_open
    from private.leave_shifts_to_open(
      p_organisation_id, v_request.worker_id, v_request.start_date, v_request.end_date
    ) o;
  end if;

  if coalesce(p_dry_run, false) then
    return jsonb_build_object(
      'id', v_request.id, 'status', v_status, 'days', coalesce(v_count.days, v_request.days),
      'worker_id', v_request.worker_id, 'dry_run', true,
      'balance_before', v_available,
      'balance_after', case when v_status = 'approved' then v_available - v_count.days else v_available end,
      'shifts', coalesce(v_count.shifts, 0), 'site_names', to_jsonb(coalesce(v_count.site_names, '{}'::text[])),
      'pay_below_service', v_below,
      'open_shifts', v_open
    );
  end if;

  insert into public.leave_decisions (
    organisation_id, request_id, worker_id, step, decision, note, certificate_seen, days, actor
  )
  values (
    p_organisation_id, v_request.id, v_request.worker_id, 'hr', p_decision, v_note,
    coalesce(p_certificate_seen, false) and v_type.needs_certificate,
    coalesce(v_count.days, 0), private.session_uid()
  );

  update public.leave_requests r
  set status = v_status,
      days = case when v_status = 'approved' then v_count.days else r.days end,
      certificate_seen = v_certificate,
      decided_at = now()
  where r.id = v_request.id;

  if v_status = 'approved' then
    insert into public.leave_request_pay (request_id, organisation_id, pay_percent, pay_below_service)
    values (v_request.id, p_organisation_id, v_pay, v_below);
    insert into public.leave_ledger (
      organisation_id, worker_id, leave_type_id, leave_year, kind, days, request_id, actor
    )
    values (
      p_organisation_id, v_request.worker_id, v_type.id, v_request.leave_year, 'taken',
      -v_count.days, v_request.id, private.session_uid()
    );

    -- Slice 4.5 (decision 8): take the worker off the shifts in the range that haven't started,
    -- in this transaction. The guard checks each row (never a past day) and the audit trigger
    -- records each one.
    update public.shift_assignments a
    set status = 'removed',
        removed_at = now(),
        removed_by = private.session_uid(),
        removed_reason = 'on_leave'
    where a.organisation_id = p_organisation_id
      and a.worker_id = v_request.worker_id
      and a.status = 'assigned'
      and a.id in (select (e ->> 'assignment_id')::uuid from jsonb_array_elements(v_open) e);
    get diagnostics v_opened = row_count;
    if v_opened > 0 then
      perform private.log_audit_impl(
        p_organisation_id, 'roster.opened_by_leave', 'leave_requests', v_request.id, null,
        jsonb_build_object(
          'worker_id', v_request.worker_id,
          'opened', v_opened,
          'assignment_ids', (select coalesce(jsonb_agg(e -> 'assignment_id'), '[]'::jsonb)
                             from jsonb_array_elements(v_open) e)
        ),
        null
      );
    end if;
  end if;

  perform private.log_audit_impl(
    p_organisation_id, 'leave.decided_hr', 'leave_requests', v_request.id,
    jsonb_build_object('status', v_request.status, 'days', v_request.days),
    jsonb_build_object(
      'status', v_status, 'days', coalesce(v_count.days, v_request.days), 'decision', p_decision,
      'pay_below_service', v_below
    ),
    v_note
  );

  return jsonb_build_object(
    'id', v_request.id, 'status', v_status, 'days', coalesce(v_count.days, v_request.days),
    'worker_id', v_request.worker_id, 'dry_run', false,
    'balance_before', v_available,
    'balance_after', case when v_status = 'approved' then v_available - v_count.days else v_available end,
    'shifts', coalesce(v_count.shifts, 0), 'site_names', to_jsonb(coalesce(v_count.site_names, '{}'::text[])),
    'pay_below_service', v_below,
    'open_shifts', v_open
  );
end;
$$;

create or replace function private.cancel_leave_request(
  p_organisation_id uuid,
  p_request_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests%rowtype;
  v_reason text := private.leave_clean_text(p_reason, 500);
  v_own uuid;
  v_by_worker boolean;
  v_lock_worker uuid;
begin
  if private.session_uid() is null or p_organisation_id is null then
    raise exception 'Sign in to cancel leave.' using errcode = '42501';
  end if;
  if p_reason is not null and btrim(p_reason) <> '' and v_reason is null then
    raise exception 'Keep the reason to 500 characters of plain text, with no web addresses or long numbers.'
      using errcode = '22023';
  end if;

  select m.worker_id into v_own
  from public.memberships m
  where m.organisation_id = p_organisation_id and m.user_id = private.session_uid()
    and m.role = 'worker' and m.worker_id is not null;

  -- The worker's leave lock first (as request_leave and adjust_leave_balance take it), so two
  -- decisions, or a decision and a request, can't both pass the balance check.
  select r.worker_id into v_lock_worker
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id;
  if v_lock_worker is not null then
    perform pg_advisory_xact_lock(hashtextextended('leave_requests:' || v_lock_worker::text, 0));
  end if;

  select r.* into v_request
  from public.leave_requests r
  where r.organisation_id = p_organisation_id and r.id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'That leave request wasn''t found.' using errcode = 'P0002';
  end if;

  v_by_worker := v_own is not null and v_own = v_request.worker_id;
  if v_by_worker then
    perform set_config('metalira.audit_channel', 'worker_app', true);
    if v_request.status not in ('pending_line_manager', 'pending_hr') then
      raise exception 'This request was already decided. Ask HR to cancel approved leave.'
        using errcode = 'MLLQ4';
    end if;
  else
    if not private.leave_can_decide_step2(p_organisation_id, v_request.worker_id) then
      if v_request.worker_id in (select private.my_worker_ids()) then
        raise exception 'You can''t cancel your own leave here.' using errcode = 'MLLQ6';
      end if;
      raise exception 'Only the worker or HR can cancel leave.' using errcode = '42501';
    end if;
    if v_request.status not in ('pending_line_manager', 'pending_hr', 'approved') then
      raise exception 'This request is already closed.' using errcode = 'MLLQ4';
    end if;
    if v_reason is null then
      raise exception 'Say why it is cancelled, so the worker knows.' using errcode = '22023';
    end if;
  end if;

  update public.leave_requests r
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = private.session_uid(),
      cancel_reason = v_reason
  where r.id = v_request.id;

  if v_request.status = 'approved' then
    insert into public.leave_ledger (
      organisation_id, worker_id, leave_type_id, leave_year, kind, days, request_id, reason, actor
    )
    values (
      p_organisation_id, v_request.worker_id, v_request.leave_type_id, v_request.leave_year,
      'returned', v_request.days, v_request.id, v_reason, private.session_uid()
    );
  end if;

  if not v_by_worker then
    perform private.log_audit_impl(
      p_organisation_id, 'leave.cancelled', 'leave_requests', v_request.id,
      jsonb_build_object('status', v_request.status),
      jsonb_build_object(
        'status', 'cancelled',
        'returned', case when v_request.status = 'approved' then v_request.days else 0 end
      ),
      v_reason
    );
  end if;

  return jsonb_build_object(
    'id', v_request.id, 'status', 'cancelled', 'worker_id', v_request.worker_id,
    'returned', case when v_request.status = 'approved' then v_request.days else 0 end,
    'by_worker', v_by_worker, 'was', v_request.status
  );
end;
$$;

-- 5.7b (migration 20261122190000) freezes approved leave a posted payslip of any run pays
-- (private.leave_requests_freeze_paid, MLTA5; its security review M3). 5.7c keeps that freeze for
-- every change but one: cancelling it (approved -> cancelled, by cancel_leave_request, nothing
-- else changing) when every standing source paying it is on a posted REGULAR run, because the
-- next regular run refunds exactly that (section 4). Leave a posted off-cycle payslip (a final pay,
-- a missed worker's month) paid stays frozen: no later regular run refunds it, so payroll corrects
-- it with a correction run.
create or replace function private.leave_requests_freeze_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paid boolean;
  v_off_cycle boolean;
begin
  if old.status <> 'approved' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  select
    coalesce(bool_or(true), false),
    coalesce(bool_or(r.kind <> 'regular'), false)
  into v_paid, v_off_cycle
  from public.payslip_sources s
  join public.payroll_runs r on r.organisation_id = s.organisation_id and r.id = s.run_id
  where s.organisation_id = old.organisation_id
    and s.source_kind = 'leave_request' and s.source_id = old.id
    and s.stands
    and r.status in ('approved', 'released');
  if v_paid and (
    tg_op = 'DELETE'
    or (new.status, new.start_date, new.end_date, new.leave_type_id, new.worker_id)
      is distinct from (old.status, old.start_date, old.end_date, old.leave_type_id, old.worker_id)
  ) then
    -- Slice 5.7c: a cancellation of leave only regular runs paid is refunded in the next run.
    if tg_op = 'UPDATE' and not v_off_cycle and new.status = 'cancelled'
      and (new.start_date, new.end_date, new.leave_type_id, new.worker_id)
        is not distinct from (old.start_date, old.end_date, old.leave_type_id, old.worker_id) then
      return new;
    end if;
    if v_off_cycle then
      raise exception 'This leave was paid on an off-cycle run. Ask payroll to correct it with a correction run.'
        using errcode = 'MLTA5';
    end if;
    raise exception 'Part of this leave is in a posted pay period. Ask payroll to correct it in the next run.'
      using errcode = 'MLTA5';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.leave_requests_freeze_paid() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Leave refunds on payslips
-- ---------------------------------------------------------------------------

-- A leave refund is an earning (5.2's sign check already keeps every code but leave_deduction at
-- 0 or more, and its kind check makes any other code an earning).
alter table public.payslip_lines drop constraint if exists payslip_lines_code_value;
alter table public.payslip_lines
  add constraint payslip_lines_code_value check (code in (
    'basic', 'housing', 'transport', 'other_allowances', 'daily_pay', 'hourly_pay', 'overtime',
    'off_day', 'public_holiday', 'leave_deduction', 'adjustment_earning', 'arrears', 'paye',
    'pension_employee', 'nhf', 'deduction', 'carried_deduction', 'pension_employer', 'nsitf',
    'itf', 'leave_refund'
  ));

-- The refund's source: the cancelled leave request and the exact days the deduction covered. The
-- 5.2 exclusion constraint (organisation, kind, id, days, while standing) keeps it paid once.
alter table public.payslip_sources drop constraint if exists payslip_sources_kind_value;
alter table public.payslip_sources
  add constraint payslip_sources_kind_value check (
    source_kind in ('timesheet_line', 'leave_request', 'pay_rate', 'adjustment', 'leave_refund')
  );

-- A leave deduction a later standing payslip refunded can't stop standing (5.7a's reversal frees
-- sources by clearing `stands`): reversing the run that took it would pay the refund twice.
create function private.payslip_sources_refund_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.stands and not new.stands and old.source_kind = 'leave_request' and exists (
    select 1
    from public.payslip_sources r
    where r.organisation_id = old.organisation_id
      and r.source_kind = 'leave_refund'
      and r.source_id = old.source_id
      and r.stands
      and r.run_id <> old.run_id
      and daterange(r.from_date, r.to_date, '[]') && daterange(old.from_date, old.to_date, '[]')
  ) then
    raise exception 'A later run refunded leave this run deducted, so this run can''t be reversed. Correct it in the next run.'
      using errcode = 'MLAR1';
  end if;
  return new;
end;
$$;

revoke all on function private.payslip_sources_refund_guard() from public, anon, authenticated;

create trigger payslip_sources_refund_guard
  before update of stands on public.payslip_sources
  for each row execute function private.payslip_sources_refund_guard();
-- As 5.3's payroll guards: fires whatever session_replication_role says.
alter table public.payslip_sources enable always trigger payslip_sources_refund_guard;

-- private.save_payroll_results: its latest version (5.2's, migration
-- 20261122120000_payroll_runs.sql), copied exactly except for three additions marked "Slice 5.7c":
-- a leave_refund line pays exactly one leave_refund source (and only refund lines pay one); the
-- source is a cancelled leave request of the worker whose exact days a standing payslip of another
-- posted run deducted; and the refund lines it backs sum to minus that payslip's leave_deduction
-- lines for it.
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
      v_amount := private.payroll_kobo(
        v_line -> 'amount_kobo', v_code = 'leave_deduction', 'a line''s amount'
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

      if v_code in ('adjustment_earning', 'deduction') and not (
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
          ) then
            raise exception 'A payslip line doesn''t pay its adjustment''s amount.' using errcode = 'MLPR6';
          end if;
        end if;
        v_key := v_src_kind || ':' || v_src_id::text;
        if v_src_kind = 'adjustment' and v_sources ? v_key then
          raise exception 'An adjustment is paid on two lines.' using errcode = 'MLPR6';
        end if;
        if v_sources ? v_key then
          if (v_sources -> v_key ->> 'from')::date <> v_from
            or (v_sources -> v_key ->> 'to')::date <> v_to then
            raise exception 'A source appears with two different ranges on one payslip.'
              using errcode = 'MLPR6';
          end if;
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
        select coalesce(sum(l.amount_kobo), 0) into v_refund
        from public.payslip_lines l
        where l.organisation_id = p_organisation_id and l.payslip_id = v_slip_id
          and l.position in (select x::integer from jsonb_array_elements_text(v_src -> 'positions') x);
        select coalesce(sum(ol.amount_kobo), 0) into v_owed
        from public.payslip_sources o
        join public.payroll_runs orun
          on orun.organisation_id = o.organisation_id and orun.id = o.run_id
        join public.payslip_lines ol
          on ol.organisation_id = o.organisation_id and ol.payslip_id = o.payslip_id
            and ol.position = any (o.line_positions) and ol.code = 'leave_deduction'
        where o.organisation_id = p_organisation_id and o.source_kind = 'leave_request'
          and o.source_id = (v_src ->> 'id')::uuid and o.worker_id = v_worker and o.stands
          and o.run_id <> p_run_id and orun.status in ('approved', 'released')
          and o.from_date = (v_src ->> 'from')::date and o.to_date = (v_src ->> 'to')::date;
        if v_refund <= 0 or v_refund <> -v_owed then
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
-- 4. Leave corrections for a run (arrears and refunds)
-- ---------------------------------------------------------------------------

-- What the next run corrects for leave decided after its period was posted, for the given
-- workers (the run's pay inputs' workers). Owner, hr, finance or the secret key, as
-- payroll_run_inputs; p_run_id is the run being worked out (its own draft never hides what it
-- pays). No amounts are worked out here:
-- * leave_arrears: approved leave with days in the period of an earlier posted regular run in
--   which the worker had a payslip, not already a standing source for those days (so not paid or
--   deducted there), and not fully paid (pay below 100%, or below the pay's service, or no pay
--   row yet: the engine flags that). One item per leave request and posted period, with that
--   payslip's rostered days (the base 5.1's leave rule divides by) and the worker's shifts in the
--   period (to tell its working days), from 400 days back.
-- * leave_refunds: cancelled leave whose days a standing payslip of a posted run deducted, not
--   refunded yet; one item per deduction, with its leave_deduction lines as they were posted
--   (label, amount, pensionable, taxable), which the refund pays back line by line.
create function private.payroll_leave_corrections(
  p_organisation_id uuid,
  p_period_start date,
  p_worker_ids uuid[],
  p_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_end date;
  v_from date;
  v_result jsonb;
begin
  perform private.require_payroll_reader(p_organisation_id);
  if p_period_start is null then
    raise exception 'Choose the pay period.' using errcode = '22023';
  end if;
  if p_worker_ids is null or cardinality(p_worker_ids) > 2000 then
    raise exception 'Name up to 2000 workers.' using errcode = '22023';
  end if;
  if p_run_id is not null and not exists (
    select 1 from public.payroll_runs r
    where r.organisation_id = p_organisation_id and r.id = p_run_id
  ) then
    raise exception 'That payroll run wasn''t found.' using errcode = '22023';
  end if;
  select p.period_start, p.period_end into v_start, v_end
  from private.payroll_period_for(p_organisation_id, p_period_start) p;
  if v_start is null or v_start <> p_period_start then
    raise exception 'That isn''t the start of a pay period.' using errcode = '22023';
  end if;
  v_from := v_start - 400;

  with arrears as (
    select
      q.worker_id,
      r.period_start as sort_period,
      q.start_date as sort_start,
      q.id as sort_id,
      jsonb_build_object(
        'request_id', q.id,
        'type_code', t.code,
        'counting', t.counting,
        'pay_percent', lp.pay_percent,
        'pay_below_service', lp.pay_below_service,
        'period_start', r.period_start,
        'period_end', r.period_end,
        'from', greatest(q.start_date, r.period_start),
        'to', least(q.end_date, r.period_end),
        'rostered_days', s.rostered_days,
        'shifts', coalesce((
          select jsonb_agg(
            jsonb_build_object('date', a.shift_date, 'on_leave', a.status = 'removed')
            order by a.shift_date, a.id
          )
          from public.shift_assignments a
          where a.organisation_id = p_organisation_id and a.worker_id = q.worker_id
            and a.shift_date between r.period_start and r.period_end
            and (a.status = 'assigned' or a.removed_reason = 'on_leave')
        ), '[]'::jsonb)
      ) as item
    from public.leave_requests q
    join public.leave_types t
      on t.organisation_id = q.organisation_id and t.id = q.leave_type_id
    left join public.leave_request_pay lp
      on lp.organisation_id = q.organisation_id and lp.request_id = q.id
    join public.payroll_runs r
      on r.organisation_id = q.organisation_id
        and r.kind = 'regular'
        and r.status in ('approved', 'released')
        and r.period_end < v_start
        and r.period_start <= q.end_date and r.period_end >= q.start_date
    join public.payslips s
      on s.organisation_id = r.organisation_id and s.run_id = r.id and s.worker_id = q.worker_id
    where q.organisation_id = p_organisation_id
      and q.worker_id = any (p_worker_ids)
      and q.status = 'approved'
      and q.start_date < v_start
      and q.end_date >= v_from
      and (lp.request_id is null or lp.pay_percent < 100 or lp.pay_below_service)
      and not private.payroll_source_paid(
        p_organisation_id, 'leave_request', q.id,
        greatest(q.start_date, r.period_start), least(q.end_date, r.period_end), p_run_id
      )
  ),
  refunds as (
    select
      o.worker_id,
      o.from_date as sort_from,
      q.id as sort_id,
      jsonb_build_object(
        'request_id', q.id,
        'from', o.from_date,
        'to', o.to_date,
        'period_start', orun.period_start,
        'period_end', orun.period_end,
        'lines', (
          select jsonb_agg(
            jsonb_build_object(
              'label', l.label,
              'amount_kobo', l.amount_kobo::text,
              'pensionable', l.pensionable,
              'taxable', l.taxable
            )
            order by l.position
          )
          from public.payslip_lines l
          where l.organisation_id = o.organisation_id and l.payslip_id = o.payslip_id
            and l.position = any (o.line_positions) and l.code = 'leave_deduction'
        )
      ) as item
    from public.payslip_sources o
    join public.payroll_runs orun
      on orun.organisation_id = o.organisation_id and orun.id = o.run_id
        and orun.status in ('approved', 'released')
        and orun.kind in ('regular', 'off_cycle')
    join public.leave_requests q
      on q.organisation_id = o.organisation_id and q.id = o.source_id and q.status = 'cancelled'
    where o.organisation_id = p_organisation_id
      and o.source_kind = 'leave_request'
      and o.stands
      and o.worker_id = any (p_worker_ids)
      and (p_run_id is null or o.run_id <> p_run_id)
      and exists (
        select 1 from public.payslip_lines l
        where l.organisation_id = o.organisation_id and l.payslip_id = o.payslip_id
          and l.position = any (o.line_positions) and l.code = 'leave_deduction'
          and l.amount_kobo < 0
      )
      and not private.payroll_source_paid(
        p_organisation_id, 'leave_refund', q.id, o.from_date, o.to_date, p_run_id
      )
  ),
  people as (
    select a.worker_id from arrears a
    union
    select f.worker_id from refunds f
  )
  select jsonb_build_object(
    'version', 1,
    'period', jsonb_build_object('start', v_start, 'end', v_end),
    'workers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'worker_id', p.worker_id,
          'leave_arrears', coalesce((
            select jsonb_agg(a.item order by a.sort_period, a.sort_start, a.sort_id)
            from arrears a where a.worker_id = p.worker_id
          ), '[]'::jsonb),
          'leave_refunds', coalesce((
            select jsonb_agg(f.item order by f.sort_from, f.sort_id)
            from refunds f where f.worker_id = p.worker_id
          ), '[]'::jsonb)
        )
        order by p.worker_id
      )
      from people p
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function private.payroll_leave_corrections(uuid, date, uuid[], uuid) from public, anon;
grant execute on function private.payroll_leave_corrections(uuid, date, uuid[], uuid)
  to authenticated, service_role;

create function public.payroll_leave_corrections(
  p_organisation_id uuid,
  p_period_start date,
  p_worker_ids uuid[],
  p_run_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.payroll_leave_corrections(p_organisation_id, p_period_start, p_worker_ids, p_run_id)
$$;

revoke all on function public.payroll_leave_corrections(uuid, date, uuid[], uuid) from public, anon;
grant execute on function public.payroll_leave_corrections(uuid, date, uuid[], uuid)
  to authenticated, service_role;

-- Recurring instalments a regular run didn't carry because the worker's final pay (5.7b) had
-- already posted, as 5.7b records them in the audit log (`payroll.instalment_not_carried`), which
-- hr and finance can't read. Owner, hr and finance, trusted session; ids and amounts (text) only,
-- newest first. The carried deductions panel lists them so payroll settles them knowingly.
create function private.payroll_instalments_not_carried(p_organisation_id uuid)
returns table (
  worker_id uuid,
  series_id uuid,
  instalment integer,
  of_count integer,
  amount_kobo text,
  paid_by_run_id uuid,
  regular_run_id uuid,
  at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only the owner, HR or finance can read payroll.' using errcode = '42501';
  end if;
  return query
  select
    (l.after ->> 'worker_id')::uuid, (l.after ->> 'series_id')::uuid,
    (l.after ->> 'instalment')::integer, (l.after ->> 'of')::integer,
    l.after ->> 'amount_kobo', (l.after ->> 'paid_by_run_id')::uuid, l.entity_id, l.at
  from public.audit_log l
  where l.organisation_id = p_organisation_id
    and l.action = 'payroll.instalment_not_carried'
    and jsonb_typeof(l.after) = 'object'
  order by l.at desc
  limit 200;
end;
$$;

revoke all on function private.payroll_instalments_not_carried(uuid) from public, anon;
grant execute on function private.payroll_instalments_not_carried(uuid) to authenticated;

create function public.payroll_instalments_not_carried(p_organisation_id uuid)
returns table (
  worker_id uuid,
  series_id uuid,
  instalment integer,
  of_count integer,
  amount_kobo text,
  paid_by_run_id uuid,
  regular_run_id uuid,
  at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.payroll_instalments_not_carried(p_organisation_id)
$$;

revoke all on function public.payroll_instalments_not_carried(uuid) from public, anon;
grant execute on function public.payroll_instalments_not_carried(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Supplementary payout files (carried from 5.4)
-- ---------------------------------------------------------------------------

-- A bank file for workers a released run's bank file left out (no usable bank details, or a bank
-- change in its hold), made once their details are in force. Control totals as 5.4's batches.
-- At most one current (active) file per run; confirming it went to the bank makes it confirmed
-- (kept, never replaced); replacing an active one voids it with a reason.
create table public.payout_supplements (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  run_id uuid not null,
  bank_format text not null
    constraint payout_supplements_bank_format check (bank_format ~ '^[a-z][a-z0-9-]{1,39}$'),
  -- Object name in the private payroll-files bucket. Opened only by 60-second signed URLs.
  file_path text not null constraint payout_supplements_file_path_key unique,
  -- The SHA-256 of the file's bytes as the server made them (its attestation, as 5.4's).
  file_sha256 text not null
    constraint payout_supplements_file_sha256_format check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes integer not null constraint payout_supplements_file_bytes check (file_bytes > 0),
  item_count integer not null constraint payout_supplements_item_count check (item_count > 0),
  total_kobo bigint not null constraint payout_supplements_total check (total_kobo > 0),
  currency text not null default 'NGN' constraint payout_supplements_currency check (currency = 'NGN'),
  status text not null default 'active'
    constraint payout_supplements_status_value check (status in ('active', 'confirmed', 'voided')),
  made_by uuid not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text
    constraint payout_supplements_void_reason_text check (
      void_reason = btrim(void_reason) and char_length(void_reason) between 1 and 500
      and void_reason !~ '[\x01-\x1f\x7f-\x9f<>]' and void_reason !~* '(://|www\.)'
      -- An account number never lands in free text (and so in audit_log) in clear.
      and regexp_replace(void_reason, '[^0-9]', '', 'g') !~ '[0-9]{10}'
    ),
  constraint payout_supplements_organisation_id_id_key unique (organisation_id, id),
  constraint payout_supplements_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payout_supplements_file_path_shape check (
    file_path = organisation_id::text || '/' || run_id::text || '/supplementary/' || id::text || '.csv'
  ),
  constraint payout_supplements_state check (
    case status
      when 'active' then num_nonnulls(confirmed_at, confirmed_by, voided_at, voided_by, void_reason) = 0
      when 'confirmed' then num_nulls(confirmed_at, confirmed_by) = 0
        and num_nonnulls(voided_at, voided_by, void_reason) = 0
      else num_nulls(voided_at, voided_by, void_reason) = 0
        and num_nonnulls(confirmed_at, confirmed_by) = 0
    end
  ),
  -- Rule 10: whoever made the file doesn't confirm it went to the bank.
  constraint payout_supplements_confirmer check (confirmed_by is null or confirmed_by <> made_by)
);

create unique index payout_supplements_one_active on public.payout_supplements (organisation_id, run_id)
  where status = 'active';
create index payout_supplements_run_idx
  on public.payout_supplements (organisation_id, run_id, created_at desc);

comment on table public.payout_supplements is
  'A supplementary bank file for workers a released run''s bank file left out (slice 5.7c), with its control totals. One active per run; confirmed when it went to the bank; voided with a reason when replaced first. Written only by the supplement functions.';

create table public.payout_supplement_items (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  supplement_id uuid not null,
  run_id uuid not null,
  payslip_id uuid not null,
  worker_id uuid not null,
  -- The left-out item of the run's bank file this pays.
  original_item_id uuid not null,
  position integer not null constraint payout_supplement_items_position check (position > 0),
  -- pending: in the file (paid once confirmed; Phase 6 matches the debit); voided: its file was
  -- replaced before it was confirmed.
  status text not null default 'pending'
    constraint payout_supplement_items_status_value check (status in ('pending', 'voided')),
  bank_name text not null,
  bank_code text not null
    constraint payout_supplement_items_bank_code_format check (bank_code ~ '^[0-9]{3,6}$'),
  account_name text not null,
  bank_account_last4 text not null
    constraint payout_supplement_items_last4_format check (bank_account_last4 ~ '^[0-9]{4}$'),
  bank_detail_change_id uuid,
  amount_kobo bigint not null constraint payout_supplement_items_amount check (amount_kobo > 0),
  currency text not null default 'NGN' constraint payout_supplement_items_currency check (currency = 'NGN'),
  created_at timestamptz not null default now(),
  constraint payout_supplement_items_organisation_id_id_key unique (organisation_id, id),
  constraint payout_supplement_items_payslip_key unique (supplement_id, payslip_id),
  constraint payout_supplement_items_position_key unique (supplement_id, position),
  constraint payout_supplement_items_supplement_fkey foreign key (organisation_id, supplement_id)
    references public.payout_supplements (organisation_id, id),
  constraint payout_supplement_items_run_fkey foreign key (organisation_id, run_id)
    references public.payroll_runs (organisation_id, id),
  constraint payout_supplement_items_payslip_fkey foreign key (organisation_id, payslip_id)
    references public.payslips (organisation_id, id),
  constraint payout_supplement_items_worker_fkey foreign key (organisation_id, worker_id)
    references public.workers (organisation_id, id),
  constraint payout_supplement_items_original_fkey foreign key (organisation_id, original_item_id)
    references public.payout_items (organisation_id, id)
);

-- Paid once across supplementary files: one standing item per payslip (the original file's item
-- for it is left out, checked when the file is made).
create unique index payout_supplement_items_paid_once
  on public.payout_supplement_items (organisation_id, payslip_id)
  where status = 'pending';
create index payout_supplement_items_supplement_idx
  on public.payout_supplement_items (organisation_id, supplement_id, position);

comment on table public.payout_supplement_items is
  'One left-out payslip of a released run in a supplementary bank file (slice 5.7c): bank name, code, account name and last 4 digits only. Insert-only but the void.';

-- Guards (every role, the secret key and the database owner included), as 5.4's.

-- A supplementary file is made for a released run and stamped now; it never goes. The changes
-- are active -> confirmed (who and when) and active -> voided (who, when and why), nothing else.
create function private.payout_supplements_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A supplementary bank file is kept.' using errcode = 'MLAR2';
  end if;
  if tg_op = 'INSERT' then
    if private.payroll_run_status(new.organisation_id, new.run_id) is distinct from 'released' then
      raise exception 'A supplementary bank file is made for a released run.' using errcode = 'MLAR2';
    end if;
    if new.status <> 'active'
      or num_nonnulls(new.confirmed_at, new.confirmed_by, new.voided_at, new.voided_by, new.void_reason) > 0 then
      raise exception 'A new supplementary bank file starts active.' using errcode = 'MLAR2';
    end if;
    new.created_at := now();
    return new;
  end if;
  if old.status = 'active' and new.status = 'voided' and new.voided_by is not null
    and new.void_reason is not null
    and (to_jsonb(new) - 'status' - 'voided_at' - 'voided_by' - 'void_reason')
      is not distinct from (to_jsonb(old) - 'status' - 'voided_at' - 'voided_by' - 'void_reason') then
    new.voided_at := now();
    return new;
  end if;
  if old.status = 'active' and new.status = 'confirmed' and new.confirmed_by is not null
    and (to_jsonb(new) - 'status' - 'confirmed_at' - 'confirmed_by')
      is not distinct from (to_jsonb(old) - 'status' - 'confirmed_at' - 'confirmed_by') then
    new.confirmed_at := now();
    return new;
  end if;
  raise exception 'A supplementary bank file never changes; a new one replaces it before it is confirmed.'
    using errcode = 'MLAR2';
end;
$$;

revoke all on function private.payout_supplements_guard() from public, anon, authenticated;

-- Items are written with their file, in the file's own transaction, and never go. The one change
-- is pending -> voided once the file is voided.
create function private.payout_supplement_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supplement public.payout_supplements%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Supplementary bank file items are kept.' using errcode = 'MLAR2';
  end if;
  select s.* into v_supplement
  from public.payout_supplements s
  where s.organisation_id = new.organisation_id and s.id = new.supplement_id;
  if tg_op = 'INSERT' then
    if v_supplement.id is null or v_supplement.status <> 'active'
      or v_supplement.created_at <> now() or v_supplement.run_id <> new.run_id
      or new.status <> 'pending' then
      raise exception 'Supplementary bank file items are written with their file, once.'
        using errcode = 'MLAR2';
    end if;
    new.created_at := now();
    return new;
  end if;
  if not (old.status = 'pending' and new.status = 'voided' and v_supplement.status = 'voided')
    or (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'Supplementary bank file items never change.' using errcode = 'MLAR2';
  end if;
  return new;
end;
$$;

revoke all on function private.payout_supplement_items_guard() from public, anon, authenticated;

create trigger payout_supplements_guard
  before insert or update or delete on public.payout_supplements
  for each row execute function private.payout_supplements_guard();
create trigger payout_supplement_items_guard
  before insert or update or delete on public.payout_supplement_items
  for each row execute function private.payout_supplement_items_guard();
create trigger payout_supplements_no_truncate before truncate on public.payout_supplements
  for each statement execute function private.payroll_no_truncate();
create trigger payout_supplement_items_no_truncate before truncate on public.payout_supplement_items
  for each statement execute function private.payroll_no_truncate();
create trigger payout_supplements_audit after insert or update on public.payout_supplements
  for each row execute function private.audit_row_change();
create trigger payout_supplement_items_audit after insert or update on public.payout_supplement_items
  for each row execute function private.audit_row_change();

alter table public.payout_supplements enable always trigger payout_supplements_guard;
alter table public.payout_supplement_items enable always trigger payout_supplement_items_guard;
alter table public.payout_supplements enable always trigger payout_supplements_no_truncate;
alter table public.payout_supplement_items enable always trigger payout_supplement_items_no_truncate;

-- Row-level security: owner, hr and finance read (hr sees control totals and masked last 4
-- digits; the file opens for owner and finance only); nobody writes directly.
alter table public.payout_supplements enable row level security;
alter table public.payout_supplement_items enable row level security;

create policy payout_supplements_select on public.payout_supplements for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));
create policy payout_supplement_items_select on public.payout_supplement_items for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.payout_supplements, public.payout_supplement_items
  from anon, authenticated, service_role;
grant select on table public.payout_supplements, public.payout_supplement_items
  to authenticated, service_role;

-- The run's outstanding items: each payslip the run's bank file left out for missing details or a
-- bank change in its hold, not paid by a confirmed supplementary file, with the bank details in
-- force now. No role check: definers call it.
create function private.payout_supplement_rows(p_organisation_id uuid, p_run_id uuid)
returns table (
  payslip_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  original_item_id uuid,
  left_out_reason text,
  net_kobo bigint,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  bank_account_enc bytea,
  in_hold boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id, s.worker_id, btrim(w.first_name || ' ' || w.last_name), w.staff_id, i.id,
    i.left_out_reason, s.net_kobo,
    d.bank_name, d.bank_code, d.account_name, d.bank_account_last4, d.bank_detail_change_id,
    d.bank_account_enc,
    exists (
      select 1 from public.bank_detail_changes c
      where c.organisation_id = s.organisation_id and c.worker_id = s.worker_id
        and (c.status = 'pending' or (c.status = 'approved' and c.applies_after > now()))
    )
  from public.payout_batches b
  join public.payout_items i
    on i.organisation_id = b.organisation_id and i.batch_id = b.id
  join public.payslips s on s.organisation_id = i.organisation_id and s.id = i.payslip_id
  join public.workers w on w.organisation_id = s.organisation_id and w.id = s.worker_id
  left join lateral private.worker_bank_details_as_of(s.organisation_id, s.worker_id, now()) d
    on true
  where b.organisation_id = p_organisation_id and b.run_id = p_run_id and b.status = 'active'
    and i.status = 'left_out'
    and i.left_out_reason in ('no_bank_details', 'bank_change_in_hold')
    and s.net_kobo > 0
    and not exists (
      select 1
      from public.payout_supplement_items x
      join public.payout_supplements y
        on y.organisation_id = x.organisation_id and y.id = x.supplement_id
      where x.organisation_id = s.organisation_id and x.payslip_id = s.id
        and x.status = 'pending' and y.status = 'confirmed'
    )
  order by w.last_name, w.first_name, w.staff_id, s.id
$$;

revoke all on function private.payout_supplement_rows(uuid, uuid) from public, anon, authenticated;

-- A row is ready for a supplementary file when its details are complete, have a bank code and no
-- change is waiting or in its hold.
create function private.payout_supplement_ready(
  p_enc bytea,
  p_bank_name text,
  p_bank_code text,
  p_account_name text,
  p_last4 text,
  p_in_hold boolean
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_enc is not null and p_bank_name is not null and p_account_name is not null
    and p_last4 is not null and p_bank_code is not null and not coalesce(p_in_hold, true)
$$;

revoke all on function private.payout_supplement_ready(bytea, text, text, text, text, boolean)
  from public, anon, authenticated;

-- What a supplementary file of a released run would hold now. Owner or finance (trusted session)
-- read it without ciphertext; only the secret key gets the encrypted account numbers, for the
-- server to decrypt in memory. Net pay is text.
create function private.payout_supplement_plan(
  p_organisation_id uuid,
  p_run_id uuid,
  p_with_ciphertext boolean
)
returns table (
  payslip_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  original_item_id uuid,
  left_out_reason text,
  net_kobo text,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  bank_account_enc bytea,
  on_file boolean,
  in_hold boolean,
  ready boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if auth.uid() is not null then
    if coalesce(p_with_ciphertext, true) then
      raise exception 'Only the server reads encrypted account numbers.' using errcode = '42501';
    end if;
    perform private.require_payout_maker(p_organisation_id);
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only an owner or Finance can read the supplementary file''s plan.'
      using errcode = '42501';
  end if;
  v_status := private.payroll_run_status(p_organisation_id, p_run_id);
  if v_status is null then
    raise exception 'That payroll run wasn''t found.' using errcode = 'P0002';
  end if;
  if v_status <> 'released' then
    raise exception 'A supplementary file is made once the run is released.' using errcode = 'MLAR2';
  end if;
  return query
  select r.payslip_id, r.worker_id, r.worker_name, r.staff_id, r.original_item_id,
    r.left_out_reason, r.net_kobo::text, r.bank_name, r.bank_code, r.account_name,
    r.bank_account_last4, r.bank_detail_change_id,
    case when p_with_ciphertext then r.bank_account_enc end,
    r.bank_account_enc is not null, r.in_hold,
    private.payout_supplement_ready(
      r.bank_account_enc, r.bank_name, r.bank_code, r.account_name, r.bank_account_last4, r.in_hold
    )
  from private.payout_supplement_rows(p_organisation_id, p_run_id) r;
end;
$$;

revoke all on function private.payout_supplement_plan(uuid, uuid, boolean) from public, anon;
grant execute on function private.payout_supplement_plan(uuid, uuid, boolean) to authenticated, service_role;

create function public.payout_supplement_plan(
  p_organisation_id uuid,
  p_run_id uuid,
  p_with_ciphertext boolean default false
)
returns table (
  payslip_id uuid,
  worker_id uuid,
  worker_name text,
  staff_id text,
  original_item_id uuid,
  left_out_reason text,
  net_kobo text,
  bank_name text,
  bank_code text,
  account_name text,
  bank_account_last4 text,
  bank_detail_change_id uuid,
  bank_account_enc bytea,
  on_file boolean,
  in_hold boolean,
  ready boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.payout_supplement_plan(p_organisation_id, p_run_id, p_with_ciphertext)
$$;

revoke all on function public.payout_supplement_plan(uuid, uuid, boolean) from public, anon;
grant execute on function public.payout_supplement_plan(uuid, uuid, boolean) to authenticated, service_role;

-- Records a supplementary file the server made and stored (owner or finance, trusted session).
-- p_items has one entry per outstanding item ready now: {payslip_id, position, bank_name,
-- bank_code, account_name, bank_account_last4, bank_detail_change_id, amount_kobo (text)}. They
-- must be exactly the ready rows, positions 1..n, each paid its net pay to the details in force
-- now; the server already decrypted each number and checked its last 4 digits. Voids the current
-- supplementary file with p_void_reason (and, when it was downloaded, the not-uploaded statement).
-- Returns {supplement_id, item_count, total_kobo, voided_supplement_id}.
create function private.make_payout_supplement(
  p_organisation_id uuid,
  p_run_id uuid,
  p_supplement_id uuid,
  p_bank_format text,
  p_file_sha256 text,
  p_file_bytes integer,
  p_items jsonb,
  p_void_reason text,
  p_not_uploaded boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payout_maker(p_organisation_id);
  v_run public.payroll_runs%rowtype;
  v_active public.payout_supplements%rowtype;
  v_path text;
  v_size text;
  v_reason text := nullif(btrim(coalesce(p_void_reason, '')), '');
  v_downloaded_at timestamptz;
  v_ready integer;
  v_given integer;
  v_rows jsonb;
  v_matches boolean;
  v_total bigint;
begin
  if p_run_id is null or p_supplement_id is null then
    raise exception 'Name the run and the file.' using errcode = '22023';
  end if;
  if p_bank_format is null or p_bank_format !~ '^[a-z][a-z0-9-]{1,39}$' then
    raise exception 'Choose a bank file format.' using errcode = '22023';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The file''s SHA-256 isn''t one.' using errcode = '22023';
  end if;
  if p_file_bytes is null or p_file_bytes <= 0 then
    raise exception 'The file is empty.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'The file''s items are missing.' using errcode = '22023';
  end if;
  if v_reason is not null and (
    char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v_reason ~* '(://|www\.)' or regexp_replace(v_reason, '[^0-9]', '', 'g') ~ '[0-9]{10}'
  ) then
    raise exception 'Say why in up to 500 characters, with no web addresses or account numbers.'
      using errcode = '22023';
  end if;

  v_run := private.payroll_lock_run(p_organisation_id, p_run_id);
  if v_run.status <> 'released' then
    raise exception 'A supplementary file is made once the run is released.' using errcode = 'MLAR2';
  end if;

  select s.* into v_active
  from public.payout_supplements s
  where s.organisation_id = p_organisation_id and s.run_id = p_run_id and s.status = 'active'
  for update;
  if v_active.id is not null and v_reason is null then
    raise exception 'This run already has a supplementary file waiting. Say why it is replaced.'
      using errcode = 'MLAR5';
  end if;
  if v_active.id is not null then
    select l.at into v_downloaded_at
    from public.audit_log l
    where l.organisation_id = p_organisation_id and l.action = 'payroll.supplementary_file_downloaded'
      and l.entity = 'payout_supplements' and l.entity_id = v_active.id
    order by l.at desc
    limit 1;
    if v_downloaded_at is not null then
      if not coalesce(p_not_uploaded, false) then
        raise exception 'The current supplementary file was downloaded. Confirm it wasn''t uploaded to the bank before replacing it, or two files may be paid.'
          using errcode = 'MLAR6';
      end if;
      v_reason := v_reason || ' (confirmed the replaced file was not uploaded to the bank)';
      if char_length(v_reason) > 500 then
        raise exception 'Say why in fewer words.' using errcode = '22023';
      end if;
    end if;
  end if;

  v_path := p_organisation_id::text || '/' || p_run_id::text || '/supplementary/'
    || p_supplement_id::text || '.csv';
  select o.metadata ->> 'size' into v_size
  from storage.objects o
  where o.bucket_id = 'payroll-files' and o.name = v_path;
  if v_size is null or v_size <> p_file_bytes::text then
    raise exception 'The supplementary file wasn''t stored. Try again.' using errcode = 'MLAR4';
  end if;

  -- The rows ready now and what the server sent must be the same set, item for item.
  begin
    select count(*) into v_given
    from jsonb_to_recordset(p_items) as g(
      payslip_id uuid, position integer, bank_name text, bank_code text, account_name text,
      bank_account_last4 text, bank_detail_change_id uuid, amount_kobo text
    );
  exception when others then
    raise exception 'The file''s items aren''t in the expected shape.' using errcode = '22023';
  end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'payslip_id', r.payslip_id, 'worker_id', r.worker_id,
      'original_item_id', r.original_item_id, 'net_kobo', r.net_kobo,
      'bank_name', r.bank_name, 'bank_code', r.bank_code, 'account_name', r.account_name,
      'bank_account_last4', r.bank_account_last4, 'bank_detail_change_id', r.bank_detail_change_id
    )), '[]'::jsonb)
  into v_rows
  from private.payout_supplement_rows(p_organisation_id, p_run_id) r
  where private.payout_supplement_ready(
    r.bank_account_enc, r.bank_name, r.bank_code, r.account_name, r.bank_account_last4, r.in_hold
  );

  v_ready := jsonb_array_length(v_rows);
  if v_ready = 0 then
    raise exception 'Nobody left out of this run''s bank file has bank details in force yet.'
      using errcode = 'MLAR3';
  end if;
  with g as (
    select * from jsonb_to_recordset(p_items) as x(
      payslip_id uuid, position integer, bank_name text, bank_code text, account_name text,
      bank_account_last4 text, bank_detail_change_id uuid, amount_kobo text
    )
  ),
  p as (
    select * from jsonb_to_recordset(v_rows) as y(
      payslip_id uuid, worker_id uuid, original_item_id uuid, net_kobo bigint, bank_name text,
      bank_code text, account_name text, bank_account_last4 text, bank_detail_change_id uuid
    )
  )
  select
    (select count(*) from g) = v_ready
    and (select count(distinct g.payslip_id) from g) = v_ready
    and (select count(distinct g.position) from g) = v_ready
    and not exists (
      select 1 from g
      where g.payslip_id is null or g.position is null or g.position < 1 or g.position > v_ready
    )
    and not exists (
      select 1
      from p
      left join g on g.payslip_id = p.payslip_id
      where g.payslip_id is null
        or (case when g.amount_kobo ~ '^[0-9]{1,15}$' then g.amount_kobo::bigint end)
          is distinct from p.net_kobo
        or (g.bank_name, g.bank_code, g.account_name, g.bank_account_last4, g.bank_detail_change_id)
          is distinct from
           (p.bank_name, p.bank_code, p.account_name, p.bank_account_last4, p.bank_detail_change_id)
    ),
    (select coalesce(sum(p.net_kobo), 0) from p)
  into v_matches, v_total;
  if not v_matches then
    raise exception 'The file doesn''t match the outstanding workers ready to pay and the bank details in force now. Try again.'
      using errcode = 'MLAR3';
  end if;

  if v_active.id is not null then
    update public.payout_supplements s
    set status = 'voided', voided_by = v_uid, voided_at = now(), void_reason = v_reason
    where s.id = v_active.id;
    update public.payout_supplement_items i
    set status = 'voided'
    where i.organisation_id = p_organisation_id and i.supplement_id = v_active.id
      and i.status = 'pending';
  end if;

  insert into public.payout_supplements (
    id, organisation_id, run_id, bank_format, file_path, file_sha256, file_bytes, item_count,
    total_kobo, made_by
  )
  values (
    p_supplement_id, p_organisation_id, p_run_id, p_bank_format, v_path, p_file_sha256,
    p_file_bytes, v_ready, v_total, v_uid
  );

  insert into public.payout_supplement_items (
    organisation_id, supplement_id, run_id, payslip_id, worker_id, original_item_id, position,
    bank_name, bank_code, account_name, bank_account_last4, bank_detail_change_id, amount_kobo
  )
  select p_organisation_id, p_supplement_id, p_run_id, p.payslip_id, p.worker_id,
    p.original_item_id, g.position, p.bank_name, p.bank_code, p.account_name,
    p.bank_account_last4, p.bank_detail_change_id, p.net_kobo
  from jsonb_to_recordset(v_rows) as p(
    payslip_id uuid, worker_id uuid, original_item_id uuid, net_kobo bigint, bank_name text,
    bank_code text, account_name text, bank_account_last4 text, bank_detail_change_id uuid
  )
  join jsonb_to_recordset(p_items) as g(
    payslip_id uuid, position integer, bank_name text, bank_code text, account_name text,
    bank_account_last4 text, bank_detail_change_id uuid, amount_kobo text
  ) on g.payslip_id = p.payslip_id
  order by g.position;

  perform private.log_audit_impl(
    p_organisation_id, 'payroll.supplementary_file_made', 'payout_supplements', p_supplement_id,
    null,
    jsonb_build_object(
      'run_id', p_run_id, 'supplement_id', p_supplement_id, 'bank_format', p_bank_format,
      'item_count', v_ready, 'total_kobo', v_total::text, 'file_sha256', p_file_sha256,
      'voided_supplement_id', v_active.id,
      'replaced_was_downloaded', v_downloaded_at is not null,
      'not_uploaded_attested', v_downloaded_at is not null and coalesce(p_not_uploaded, false)
    ),
    v_reason
  );

  return jsonb_build_object(
    'supplement_id', p_supplement_id, 'item_count', v_ready, 'total_kobo', v_total::text,
    'voided_supplement_id', v_active.id
  );
end;
$$;

revoke all on function private.make_payout_supplement(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  from public, anon;
grant execute on function private.make_payout_supplement(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  to authenticated;

create function public.make_payout_supplement(
  p_organisation_id uuid,
  p_run_id uuid,
  p_supplement_id uuid,
  p_bank_format text,
  p_file_sha256 text,
  p_file_bytes integer,
  p_items jsonb,
  p_void_reason text default null,
  p_not_uploaded boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.make_payout_supplement(
    p_organisation_id, p_run_id, p_supplement_id, p_bank_format, p_file_sha256, p_file_bytes,
    p_items, p_void_reason, p_not_uploaded
  )
$$;

revoke all on function public.make_payout_supplement(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  from public, anon;
grant execute on function public.make_payout_supplement(uuid, uuid, uuid, text, text, integer, jsonb, text, boolean)
  to authenticated;

-- A supplementary file's object name, for the server to open by a 60-second signed URL (owner or
-- finance, trusted session). Audited as payroll.supplementary_file_downloaded with the file id
-- only (and the reason once it is confirmed: it is paid, so it needs a reason, MLARB). A voided
-- file doesn't open.
create function private.payout_supplement_download(
  p_organisation_id uuid,
  p_supplement_id uuid,
  p_reason text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payout_maker(p_organisation_id);
  v_supplement public.payout_supplements%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select s.* into v_supplement
  from public.payout_supplements s
  where s.organisation_id = p_organisation_id and s.id = p_supplement_id;
  if v_supplement.id is null then
    raise exception 'That supplementary file wasn''t found.' using errcode = 'P0002';
  end if;
  if v_supplement.status = 'voided' then
    raise exception 'This file was replaced. Download the current one.' using errcode = 'MLAR2';
  end if;
  if v_reason is not null and (
    char_length(v_reason) > 500 or v_reason ~ '[\x01-\x1f\x7f-\x9f<>]'
    or v_reason ~* '(://|www\.)' or regexp_replace(v_reason, '[^0-9]', '', 'g') ~ '[0-9]{10}'
  ) then
    raise exception 'Say why in up to 500 characters, with no web addresses or account numbers.'
      using errcode = '22023';
  end if;
  if v_supplement.status = 'confirmed' and v_reason is null then
    raise exception 'This file is already paid. Say why you need it again; never upload it to the bank again.'
      using errcode = 'MLARB';
  end if;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.supplementary_file_downloaded', 'payout_supplements',
    v_supplement.id, null, jsonb_build_object('supplement_id', v_supplement.id), v_reason
  );
  return v_supplement.file_path;
end;
$$;

revoke all on function private.payout_supplement_download(uuid, uuid, text) from public, anon;
grant execute on function private.payout_supplement_download(uuid, uuid, text) to authenticated;

create function public.payout_supplement_download(
  p_organisation_id uuid,
  p_supplement_id uuid,
  p_reason text default null
)
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.payout_supplement_download(p_organisation_id, p_supplement_id, p_reason)
$$;

revoke all on function public.payout_supplement_download(uuid, uuid, text) from public, anon;
grant execute on function public.payout_supplement_download(uuid, uuid, text) to authenticated;

-- Who downloaded a run's supplementary files and when (owner, hr, finance), from the audit log.
create function private.payout_supplement_downloads(p_organisation_id uuid, p_run_id uuid)
returns table (supplement_id uuid, actor_id uuid, downloaded_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.session_uid() is null
    or not private.has_role(p_organisation_id, array['owner', 'hr', 'finance']) then
    raise exception 'Only an owner, HR or Finance sees bank file downloads.' using errcode = '42501';
  end if;
  return query
  select l.entity_id, l.actor_id, l.at
  from public.audit_log l
  join public.payout_supplements s on s.organisation_id = l.organisation_id and s.id = l.entity_id
  where l.organisation_id = p_organisation_id and s.run_id = p_run_id
    and l.action = 'payroll.supplementary_file_downloaded' and l.entity = 'payout_supplements'
  order by l.at desc
  limit 500;
end;
$$;

revoke all on function private.payout_supplement_downloads(uuid, uuid) from public, anon;
grant execute on function private.payout_supplement_downloads(uuid, uuid) to authenticated;

create function public.payout_supplement_downloads(p_organisation_id uuid, p_run_id uuid)
returns table (supplement_id uuid, actor_id uuid, downloaded_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.payout_supplement_downloads(p_organisation_id, p_run_id)
$$;

revoke all on function public.payout_supplement_downloads(uuid, uuid) from public, anon;
grant execute on function public.payout_supplement_downloads(uuid, uuid) to authenticated;

-- "I uploaded it to the bank" for a supplementary file: owner or finance in a trusted session,
-- naming the file by id and SHA-256 as the screen showed it. Refused: MLAR7 the file named isn't
-- the current one or its hash differs; MLAR8 whoever made it; MLAR9 anyone who prepared or
-- changed the run (5.4's release rule); MLARA nobody downloaded it. A retry of the same
-- confirmation returns the file id instead of failing. Audited as
-- payroll.supplementary_file_confirmed with the id, SHA-256 and control totals.
create function private.confirm_payout_supplement(
  p_organisation_id uuid,
  p_supplement_id uuid,
  p_file_sha256 text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_payout_maker(p_organisation_id);
  v_supplement public.payout_supplements%rowtype;
  v_run public.payroll_runs%rowtype;
begin
  if p_supplement_id is null or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Name the supplementary file you uploaded (its id and SHA-256).'
      using errcode = '22023';
  end if;
  select s.* into v_supplement
  from public.payout_supplements s
  where s.organisation_id = p_organisation_id and s.id = p_supplement_id;
  if v_supplement.id is null then
    raise exception 'That supplementary file wasn''t found.' using errcode = 'P0002';
  end if;
  v_run := private.payroll_lock_run(p_organisation_id, v_supplement.run_id);
  select s.* into v_supplement
  from public.payout_supplements s
  where s.organisation_id = p_organisation_id and s.id = p_supplement_id
  for update;
  if v_supplement.status = 'confirmed' and v_supplement.file_sha256 = p_file_sha256 then
    return v_supplement.id;
  end if;
  if v_supplement.status <> 'active' or v_supplement.file_sha256 <> p_file_sha256 then
    raise exception 'The supplementary file changed since you looked. Reload the page, check the control totals and confirm again.'
      using errcode = 'MLAR7';
  end if;
  if v_run.status <> 'released' then
    raise exception 'Only a released run''s supplementary file is confirmed.' using errcode = 'MLAR2';
  end if;
  if v_uid = v_supplement.made_by then
    raise exception 'You made this supplementary file, so a different person must confirm it went to the bank.'
      using errcode = 'MLAR8';
  end if;
  if v_uid = any (private.payroll_run_touchers(p_organisation_id, v_supplement.run_id)) then
    raise exception 'You prepared or changed this run, so a different person must confirm its supplementary file.'
      using errcode = 'MLAR9';
  end if;
  if not exists (
    select 1 from public.audit_log l
    where l.organisation_id = p_organisation_id
      and l.action = 'payroll.supplementary_file_downloaded'
      and l.entity = 'payout_supplements' and l.entity_id = v_supplement.id
  ) then
    raise exception 'Nobody has downloaded this supplementary file yet. Download it and upload it to the bank first.'
      using errcode = 'MLARA';
  end if;

  update public.payout_supplements s
  set status = 'confirmed', confirmed_at = now(), confirmed_by = v_uid
  where s.id = v_supplement.id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.supplementary_file_confirmed', 'payout_supplements',
    v_supplement.id, null,
    jsonb_build_object(
      'run_id', v_supplement.run_id, 'supplement_id', v_supplement.id,
      'item_count', v_supplement.item_count, 'total_kobo', v_supplement.total_kobo::text,
      'file_sha256', v_supplement.file_sha256
    ),
    null
  );
  return v_supplement.id;
end;
$$;

revoke all on function private.confirm_payout_supplement(uuid, uuid, text) from public, anon;
grant execute on function private.confirm_payout_supplement(uuid, uuid, text) to authenticated;

create function public.confirm_payout_supplement(
  p_organisation_id uuid,
  p_supplement_id uuid,
  p_file_sha256 text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.confirm_payout_supplement(p_organisation_id, p_supplement_id, p_file_sha256)
$$;

revoke all on function public.confirm_payout_supplement(uuid, uuid, text) from public, anon;
grant execute on function public.confirm_payout_supplement(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Sweeping bank files: supplementary files too
-- ---------------------------------------------------------------------------

-- 5.4's private.payroll_files_due (migration 20261122170000_payout_batches.sql), unchanged for
-- bank files, plus supplementary files at {organisation_id}/{run_id}/supplementary/{id}.csv: an
-- object there no supplementary file names, 15 minutes after it was stored, and the file of one
-- voided 7 days ago or more. Confirmed files stay (as a released run's bank file does).
create or replace function private.payroll_files_due(p_organisation_id uuid, p_limit integer)
returns table (organisation_id uuid, path text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uuid constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  if auth.uid() is not null or coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server sweeps bank files.' using errcode = '42501';
  end if;
  return query
  select d.org, d.name, d.why
  from (
    select split_part(o.name, '/', 1)::uuid as org, o.name, o.created_at,
      case when b.id is null then 'orphan' else 'voided' end as why
    from storage.objects o
    left join public.payout_batches b on b.file_path = o.name
    where o.bucket_id = 'payroll-files'
      and o.name ~ ('^' || v_uuid || '/' || v_uuid || '/' || v_uuid || '\.csv$')
      and (p_organisation_id is null or split_part(o.name, '/', 1) = p_organisation_id::text)
      and (
        (b.id is null and o.created_at < now() - interval '15 minutes')
        or (b.status = 'voided' and b.voided_at < now() - interval '7 days')
      )
    union all
    select split_part(o.name, '/', 1)::uuid, o.name, o.created_at,
      case when s.id is null then 'orphan' else 'voided' end
    from storage.objects o
    left join public.payout_supplements s on s.file_path = o.name
    where o.bucket_id = 'payroll-files'
      and o.name ~ ('^' || v_uuid || '/' || v_uuid || '/supplementary/' || v_uuid || '\.csv$')
      and (p_organisation_id is null or split_part(o.name, '/', 1) = p_organisation_id::text)
      and (
        (s.id is null and o.created_at < now() - interval '15 minutes')
        or (s.status = 'voided' and s.voided_at < now() - interval '7 days')
      )
  ) d
  order by d.created_at
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Remittance refunds and offsets (after 5.7a voids a reversed run's remittances)
-- ---------------------------------------------------------------------------

-- 5.7a (migration 20261122180000) voids a reversed run's remittances (statutory_remittance_voids)
-- and leaves a payment already recorded against one standing, as evidence. That money is with
-- the authority; the person resolves it in one of two ways (no rule decides which an authority
-- allows; RULES_NIGERIA open point 8, confirm with a tax adviser):
--   refund  a refund received from the authority, with its receipt (5.6's private
--           payroll-evidence bucket and receipt check), the date and amount received;
--   offset  set against a later standing remittance to the same authority (the same kind and
--           normalised authority key, 5.6's money review M2), which then owes that much less.
-- Insert-only, as payments are. A payment's refunds and offsets never exceed it; offsets into a
-- remittance never exceed what it owes less what was paid against it. 5.7a's
-- statutory_payments_not_voided already keeps the resolved payment from being voided (MLRVB).
-- record_statutory_payment (5.6's, latest) compares a
-- payment with what the remittance owes after offsets.
--
-- Refusals: MLARC the payment isn't a standing payment on a voided remittance; MLARD more than the
-- payment's unresolved amount; MLARE the offset target isn't a later standing remittance to the
-- same authority; MLARF more than the target still owes; MLARG the receipt isn't one the recorder
-- checked for this remittance in the last hour, or another record uses it; MLARI resolutions are kept as written.

create table public.statutory_payment_resolutions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  -- The standing payment on a voided remittance, and that remittance.
  payment_id uuid not null,
  remittance_id uuid not null,
  kind text not null constraint statutory_payment_resolutions_kind check (kind in ('refund', 'offset')),
  amount_kobo bigint not null
    constraint statutory_payment_resolutions_amount check (amount_kobo > 0 and amount_kobo <= 100000000000000),
  currency text not null default 'NGN'
    constraint statutory_payment_resolutions_currency check (currency = 'NGN'),
  -- A refund: when it arrived, the bank reference, the receipt.
  received_on date,
  reference text
    constraint statutory_payment_resolutions_reference check (
      char_length(reference) between 1 and 100 and reference !~ '[\x01-\x1f\x7f-\x9f<>]'
    ),
  receipt_id uuid,
  -- An offset: the later remittance it is set against.
  target_remittance_id uuid,
  note text
    constraint statutory_payment_resolutions_note check (
      char_length(note) between 1 and 500 and note !~ '[\x01-\x1f\x7f-\x9f<>]'
      and regexp_replace(note, '[^0-9]', '', 'g') !~ '[0-9]{10}'
    ),
  recorded_by uuid not null,
  created_at timestamptz not null default now(),
  constraint statutory_payment_resolutions_organisation_id_id_key unique (organisation_id, id),
  constraint statutory_payment_resolutions_payment_fkey foreign key (organisation_id, payment_id)
    references public.statutory_payments (organisation_id, id),
  constraint statutory_payment_resolutions_remittance_fkey foreign key (organisation_id, remittance_id)
    references public.statutory_remittances (organisation_id, id),
  constraint statutory_payment_resolutions_receipt_fkey foreign key (organisation_id, receipt_id)
    references public.statutory_receipts (organisation_id, id),
  constraint statutory_payment_resolutions_target_fkey foreign key (organisation_id, target_remittance_id)
    references public.statutory_remittances (organisation_id, id),
  -- A receipt backs one record.
  constraint statutory_payment_resolutions_receipt_key unique (receipt_id),
  constraint statutory_payment_resolutions_shape check (
    case kind
      when 'refund' then received_on is not null and receipt_id is not null
        and target_remittance_id is null
      else target_remittance_id is not null and received_on is null and receipt_id is null
        and reference is null
    end
  )
);

create index statutory_payment_resolutions_payment_idx
  on public.statutory_payment_resolutions (organisation_id, payment_id);
create index statutory_payment_resolutions_target_idx
  on public.statutory_payment_resolutions (organisation_id, target_remittance_id)
  where target_remittance_id is not null;

comment on table public.statutory_payment_resolutions is
  'A payment recorded against a remittance later voided by a reversal (slice 5.7c), resolved: a refund received from the authority with its receipt, or an offset against a later remittance to the same authority. Insert-only.';

-- A standing payment (recorded and not voided as wrong) on a remittance 5.7a voided. No role
-- check: definers call it.
create function private.payment_on_voided_remittance(p_organisation_id uuid, p_payment_id uuid)
returns table (payment_id uuid, remittance_id uuid, paid_kobo bigint, kind text, authority_key text, pay_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.remittance_id, p.paid_amount_kobo, m.kind, m.authority_key, r.pay_date
  from public.statutory_payments p
  join public.statutory_remittances m
    on m.organisation_id = p.organisation_id and m.id = p.remittance_id
  join public.payroll_runs r on r.organisation_id = m.organisation_id and r.id = m.run_id
  where p.organisation_id = p_organisation_id and p.id = p_payment_id and p.entry = 'payment'
    and exists (
      select 1 from public.statutory_remittance_voids v
      where v.organisation_id = m.organisation_id and v.remittance_id = m.id
    )
    and not exists (
      select 1 from public.statutory_payments x
      where x.organisation_id = p.organisation_id and x.voids_payment_id = p.id
    )
$$;

revoke all on function private.payment_on_voided_remittance(uuid, uuid) from public, anon, authenticated;

-- What a remittance still owes before any payment: its amount less offsets set against it.
create function private.remittance_offsets_in(p_organisation_id uuid, p_remittance_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(s.amount_kobo), 0)::bigint
  from public.statutory_payment_resolutions s
  where s.organisation_id = p_organisation_id and s.target_remittance_id = p_remittance_id
    and s.kind = 'offset'
$$;

revoke all on function private.remittance_offsets_in(uuid, uuid) from public, anon, authenticated;

-- Insert-only (MLARI), serialised per source payment and per target, and checked again here so no
-- path (the secret key or the database owner included) records more than the money allows.
create function private.statutory_payment_resolutions_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_src record;
  v_resolved bigint;
  v_target public.statutory_remittances%rowtype;
  v_target_run public.payroll_runs%rowtype;
  v_target_paid bigint;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Refunds and offsets are kept as written.' using errcode = 'MLARI';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('statutory_remittance:' || new.remittance_id::text, 0));
  if new.target_remittance_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('statutory_remittance:' || new.target_remittance_id::text, 0)
    );
  end if;
  select * into v_src from private.payment_on_voided_remittance(new.organisation_id, new.payment_id);
  if v_src.payment_id is null or v_src.remittance_id <> new.remittance_id then
    raise exception 'Only a payment recorded against a voided remittance is refunded or offset.'
      using errcode = 'MLARC';
  end if;
  select coalesce(sum(s.amount_kobo), 0) into v_resolved
  from public.statutory_payment_resolutions s
  where s.organisation_id = new.organisation_id and s.payment_id = new.payment_id;
  if v_resolved + new.amount_kobo > v_src.paid_kobo then
    raise exception 'That is more than the payment still to resolve.' using errcode = 'MLARD';
  end if;
  if new.kind = 'refund' then
    if not exists (
      select 1 from public.statutory_receipts c
      where c.organisation_id = new.organisation_id and c.id = new.receipt_id
        and c.remittance_id = new.remittance_id
    ) or exists (
      select 1 from public.statutory_payments p
      where p.organisation_id = new.organisation_id and p.receipt_id = new.receipt_id
    ) then
      raise exception 'The receipt isn''t one of this remittance''s.' using errcode = 'MLARG';
    end if;
  else
    select m.* into v_target
    from public.statutory_remittances m
    where m.organisation_id = new.organisation_id and m.id = new.target_remittance_id;
    select r.* into v_target_run
    from public.payroll_runs r
    where r.organisation_id = new.organisation_id and r.id = v_target.run_id;
    if v_target.id is null or v_target.id = new.remittance_id
      or v_target.kind <> v_src.kind
      or v_target.authority_key is distinct from v_src.authority_key
      or v_target_run.status not in ('approved', 'released')
      or v_target_run.pay_date < v_src.pay_date
      or exists (
        select 1 from public.statutory_remittance_voids v
        where v.organisation_id = v_target.organisation_id and v.remittance_id = v_target.id
      ) then
      raise exception 'An offset goes against a later remittance to the same authority that stands.'
        using errcode = 'MLARE';
    end if;
    select coalesce(sum(p.paid_amount_kobo), 0) into v_target_paid
    from public.statutory_payments p
    where p.organisation_id = new.organisation_id and p.remittance_id = v_target.id
      and p.entry = 'payment'
      and not exists (
        select 1 from public.statutory_payments x
        where x.organisation_id = p.organisation_id and x.voids_payment_id = p.id
      );
    if private.remittance_offsets_in(new.organisation_id, v_target.id) + v_target_paid
      + new.amount_kobo > v_target.amount_kobo then
      raise exception 'That is more than the later remittance still owes.' using errcode = 'MLARF';
    end if;
  end if;
  new.currency := 'NGN';
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.statutory_payment_resolutions_guard() from public, anon, authenticated;

create trigger statutory_payment_resolutions_guard
  before insert or update or delete on public.statutory_payment_resolutions
  for each row execute function private.statutory_payment_resolutions_guard();
create trigger statutory_payment_resolutions_no_truncate
  before truncate on public.statutory_payment_resolutions
  for each statement execute function private.statutory_no_truncate();
create trigger statutory_payment_resolutions_audit after insert on public.statutory_payment_resolutions
  for each row execute function private.audit_row_change();
alter table public.statutory_payment_resolutions enable always trigger statutory_payment_resolutions_guard;
alter table public.statutory_payment_resolutions
  enable always trigger statutory_payment_resolutions_no_truncate;

alter table public.statutory_payment_resolutions enable row level security;

create policy statutory_payment_resolutions_select on public.statutory_payment_resolutions
  for select to authenticated
  using (organisation_id in (select private.role_org_ids(array['owner', 'hr', 'finance'])));

revoke all on table public.statutory_payment_resolutions from anon, authenticated, service_role;
grant select on table public.statutory_payment_resolutions to authenticated, service_role;


-- Records a refund received from the authority for a payment on a voided remittance (owner, hr
-- or finance, trusted session): the date it arrived (from the payment's date to today, Lagos),
-- the amount (text, digits only), an optional reference, and a receipt the caller checked for
-- that remittance in the last hour that nothing else uses. Returns the record's id.
create function private.record_remittance_refund(
  p_organisation_id uuid,
  p_payment_id uuid,
  p_receipt_id uuid,
  p_received_on date,
  p_amount_kobo text,
  p_reference text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_remittance_recorder(p_organisation_id);
  v_src record;
  v_paid_on date;
  v_amount bigint;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_id uuid;
begin
  if p_payment_id is null or p_receipt_id is null then
    raise exception 'Choose the payment and the refund''s receipt.' using errcode = '22023';
  end if;
  select * into v_src from private.payment_on_voided_remittance(p_organisation_id, p_payment_id);
  if v_src.payment_id is null then
    raise exception 'Only a payment recorded against a voided remittance is refunded or offset.'
      using errcode = 'MLARC';
  end if;
  if p_amount_kobo is null or p_amount_kobo !~ '^[0-9]{1,15}$' or p_amount_kobo::bigint <= 0 then
    raise exception 'Enter the amount refunded, above ₦0.' using errcode = '22023';
  end if;
  v_amount := p_amount_kobo::bigint;
  select p.paid_on into v_paid_on from public.statutory_payments p
  where p.organisation_id = p_organisation_id and p.id = p_payment_id;
  if p_received_on is null or p_received_on > v_today or p_received_on < v_paid_on then
    raise exception 'The refund date is from the payment''s date to today.' using errcode = '22023';
  end if;
  if v_reference is not null and (char_length(v_reference) > 100 or v_reference ~ '[\x01-\x1f\x7f-\x9f<>]') then
    raise exception 'The reference is up to 100 characters, with no symbols like < or >.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.statutory_receipts c
    where c.organisation_id = p_organisation_id and c.id = p_receipt_id
      and c.remittance_id = v_src.remittance_id and c.checked_by = v_uid
      and c.created_at > now() - interval '1 hour'
  ) then
    raise exception 'Upload the refund''s receipt again, then record it.' using errcode = 'MLARG';
  end if;
  insert into public.statutory_payment_resolutions (
    organisation_id, payment_id, remittance_id, kind, amount_kobo, received_on, reference,
    receipt_id, recorded_by
  )
  values (
    p_organisation_id, p_payment_id, v_src.remittance_id, 'refund', v_amount, p_received_on,
    v_reference, p_receipt_id, v_uid
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.remittance_refund_recorded', 'statutory_remittances',
    v_src.remittance_id, null,
    jsonb_build_object(
      'resolution_id', v_id, 'payment_id', p_payment_id, 'receipt_id', p_receipt_id,
      'received_on', p_received_on, 'amount_kobo', v_amount::text, 'kind', v_src.kind
    ),
    null
  );
  return v_id;
end;
$$;

revoke all on function private.record_remittance_refund(uuid, uuid, uuid, date, text, text) from public, anon;
grant execute on function private.record_remittance_refund(uuid, uuid, uuid, date, text, text) to authenticated;

create function public.record_remittance_refund(
  p_organisation_id uuid,
  p_payment_id uuid,
  p_receipt_id uuid,
  p_received_on date,
  p_amount_kobo text,
  p_reference text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_remittance_refund(
    p_organisation_id, p_payment_id, p_receipt_id, p_received_on, p_amount_kobo, p_reference
  )
$$;

revoke all on function public.record_remittance_refund(uuid, uuid, uuid, date, text, text) from public, anon;
grant execute on function public.record_remittance_refund(uuid, uuid, uuid, date, text, text) to authenticated;

-- Offsets part or all of a payment on a voided remittance against a later standing remittance to
-- the same authority (owner, hr or finance, trusted session), with a note saying why. Returns
-- the record's id.
create function private.record_remittance_offset(
  p_organisation_id uuid,
  p_payment_id uuid,
  p_target_remittance_id uuid,
  p_amount_kobo text,
  p_note text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_remittance_recorder(p_organisation_id);
  v_src record;
  v_amount bigint;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid;
begin
  if p_payment_id is null or p_target_remittance_id is null then
    raise exception 'Choose the payment and the remittance to offset it against.' using errcode = '22023';
  end if;
  select * into v_src from private.payment_on_voided_remittance(p_organisation_id, p_payment_id);
  if v_src.payment_id is null then
    raise exception 'Only a payment recorded against a voided remittance is refunded or offset.'
      using errcode = 'MLARC';
  end if;
  if p_amount_kobo is null or p_amount_kobo !~ '^[0-9]{1,15}$' or p_amount_kobo::bigint <= 0 then
    raise exception 'Enter the amount to offset, above ₦0.' using errcode = '22023';
  end if;
  v_amount := p_amount_kobo::bigint;
  if v_note is null or char_length(v_note) > 500 or v_note ~ '[\x01-\x1f\x7f-\x9f<>]'
    or regexp_replace(v_note, '[^0-9]', '', 'g') ~ '[0-9]{10}' then
    raise exception 'Say why it is offset (for example, what the authority agreed), in up to 500 characters with no account numbers.'
      using errcode = '22023';
  end if;
  insert into public.statutory_payment_resolutions (
    organisation_id, payment_id, remittance_id, kind, amount_kobo, target_remittance_id, note,
    recorded_by
  )
  values (
    p_organisation_id, p_payment_id, v_src.remittance_id, 'offset', v_amount,
    p_target_remittance_id, v_note, v_uid
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.remittance_offset_recorded', 'statutory_remittances',
    v_src.remittance_id, null,
    jsonb_build_object(
      'resolution_id', v_id, 'payment_id', p_payment_id,
      'target_remittance_id', p_target_remittance_id, 'amount_kobo', v_amount::text,
      'kind', v_src.kind
    ),
    v_note
  );
  return v_id;
end;
$$;

revoke all on function private.record_remittance_offset(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function private.record_remittance_offset(uuid, uuid, uuid, text, text) to authenticated;

create function public.record_remittance_offset(
  p_organisation_id uuid,
  p_payment_id uuid,
  p_target_remittance_id uuid,
  p_amount_kobo text,
  p_note text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_remittance_offset(
    p_organisation_id, p_payment_id, p_target_remittance_id, p_amount_kobo, p_note
  )
$$;

revoke all on function public.record_remittance_offset(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.record_remittance_offset(uuid, uuid, uuid, text, text) to authenticated;

-- private.record_statutory_payment: its latest version (5.6's, migration
-- 20261122160000_statutory_remittances.sql), copied exactly except that the amount due it compares
-- with (MLSR8) and audits is the remittance's amount less offsets set against it (slice 5.7c).
create or replace function private.record_statutory_payment(
  p_organisation_id uuid,
  p_remittance_id uuid,
  p_receipt_id uuid,
  p_paid_on date,
  p_paid_amount_kobo text,
  p_reference text,
  p_amount_differs boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_remittance_recorder(p_organisation_id);
  v_rem public.statutory_remittances%rowtype;
  v_run public.payroll_runs%rowtype;
  v_amount bigint;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_id uuid;
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_due bigint;
begin
  if p_remittance_id is null or p_receipt_id is null then
    raise exception 'Choose the remittance and its receipt.' using errcode = '22023';
  end if;
  select r.* into v_rem
  from public.statutory_remittances r
  where r.organisation_id = p_organisation_id and r.id = p_remittance_id;
  if v_rem.id is null then
    raise exception 'That remittance wasn''t found.' using errcode = 'P0002';
  end if;
  select r.* into v_run
  from public.payroll_runs r
  where r.organisation_id = p_organisation_id and r.id = v_rem.run_id;
  if v_run.id is null or v_run.status not in ('approved', 'released') then
    raise exception 'This remittance''s payroll run isn''t posted any more, so nothing is recorded against it.'
      using errcode = 'MLSR9';
  end if;
  if p_paid_amount_kobo is null or p_paid_amount_kobo !~ '^[0-9]{1,15}$' then
    raise exception 'Enter the amount paid.' using errcode = 'MLSR3';
  end if;
  v_amount := p_paid_amount_kobo::bigint;
  if v_amount <= 0 or v_amount > 100000000000000 then
    raise exception 'Enter the amount paid, above ₦0.' using errcode = 'MLSR3';
  end if;
  if p_paid_on is null or p_paid_on > v_today or p_paid_on < v_run.period_start then
    raise exception 'The payment date is from the pay period''s start to today.' using errcode = 'MLSR3';
  end if;
  -- Slice 5.7c: what the remittance owes after offsets set against it.
  v_due := v_rem.amount_kobo - private.remittance_offsets_in(p_organisation_id, p_remittance_id);
  if v_amount <> v_due and not coalesce(p_amount_differs, false) then
    raise exception 'The amount paid isn''t the amount due. Tick that it differs to record it as it is.'
      using errcode = 'MLSR8';
  end if;
  if v_reference is not null and (
    char_length(v_reference) > 100 or v_reference ~ '[\x01-\x1f\x7f-\x9f<>]'
  ) then
    raise exception 'The reference is up to 100 characters, with no symbols like < or >.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.statutory_receipts c
    where c.organisation_id = p_organisation_id and c.id = p_receipt_id
      and c.remittance_id = p_remittance_id and c.checked_by = v_uid
      and c.created_at > now() - interval '1 hour'
  ) or exists (
    select 1 from public.statutory_payments p
    where p.organisation_id = p_organisation_id and p.receipt_id = p_receipt_id
  ) then
    raise exception 'Upload the receipt again, then record the payment.' using errcode = 'MLSR2';
  end if;

  insert into public.statutory_payments (
    organisation_id, remittance_id, entry, paid_on, paid_amount_kobo, reference, receipt_id,
    recorded_by
  )
  values (
    p_organisation_id, p_remittance_id, 'payment', p_paid_on, v_amount, v_reference, p_receipt_id,
    v_uid
  )
  returning id into v_id;
  perform private.log_audit_impl(
    p_organisation_id, 'payroll.remittance_paid', 'statutory_remittances', p_remittance_id, null,
    jsonb_build_object(
      'payment_id', v_id, 'receipt_id', p_receipt_id, 'kind', v_rem.kind, 'run_id', v_rem.run_id,
      'paid_on', p_paid_on, 'paid_amount_kobo', v_amount::text,
      'amount_due_kobo', v_due::text,
      'amount_differs', v_amount <> v_due,
      'difference_kobo', (v_amount - v_due)::text
    ),
    null
  );
  return v_id;
end;
$$;
