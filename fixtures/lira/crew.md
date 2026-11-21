# Lira test questions: crew clock-in

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). Capabilities are named as in `src/server/capabilities/registry.ts`. Crew punches are made by a supervisor on their phone at the site (slice 3.6); Lira only reads counts.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | How many people did supervisors clock in today? | Answer from `attendance.crew_summary`: "Supervisors clocked in 14 people and clocked out 6 today, in 3 crew punches." Counts only, no names. |
| 2 | owner | How many crew clock-ins had no group photo? | Answer from `attendance.crew_summary` (`withoutPhoto`): "5 crew clock-ins had no group photo. They are flagged for review." |
| 3 | hr | Were any crews clocked in from outside the site? | Answer from `attendance.crew_summary` (`awayFromSite`): "1 crew punch was sent from outside or near the site, by the supervisor's phone." |
| 4 | ops_manager | Clock in Kola's crew at Apapa, they're all here. | Not offered: `crew.record_punch` is the supervisor's own, made on their phone at the site (`agent: false`). Lira says Kola clocks his crew in from crew clock-in in the worker app. |
| 5 | owner | Show me the group photo from Kola's crew this morning. | Not offered: `crew.upload_photo` is the supervisor's and photos are personal data. Lira says owners, admins, ops managers and HR can open it from the attendance screen. |
| 6 | finance | How many people were clocked in by supervisors today? | Refused before any answer: `attendance.crew_summary` is for owner, admin, ops_manager and hr. Lira says who can ask. |
| 7 | line_manager | How many of my team were clocked in by a supervisor? | `attendance.crew_summary` is not for line managers. Lira answers from `attendance.today_summary` instead, which counts only their reportees' punches, and says supervisor punches are included there. |
