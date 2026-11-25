# Nigerian payroll and billing rules

Every rule here is stored as a dated `tax_rule_sets` row or a dated company setting, not hard-coded. If code needs a rule that is not here, stop and ask.

**Status (25 Nov 2026).** The company's tax adviser answered the 27 payroll questions below. Where the adviser confirmed a rule it is marked **Confirmed by the tax adviser** with its source; the old "confirm with a tax adviser" marks are gone from those rules. Answers 24 to 26 are employment-law points: the adviser asked that they be confirmed with an **employment lawyer**, and they stay marked so. The owner's product decisions are marked **Owner decision**. Each rule set version still shows "Confirm with a tax adviser before the first live payroll" in the app until the owner records the adviser's confirmation on that version (`confirm_tax_rule_set`).

Abbreviations: NTA (Nigeria Tax Act 2025), NTAA (Nigeria Tax Administration Act 2025), PRA (Pension Reform Act 2014), ECA (Employees' Compensation Act 2010), JRB (Joint Revenue Board).

## PAYE (Nigeria Tax Act 2025, from 1 Jan 2026), annual bands on taxable income
| Band | Rate |
| --- | --- |
| First ₦800,000 | 0% |
| Next ₦2,200,000 | 15% |
| Next ₦9,000,000 | 18% |
| Next ₦13,000,000 | 21% |
| Next ₦25,000,000 | 23% |
| Above ₦50,000,000 | 25% |

**Confirmed by the tax adviser** (answer 1): the bands, NTA s.58 and the Fourth Schedule.

Starting values stored as NTA 2025 v1 (slice 5.0):
- Taxable income = annual gross − employee pension − NHF (if opted in) − rent relief.
- Rent relief = 20% of annual rent declared, capped at ₦500,000.
- Monthly PAYE = annual tax ÷ 12, rounded to the nearest kobo; remit to the worker's tax state.

The adviser's answers, which slice 5.9a builds into the engine:
- **Chargeable income** (answer 2, NTA s.30): gross income less employee pension, NHF, rent relief, NHIS/NHIA contributions, and life assurance or deferred annuity premiums. The old consolidated relief allowance (CRA) is abolished. Interest on a loan for an owner-occupied house is claimed by the worker through self-assessment, not through payroll.
- **Rent relief** (answer 3, NTA s.30(2)(a)(vi); JRB Personal Income Tax Guidelines, April 2026): 20% of the actual annual rent paid, capped at ₦500,000. Proof is required: the tenancy agreement, receipts, and a payment record with the landlord's details. No relief for employer-provided housing or a home the worker owns.
- **Calculation method** (answer 4, NTAA s.51(6)): cumulative year to date, not the month annualised.
- **Minimum-wage exemption** (answer 10; NTA exempt-income provisions; National Minimum Wage (Amendment) Act 2024): a worker earning ₦70,000 a month (₦840,000 a year) or less is exempt from PAYE.
- **Hourly workers** (answer 11): treated as monthly workers.
- **Tax state** (answer 12, NTAA s.3(2) and First Schedule): the worker's principal place of residence on 1 January, or at the employment start date for a joiner.
- **Overtime and allowances** (answer 13): taxable.
- **One-off items** (answer 14): one-off earnings are taxable; one-off deductions come off after tax.
- **Several payments in a month** (answer 15): the month-aggregate method (owner decision, 24 Nov 2026) was agreed; the cumulative year-to-date method supersedes it.
- **Underpayments** (answer 16): taxed in the month paid. Arrears for a prior year are taxed on a cash basis; the worker may apply to spread them.
- **Overpayment clawback** (answer 17): recovered before tax within the same tax year; for a prior year, recovered net. The window is 3 months (Labour Act s.5(5)).
- **Leave approved after its month was paid** (answer 18): deducted before tax, reducing taxable pay and the pension base in the month it is processed.
- **Tax year** (answer 27, NTA s.202): the calendar year.

## Pension (PRA 2014)
- Employee 8%, employer 10% of basic + housing + transport. Remit to the worker's PFA within 7 working days of paying salary.

**Confirmed by the tax adviser** (answer 5, PRA s.4(1) and s.120): 8% employee and 10% employer on basic + housing + transport. The scheme applies to employers with 3 or more employees (s.2(2)). Where the employer bears the whole contribution, it is 20%.
- **Remittance deadline** (answer 20, PRA s.11(3)(b)): within 7 working days of the actual payment of salary, the next working day being day 1. Example: salary paid on Sunday 25 Oct 2026 gives day 1 on Monday 26 Oct and the deadline on Tuesday 3 Nov 2026. Slice 5.9b builds this.
- **Overtime and allowances** (answer 13): not pensionable unless the contract says so.
- **Final pay** (answer 19): pay in lieu of leave or notice, gratuity and redundancy pay are not pensionable.

## NHF
- 2.5% of basic, only where `nhf_opt_in` is true.

**Confirmed by the tax adviser** (answer 6, Business Facilitation Act 2022 s.45, amending NHF Act s.4): NHF is optional for the private sector. It needs the worker's opt-in, an NHF number, and pay at or above the minimum wage. NHF is on basic only (answer 13).
- **Due date** (answer 22, NHF Act s.9(2)): within 1 month.

## Employer levies
- NSITF: 1% of total monthly payroll.
- ITF: 1% of annual payroll, for employers with 5+ staff or ₦50m+ turnover. Accrue monthly.

**Confirmed by the tax adviser**, with these refinements (slice 5.9a builds the NSITF base):
- **NSITF** (answer 7, ECA 2010 s.33; NECA–NSITF guidelines): 1% of the regular monthly payroll, leaving out pension, bonuses, overtime and irregular payments. Borne by the employer. Due by the 15th of the following month (answer 22, ECA s.33(1)).
- **ITF** (answer 8, ITF (Amendment) Act 2011 s.6): 1% of annual payroll, for employers with 5 or more employees OR a turnover of ₦50m or more. Due by 1 April (answer 22, s.6(2)).
- **Open point: redundancy pay in the ITF base.** The adviser text doesn't say whether redundancy or loss-of-office pay (or other final-pay items) is part of the annual payroll ITF is worked on. The app leaves it to slice 5.9a's engine and flags it for the adviser.

## Remittance due dates and working days

**Confirmed by the tax adviser** (slice 5.9b builds these):
- **PAYE** (answer 22, NTAA s.107): by the 10th of the following month; a penalty applies after the 21st. The annual return, Form H1, is due by 31 January.
- **Pension**: 7 working days from the actual payment (answer 20, above).
- **NHF**: within 1 month (NHF Act s.9(2)).
- **NSITF**: by the 15th of the following month (ECA s.33(1)).
- **ITF**: by 1 April (ITF Act s.6(2)).
- **Working days** (answer 21, Public Holidays Act Cap P40): Monday to Friday, less federal and state gazetted public holidays.
- **Over-remittance** (answer 23): offsetting it, or carrying the credit forward against the next remittance to the same authority, is the primary route.

## Leavers' final pay (slice 5.9c)

**Confirmed by the tax adviser** (answer 19). The app takes these as typed final-pay items on a final-pay off-cycle run, each with its own flags. None is pensionable.

| Item | Owed? | Calculation | Tax |
| --- | --- | --- | --- |
| Pay in lieu of untaken annual leave | By law after 6 months' continuous service (Labour Act s.18(4)) | Basic money wages only: untaken days × basic daily rate. Days pre-filled by the owner's formula below; editable with a reason | Taxable |
| Pay in lieu of notice | Where notice isn't given (Labour Act s.11(6) to (9)) | Basic money wages only: notice days × basic daily rate; editable with a reason | Taxable, unless part of a redundancy or loss-of-office settlement |
| Gratuity | Only if the contract says so | Amount entered by HR | Taxable |
| Redundancy, or compensation for loss of employment | Labour Act s.20; the amount is negotiated | Amount entered by HR | Exempt up to ₦50,000,000; only the excess is taxable |

How the app applies it, and the gaps the adviser text leaves (product readings, flagged for the adviser):
- **Basic daily rate.** The adviser says "basic daily rate" without defining it. The app uses the basic monthly pay of the pay version in force on the last day ÷ the company's `hourly_rate_divisor_days` (20), the divisor the pay policy already uses. Daily and hourly pay rates get no pre-fill: HR enters the amount with a reason.
- **Untaken leave days** (**Owner decision**, 25 Nov 2026, pending an employment lawyer): the yearly entitlement of the annual leave type (code `annual`) in force on the last day × the complete months worked in that leave year (from 1 January, or the start date when later) ÷ 12, less the days already taken that year, rounded down to whole days. It applies from 6 months' continuous service (Labour Act s.18(4)); below 6 months the pre-fill is 0 with the note "not owed by law below 6 months". Between 6 and 12 months' service under preset A the entitlement is still prorated from the start date (preset A's 12-month wait for taking leave isn't applied to pay on leaving). HR can change the days with a reason, and the form shows how the pre-fill was worked out. A month counts once the day after the last day reaches the start date plus that many months, the start day clamped to the month's end.
- **Labour Act s.18 and s.18(4).** Preset A's annual leave row cites s.18 as a whole (6 working days after 12 months' continuous service, from secondary sources); the adviser's answer 19 cites s.18(4) for pay in lieu of untaken leave on leaving, owed after 6 months' continuous service. They are read as two rules, not a conflict: preset A says when leave can be taken; s.18(4) says what is paid for untaken leave when employment ends. **Confirm with an employment lawyer.**
- **Notice period.** The app holds no notice period, and the Labour Act s.11 notice lengths aren't in the adviser text, so HR enters the notice days (1 week is 5, 1 month is 20); the amount is pre-filled from them.
- **The ₦50,000,000 cap** is stored on each dated rule set version (`tax_rule_sets.loss_of_office_exempt_kobo`). It is **per person, cumulative** (**Owner decision**, 25 Nov 2026; the adviser text didn't settle per payment or per person): across every redundancy item (and notice pay marked as part of the settlement) on runs not discarded or reversed, drafts included. No other earning can be exempt from PAYE (the database refuses one). Payments made before the company used Metalira aren't known to the app.
- **Notice pay in a settlement** shares the same cap as the redundancy payment (the app's reading of "unless part of a redundancy or loss-of-office settlement").
- Below 6 months' service the app still lets HR pay leave in lieu (a contract may give it) and says it isn't owed by law.

## Pay policy (set by the owner, 15 Nov 2026)

These are product defaults stored per organisation (`organisations` pay settings and dated `tax_rule_sets` rows), not hard-coded. **Owner decision** throughout.

- **Pay cycle**: 20th of the previous month to 19th of the current month. Salary is paid on the 25th of the current month. Example: the October 2026 run covers 20 Sep–19 Oct 2026 and pays on 25 Oct 2026.
- **Working week**: 5 working days and 2 off days, following **each worker's own roster** (not a fixed Mon–Fri calendar). Guards who work weekends have their off days on other days.
- **Working days in the cycle**: the days the worker's roster pattern schedules them to work between the 20th and the 19th.
- **Proration (joiners and leavers)**: a worker who joins or leaves mid-cycle is paid monthly gross × (rostered working days they were employed in the cycle ÷ rostered working days in the full cycle). Joiners count from `start_date`; leavers count to `end_date`.
- **Normal hourly rate (monthly-paid)**: monthly gross pay ÷ (20 days × standard shift hours). With the default 8-hour shift: monthly gross ÷ 160. Gross means basic + housing + transport + other allowances. The 20-day divisor is fixed and does not change with the length of the cycle (organisation setting `hourly_rate_divisor_days`, default 20).
- **Normal hourly rate (daily workers)**: daily rate ÷ standard shift hours (default 8).
- **Overtime**: only time worked past the end of the worker's **assigned shift** counts. A rostered 12-hour shift worked in full is not overtime.
- **Overtime rate**: paid at the worker's normal hourly rate (multiplier 1.0×).
- **Special project or task overtime**: a pay multiplier can be set on a project or task; overtime worked on it is paid at normal hourly rate × that multiplier.
- **Off-day work**: a worker approved to work on an off day is paid one overtime shift of 8 hours at the overtime rate.
- **Public holidays**: work done on a public holiday is paid as holiday work (below). Each organisation keeps its own public holiday list, because federal holidays are declared year by year.
- **Extra pay for holiday work** (adviser answer 24; **Owner decision**, slice 5.9c): set per company as `payroll_holiday_pay_rates.multiplier_bps`, dated versions (default 10000, 1.0×). Every minute worked on a public holiday earns normal pay plus extra pay of the hourly (overtime) rate × the multiplier: at ₦750 an hour and 1.5×, ₦750 normal + ₦1,125 extra = ₦1,875 an hour. Owner, HR and Finance change it in Settings > Payroll rules, from tomorrow or later, audited; the earnings stage uses the multiplier in force on the day worked. The adviser: holiday pay is contract-driven and there is no statutory multiplier (Public Holidays Act s.4; Labour Act s.13 and s.17). **Confirm with an employment lawyer.** The app allows 1.0× to 5.0× (a product limit: below 1.0× the holiday line would also underpay the day's overtime minutes).
- **Daily workers** (`employment_type = daily`): paid daily rate × days worked. Overtime is allowed and paid at their normal hourly rate. Starting rule set NTA 2025 v1 (slice 5.0): No PAYE, no pension, no NSITF, no ITF, and they are left out of the employer levy base. **Superseded** by adviser answer 9, now also the **Owner decision**: PAYE (with the minimum-wage exemption), pension, NSITF and ITF all apply to daily workers; NHF is optional. Slice 5.9a builds it.

Phase 5 defaults (docs/PHASE_5.md, built in slices 5.1 to 5.8), with the adviser's answers:

- **Hourly-rate pay** (`pay_type` hourly): approved worked minutes × hourly rate ÷ 60, overtime minutes at the hourly rate × the overtime multiplier; statutory deductions as for monthly workers. **Confirmed by the tax adviser** (answer 11).
- **A day that is both an off day and a public holiday** pays the larger of the two rules (one 8-hour overtime shift, or the minutes worked at the holiday rate), never both. Product rule.
- **Daily and hourly workers get no leave pay** (and no leave deduction): they are paid for days or minutes worked. Leave still counts against their balance. Product rule.
- **Public holidays are left out of an unpaid or part-paid working-day leave deduction**, as the leave counter leaves them out of a working-day request; they stay in the rostered-day base, so a monthly worker keeps the holiday's pay. Calendar-day leave (maternity) keeps them in the deduction. Product rule.
- **Holiday minutes are paid once at the holiday rate**: every minute worked on a public holiday (worked plus overtime) is paid at the overtime rate × the company's holiday multiplier, on top of normal pay; its overtime minutes are not paid again as overtime. A monthly worker rostered on a holiday who doesn't work keeps full pay.
- **Maternity** (Labour Act s.54, preset A below): **Confirmed by the tax adviser** (answer 25). **Confirm with an employment lawyer**, as the adviser advised.
- **Tax year = the calendar year of the pay date** (slice 5.5): a payslip's "This year so far" sums the worker's released payslips whose pay date falls in the same calendar year. **Confirmed by the tax adviser** (answer 27, NTA s.202).

### Deductions from wages

- **Cap** (answer 26, Labour Act s.5(7), with s.5(1), s.4 and s.5(5)): deductions from a worker's wages may not exceed one-third of the monthly wages. **Owner decision**: statutory deductions (PAYE, pension, NHF) sit outside the cap pending a lawyer's view. Slice 5.9a builds the cap. **Confirm with an employment lawyer.**
- **Net pay below ₦0** is never paid; the rest of a deduction is carried to the next run (Phase 5 open question 6, product rule).

### The old open points, closed (25 Nov 2026)

1. **Public holiday work.** Paid as the minutes actually worked (worked plus overtime) at the overtime rate × the company's holiday multiplier (default 1.0×), on top of normal pay; a monthly worker rostered on a holiday who doesn't work keeps full pay. The multiplier is the owner's decision on adviser answer 24 (contract-driven, no statutory multiplier). Built in slice 5.9c. Still for the employment lawyer.
2. **"Gross" for the hourly rate.** Stays the full monthly gross (basic + housing + transport + other allowances): the owner's pay policy. Not a tax rule.
3. **Pension remittance date.** Adviser answer 20: 7 working days from the actual payment of salary, the next working day being day 1 (PRA s.11(3)(b)). Replaces the Phase 5 default (pay date rolled back, counted as day 1). Built in slice 5.9b.
4. **Working days and due dates.** Adviser answers 21 and 22: federal and state gazetted public holidays (Public Holidays Act Cap P40); PAYE by the 10th (penalty after the 21st; Form H1 by 31 January), NHF within 1 month, NSITF by the 15th, ITF by 1 April. Built in slice 5.9b.
5. **Corrections and clawbacks.** Adviser answers 16 and 17: an underpayment is taxed in the month paid (prior-year arrears on a cash basis; the worker may apply to spread them); an overpayment is clawed back before tax within the same tax year and recovered net for a prior year, within 3 months (Labour Act s.5(5)). Built in slice 5.9a.
6. **Off-cycle and one-off pay.** Adviser answers 4 and 15: the month-aggregate method was agreed and is superseded by the cumulative year-to-date method (NTAA s.51(6)). Built in slice 5.9a.
7. **Leave encashment and terminal benefits.** Adviser answer 19: the four final-pay items above, built in slice 5.9c.
8. **A remittance paid for a reversed run.** Adviser answer 23: offset, or a credit carried forward, is the primary route. The app's refund or offset record (slice 5.7c) stays; offset is the one to choose first.
9. **A cap on deductions from wages.** Adviser answer 26: one-third of monthly wages (Labour Act s.5(7)); statutory deductions outside the cap by the owner's decision. Built in slice 5.9a. Still for the employment lawyer.
10. **Leave approved after its month was paid.** Adviser answer 18: deducted before tax, reducing taxable pay and the pension base in the month processed (replacing the after-tax default of slice 5.7c). Built in slice 5.9a.

### Still for the employment lawyer

- Public holiday pay (answer 24): no statutory multiplier; the company's multiplier follows its contracts (Public Holidays Act s.4; Labour Act s.13 and s.17).
- Maternity (answer 25): preset A's Labour Act s.54 figures, and pay below 6 months' service (Phase 5 open question 3).
- The deduction cap (answer 26): one-third of monthly wages, and whether statutory deductions sit outside it.
- Notice periods (Labour Act s.11): not in the adviser text; the app takes the notice days from HR.
- The leave-in-lieu pre-fill formula and the s.18 / s.18(4) reading (owner decision, above).

### The tax adviser's 27 answers, in brief

| # | Question | Answer | Source |
| --- | --- | --- | --- |
| 1 | PAYE bands | Confirmed | NTA 2025 s.58, Fourth Schedule |
| 2 | Chargeable income | Less pension, NHF, rent relief, NHIS/NHIA, life assurance or deferred annuity premiums; CRA abolished; owner-occupied house loan interest by self-assessment | NTA s.30 |
| 3 | Rent relief | 20% of actual rent paid, capped at ₦500,000, with proof; none for employer-provided or own homes | NTA s.30(2)(a)(vi); JRB guidelines, April 2026 |
| 4 | Method | Cumulative year to date | NTAA s.51(6) |
| 5 | Pension | 8% / 10% of basic + housing + transport; 3 or more employees; 20% if the employer bears all | PRA s.4(1), s.120, s.2(2) |
| 6 | NHF | Optional for the private sector; opt-in, NHF number, pay at or above minimum wage | Business Facilitation Act 2022 s.45; NHF Act s.4 |
| 7 | NSITF | 1% of regular monthly payroll, without pension, bonuses, overtime, irregular pay; employer-borne | ECA 2010 s.33; NECA–NSITF guidelines |
| 8 | ITF | 1% of annual payroll; 5 or more employees OR ₦50m turnover | ITF (Amendment) Act 2011 s.6 |
| 9 | Daily workers | PAYE (with the minimum-wage exemption), pension, NSITF, ITF apply; NHF optional (also the owner's decision) | Adviser |
| 10 | Minimum-wage exemption | ₦70,000 a month (₦840,000 a year) or less exempt from PAYE | NTA exempt income; National Minimum Wage (Amendment) Act 2024 |
| 11 | Hourly workers | As monthly workers | Adviser |
| 12 | Tax state | Principal place of residence on 1 January, or at the start date | NTAA s.3(2), First Schedule |
| 13 | Overtime and allowances | Taxable; not pensionable unless the contract says so; NHF on basic only | Adviser |
| 14 | One-off items | Earnings taxable and not pensionable; deductions post-tax | Adviser |
| 15 | Several payments in a month | Agreed; superseded by year to date | Adviser |
| 16 | Underpayments | Taxed in the month paid; prior-year arrears on a cash basis, spreading on application | Adviser |
| 17 | Overpayment clawback | Pre-tax in the same tax year; net for a prior year; 3-month window | Labour Act s.5(5) |
| 18 | Late unpaid leave | Pre-tax, reducing taxable pay and pension in the month processed | Adviser |
| 19 | Final pay | The four items above | Labour Act s.18(4), s.11(6)–(9), s.20 |
| 20 | Pension deadline | 7 working days from actual payment, next working day as day 1 (e.g. Tue 3 Nov 2026) | PRA s.11(3)(b) |
| 21 | Working days | Federal and state gazetted public holidays | Public Holidays Act Cap P40 |
| 22 | Due dates | PAYE 10th (penalty after 21st; H1 31 Jan); NHF 1 month; NSITF 15th; ITF 1 April | NTAA s.107; NHF Act s.9(2); ECA s.33(1); ITF Act s.6(2) |
| 23 | Over-remittance | Offset or credit carried forward first | Adviser |
| 24 | Public holiday pay | Contract-driven, no statutory multiplier; default 1.0×, company may change (confirm with an employment lawyer) | Public Holidays Act s.4; Labour Act s.13, s.17 |
| 25 | Maternity | Confirmed (confirm with an employment lawyer) | Labour Act s.54 |
| 26 | Deduction cap | One-third of monthly wages; statutory deductions outside pending a lawyer (owner decision) | Labour Act s.5(7), s.5(1), s.4, s.5(5) |
| 27 | Tax year | Calendar year | NTA s.202 |

## Invoicing
- VAT 7.5% on taxable services, shown as its own line.
- Withholding tax: clients may deduct WHT on payment. The rate is set **per rate line** by service type and versioned with the rate card (`rate_card_lines.service_type`, `wht_rate_bps`, slice 2.4, owner's accountant 19 Nov 2026). Whether a client deducts it at all is a client setting (`clients.deducts_wht`). The rules are below.

## WHT and VAT withholding (owner, 19 Nov 2026; confirm with accountant where marked)

- **Base.** WHT is calculated on the service amount **before VAT**. A ₦1,000,000 fee plus ₦75,000 VAT gives WHT on ₦1,000,000.
- **Rules.** The Deduction of Tax at Source (Withholding) Regulations 2024. Rates for payments to resident companies:
  - commission, consultancy, technical, management and professional fees: 5%;
  - services not specifically listed: 2%;
  - supply of goods by a non-manufacturer: 2%;
  - rent, hire and lease: 10%.
- **The rate depends on the service and the payee**, not on the kind of client. Government bodies must deduct.
- **Accountant's views (19 Nov 2026):**
  - Security guarding and cleaning: "services not specifically listed", 2%.
  - Staffing: 2% (wages passed through, "services not specifically listed").
  - Facility management: 5% if invoiced as one lump sum; otherwise 2% on the service lines and 5% only on a separate management-fee line. **Always split.** ₦1,000,000 of which a ₦100,000 management fee gives WHT of ₦23,000 (2% of ₦900,000 plus 5% of ₦100,000) instead of ₦50,000.
  - So the app sets WHT per rate line by service type: services 2%, management fee 5%, rent or hire 10%, goods 2%, other 2%, editable per line.
- **No TIN.** A payee without a TIN is charged twice the rate, up to 20% (hence the 0–20% range on `wht_rate_bps`). The company's TIN must be printed on every invoice (Phase 6), and the app should warn when the organisation has no TIN.
- **Small-client exemption.** A small client need not deduct WHT where the supplier has a valid TIN and the transaction value is ₦2m or less in the calendar month. "Small" is ₦50m turnover (the Nigeria Tax Act definition, replacing CITA's ₦25m; the Tax Administration Act's ₦100m "small business" is not used for WHT; an NRS circular may follow). It is the client's decision, so **the app applies no threshold** and learns per client (`clients.deducts_wht`).
- **Penalty.** A payer that under-deducts faces a penalty of 40% of the WHT not deducted, which is why payers lean towards the higher rate.
- **VAT withholding.** Government MDAs and companies appointed as VAT withholding agents pay the VAT straight to the tax authority (remitted by the 14th of the following month), so their payment can arrive as the service amount less WHT, without the VAT. A client records this as `clients.withholds_vat` (slice 2.4).
- **Remittance.** WHT deducted from payments to companies goes to the Nigeria Revenue Service (NRS, formerly FIRS) by the 21st of the following month; WHT on payments to individuals and unincorporated entities goes to the State IRS. The customer company's WHT credit notes are NRS credits.
- **Phase 6 implications:**
  - Expected WHT is worked out per invoice line on the pre-VAT amount (the line's `wht_rate_bps`), rounded once per line, and summed.
  - Record the WHT actually deducted on each payment and flag differences from the expected amount.
  - `clients.deducts_wht` is learned from payments (a client that pays in full is flagged, not assumed small).
  - Bank matching accepts three patterns: the full amount; the amount less WHT; the amount less WHT and VAT (clients that withhold VAT).
  - Invoice lines are split by rate-card version, so each line has one WHT rate.
  - WHT on credit-note (negative) lines rounds half away from zero, symmetric with `roundHalfUp`, so a credit mirrors the line it reverses.
  - A WHT credit-note tracker per client.
  - A warning when the organisation has no TIN.

## Rounding
- Compute in kobo integers. Round once, at the final value of each line, half-up. Use `allocateKobo` when splitting so parts sum to the whole.

## Leave presets (Phase 4)

Owner rule (20 Nov 2026): where a rule depends on Nigerian law or practice, build the best-fit options side by side; the owner tests them and drops the rest. Owner decision (21 Nov 2026), after review: keep two presets, A and B. **Preset C ("Public-service aligned") was dropped by the owner after review** and is not offered.

Leave setup (slice 4.1) offers the two presets. Each is a starting point the company edits, stored as its own `leave_types` and dated `leave_entitlements` rows, never hard-coded. Every preset card says: **These are starting values, not legal advice. Confirm them with an adviser.** None of this is legal advice, and the app never says it is.

The "App values" table under each preset is what the app stores. `src/lib/leave/presets.ts` and the database's `private.leave_preset_rows` must match it exactly (a unit test and the RLS suite check). Columns: code, name, counting, days a year, paid, pay percent, minimum service in months before the type can be asked for, months of service the pay needs (`-` for none), and whether a certificate is needed.

### Preset A, "Labour Act minimum"
Source: Labour Act, Cap L1 LFN 2004. Sections 18 and 16 as summarised by Chambers Employment 2025 (Nigeria), the DLA Piper leave FAQ (2024) and WageIndicator Nigeria. Section 54 text read by the owner on 21 Nov 2026 on the jurist.ng mirror (https://jurist.ng/labour_act/sec-54), a third-party copy, not the official gazette. **Confirm with an adviser.**

| Leave | Figure | Source | Check |
| --- | --- | --- | --- |
| Annual | 6 working days with pay, after 12 months' continuous service (`min_service_months` 12) | Labour Act s. 18, per DLA Piper, WageIndicator and Chambers | Confirmed by the secondary sources (21 Nov 2026 search); statute text not read |
| Sick | Up to 12 paid working days a calendar year, certified by a registered medical practitioner (`needs_certificate`) | Labour Act s. 16, per WageIndicator and DLA Piper | Confirmed by the secondary sources; statute text not read |
| Maternity | 12 weeks (84 calendar days): 6 weeks before confinement (on a medical certificate that she will probably be confined within 6 weeks) and 6 weeks after it | Labour Act s. 54(1)(a) and (b), jurist.ng mirror | Verified against the jurist.ng mirror (21 Nov 2026); not checked against the official gazette |
| Maternity pay | No less than 50% of the wages she would have earned, only if she has been continuously employed by the employer for 6 months or more immediately before the absence (`pay_percent` 50, `pay_min_service_months` 6; the leave itself needs no minimum service) | Labour Act s. 54(1)(c), jurist.ng mirror | **Verified** against the jurist.ng mirror (21 Nov 2026); not checked against the official gazette |
| Paternity | None | The Labour Act has no private-sector paternity entitlement | Per Chambers and DLA Piper |
| Compassionate | None | Not in the Labour Act | Per DLA Piper |

App values, preset A:

| Code | Name | Counting | Days | Paid | Pay % | Min service | Pay service | Certificate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| annual | Annual | working_days | 6 | yes | 100 | 12 | - | no |
| sick | Sick | working_days | 12 | yes | 100 | 0 | - | yes |
| maternity | Maternity | calendar_days | 84 | yes | 50 | 0 | 6 | yes |

Notes:
- s. 54(4): while a woman is absent under s. 54, no employer may give her notice of dismissal during the absence, or notice that would expire during it. The app does not enforce this (dismissal is outside the product); it is recorded here so HR sees it.
- The Act's sick-leave and annual-leave rules cover "workers" as the Act defines them; sick leave for managerial and professional staff is set by their contracts. Companies set such staff's figures by contract.
- A Lagos State maternity rule is outside what the app enforces.
- Below 6 months' service the maternity leave can still be taken; what it pays then is a Phase 5 question (open).

### Preset B, "Common private-sector practice"
Source: market practice described in Chambers Employment 2025 (Nigeria), the Payoneer Nigeria leave policy guide and the CXC Nigeria employment guide. Not a statute. **Confirm with an adviser.**

| Leave | Figure | Source |
| --- | --- | --- |
| Annual | 15 working days | Common practice (Payoneer, CXC) |
| Sick | 12 working days | Labour Act figure, commonly kept (WageIndicator) |
| Maternity | 12 weeks (84 calendar days), full pay | Common practice (Payoneer, CXC) |
| Paternity | 5 working days | Common practice (Payoneer, CXC) |
| Compassionate | 3 working days | Common practice (CXC) |

App values, preset B:

| Code | Name | Counting | Days | Paid | Pay % | Min service | Pay service | Certificate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| annual | Annual | working_days | 15 | yes | 100 | 0 | - | no |
| sick | Sick | working_days | 12 | yes | 100 | 0 | - | yes |
| maternity | Maternity | calendar_days | 84 | yes | 100 | 0 | - | yes |
| paternity | Paternity | working_days | 5 | yes | 100 | 0 | - | no |
| compassionate | Compassionate | working_days | 3 | yes | 100 | 0 | - | no |

Certificates for sick and maternity leave in preset B are a product choice that follows preset A's rule, not a statement of practice.

### How the app uses them
- Applying a preset adds the types the company doesn't have (first version from 1 January this year) and, for types it has (found by code), sets the preset's rules and adds a new version from the next 1 January or tomorrow. The company's other types are never deleted or changed.
- Leave year: calendar year; joiners prorated (days left in the year ÷ days in the year, half up to a whole day); no carry-over unless the company sets a cap per type (owner decisions 2, Phase 4). The proration method is a product default, not a legal rule.
- Working-day types skip the worker's off-days and the company's public holidays; maternity counts calendar days (PHASE_4.md "Choices made in this plan").
- `pay_percent` and `pay_min_service_months` are stored for Phase 5; Phase 4 does no pay maths.

Sources (web search 20 and 21 Nov 2026):
- Labour Act s. 54, jurist.ng mirror (third-party copy, not the official gazette), read by the owner 21 Nov 2026: https://jurist.ng/labour_act/sec-54
- Chambers and Partners, Employment 2025, Nigeria: practiceguides.chambers.com/practice-guides/employment-2025/nigeria
- DLA Piper, Employee leave in Nigeria: frequently asked questions (2024): dlapiperafrica.com/en/nigeria/insights/2024/frequently-asked-questions-employee-leave-in-nigeria.html
- WageIndicator Nigeria, sick leave, maternity and family responsibilities: wageindicator.org/en-ng/work-in-nigeria/labour-law
- Payoneer, Leave policy in Nigeria: payoneer.com/en-in/resources/workforce-management/leave-policy/nigeria/
- CXC Global, Nigeria employment guide (cited in the 20 Nov search; not re-checked on 21 Nov)
- Labour Act, Cap L1 LFN 2004 (PLAC): lawsofnigeria.placng.org/laws/L1.pdf (not read in full)
