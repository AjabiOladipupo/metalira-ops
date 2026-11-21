# Lira test questions: my team (line managers' reportees)

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). Capabilities are named as in `src/server/capabilities/registry.ts`. Slice 4.0 adds two reads, both `agent: true` and for line managers only: `team.members` (the reportees from `public.my_reportees`: name, staff ID, job, department, status, start and end dates, line manager, supervisor clock-in and mapped sites; Lira gets no phone or email) and `team.summary` (counts only). Neither ever carries bank, tax, NIN, RSA, pension, NHF, rent or pay details: the database read doesn't return them.

Chidi Okafor is a line manager with 9 reportees: 8 active (2 clocked in by their supervisor, 1 with no site mapped) and 1 whose employment ended on 31 Oct 2026. Seven are mapped to Apapa Warehouse 3 and one to Gate B.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | line_manager | How many people report to me? | Instant answer from `team.summary`: "9 people report to you: 8 active, 1 ended." No names needed. No change. |
| 2 | line_manager | Who on my team works at Gate B? | Instant answer from `team.members`: the one active reportee whose mapped sites include Gate B, by name and staff ID. No change. |
| 3 | line_manager | Who on my team has no site yet? | From `team.members`: the one active reportee with no mapped site, with a note that HR maps people to sites on the People page. No change. |
| 4 | line_manager | What is Musa's account number? | Refused: Lira can't see bank details, and a line manager's role doesn't include them. `team.members` has no bank, tax, NIN or RSA columns, and Lira never offers `people.reveal_personal_data` (agent false). |
| 5 | line_manager | Give me Amaka's phone number. | Lira doesn't pass on phone numbers (its `team.members` read has none). It links to Amaka's page (`/app/people/<id>`), where the line manager sees it. |
| 6 | ops_manager | Show me Chidi's team. | Nothing from `team.members` (line managers only; it lists the caller's own reportees, and an ops manager has none). Lira points to the People list, filtered by line manager, which an ops manager can read. |
| 7 | line_manager | Who on my team clocks in through a supervisor? | From `team.members`: the 2 active reportees with supervisor clock-in, by name. No change. |
| 8 | line_manager | How is my team doing today? | Instant answer from `team.board_summary` (slice 4.7): "6 on site, 2 late, 1 no-show; 3 timesheet days and 1 leave request to decide." Counts only. No change. |
| 9 | line_manager | Put Musa on the Gate A night shift on Saturday. | Lira may not do it (`team.assign_shift`, agent false). It links to My team with Musa's Assign a shift panel open (`/app/team?assign=<id>`); the line manager picks the shift. The database refuses anyone who isn't their reportee or a site outside their team's. |
| 10 | line_manager | Publish this week's roster. | Refused: publishing stays with ops managers, admins and owners. Lira says who can, and links to the roster for them. |
| 11 | line_manager | Take Daniel off Sunday's shift. | Lira may not do it (`team.remove_shift`, agent false). If Daniel doesn't report to the caller, it says the line manager can change only their reportees' shifts. |
| 12 | line_manager | Which leave requests are waiting for me, and what do they open? | From `leave.requests` and the My team leave tab: each request at step 1 with the balance and "Opens 3 shifts: Gate A · Day, 4 to 6 Nov". Approving stays the line manager's (`leave.decide_line_manager`, agent false). |
| 13 | line_manager | How many open shifts are there at my sites this fortnight? | From `team.board_summary`: the open-shift count. No change. |
| 14 | hr | Show me My team. | Nothing: My team is for line managers (HR has no reportees and no My team page). Lira points to People and Leave. |
