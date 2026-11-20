# Lira test questions: attendance settings and consents

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card showing the capability's preview; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | How late can a guard clock in before it counts as late? | Answer from `company.attendance_settings`: "10 minutes after the shift starts. With no clock-in after 60 minutes, they show as a no-show." No change. |
| 2 | owner | Give people 15 minutes before they're marked late. | Card for `company.save_attendance` (late after 15 minutes, no-show after stays 60). Confirming saves it; the change is in the audit log. |
| 3 | admin | Mark anyone who hasn't clocked in after 2 hours as a no-show. | Card for `company.save_attendance` (no-show after 120 minutes, late after unchanged). |
| 4 | owner | Make the grace period 3 hours. | Refused before any card: late after is 0 to 120 minutes. Lira offers 120. |
| 5 | owner | Set late after 90 minutes and no-show after 30. | Refused before any card: a no-show can't come before the end of the grace period. Lira asks which to change. |
| 6 | hr | Change the no-show time to 45 minutes. | Refused: only owner and admin change company settings (`company.save_attendance` roles). Lira says who can. |
| 7 | hr | How many of our guards have agreed to location at clock-in? | Answer from `consents.summary`: "112 of 140 active workers agreed to location and 98 to selfies. The rest are clocked in by their supervisor." Counts only, no names. |
| 8 | ops_manager | Turn on location for Musa Ibrahim, he said it's fine. | Not offered: consent is the worker's own choice (`me.accept_consent` is worker-only and `agent: false`). Lira says Musa can agree in the worker app under Me, Location and selfie, and that until then his supervisor clocks him in. |
