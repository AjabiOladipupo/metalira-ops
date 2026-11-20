-- Local and CI databases only (`supabase db reset`, `supabase start`). Never applied to the
-- hosted project, which gets migrations only.
--
-- Slice 2.3b: lets account name lookups from the test resolver (no provider keys) and the
-- provider's sandbox back requests and approvals, so tests and local development work. On the
-- hosted project this row is absent: test and sandbox answers can be shown but never used.
insert into private.settings (key, value)
values ('allow_test_bank_lookups', 'on')
on conflict (key) do update set value = excluded.value;
