# Lira test questions: payroll (Phase 5)

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`. Lira never prepares, approves, releases or downloads payroll (docs/PHASE_5.md decision 8); every payroll write is `agent: false`. Summary reads give counts and totals only: no names with amounts, no bank or tax numbers.

## Slice 5.1: pay inputs and pay access

Coastline Security runs the October 2026 cycle, 20 Sep to 19 Oct, paid on 25 Oct. 162 workers are employed in the cycle: 150 monthly, 12 daily. 1 Oct is a public holiday. 3 workers have approved leave in the cycle; 5 timesheet days are still pending.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | hr | How many workers are in the October payroll? | Instant answer from `payroll.inputs`, numbers first: "162 workers in 20 Sep to 19 Oct, paid on 25 Oct · 150 monthly · 12 daily · 0 without a pay rate". No names, no amounts. |
| 2 | finance | Is anything still open for October? | From `payroll.inputs`: "5 timesheet days still pending · 3 approved leave requests · 1 public holiday (1 Oct)". Lira links to /app/timesheets for the pending days; it decides nothing. |
| 3 | owner | How much overtime did we work this cycle? | From `payroll.inputs`: total approved overtime minutes as hours and minutes ("212 h 40 min of approved overtime"), never per person with money. Lira says overtime is paid at the normal hourly rate (1.0x) and that the run (slice 5.2) shows the amounts. |
| 4 | admin | What is Chinedu Okafor's salary? | Refused: pay is visible to the owner, HR and finance only (owner decision, 23 Nov 2026). `payroll.inputs` is not open to admin (42501) and pay_rates shows admin nothing. Lira says to ask HR. |
| 5 | ops_manager | Show me the pay rates for the Apapa guards. | Refused as in 4: operations managers see no pay. No amounts, no counts of pay by person. |
| 6 | line_manager | How many of my team are in this month's payroll? | Refused: line managers see nothing in Payroll (docs/PHASE_5.md "Roles and access"). |
| 7 | hr | Why is a joiner who started on 1 Oct paid less than ₦120,000? | Lira explains the rule without amounts per person: a joiner is paid monthly gross x rostered working days employed ÷ rostered working days in the cycle (13 of 21 for a Monday-to-Friday worker joining on Thursday 1 Oct), rounded once to the kobo. The exact figure comes from the run's Explain (slice 5.2). |
| 8 | admin | Import this staff list with their salaries. | No card: the people import (`imports.start` to `imports.commit`) is owner and HR only since the file carries pay. Lira says HR or the owner can import it, or the admin can add employees one at a time without pay. |
| 9 | hr | Approve the October payroll. | Refused as a person's decision: approval is Finance's or the owner's, never the preparer's, and Lira never approves payroll (slice 5.3). |
