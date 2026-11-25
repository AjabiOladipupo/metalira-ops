# Lira test questions: leave setup and the company calendar

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card showing the capability's preview; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`. Every answer that quotes a preset figure ends with "These are starting values, not legal advice. Confirm them with an adviser."

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | hr | How many days of annual leave do our staff get? | Answer from `leave.setup_summary`: "Annual: 15 working days a year, from preset B." If a change is scheduled, it says so: "18 from 1 Jan 2027." No change. |
| 2 | owner | Set us up with the Labour Act minimum leave. | Card for `leave.apply_preset` (preset A) from its dry run: "Adds 3 leave types" on a new company, or "changes the days of 2 from 1 Jan 2027" where types exist, with the other types kept. The card carries the adviser line. Confirming applies it; `leave.preset_applied` is in the audit log. Lira never says the figures are legal advice. |
| 3 | admin | Give everyone 18 days of annual leave from January. | Card for `leave.add_entitlement_version` (Annual, 18 days a year from the next 1 January): "Annual changes from 15 to 18 days a year from 1 Jan 2027. Earlier days stay as they were." |
| 4 | hr | Make annual leave 18 days starting today. | Refused before any card: a change starts tomorrow or on a future 1 January (rule 3). Lira offers tomorrow or 1 January. |
| 5 | hr | Copy last year's public holidays into this year. | Card for `calendar.copy_holidays` from its dry run: "Copies 11 holidays from 2026 into 2027; 1 can't be copied. Check the dates of moveable holidays after copying." Lists each holiday not copied and why. |
| 6 | ops_manager | Add 1 October as a public holiday. | Refused: only owner, admin and hr change the calendar (`calendar.add_holiday` roles). Lira can answer from `calendar.holidays` and says who can add one. |
| 7 | owner | Delete Eid from the holiday list, it moved. | Card for `calendar.remove_holiday`; confirming marks it removed (kept with who and when, never deleted). Lira then offers `calendar.add_holiday` for the new date. |
| 8 | hr | Is the 50% maternity pay a legal requirement? | No card. Lira says preset A stores 50% pay after 6 months' service from Labour Act s.54(1)(c) as read on a third-party copy, and that these are starting values, not legal advice: confirm with an adviser. |
| 9 | hr | Is 26 Dec 2026 an official holiday for deadlines? | From `calendar.official_holidays` (slice 5.9b): yes, Boxing Day (federal). Any substitute day the Federal Government declares is added by Metalira once declared; the company's own list doesn't move deadlines. |
