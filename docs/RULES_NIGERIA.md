# Nigerian payroll and billing rules (starting settings)

Every rule here must be stored as a dated `tax_rule_sets` row, not hard-coded. Each item is marked **confirm with a tax adviser** before the first live payroll. If code needs a rule that is not here, stop and ask.

## PAYE (Nigeria Tax Act 2025, from 1 Jan 2026), annual bands on taxable income
| Band | Rate |
| --- | --- |
| First ₦800,000 | 0% |
| Next ₦2,200,000 | 15% |
| Next ₦9,000,000 | 18% |
| Next ₦13,000,000 | 21% |
| Next ₦25,000,000 | 23% |
| Above ₦50,000,000 | 25% |

- Taxable income = annual gross − employee pension − NHF (if opted in) − rent relief.
- Rent relief = 20% of annual rent declared, capped at ₦500,000.
- Monthly PAYE = annual tax ÷ 12, rounded to the nearest kobo; remit to the worker's tax state. **Confirm with a tax adviser.**

## Pension (PRA 2014)
- Employee 8%, employer 10% of basic + housing + transport. Remit to the worker's PFA within 7 working days of paying salary. **Confirm.**

## NHF
- 2.5% of basic, only where `nhf_opt_in` is true (treated as optional; status unconfirmed). **Confirm.**

## Employer levies
- NSITF: 1% of total monthly payroll. **Confirm.**
- ITF: 1% of annual payroll, for employers with 5+ staff or ₦50m+ turnover. Accrue monthly. **Confirm.**

## Pay policy (set by the owner, 15 Nov 2026)

These are product defaults stored per organisation (`organisations` pay settings and dated `tax_rule_sets` rows), not hard-coded.

- **Pay cycle**: 20th of the previous month to 19th of the current month. Salary is paid on the 25th of the current month. Example: the October 2026 run covers 20 Sep–19 Oct 2026 and pays on 25 Oct 2026.
- **Working week**: 5 working days and 2 off days.
- **Proration**: a worker who joins mid-cycle is paid monthly pay × (working days from start date to cycle end ÷ working days in the cycle).
- **Overtime rate**: paid at the worker's normal hourly rate (multiplier 1.0×).
- **Special project or task overtime**: a pay multiplier can be set on a project or task; overtime worked on it is paid at normal hourly rate × that multiplier.
- **Off-day work**: a worker approved to work on an off day is paid one overtime shift of 8 hours at the overtime rate.
- **Daily workers** (`employment_type = daily`): paid daily rate × days worked. No PAYE, no pension, no NSITF, no ITF, and they are left out of the employer levy base. Owner decision; **confirm with a tax adviser**.

Open points (ask before Phase 5 code depends on them):

1. Normal hourly rate for monthly-paid workers: is it monthly gross ÷ (working days in the cycle × 8 hours), or basic only, or a fixed divisor?
2. Working days: a fixed Mon–Fri calendar, or each worker's own roster pattern (guards often work weekends)? Are public holidays excluded?
3. Overtime on a working day: does anything past 8 hours count (e.g. 12-hour guard shifts), or only hours past the rostered shift?
4. Leavers mid-cycle: prorated the same way as joiners?
5. Daily workers: can they earn overtime, and at what rate?

## Invoicing
- VAT 7.5% on taxable services, shown as its own line.
- Withholding tax: clients may deduct WHT on payment (rate per client in `clients.wht_rate_bps`). Matching must accept amount = total − WHT and record the WHT credit. **Confirm the rate per service type.**

## Rounding
- Compute in kobo integers. Round once, at the final value of each line, half-up. Use `allocateKobo` when splitting so parts sum to the whole.
