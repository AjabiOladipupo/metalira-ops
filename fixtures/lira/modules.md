# Lira test questions: business type and module switches (slice 3.0)

Realistic manager requests about turning parts of the app on or off, with the outcome Lira must
reach. Lira runs as the signed-in user, shows a confirmation card (built from
`previewSetModules`, the same sentence as the Modules form's confirm step) before the write, and
calls `company.set_modules` only after the person confirms. Turning a part off never deletes
anything.

1. **Owner of a security company, everything on:** "We don't use the roster. Switch it off."
   - Expected: card "Turns off 1 part: Shifts. Their pages leave the menu and nothing is deleted; turning it back on shows everything again." with the change Shifts On → Off. On confirm: `set_company_modules(shifts false, people true, payroll true)`, audited `company.modules_changed`. Roster and Live attendance leave the menu; workers lose Clock and My shifts.

2. **Owner of a design studio (services, everything off):** "We've hired two people. Turn on payroll."
   - Expected: explains that Payroll needs People, and offers one card that turns on both: "Turns on 2 parts: People and Payroll." No write until confirmed. Never sends Payroll on with People off (the database would refuse it, MLMO1).

3. **Admin:** "Turn off People but keep Payroll running."
   - Expected: refused before any card: "Payroll needs People. Turn People on, or turn Payroll off." (`modulesProblem`, the same words as MLMO1.)

4. **ops_manager:** "Switch off Payroll, we don't use it."
   - Expected: refused: only an owner or an admin can switch parts of the app on or off. Lira says who can (the company's owners and admins) and links nothing it can't open.

5. **HR manager:** "Which parts of the app do we have on?"
   - Expected: read only: "Shifts on, People on, Payroll off." from the company row. No card, no write.

6. **Owner, Shifts off since last month:** "Did we lose the old rosters when we turned shifts off?"
   - Expected: "No. Turning a part off deletes nothing; turning Shifts back on shows every roster and clock-in again." Offers the card for turning Shifts on if asked.

7. **Owner, during setup:** "We're a consultancy, not a staffing company."
   - Expected: points to Setup step 2, "What does your business do?", and suggests "We deliver services or projects to clients". Changing the answer during setup is a business-details save (`company.save_business`): while setup is unfinished it sets Shifts, People and Payroll to off and drops the Employees step. Lira shows that in the card before saving.

8. **Owner, with people rostered for next week:** "Turn off shifts."
   - Expected: refused with the database's message (MLMO3), for example "12 assigned shifts are still on the roster from 24 Nov 2026. Remove them before turning Shifts off."; nothing changes until they are removed.
