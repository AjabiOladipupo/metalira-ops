# Lira test questions: headcount

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card showing the capability's preview; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`. Headcount rows are written one at a time (`headcount.add`, `headcount.update`, `headcount.remove`, kind `write`, `agent: true`), each with a preview from `previewHeadcountChange` that names the row and gives the weekly total before and after. Amounts come from the stored kobo through `src/lib/headcount.ts`, never recalculated by the model.

The Coastline contract below is a draft manned-post contract at Apapa Warehouse 3 and Gate B, with Guard · Day ₦12,500 and Guard · Night ₦15,000 a shift.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | Coastline needs one guard at Gate A, Apapa, every day 6am to 6pm. | Card for `headcount.add`: "Adds Gate A · Day at Apapa Warehouse 3. 1 post · 7 shifts a week · ₦87,500 a week at today's rates." Confirming adds the row (role Guard, band Day, per shift, every day, 06:00–18:00, 1 person). |
| 2 | ops_manager | And a night guard there, 6pm to 6am. | Card for `headcount.add` with "Every day 18:00–06:00 (next day) × 1: 7 shifts a week · ₦105,000 a week" and the weekly total moving from ₦87,500 to ₦192,500. The shift belongs to the day it starts. |
| 3 | ops_manager | Add a supervisor at Gate B, weekdays 8 to 5. | Card for `headcount.add` that flags it before confirming: "1 row has no rate", with "No rate for Guard · Supervisor". Lira says activation will refuse it until a Guard · Supervisor (shift) line is on the rate card, and links to the Rate card tab (rate changes are `money`, kept to people). |
| 4 | finance | What does Coastline's headcount come to a week? | Instant answer from `headcount.for_contract`: "4 posts · 28 shifts a week · ₦385,000 a week at today's rates", without VAT, with the per-site lines. No change. |
| 5 | owner | Which contracts have headcount with no rate? | Instant answer from `headcount.summary` (`contractsWithUnpricedRows`, `unpricedRows`), counts only, with a link to /app/clients. No change. |
| 6 | ops_manager | Make the Gate A night post two guards. | Card for `headcount.update`: "Changes Gate A · Night at Apapa Warehouse 3", × 1 → × 2, 7 → 14 shifts a week, ₦105,000 → ₦210,000 a week, and the new weekly total. Refused on a live contract (below). |
| 7 | ops_manager | Take the patrol off Gate B. | Card for `headcount.remove` naming "Patrol · Night at Gate B" and the weekly total after. Confirming removes the draft row (audited with before). |
| 8 | ops_manager | Add another guard at Gate A on the active Greenfield contract. | Refused before any card: the contract is live, so its headcount is frozen (the database refuses with MLHC1). Lira says live posts change from the contract page once slice 2.8 lands. |
| 9 | ops_manager | Take Gate B off the Coastline contract. | Refused while Gate B has headcount: "Remove the headcount at Gate B first (2 rows)." (MLHC2). Lira offers `headcount.remove` cards for those rows first. |
| 10 | hr | How many guards does Coastline need at night? | Refused: headcount is read by owner, admin, finance and ops_manager only. Posts and roster requirements (2.7) are what hr and line managers read. |
