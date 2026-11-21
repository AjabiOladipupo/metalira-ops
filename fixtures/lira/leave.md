# Lira test questions: leave requests and balances

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). Capabilities are named as in `src/server/capabilities/registry.ts`. Deciding leave is a person's decision: `leave.decide_line_manager`, `leave.decide_hr`, `leave.cancel` and `leave.adjust_balance` are `agent: false`, so Lira explains and links to the screen, and never approves, declines, cancels or adjusts. Reads never show reasons or notes.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | hr | Who is on leave today? | Answer from `leave.summary` and `leave.requests` (status approved, today's date): "2 people are on leave today: Ada Obi (Annual, 30 Nov to 2 Dec) and Musa Bello (Sick, 1 Dec)." No change. |
| 2 | line_manager | What leave do I need to approve? | Answer from `leave.requests` (status waiting) with only the rows marked yours to decide: "1 request waits for you: Ada Obi, Annual, 3 working days, 30 Nov to 2 Dec." Lira links to `/app/leave/<id>` and does not offer to approve: approving is the line manager's own decision. |
| 3 | hr | Approve Ada's annual leave. | No card. Lira says the final approval is HR's decision on the screen and links to `/app/leave/<id>`, where the preview shows "Approves 3 days: the balance goes from 15 to 12." Nothing changes. |
| 4 | owner | How many days of annual leave does Ada have left? | Answer from `leave.balances` for Ada: "12 of 15 annual days left this year; 0 waiting for a decision." No change. |
| 5 | ops_manager | Why is Musa off next week? | Lira answers the dates and type from `leave.requests` ("Sick leave, 7 to 9 Dec, approved") and says ops managers see dates and type only, not the reason. |
| 6 | hr | Give Ada 2 extra days for long service. | No card: `leave.adjust_balance` is kept to HR on the screen. Lira links to `/app/leave/balances?worker=<id>` and says the reason is kept in the ledger and a balance can't go below 0. |
| 7 | line_manager | Approve my own annual leave. | Refused: nobody decides their own leave (MLLQ6). Lira says it goes to the owner, an admin or an ops manager first, then HR. |
| 8 | hr | What happens to Musa's shifts if I approve his leave? | Lira reads the request (`leave.requests`) and points to `/app/leave/<id>`, where the preview from `leave.decide_hr` lists them: "Opens 3 shifts: Gate A · Day, 24 to 26 Nov; they go back to uncovered and ops is emailed." No change: the final approval stays with HR. |
| 9 | ops_manager | Which shifts are open at Apapa this week because of leave? | Answer from `roster.week` for the site: the Uncovered places, naming the ones marked On leave ("Gate A · Day, Tue 24 to Thu 26 Nov: Musa Ibrahim is on approved leave"). No change. |
| 10 | ops_manager | Who can cover Gate A day on Tuesday? | Answer from `roster.suggestions`: workers on approved leave that day are left out; a worker with leave waiting for a decision is listed last with "Leave waiting for a decision 24 Nov". Lira may offer `roster.assign` for the top suggestion. |
| 11 | ops_manager | Put Musa on Gate A night on Wednesday. | `roster.assign` is refused by the database (MLRSL): "On approved leave 24 to 26 Nov." Lira says so and suggests someone free from `roster.suggestions`. |
| 12 | owner | HR cancelled Musa's leave. Are his shifts back? | No: cancelling leave gives the days back but doesn't put him back on shifts that were opened (others may have filled them). Lira answers from `roster.week` and offers `roster.assign` for any place still open. |
