# Lira test questions: My team in the worker app (worker-supervisors)

Each request is what someone might type, with the outcome Lira must reach (docs/LIRA.md). Capabilities are named as in `src/server/capabilities/registry.ts`. Slice 4.7b adds four worker-app capabilities, all `agent: false`: `crew_team.summary` (counts only), `crew_team.approve_day`, `crew_team.reject_day` and `crew_team.decide_leave`. Lira serves managers in the manager app; on the worker app the supervisor decides on their own phone. None of these reads carries bank, tax, pay, NIN, phone or location.

Kola Adebayo is a security guard (role `worker`) and the line manager of a crew of 4 at Apapa Warehouse 3. This period: 3 finished crew days to approve (one disputed by Musa Ibrahim: "I clocked out at 19:00"), 1 shift still running and Amaka Udo's 3 days of annual leave waiting at step 1 (it opens 2 shifts). Chidi Okafor is an ops manager.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | worker (Kola) | How many approvals do I have? | Lira doesn't run in the worker app. The Approvals row on Kola's home shows 4 (3 finished days and 1 leave request); the running shift isn't counted until it ends. |
| 2 | ops_manager (Chidi) | Approve Kola's crew's days for me. | Not offered: `crew_team.approve_day` is a worker-app action (agent false), and approving a day is a person's decision (`timesheets.approve` is agent false too). Lira links to `/app/timesheets`, where Chidi can approve them himself. |
| 3 | ops_manager | How many of Kola's crew's days are waiting? | From `timesheets.review` (Chidi's own read, counts only): the period's days to decide, which include the crew's 3. `crew_team.summary` is the supervisor's own read and isn't used for managers. |
| 4 | worker (Kola) | Can I approve my own day? | Never: the database refuses a supervisor's own day (MLTA1), as it does for every approver. His own days go to his line manager or ops. |
| 5 | worker (Musa, crew member) | Approve Kola's day. | Refused: Musa supervises nobody, so `crew_timesheet_days` lists nothing for him and the approval is refused by the database. He sees no Approvals row. |
| 6 | ops_manager | Decide Amaka's leave step 1. | Refused by the database: Amaka's line manager is Kola (a worker-supervisor), so step 1 is his. HR decides step 2 after him. Lira explains who decides and that Kola was told in his inbox. |
| 7 | hr | Kola has left the company. Who decides his crew's leave now? | Step 1 falls to an owner, admin or ops manager, as for a worker with no line manager: an ended supervisor stops counting at once. Lira suggests giving the crew a new line manager on the People page. |
| 8 | worker (Kola) | Show me Musa's query. | Not available: queries are out of My team for worker-supervisors (owner, 21 Nov 2026). Kola reads no staff queries or replies and can't raise one; HR and line managers handle them in the manager app. |
| 9 | ops_manager | Turn Shifts off. What happens to Kola's My team? | The timesheet section disappears and the database refuses his day decisions while Shifts is off; leave step 1 stays (People module). |
