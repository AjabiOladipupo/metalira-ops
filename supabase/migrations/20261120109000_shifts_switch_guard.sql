-- Slice 3.0 follow-up, after slice 3.2 (roster): fills the Phase 3 hook from
-- 20261120100000_business_type_modules.
--
-- private.assert_shifts_can_be_switched_off refuses (SQLSTATE MLMO3) while the company has
-- people assigned to shifts today or later (shift_assignments with status 'assigned' and a
-- shift_date on or after the company's own today, private.org_today). Past shifts never block:
-- turning Shifts off deletes nothing and keeps the history. The message gives the count and the
-- first date so the owner knows what to remove.
--
-- This file's timestamp sits before 3.2's roster migration (slice 3.0's assigned range). A
-- plpgsql body is resolved when it runs, not when it is created, so the reference to
-- public.shift_assignments is fine on a fresh database; nothing calls the function until the
-- roster exists.

create or replace function private.assert_shifts_can_be_switched_off(p_organisation_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_first date;
begin
  select count(*), min(a.shift_date)
  into v_count, v_first
  from public.shift_assignments a
  where a.organisation_id = p_organisation_id
    and a.status = 'assigned'
    and a.shift_date >= private.org_today(p_organisation_id);

  if v_count > 0 then
    raise exception '% % still on the roster from %. Remove them before turning Shifts off.',
      v_count,
      case when v_count = 1 then 'assigned shift is' else 'assigned shifts are' end,
      to_char(v_first, 'FMDD Mon YYYY')
      using errcode = 'MLMO3';
  end if;
end;
$$;

revoke all on function private.assert_shifts_can_be_switched_off(uuid) from public, anon, authenticated;
