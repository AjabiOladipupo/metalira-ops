-- Slice 3.1: attendance settings on the company (owner decision, 20 Nov 2026).
--
-- * late_grace_minutes: a clock-in this many minutes after the shift starts still counts as on
--   time. Default 10, 0 to 120.
-- * no_show_after_minutes: with no clock-in this many minutes after the shift starts, the worker
--   shows as a no-show on the live board (slice 3.7). Default 60, 15 to 480, and never shorter
--   than the grace period.
--
-- Owner and admin change them in Settings -> Company -> Attendance, through the existing
-- organisations_update policy (owner, admin) and a column grant; the organisations_audit trigger
-- logs each change.

alter table public.organisations
  add column late_grace_minutes smallint not null default 10
    constraint organisations_late_grace_range check (late_grace_minutes between 0 and 120),
  add column no_show_after_minutes smallint not null default 60
    constraint organisations_no_show_range check (no_show_after_minutes between 15 and 480),
  add constraint organisations_no_show_after_grace check (no_show_after_minutes >= late_grace_minutes);

comment on column public.organisations.late_grace_minutes is
  'Minutes after a shift starts that a clock-in still counts as on time (0 to 120).';
comment on column public.organisations.no_show_after_minutes is
  'Minutes after a shift starts with no clock-in before the worker shows as a no-show (15 to 480, at least the grace period).';

grant update (late_grace_minutes, no_show_after_minutes) on table public.organisations to authenticated;
