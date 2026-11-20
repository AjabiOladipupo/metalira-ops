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
- **Working week**: 5 working days and 2 off days, following **each worker's own roster** (not a fixed Mon–Fri calendar). Guards who work weekends have their off days on other days.
- **Working days in the cycle**: the days the worker's roster pattern schedules them to work between the 20th and the 19th.
- **Proration (joiners and leavers)**: a worker who joins or leaves mid-cycle is paid monthly gross × (rostered working days they were employed in the cycle ÷ rostered working days in the full cycle). Joiners count from `start_date`; leavers count to `end_date`.
- **Normal hourly rate (monthly-paid)**: monthly gross pay ÷ (20 days × standard shift hours). With the default 8-hour shift: monthly gross ÷ 160. Gross means basic + housing + transport + other allowances. The 20-day divisor is fixed and does not change with the length of the cycle (organisation setting `hourly_rate_divisor_days`, default 20).
- **Normal hourly rate (daily workers)**: daily rate ÷ standard shift hours (default 8).
- **Overtime**: only time worked past the end of the worker's **assigned shift** counts. A rostered 12-hour shift worked in full is not overtime.
- **Overtime rate**: paid at the worker's normal hourly rate (multiplier 1.0×).
- **Special project or task overtime**: a pay multiplier can be set on a project or task; overtime worked on it is paid at normal hourly rate × that multiplier.
- **Off-day work**: a worker approved to work on an off day is paid one overtime shift of 8 hours at the overtime rate.
- **Public holidays**: work done on a public holiday is recorded as overtime. Each organisation keeps its own public holiday list, because federal holidays are declared year by year.
- **Daily workers** (`employment_type = daily`): paid daily rate × days worked. Overtime is allowed and paid at their normal hourly rate. No PAYE, no pension, no NSITF, no ITF, and they are left out of the employer levy base. Owner decision; **confirm with a tax adviser**.

Open points (ask before Phase 5 code depends on them):

1. Public holiday work: is it paid as the hours actually worked, or as a fixed 8-hour overtime shift like off-day work? Does a monthly worker who is rostered on a public holiday but does not work still get full pay?
2. Is "gross" for the hourly rate the full monthly gross (basic + housing + transport + other allowances), as recorded above? The owner said "gross base pay".

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
