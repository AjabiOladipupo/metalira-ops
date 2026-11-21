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
