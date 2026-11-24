# Phase 5: payroll (about 3 weeks)

Goal: HR prepares a month's payroll from pay rates, approved timesheet days and approved leave; the app works out gross to net for every worker with a step-by-step explanation, lists what looks wrong, and a second person in Finance approves it. Approval posts the payslips (never edited after), locks the pay period, and gives Finance a bank file to upload to the company's own bank. Workers read their payslips on the phone. HR gets the statutory schedules (PAYE by tax state, pension by PFA, NHF, NSITF, ITF) and records each remittance with its receipt. Metalira never holds or moves the money.

**Done when** (BUILD_PLAN): the app reproduces `fixtures/october-2026-golden.json` exactly, in kobo, for every worker line, the totals and the statutory figures.

Planned 21 Nov 2026, from `main` at `a455a4a` with Phase 4 signed off (all 12 pull requests merged). The screens follow the prototype boards `Payroll.dc.html` (the six-step run: Period, Timesheets, Earnings, Anomalies, Gross to net, Submit; the gross-to-net table with Explain; "How Musa Ibrahim's PAYE is worked out"; "A different person in Finance must approve before any payment file is released") and `WkPayslip.dc.html` (You received, What you earned, Taken out, Your employer also paid, This year so far, Download PDF, Ask HR).

Parts of those boards that are superseded:
- "Pay period 1–31 October 2026", "pay date 31 Oct": the pay cycle is the 20th of the previous month to the 19th, paid on the 25th (RULES_NIGERIA "Pay policy"). The October 2026 run covers 20 Sep–19 Oct and pays on 25 Oct.
- "Night overtime, 12 h at 1.5×": overtime is paid at the normal hourly rate (1.0×); a multiplier comes only from a special project or task (Phase 8).
- "you pay from your own bank or Paystack account": the company uploads the bank file to its own bank. No payment provider (BUILD_PLAN "Payments model").
- "Minimum-wage earner: PAYE exempt" (the Explain panel): RULES_NIGERIA.md has no such rule. The engine applies the bands only (Grace Edet's PAYE is ₦0 from the bands anyway); open question 9.
- "Rule set NTA 2025 v1" is kept as the idea: the run names the dated rule set it used.
- "Proof of payment is on file for October" (payslip): shown only once 5.6 records the pension remittance with its receipt.

Builds on (names as they are on `main`):
- `pay_rates` (dated versions; `pay_type` monthly, daily or hourly; `basic_kobo`, `housing_kobo`, `transport_kobo`, `other_allowances_kobo`, `daily_rate_kobo`, `hourly_rate_kobo`; guard `private.pay_rates_guard` refuses a start in the past once a worker has a rate: Phase 1 decision 17 waits for posted payroll).
- `workers`: `employment_type` (permanent, contract, casual, daily), `start_date`, `end_date`, `status`, `tax_state`, `tin`, `pfa_name`, `rsa_pin_enc`, `rsa_pin_last4`, `nhf_opt_in`, `annual_rent_declared_kobo`, `bank_name`, `account_name`, `bank_account_enc`, `bank_account_last4`, `bank_code`, `bank_name_check`, `needs_pay_details`, `usual_work_days`.
- `bank_detail_changes` (second approver, 72-hour hold) and `private.worker_bank_details_as_of(org, worker, at)` (owner, hr, finance or the secret key; returns name, account name, encrypted number, last 4 and the change id; no bank code yet).
- `src/server/crypto/pii.ts` (AES-256-GCM, the value's place bound into the tag).
- `organisations`: `pay_cycle_start_day` (20), `pay_day` (25), `standard_shift_minutes` (480), `hourly_rate_divisor_days` (20), `default_work_days`, `payroll_enabled`.
- Phase 4: `timesheet_lines` (`worked_minutes`, `ot_minutes`, `status`, `shift_assignment_id`, `work_date`), `timesheet_decisions`, `work_units`, `public_holidays`, `leave_requests`, `leave_request_pay` (`pay_percent`, `pay_below_service`, written at HR's approval), `leave_ledger`, `shift_assignments` (`removed_reason = 'on_leave'`), the working-day counter in `src/lib/leave/days.ts`, and the hook `private.timesheet_period_posted(org, work_date)`, which returns false today and blocks Reopen and Dispute (MLTA5) once it returns true.
- `src/lib/money.ts`: `Kobo`, `roundHalfUp`, `applyBps`, `sumKobo`, `allocateKobo`, `formatNaira`.
- `inbox_items` and `notifyWorker`, `src/server/email/send.ts` and its caps, `claim_manager_email`.
- `/app/payroll` and `/m/payslips` are placeholder pages today.

## Rules that apply to every slice here (as in Phases 1 to 4)

- Every new table has `organisation_id uuid not null`, RLS in the set-helper form (`organisation_id in (select private.role_org_ids(array[...]))`, `worker_id in (select private.my_worker_ids())`), composite `(organisation_id, id)` foreign keys, an entry in `tests/rls/tables/` and a declaration in `tests/rls/work-records-hook.test.ts` (payslips are work records).
- **Money is integer kobo** (`bigint`) with a `currency` column (`NGN`, checked). The engine computes in `bigint`; no `number` ever holds kobo; SQL never does money maths except sums and the checks below. Format only at the edge with `formatNaira()`.
- **Rounding** (RULES_NIGERIA "Rounding"): round once, half up, at the final value of each line. Tax is worked out as an exact fraction and rounded once, at the monthly figure. Splits use `allocateKobo` so the parts sum to the whole.
- **Dated rules** (rule 3): tax rule sets and pay-policy figures are dated versions. A version in force is never updated except to close it; a change is a new version.
- **Posted is final** (rule 5): once a run is approved, its payslips, lines, sources and the run's totals can't be edited or deleted by anyone, the secret key and the database owner included. A correction is a reversal or an adjustment in a later run, with a reason and an actor.
- **Two people** (rule 10): the person who prepares or last changes a run can never approve it. Checked in SQL (`approved_by <> prepared_by`, and not anyone who added an adjustment or acknowledged an anomaly on the run), not only in the app.
- **Bank file and schedules** (rule 9): files holding account numbers or RSA PINs go to a private bucket at `{organisation_id}/...`, open by 60-second signed URLs scoped to the organisation, are never logged (not the contents, not the plaintext numbers, not the URL), and their downloads are audited (who, when, which file, never what is in it).
- **No custody** (rule 6): the bank file is a file. Nothing in Phase 5 calls a bank or payment API.
- **Notifications** (rule 8): the in-app inbox, and email through `src/server/email/send.ts` inside the caps. Emails carry no amounts and no attachments.
- **Never invent a rule**: every statutory figure comes from RULES_NIGERIA.md and is shown with "confirm with a tax adviser before the first live payroll". Where code needs a rule that is not there, the slice stops and asks (open questions below).
- Every mutation goes through `mutate()` with module `payroll`; multi-row writes are SQL functions (private security definer behind a public invoker wrapper, `search_path ''`, grants revoked from public and anon), one transaction each, audited with `log_audit` events as well as the row triggers. Refusal codes start `MLPR`.
- Code lives in `src/lib/payroll/` (pure engine, earnings, trace, formats of numbers), `src/server/payroll/` (inputs, runs, files, schedules), `src/app/app/payroll/` and `src/app/m/(app)/payslips/`. Each slice has its own timestamped migration. Merge `main` in and regenerate `src/types/db.ts` before the PR. Merge main INTO branches; never rebase or force-push.
- Corners are 12px; screens work at 390px and 1440px.
- Crons stay daily (Vercel Hobby) and Phase 5 adds none: due dates and reminders are worked out on read.

## Decisions

These are the plan's defaults. Every statutory figure below is **confirm with a tax adviser before the first live payroll**; the app shows that line on Settings > Payroll rules and on the run's Gross to net step.

1. **Statutory figures** come from RULES_NIGERIA.md, stored as the first dated `tax_rule_sets` version (from 1 Jan 2026): PAYE bands 0% / 15% / 18% / 21% / 23% / 25% on ₦800,000 / ₦2,200,000 / ₦9,000,000 / ₦13,000,000 / ₦25,000,000 / above ₦50,000,000; rent relief 20% of declared annual rent capped at ₦500,000; employee pension 8% and employer pension 10% of basic + housing + transport; NHF 2.5% of basic where `nhf_opt_in`; NSITF 1% of monthly payroll; ITF 1% of payroll accrued monthly for employers with 5 or more staff (or ₦50m turnover). **Confirm with a tax adviser.**
2. **PAYE method** (RULES_NIGERIA): taxable income = annual gross − employee pension − NHF − rent relief; monthly PAYE = annual tax ÷ 12, rounded half up to the kobo. "Annual" is this month's figures × 12 (the month annualised), which is what the golden fixture does. **Confirm with a tax adviser** (open question 9 asks about a cumulative year-to-date method).
3. **Pay policy** (owner, 15 Nov 2026), stored per organisation and in the rule set's `policy` part: cycle 20th to 19th, paid on the 25th; normal hourly rate = monthly gross ÷ (20 × standard shift hours); overtime only past the assigned shift's end, at 1.0×; off-day work paid as one 8-hour overtime shift; public-holiday work recorded as overtime; daily workers paid daily rate × days worked, with no PAYE, pension, NSITF or ITF and left out of the levy base (**confirm with a tax adviser**).
4. **Proration** (pay policy): monthly gross × rostered working days employed in the cycle ÷ rostered working days in the full cycle. "Rostered working days" uses the 4.4 counter: a day with an assigned shift (including one removed for leave, `on_leave`) is a working day; days with no shift fall back to `workers.usual_work_days`, else `organisations.default_work_days`. A worker employed the whole cycle on one pay rate with no unpaid leave gets the monthly gross exactly; the ratio is used only when something splits the cycle.
5. **One engine, in TypeScript.** Gross to net is a pure function in `src/lib/payroll/` with a step-by-step trace. SQL gathers inputs and checks the stored results' invariants (lines sum to totals, net = gross − deductions, nothing negative); it never recomputes tax. No SQL mirror is planned; one is added only if a later slice needs the database to work out pay on its own.
6. **The golden fixture is the gate.** 5.0's unit test reproduces it from the engine alone; 5.3's database test reproduces it end to end (six workers, pay rates, a full cycle, run, approve); 5.6 checks its statutory totals. A slice that changes the engine must keep it green.
7. **Stale runs can't be approved.** A run stores the SHA-256 of its canonical inputs. Approval re-gathers them and refuses (MLPRF; the plan said MLPR3, which is Phase 1's) if anything changed since submission: a timesheet day approved, a pay rate added, leave decided, a bank change applied.
8. **Who does what:** HR or the owner prepare and submit; Finance or the owner approve; the approver is never the preparer. Admins and ops managers see no payroll and, since 23 Nov 2026, no pay rates (owner decision, slice 5.1: pay rates are read by owner, hr and finance, changed by owner and hr; the people import, which carries pay, is owner and hr only). A company with one manager can't approve payroll until a second person (finance or another owner) joins; rule 10 has no single-approver exception for payroll. Lira never prepares, approves, releases or downloads anything here (all `agent: false`).
9. **Posting happens at approval.** Approval makes the payslips final, locks the pay period (`private.timesheet_period_posted` returns true for every day in a posted run's period) and opens the bank file step. **Release** is Finance or the owner confirming the file went to the bank; it publishes the payslips to workers and sends their notices.
10. **A source is paid once.** Every approved timesheet day, leave day and adjustment that a payslip pays is recorded as a payslip source, unique while the payslip stands. A day approved after its period was posted is paid in the next run as arrears ("20 Sep–19 Oct, approved after posting"), never by reopening the posted run.
11. **Bank details** are taken as of the moment the bank file is made (`worker_bank_details_as_of`), decrypted on the server, and refused if the decrypted number's last 4 digits don't match `bank_account_last4` (Phase 1 carry). A worker with no bank details, or details still in the 72-hour hold, is an anomaly; HR either acknowledges and leaves them out of the file (their payslip still posts, and the file shows them as "not in this file") or waits.
12. **The bank file is pluggable.** One generic CSV format first; each pilot's bank bulk-payment template is added as a format when the owner supplies it.
13. **Levies per worker.** Employer pension, NSITF and ITF are worked out per payslip and rounded per line; the remittance is the sum of the lines, so Phase 7's per-site labour cost adds up to the remittance to the kobo.
14. **Payslip PDFs** are made once at release with `@react-pdf/renderer`, stored in a private bucket with their SHA-256, and opened by 60-second signed URLs: the worker their own, owner, hr and finance any. They show masked bank account and RSA PIN (last 4) only.
15. **One rule set per run** (coordinator, 23 Nov 2026, from the 5.0 money review). A payroll run uses one `tax_rule_sets` version: the one in force on the run's pay date (the 25th, clamped to the month), snapshotted on the run by 5.2 (`private.tax_rule_set_on(org, date)`). The pay-policy figures (overtime multiplier, off-day minutes) are taken per day, from the version in force on the day worked.

### Choices made in this plan (recommended defaults; the owner can overturn any)

None of these is a Nigerian legal rule.
- **Overtime minutes are paid exactly**: every approved overtime minute, no rounding and no threshold (carried from Phase 4).
- **Off-day work**: an approved day with worked minutes is an off day when it is a no-shift day, or an assigned shift beyond `work_days_per_week` (5) in the worker's ISO week (the latest days in the week count as the extra ones). It pays the flat 8 hours at the overtime rate, not its actual minutes.
- **A day that is both an off day and a public holiday** pays the larger of the two rules, never both.
- **Daily workers**: a day counts once per date when an approved line on it has worked minutes above 0. Overtime minutes pay at daily rate ÷ standard shift hours.
- **Hourly pay rates** (`pay_type` hourly, in Phase 1 but not in RULES_NIGERIA): approved worked minutes plus overtime minutes × hourly rate ÷ 60, with statutory deductions as for monthly workers unless `employment_type` is daily. Open question 11.
- **Daily and hourly workers get no leave pay**: they are paid for days or hours worked. Leave still counts against their balance.
- **With Shifts switched off**, monthly workers are paid from pay rates and leave alone; HR enters days or hours worked for daily and hourly workers as run inputs with a reason.
- **One-off and recurring earnings** (an allowance, a bonus) are taxable and not pensionable unless HR marks them pensionable. **Deductions** (salary advance repayment, "2 of 3") come off after tax. Open question 12.
- **Net change anomaly**: a worker whose net pay moves more than 10% from their last posted payslip is flagged.
- **Pay date**: the run shows the company's pay day (the 25th); HR may set another date for that run. The app never moves it for weekends on its own.
- **Year to date** on the payslip is the calendar year (the tax year under the Nigeria Tax Act 2025 is assumed to be the calendar year; **confirm with a tax adviser**).

## Open questions for the owner (defaults above apply until answered)

Each has a recommended default; the plan builds the default. Questions marked **(adviser)** need the tax adviser's answer before the first live payroll, whatever the owner chooses for the build.

1. **Public-holiday work** (RULES_NIGERIA open point 1). Is it paid as the hours actually worked, or as a fixed 8-hour overtime shift like off-day work? Does a monthly worker rostered on a public holiday who doesn't work still get full pay? **Default:** every minute worked on a public holiday (worked plus overtime) is paid at the overtime rate on top of normal pay; a monthly worker keeps full pay for a rostered holiday not worked (no deduction); a daily worker is paid only for days worked. **(adviser)**
2. **What "gross" means for the hourly rate** (open point 2; the owner said "gross base pay"). **Default:** the full monthly gross, basic + housing + transport + other allowances, as RULES_NIGERIA records it. The alternative is basic only, or basic + housing + transport.
3. **Preset A maternity leave below 6 months' service** (`leave_request_pay.pay_below_service`). **Default:** unpaid, the coordinator's default from Phase 4: the leave days are deducted at 100%. From 6 months' service it pays 50% (Labour Act s.54(1)(c)). **(adviser)**
4. **Unpaid and part-paid leave deduction.** **Default:** monthly gross × the leave's working days in the cycle ÷ rostered working days in the cycle × (100 − pay percent)%, rounded once per leave line. The same base as proration, so a fully unpaid cycle pays 0. Alternatives: ÷ 20 days (the hourly divisor), or ÷ calendar days. Calendar-day leave (maternity) is deducted only for the days that would have been working days.
5. **Mid-cycle pay-rate changes.** **Default:** split the cycle by rostered working days in each version (the proration rule applied per version); overtime is priced at the version in force on the day worked. The alternative is the rate in force on the last day of the cycle.
6. **Negative net pay.** **Default:** never paid. Statutory deductions come first, then other deductions in the order they were added, each cut to what fits so net pay is at least ₦0; the remainder is carried to the next run as an outstanding deduction, shown on the payslip and flagged. Whether Nigerian law caps total deductions from wages is **(adviser)**.
7. **Payslips by email or in the app.** **Default:** the payslip lives in the worker app (`/m/payslips`, PDF download behind sign-in); every worker gets an inbox item at release, and workers with an email get a short "Your October payslip is ready" email with a link, no amounts and no attachment, inside the email caps. Resend Free's 100 a day (30 per company) won't cover a 162-person release: Resend Pro is needed before the first live payroll.
8. **Absence without leave for monthly workers** (a no-show day, a rejected day). **Default:** no automatic deduction; the run flags each worker's no-show days and HR adds a deduction with a reason if the company docks pay.
9. **PAYE details (adviser).** (a) Annualise the month (the default, RULES_NIGERIA's "annual tax ÷ 12") or a cumulative year-to-date method that evens out joiners, overtime and arrears? (b) The prototype treats a minimum-wage earner as PAYE exempt; RULES_NIGERIA.md has no such rule, so the default is the bands only. (c) The tax state is `workers.tax_state`; a worker without one is a blocking anomaly.
10. **Overtime, off-day and arrears in the pension base (adviser).** **Default:** pension and NHF use basic + housing + transport (prorated) only; overtime, off-day pay, other allowances and one-off earnings are left out of the pension base but taxed.
11. **Hourly-rate workers (adviser).** **Default:** paid for approved minutes, with statutory deductions as monthly workers unless their employment type is daily.
12. **One-off earnings and deductions (adviser).** **Default:** earnings taxable, not pensionable unless marked; deductions after tax.
13. **Remittance due dates (adviser).** RULES_NIGERIA gives only pension (within 7 working days of paying salary). **Default:** pension due 7 working days after the pay date (skipping weekends and the company's public holidays); PAYE, NHF, NSITF and ITF have a due date only when the company sets one in Settings > Payroll rules (until the adviser confirms them); ITF accrues monthly and is remitted when the company records it.
14. **ITF eligibility.** **Default:** on when the run has 5 or more workers in the levy base; the owner may switch it (₦50m turnover is not known to the app), with a reason, audited. **(adviser)**
15. **Who approves.** **Default:** Finance or the owner, never the preparer. Should admins see payroll? Default no.

## Calculation design

### Two pure stages and a trace

```
inputs (5.1, server)  ──►  earnings stage (5.1)  ──►  gross-to-net stage (5.0)  ──►  PayslipResult
pay rates by day,          monthly salary,             pension, NHF, PAYE,            lines, totals,
rostered days, leave,      proration, rate splits,     levies, employer cost,         trace, anomalies
approved minutes,          overtime, off-day,          net pay, deductions
holidays, adjustments      public holiday, leave,      cut to fit
                           daily and hourly pay
```

- `src/lib/payroll/rule-set.ts`: the rule set type, a Zod schema for `tax_rule_sets.rules`, and `NTA_2025_V1`, the starting values, which must equal RULES_NIGERIA.md (a unit test compares them figure by figure, as `src/lib/leave/presets.ts` does).
- `src/lib/payroll/paye.ts`: annual tax on taxable kobo through the bands, kept as an exact fraction (kobo × basis points), and `monthlyPaye` that divides by 12 and rounds half up once.
- `src/lib/payroll/gross-to-net.ts` (5.0): `grossToNet(input: GrossToNetInput, rules: RuleSet, options: GrossToNetOptions): PayslipResult`, where `options` is `{ itfApplies: boolean; ruleSetId?: string | null; priorTrace?: TraceStep[] }` (ITF is a per-run choice, open question 14).
- `src/lib/payroll/earnings.ts` (5.1): `computeEarnings(input: PayInputs, policy: PayPolicy): EarningsResult`, which returns the earning lines and the trace steps that `grossToNet` continues.
- `src/lib/payroll/trace.ts`: the trace's shape and the text the Explain panel shows ("Gross pay (₦120,000 × 12)", "Less employee pension 8%", "15% on ₦452,800").

The contract between the stages, fixed here so 5.0 and 5.1 can be built at the same time:

```ts
type EarningCode =
  | "basic" | "housing" | "transport" | "other_allowances"   // monthly salary, prorated
  | "daily_pay" | "hourly_pay"
  | "overtime" | "off_day" | "public_holiday"
  | "leave_deduction"                                          // negative
  | "adjustment_earning" | "arrears";
interface EarningLine {
  code: EarningCode;
  label: string;                // "Overtime, 6 h 20 min at ₦750 an hour"
  amountKobo: bigint;           // rounded once, may be negative only for leave_deduction
  pensionable: boolean;         // counts toward basic + housing + transport
  nhfBase: boolean;             // counts toward basic
  taxable: boolean;
  sources: PaySourceRef[];      // timesheet lines, leave requests, adjustments
}
interface GrossToNetInput {
  employmentType: "permanent" | "contract" | "casual" | "daily";
  earnings: EarningLine[];
  nhfOptIn: boolean;
  annualRentKobo: bigint;
  deductions: DeductionLine[];  // after tax, in the order added
  carriedDeductionKobo: bigint; // outstanding from earlier runs (decision 6 default)
}
interface PayslipResult {
  grossKobo: bigint; payeKobo: bigint; pensionEmployeeKobo: bigint; nhfKobo: bigint;
  otherDeductionsKobo: bigint; netKobo: bigint; carriedForwardKobo: bigint;
  pensionEmployerKobo: bigint; nsitfKobo: bigint; itfKobo: bigint; employerCostKobo: bigint;
  lines: PayslipLine[]; trace: TraceStep[]; flags: AnomalyCode[];
}
```

As built in 5.0: the contract types are in `src/lib/payroll/contract.ts`, with `PaySourceRef` in 5.1's shape. The rule set decides which salary components (`basic`, `housing`, `transport`, `other_allowances`) count toward the pension and NHF bases; a line's own `pensionable` and `nhfBase` flags count only for other codes, and an overridden flag is recorded in the trace (`base_override`). In memory a `TraceStep` has 5.1's shape (`valueKobo: bigint | null`, `ruleRef`, camel case); `storedTrace()` in `src/lib/payroll/trace.ts` gives the stored jsonb (`value_kobo` as a string, `rule_ref`). 5.2 keeps one definition of `EarningLine` and `TraceStep` (5.1's `earning-lines.ts` and 5.0's `contract.ts` / `trace.ts` agree in shape).

### Inputs (5.1)

Gathered by one definer read, `private.payroll_inputs(org, period_start, worker_ids)` (owner, hr, finance or the secret key), as jsonb, then typed and checked with Zod on the server:
- **Pay rates as of each day** of the cycle (every version that overlaps it), with the worker's employment type, start and end dates.
- **Rostered working days**: each day of the cycle marked working or off by the 4.4 rule (assigned shifts, including `on_leave` removals; else usual days; else the company's default days). Employed days are the ones from `start_date` to `end_date`.
- **Approved timesheet lines** in the cycle, and approved lines from earlier posted cycles not yet paid (arrears): line id, work date, `worked_minutes`, `ot_minutes`, whether it had a shift assignment, the post's project (null until Phase 8, multiplier 1.0×).
- **Public holidays** in the cycle (not removed).
- **Approved leave** overlapping the cycle: request id, type's counting, days in the cycle that are working days, `pay_percent`, `pay_below_service`.
- **Adjustments** for the run (5.2) and outstanding carried deductions.
- **Statutory details**: `tax_state`, `pfa_name`, `nhf_opt_in`, `annual_rent_declared_kobo`, whether a TIN and an RSA PIN are on file (never the numbers).

### Earnings rules (5.1)

- **Monthly salary**: each pay version's components × that version's rostered employed days ÷ rostered days in the full cycle, rounded once per component per version (with `allocateKobo` so the components sum to the rounded version total). With one version and the full cycle employed, exactly the monthly components.
- **Normal hourly rate**: monthly gross (open question 2) ÷ (`hourly_rate_divisor_days` × `standard_shift_minutes` ÷ 60), kept as a fraction; daily workers: daily rate ÷ standard shift hours; hourly workers: the hourly rate.
- **Overtime**: Σ approved `ot_minutes` × hourly rate (of the version on that day) × multiplier ÷ 60, rounded once per pay version (one line per version, sources listing each day).
- **Off-day work**: off-day count × `off_day_paid_minutes` (480) at the overtime rate, rounded once per version.
- **Public holiday**: minutes worked on holidays (open question 1) at the overtime rate, rounded once per version.
- **Leave**: one deduction line per leave request (open questions 3 and 4).
- **Daily workers**: daily rate × days worked, plus overtime.
- **Arrears**: earlier-period days approved after posting, priced at the rate in force on each day, one line per earlier period.

### Gross to net (5.0)

Per worker, in this order, each line rounded once:
1. Gross = Σ earning lines.
2. Daily workers: no PAYE, pension, NHF, NSITF or ITF; net = gross − other deductions; employer cost = gross.
3. Pension base = Σ pensionable lines; employee pension = base × 8%; employer pension = base × 10%.
4. NHF = Σ NHF-base lines × 2.5% where opted in, else 0.
5. Annual taxable = 12 × (Σ taxable lines − employee pension − NHF) − min(annual rent × 20%, ₦500,000), floored at 0.
6. Annual tax through the bands as an exact fraction; monthly PAYE = annual tax ÷ 12, rounded half up.
7. Net before other deductions = gross − PAYE − employee pension − NHF; other deductions and the carried deduction are cut to fit (open question 6).
8. NSITF = gross × 1%; ITF = gross × 1% when ITF applies; employer cost = gross + employer pension + NSITF + ITF.

Worked check, Musa Ibrahim (golden): gross ₦120,000; pension ₦9,600; annual gross ₦1,440,000 − ₦115,200 pension − ₦72,000 rent relief = ₦1,252,800 taxable; 15% of ₦452,800 = ₦67,920; ÷ 12 = PAYE ₦5,660; net ₦104,740; employer cost ₦120,000 + ₦12,000 + ₦1,200 + ₦1,200 = ₦134,400.

### Outputs

- **Payslip** (one per worker per run): gross, PAYE, employee pension, employer pension, NHF, other deductions, net, NSITF, ITF, employer cost, carried forward, all kobo with currency; snapshots of the rule set id, pay rate ids, employment type, tax state and PFA name; the days counted (cycle, employed, rostered, leave).
- **Payslip lines**: code, label, amount, pensionable, taxable, kind (earning, deduction, statutory, employer).
- **Payslip sources**: what each line paid (timesheet line, leave request, adjustment), unique while the payslip stands (decision 10).
- **Trace** (`payslips.trace jsonb`): versioned (`trace_version`), an ordered list of steps `{step, label, formula, inputs (kobo as strings, days, minutes), value_kobo, rule_ref}`. No names, account numbers, RSA PINs or TINs in the trace.
- **Run totals** and **levies** by kind and authority (tax state, PFA), feeding 5.6.

### Tests that gate the engine

- `tests/unit/payroll/golden.test.ts`: converts every naira figure in `fixtures/october-2026-golden.json` to kobo (× 100, as `bigint`) and compares each worker's PAYE, employee pension, net and employer cost, the totals and `statutory` (`pension_total`, `nsitf`, `itf`) exactly. Components split 50% basic, 30% housing, 20% transport (the WkPayslip board's ₦60,000 / ₦36,000 / ₦24,000), full cycle, no overtime, no NHF, ITF on (6 workers). The `invoices` part is Phase 6.
- Property tests (fast-check, or loops if the dependency isn't wanted): net + deductions = gross for any input; no line rounds twice; allocations sum to the whole; PAYE is monotonic in gross.
- Band edges: taxable exactly ₦800,000, ₦800,001, ₦3,000,000, ₦50,000,000; rent relief at the ₦500,000 cap (rent ₦2,500,000 and ₦3,000,000).

## Lira groundwork (every slice)

As in Phases 2 to 4 (docs/LIRA.md): every new Server Action goes in `src/server/capabilities/registry.ts`; summary reads give counts and totals only (workers in the run, anomalies open, total net, no names with amounts, no bank or tax numbers); **every write that changes money has a preview** used by the screen's confirm step (create or recalculate a run: totals against the last posted run; add an adjustment: the worker's net before and after; submit; approve: the control totals and anomaly count; make a bank file: item count, total, workers left out; release; record a remittance; reverse a run: the negative totals); new server paths set the audit channel (`worker_app` for payslip reads and "Ask HR" from `/m`). Every payroll write is kind `money` and `agent: false` (LIRA.md "Never releases payroll or moves money"); bank file and schedule downloads and PII reveals are `agent: false`. Each slice adds 5 to 10 manager requests with expected outcomes to `fixtures/lira/payroll.md` ("how many workers are in the October run?", "why is Ibrahim Sani's pay up this month?" answered from the trace, "approve the October run" refused as a person's decision).

## Roles and access

| Thing | Read | Write |
| --- | --- | --- |
| Tax rule sets and payroll settings | owner, hr, finance | owner, hr (a new dated version with a reason; never a past one) |
| Payroll runs, payslips, lines, sources, anomalies | owner, hr, finance; the worker their own payslips, only once the run is released | hr and owner prepare, recalculate and submit; finance and owner approve (never the preparer) and release; nobody edits after approval |
| Run adjustments (one-off and recurring earnings and deductions) | owner, hr, finance | owner, hr, while the run is a draft |
| Run decisions (submitted, returned, approved, released, reversed) | owner, hr, finance | the run functions only; insert-only |
| Payout batches and items, the bank file | owner, finance (control totals and masked last 4 also to hr) | owner, finance make the file and release; downloads audited |
| Statutory remittances, schedules, receipts | owner, hr, finance | owner, hr, finance record a payment and upload its receipt; schedules with RSA PINs download for owner, hr, finance only, audited |
| Payslip PDFs | the worker their own (released); owner, hr, finance | made by the server at release |
| Pay rates (`pay_rates`, the Pay section of a person's page) | owner, hr, finance; the worker their own (owner decision, 23 Nov 2026, slice 5.1) | owner, hr (dated versions, as Phase 1) |
| The people import (its file and rows carry pay) | owner, hr | owner, hr |
| Pay inputs (`payroll_inputs`, `payroll_period`) | owner, hr, finance, the secret key | none (a read) |
| Line managers, ops managers, admins, client approvers | nothing in Payroll and no pay rates (owner decision, 23 Nov 2026) | nothing |

## Slices (one pull request each)

### 5.0 Rule sets and the gross-to-net engine (independent, first)
- Migration `20261122100000_tax_rule_sets.sql`.
- `tax_rule_sets`: organisation, name ("NTA 2025 v1"), `effective_from`, `effective_to`, `rules jsonb` (PAYE bands in kobo and basis points, rent relief bps and cap, pension employee and employer bps and base components, NHF bps and base, NSITF bps, ITF bps and minimum staff, daily-worker exemption), `policy jsonb` (overtime multiplier bps 10000, off-day paid minutes 480, public-holiday mode per open question 1), `source_label`, `adviser_confirmed_at` null, `adviser_note` null, `reason`, created_by. Dated, no overlaps (GiST), never updated except to close `effective_to`; a version in force or used by a posted run can't change (guard).
- `private.tax_rule_set_template()` returns the starting version; `ensure_tax_rule_set(org)` copies it on first use (idempotent, from 1 Jan 2026); `add_tax_rule_set_version(org, rules, policy, effective_from, reason)` (owner, hr; from tomorrow or a future date; Zod and a SQL check of the shape); `confirm_tax_rule_set(org, id, note)` records the adviser's confirmation (owner).
- Pure `src/lib/payroll/rule-set.ts`, `paye.ts`, `gross-to-net.ts`, `trace.ts` as in "Calculation design".
- Screen: Settings > Payroll rules (`/app/settings/payroll`): the version in force with every figure and "Confirm with a tax adviser before the first live payroll" until `adviser_confirmed_at` is set, earlier versions, and "Add a version" with its preview (the figures that change).
- Tests: unit (golden, band edges, rent cap, NHF on and off, daily worker, property tests, the template equals RULES_NIGERIA.md), RLS (isolation, owner and hr write, finance reads, line manager and worker see nothing, no overlap, a version in force can't be updated, the template in SQL equals `NTA_2025_V1`).
- **money-reviewer.**

**Accept:** `pnpm test` reproduces every figure of `fixtures/october-2026-golden.json` from the engine, and Settings > Payroll rules shows the bands with the adviser line.

### 5.1 Pay inputs and the earnings stage (independent of 5.0; uses the contract above)
- Migration `20261122110000_pay_inputs.sql`.
- `private.payroll_inputs(org, period_start, worker_ids)` and its invoker wrapper (owner, hr, finance, the secret key; 42501 otherwise): the inputs listed in "Inputs (5.1)", no personal numbers. `private.payroll_period(org, date)` gives the cycle (start the 20th, end the 19th, pay date the 25th, from the organisation's settings).
- `organisations.payroll_settings`-style columns only if a figure has nowhere else to live (ITF on or off per open question 14, remittance due-day settings per open question 13); otherwise everything comes from `organisations` and the rule set's policy.
- Pure `src/lib/payroll/inputs.ts` (Zod parse of the jsonb, the rostered-day calendar reusing `src/lib/leave/days.ts`) and `src/lib/payroll/earnings.ts` (every rule in "Earnings rules").
- No screen: a server read `loadPayInputs(org, period)` with a summary (workers, days, minutes, counts of leave and holidays).
- Tests: unit (full cycle equals the monthly gross; a joiner on the 1st of October; a leaver on the 5th; a rate change mid-cycle; a 12-hour shift worked in full is not overtime; 20 overtime minutes; a sixth shift in a week pays 8 hours; a no-shift day; a public holiday worked, not worked, and on an off day; preset A maternity at 50% and below 6 months; unpaid leave across the 19th and 20th; daily worker with two lines on one date; hourly worker; arrears from a day approved after posting (with a fake posted flag)), RLS (only owner, hr, finance and the secret key can call the read; another company's worker id gives nothing; line managers 42501).
- **money-reviewer** (pay maths) and **security-reviewer** (a definer read joining pay rates, leave and work records).

**Accept:** for a worker on ₦120,000 who joins on Thursday 1 Oct 2026, with no shifts and the company's default Monday-to-Friday days, the earnings stage counts 13 of 21 rostered days and gives basic, housing and transport summing to ₦74,286 (₦120,000 × 13 ÷ 21, rounded half up once), and a full-cycle worker gets exactly ₦120,000.

### 5.2 The payroll run: draft, review, anomalies (after 5.0 and 5.1)
- Migration `20261122120000_payroll_runs.sql`.
- `payroll_runs`: period_start, period_end, pay_date, kind (regular; off_cycle and reversal come in 5.7), status (draft, review, approved, released; reversed in 5.7), rule_set_id, `inputs_sha256`, totals (gross, PAYE, employee and employer pension, NHF, other deductions, net, NSITF, ITF, employer cost, worker count; kobo and currency), prepared_by, submitted_at. One regular run per company and period (unique).
- `payslips` (as DATA_MODEL plus the columns in "Outputs"), `payslip_lines`, `payslip_sources` (unique on source while its payslip stands), `payroll_adjustments` (worker, kind earning or deduction, label, amount, pensionable, taxable, recurring with instalments "2 of 3", reason, actor; draft runs only), `payroll_anomalies` (run, worker null, code, severity blocking or warning, detail jsonb without personal numbers, acknowledged_by, acknowledged_at), `payroll_run_decisions` (insert-only: submitted, returned with a reason; 5.3 adds approved and released).
- Functions: `create_payroll_run(org, period)` (hr, owner), `save_payroll_results(org, run, results jsonb, inputs_sha256)` (server only: the secret key after the server ran the engine; checks every invariant in SQL and replaces the draft's payslips in one transaction), `add_payroll_adjustment` / `remove_payroll_adjustment` (draft only, then recalculation), `acknowledge_payroll_anomaly`, `submit_payroll_run` (no unacknowledged anomaly; no blocking anomaly at all; records the decision; emails Finance and the other owners inside the caps), `return_payroll_run(org, run, reason)` (finance, owner: back to draft).
- Anomalies (the board's list, worked out at each recalculation): no pay rate for part of the cycle (blocking), pending or disputed timesheet days in the period (warning: "5 timesheets still block this run", acknowledged per site as "pay next run"), bank details missing, in the 72-hour hold or "Not checked" from the first import, first pay, leaver's final pay, net change over 10%, net cut to ₦0 with a carried deduction, two workers sharing one account number (the server compares decrypted numbers in memory; nothing stored or logged), no tax state (blocking), no PFA or RSA PIN while pension is due, no-show days (open question 8).
- Server `src/server/payroll/run.ts`: gather inputs (5.1), run the engine per worker, hash the canonical inputs, save. Recalculation is explicit ("Recalculate", with a preview of totals against the current draft).
- Screen `/app/payroll` per the Payroll board: the run list by period with status chips; the six steps (Period with pay date and rule set; Timesheets with flagged days by site and Review links to `/app/timesheets`; Earnings and one-off changes with Add; Anomalies with acknowledge; Gross to net with Explain showing the trace; Submit with the totals: net pay, PAYE by tax state, pension by PFA, NSITF and ITF, anomalies acknowledged, "Prepared by … A different person in Finance must approve before any payment file is released."). The `payroll-ready` illustration (160) when a run is waiting for approval.
- Tests: unit (anomaly rules, canonical hashing ignores key order, adjustments in the engine), RLS (isolation for every table; hr and owner prepare; finance can't prepare; line manager and admin see nothing; payslips of a draft invisible to workers; `save_payroll_results` refused to signed-in users and refused when the invariants fail; a source paid twice refused), Playwright: create the October run for the six golden workers, add an allowance, acknowledge anomalies, open Explain for Musa Ibrahim (PAYE ₦5,660), submit, at 1440px and 390px.
- **money-reviewer** and **security-reviewer.**

**Accept:** HR creates the October 2026 run, the Gross to net step shows the golden figures for the six workers with totals ₦870,000 / ₦55,150 / ₦69,600 / ₦745,250 / ₦974,400, Explain shows the trace, and submit is refused while an anomaly is unacknowledged.

As built in 5.2 (migration `20261122120000_payroll_runs.sql`):
- **Refusal codes.** MLPR1 to MLPR3 were already Phase 1's pay-rate codes, so 5.2 uses MLPR4 (anomalies stop the submission), MLPR6 (results break an invariant), MLPRA (a regular run for the period exists), MLPRB (a blocking anomaly can't be acknowledged), MLPRC (a source already paid) and MLPRD (the run isn't in a state that allows this). **5.3 and 5.4 must not use MLPR1, MLPR3 or MLPR5 as planned above**: pick free codes (for example MLPRE onwards).
- **Two people (for 5.3).** `private.payroll_run_touchers(org, run)` returns everyone who prepared or changed a run: `prepared_by`, every recalculator (`calculated_by` and the audit log's `payroll.results_saved` actors), every submitter, every adjustment's `created_by` and every anomaly's `acknowledged_by`. Each is taken from the session where they acted (a recalculation's actor is the signed-in user the server checked). 5.3's approval must refuse anyone in that list.
- **Inputs.** 5.1's `payroll_inputs(org, period, worker_ids)` keeps its signature; `payroll_run_inputs(org, period, run, worker_ids)` is the run's read (its own draft never hides what it pays). Arrears leave out lines already a source of a standing payslip of another run; `week_off_days_paid` counts the week's shift days other runs paid as off-day work (`payslip_sources.off_day`); `week_shift_days` counts only days before the cycle (the cycle's own off-day rule sees the whole week). Ordering is stable, so the inputs hash is deterministic.
- **Sources.** `payslip_sources` holds one row per source per payslip with the lines it backs; an exclusion constraint keeps a source's days unpaid twice across standing payslips (`stands`, which 5.7's reversal will clear through its own function).
- **History.** A run reads the regular run of the period just before: its payslips give the carried deduction and the 10% net check when it is posted; when it isn't, the run has the blocking anomaly `previous_not_posted`. A worker with no payslip there carries from their own latest posted payslip. Recurring instalments are carried at creation only from posted runs; a series of the period before not carried is the warning `recurring_not_carried`. HR clears it with **Carry next instalment** (`carry_payroll_instalment`), which continues the same series at instalment n + 1 (refused if that instalment exists anywhere), so a manual add never starts a second series. The previous run is the latest regular run of an earlier period. An adjustment line pays exactly one adjustment, once per payslip; an adjustment whose worker the inputs don't hold blocks the run (`calculation_failed` with its id).
- **Anomaly severity** is derived in SQL from the code (`private.payroll_anomaly_severity`, mirrored by `ANOMALY_SEVERITY`). Details hold ids, dates, counts and percentages only: open timesheet days name the site by id; a shared-account group names at most 20 worker ids with the full count.
- **Work records.** `worker_has_work_records` counts payslips of runs past draft.
- **Admins** no longer see the Payroll run nav item (decision 8).

### 5.3 Two-person approval, posting and the period lock (after 5.2)
- Migration `20261122130000_payroll_approval.sql`.
- `approve_payroll_run(org, run)`: finance or owner, trusted session, never `prepared_by` nor anyone who added an adjustment or acknowledged an anomaly on this run (MLPRE); re-gathers inputs on the server and refuses a changed hash (MLPRF); status review → approved; writes the decision; posting guards make the run, payslips, lines and sources immutable for every role, the secret key and the database owner (truncate guard included).
- **Replace `private.timesheet_period_posted`**: true when the day falls in the period of an approved or released regular run that isn't reversed. Reopen and Dispute then refuse with MLTA5 (4.3's code).
- **Replace `private.worker_has_work_records`** with a real check on `payslips`.
- **Backdated pay rates** (Phase 1 decision 17): `private.pay_rates_guard` lets a new version start as far back as the first day of the earliest unposted period; a version used by a posted payslip can't change or be cancelled.
- The approver sees the control totals and every acknowledged anomaly before approving (preview); the preparer gets an email on approval or return.
- Tests: RLS (same person refused, including an owner who prepared; hr can't approve; changed inputs refused; posted rows refused for every role and the database owner; period lock makes 4.3's reopen and dispute refuse; a pay rate backdated into a posted period refused, into an unposted one allowed), **end-to-end golden test** `tests/rls/payroll-golden.test.ts`: seed the six golden workers with pay rates and a full October 2026 cycle of approved days, run the server engine, approve as a second person, and compare every stored payslip and the run totals with the fixture in kobo. Playwright: Finance approves; HR's own approval is refused with the two-person message.
- **money-reviewer** and **security-reviewer.**

**Accept:** a second person approves the October run, the stored payslips equal the golden fixture to the kobo, and reopening a timesheet day in 20 Sep–19 Oct is refused.

As built in 5.3 (migration `20261122130000_payroll_approval.sql`):
- **Refusal codes.** MLPRE (the approver prepared or changed the run), MLPRF (the inputs weren't re-checked, or changed since the run was worked out) and MLPRG (posted payroll used this pay rate, or a pay-rate change reaches into a posted period). MLPR1 to MLPR3 stay Phase 1's pay-rate codes (MLPR2 now also says how far back a new version may start); MLPR5 stays free for 5.4.
- **Two people.** `approve_payroll_run(org, run)` (owner or finance, trusted session) refuses anyone in `private.payroll_run_touchers` (preparer, every recalculator, submitters, adjusters, acknowledgers; the owner included) and a check constraint keeps `approved_by` apart from `prepared_by`, `submitted_by` and `calculated_by`. hr never approves (42501).
- **Re-gathering on the server (decision 7).** The server reads the inputs as the approver, hashes them with the engine's canonical form and records the hash with the secret key in `payroll_approval_checks` (insert-only; `record_payroll_approval_check`, service role only, naming the approver). The approval needs the approver's own latest check, made after the latest submission and in the last 2 minutes (the server records it and approves in one action), with the hash the run was worked out from; a signed-in user can't write a check, so nobody skips it. The preview runs the same re-gathering without recording.
- **Approval holds what the run pays (money review M1).** The server reads the database's clock (`payroll_clock()`, secret key) before it gathers the inputs and stores it on the check as `read_started_at`. `approve_payroll_run` takes the run's workers' leave locks (4.4's key, in worker order), FOR SHARE locks on the run's timesheet-line, leave and pay-version sources, refuses if any isn't approved, gone, no longer covering its days or written after the read began, and refuses if a timesheet decision, leave decision, pay rate or adjustment in the run's scope (its workers; the period, and 400 days back for timesheet days) was written after the read began. Those refusals say "Something changed while you were approving. Try again."; a check whose hash differs says to return the run to HR.
- **Posting.** review → approved sets `approved_at` and `approved_by`; nothing about an approved run changes after (5.4 adds approved → released). Every payroll guard (runs, payslips, lines, sources, adjustments, anomalies, decisions, checks, and the truncate guards) is an `ENABLE ALWAYS` trigger, so `session_replication_role = replica` doesn't skip them, and none reads a session setting. 5.7 adds its reversal through a function of its own. 5.2's recurring-instalment test now approves September through the real functions instead of setting the status as the database owner with triggers off.
- **Period lock.** `private.timesheet_period_posted` is true for a day in the period of an approved or released regular run; 4.3's reopen and dispute refuse with MLTA5, and `timesheet_lines_freeze_posted` (ENABLE ALWAYS, so replica mode doesn't skip it) refuses any change (but its timestamps and 4.2's adding of `late_punch_after_decision`) or delete of an approved or rejected timesheet day in a posted period, and the insert of an approved or rejected day into one, for everyone. 4.2's `timesheet_lines_guard` stays an ordinary trigger: seeding in the test suites inserts decided days with triggers off, and the freeze alone holds what posting relies on.
- **Leave in posted periods (money review H1; coordinator decision).** Approving leave (either step) and cancelling APPROVED leave refuse with MLTA5 ("Part of this leave is in a posted pay period. Ask payroll to correct it in the next run.") when any of the request's days fall in a posted period; declining, or withdrawing a request not approved yet, pays nothing differently and stays open. `cancel_leave_request`, `decide_leave_line_manager` and `decide_leave_hr` are each their latest version (4.4, 4.5, 4.7b) with only that check added. A pending day there may still be approved or rejected; an approval is paid in the next run as arrears (tested end to end in `tests/rls/payroll-golden.test.ts`).
- **Rule sets.** `private.tax_rule_set_in_posted_run` checks posted runs. A version a posted run used may still close when a new version is added from tomorrow, but never before that run's pay date and period end (otherwise no rule change would ever be possible after the first payroll).
- **Backdated pay rates (Phase 1 decision 17).** Once the company has posted payroll, a new version for a worker who has one may start back to the day after the latest posted period; until then 1.3's "today or later" stays (so the earliest unposted period is never guessed before payroll runs in the app). No version's end moves into a posted period, a version that ended in one never changes, and a version a posted payslip used never changes or is cancelled (MLPRG). A version starting after the posted period that no posted payslip used may have its amounts corrected or be cancelled even in force (money review M2: a backdated typo). A version that ended before today stays frozen, as before, except that it may be reopened (its end moved later, as when the version after it is cancelled) when it ends on the last posted day, or after it and no posted payslip used it. The floor counts regular runs only. `public.pay_rate_earliest_start(org)` (owner, hr, finance) feeds the Pay section's date picker.
- **Work records.** 5.2 already made `worker_has_work_records` count payslips of runs past draft; 5.3 leaves it.
- **Email.** The preparer (and the submitter, when someone else) gets "Payroll for … is approved" or "… was returned to you" (`payroll_approved`, `payroll_returned`, inside the shared caps); no amounts and no reason text.

### 5.4 Bank file export and release (after 5.3)
- Migration `20261122140000_payout_batches.sql` (built as `20261122170000`: 5.5 and 5.6 merged first).
- `worker_bank_details_as_of` returns `bank_code` (and the previous bank code from a change; Phase 2 carry).
- `payout_batches` (run, bank_format, file_path, file_sha256, item_count, total_kobo, currency, status active or voided, voided_by, void_reason, made_by) and `payout_items` (batch, payslip, bank name, bank code, account name, `bank_account_last4`, the bank-detail change id used, amount, status pending, left_out with a reason; matched comes from Phase 6 statement debits). One active batch per run (partial unique index); making a new one voids the previous with a reason. Insert-only except status moves inside the functions.
- Private bucket `payroll-files` (CSV only, size limit), path `{organisation_id}/{run_id}/{batch_id}.csv`; no select grant on objects; 60-second signed URLs made by the server for owner and finance; downloads audited as `payroll.bank_file_downloaded` (batch id only).
- `src/server/payroll/bank-formats/`: a registry of formats (`id`, `label`, `extension`, `render(items): Uint8Array`), and `generic-csv` (beneficiary name, account number, bank code, bank name, amount in naira with 2 decimals from kobo, narration "Salary Oct 2026 MLS-0001"), with cells that start with `=`, `+`, `-` or `@` prefixed so a spreadsheet never runs them. Each pilot's template becomes one more format with its fixture test.
- `make_payout_batch` (server: decrypts each account number with `pii.ts`, refuses a last-4 mismatch (MLBF1; 5.4's refusal codes use the prefix MLBF, not MLPR5) and a missing bank code, leaves out workers HR acknowledged as having no usable bank details, records items and the file's SHA-256, never logs a number). The screen shows count, total and SHA-256 as control totals.
- `release_payroll_run(org, run)`: finance or owner, with an active batch; status approved → released; triggers 5.5's publication.
- Screen: the run's Pay step on `/app/payroll/[id]`: format picker, Make file (preview: "162 workers, ₦18,412,600; 2 left out"), Download, "I uploaded it to the bank" (release), voided files listed.
- Tests: unit (generic CSV bytes against a fixture, formula-injection escaping, kobo to naira with 2 decimals, total equals the sum), RLS (isolation, hr can't download or make a file, a second active batch refused, items insert-only, the bucket refuses direct reads by any signed-in role and another company's path), a test that the server log of a file run holds no account number, Playwright: Finance makes the file, sees the control totals, downloads it, releases.
- **money-reviewer** and **security-reviewer.**

**Accept:** Finance makes the October bank file, the control totals equal the run's net total and count, the file opens only through a 60-second link, and a worker whose last 4 digits don't match is refused by name.

As built in 5.4 (migration `20261122170000_payout_batches.sql`):
- **Refusal codes** use the prefix **MLBF** (coordinator, 24 Nov 2026), not MLPR5: MLBF1 an account number's last 4 digits don't match, or it isn't 10 digits (the server, by name; the database has no key), MLBF2 no bank details and HR didn't acknowledge it on the run (by name), MLBF3 no bank code (by name), MLBF4 the items don't match the run's payslips and the details in force now (or nobody can be paid), MLBF5 the run or file isn't in a state that allows this (not approved, released, a voided file), MLBF6 replacing the current file needs a reason, MLBF7 release needs an active file, MLBF8 the releaser prepared or changed the run, MLBF9 the stored file isn't at the batch's path with that size. MLPR5 stays unused.
- **Bank code as of a moment.** `bank_detail_changes.previous_bank_code` is set by its own trigger when a second person approves (the worker's code then); `worker_bank_details_as_of` (dropped and created again from its 1.7 version, same body, role check and grants) returns `bank_code` last: the change's, the replaced one during the hold, or the worker's.
- **Who is paid** (decision 11, `src/lib/payroll/payout.ts`, checked again in SQL): net ₦0 is left out (`nothing_to_pay`); no usable details is left out (`no_bank_details`) only when HR acknowledged a `bank_missing` or `bank_in_hold` anomaly for the worker on the run, else refused by name; a change waiting or in its hold is left out (`bank_change_in_hold`) when HR acknowledged a bank anomaly, else paid to the account in force (the one `worker_bank_details_as_of` gives, as 1.7 intended); no bank code is refused by name. The file shows left-out workers as "not in this file"; their payslips stand.
- **Making the file** is the server's two steps: `payout_plan(org, run, with_ciphertext)` (owner and finance read it without ciphertext for the preview; only the secret key gets the encrypted numbers), decrypt in memory and check each last 4 digits, render the format, SHA-256, store the file with the secret key at `{organisation_id}/{run_id}/{batch_id}.csv`, then `make_payout_batch` **as the signed-in user** (owner or finance, trusted session). It checks the object is stored at that path with that size, re-reads the details in force and the acknowledged anomalies, and refuses any item that differs (amount = net pay, bank name, code, account name, last 4, change id, positions); a refusal deletes the stored file. A user calling it directly can't produce a file: no signed-in role can write to the bucket.
- **Tables.** `payout_batches` (control totals: `item_count`, `total_kobo`, `left_out_count`, `left_out_kobo`, `file_sha256`, `file_bytes`; one active per run by partial unique index; `void_reason` can't hold 10 digits in a row) and `payout_items` (one per payslip: position, pending or left_out with its reason, bank name, code, account name, last 4, change id, amount; `voided` when its batch is replaced; Phase 6 adds `matched`). Items are written only in their batch's transaction. Guards are ENABLE ALWAYS with truncate guards; the only changes are a batch active -> voided (while the run is approved) and its pending items -> voided. Owner, hr and finance read both (hr sees control totals and masked last 4 digits; only owner and finance download).
- **Bucket** `payroll-files`: private, CSV only, 5 MB, no storage policy at all, so no signed-in role reads, lists, signs, writes or deletes in it. `payout_file_download(org, batch)` (owner or finance) returns the active file's path and audits `payroll.bank_file_downloaded` with the batch id only; the server signs a 60-second URL with the secret key. A voided file doesn't open. 5.6's schedules use the same bucket.
- **Release.** `release_payroll_run(org, run)`: owner or finance in a trusted session, an active file (MLBF7), and never anyone in `private.payroll_run_touchers` (MLBF8; the stricter reading of rule 10: the same list approval refuses, so the owner who prepared the run can't release it either). `payroll_runs` gains `released_at` and `released_by`, with a check constraint keeping `released_by` apart from `prepared_by`, `submitted_by` and `calculated_by`; 5.3's run guard allows approved -> released only when nothing else changes. Records the `released` decision; audited as `payroll.run_released`.
- **Hook for 5.5.** After a release commits, the Server Action calls `onPayrollReleased(organisationId, runId)` in `src/server/payroll/release.ts` (inside `after()`), which runs each step of `RELEASE_FOLLOW_UPS` in order, catching and logging each failure by error name. 5.5 adds its publication (PDFs, inbox items, emails) to that list; each step must be idempotent.
- **No number anywhere but the file.** Decrypted numbers live only in server memory while the file's bytes are made (the byte buffer is zeroed after upload); errors and logs carry names and codes only; `tests/unit/payroll/bank-file-log.test.ts` captures every console channel and stdout/stderr through a run, a mismatch, an unreadable number and a database refusal.
- **Review fixes (24 Nov 2026).** Security: whoever made the active file can't release it (MLBFA; the approver may, so P prepares and makes the file, F approves and releases); bank files are swept (orphans at the bank-file path shape after 15 minutes, files of batches voided 7 days ago) through the Storage API after each file made and daily from `/api/cron/import-uploads` (Phase 5 adds no cron), each sweep audited as `payroll.bank_files_swept` with paths only (pg_cron can't remove Storage objects: Storage refuses deletes in SQL); the user's own `payout_plan` read comes before any secret-key read or decrypt; `file_sha256` is the server's attestation (the database can't hash a stored object; no signed-in role can write to the bucket); reasons refuse ten digits however spaced; a payee or bank name starting with `=`, `+`, `-` or `@` is refused by name at make time; `previous_bank_code` backfilled for changes in their hold and its trigger fires always; `worker_bank_details_as_of` refuses a caller with no signed-in user unless it is the secret key. Money: replacing a downloaded file needs the statement that it wasn't uploaded (MLBFB; kept in the void reason and the audit row, and the preview names who downloaded it when); release names the file by id and SHA-256 and is refused when another file replaced it (MLBFC) or nobody downloaded it (MLBFD); a retried release returns its decision and runs the follow-ups again; a stored file is deleted only after a real refusal, or once no batch names it; a download after release needs a reason (MLBFE) and says the file is already paid; workers left out stay listed as outstanding on the Pay step after release, with their total in the release preview.
- **Supplementary payout files** for workers left out of a released run's file are deferred to 5.7 (with corrections); until then they are paid outside the file and shown as outstanding.
- **Release hook.** `onPayrollReleased(org, run, { actorId })` calls 5.5's `publishPayslips` after the release commits (the Server Action's `after()`), on a retry too; publication is idempotent.
- **Screen.** The run's seventh step, Pay (`/app/payroll/[id]?step=pay`): control totals (workers in the file, total, left out, SHA-256), the items with masked accounts, Make file with its preview ("2 workers, ₦220,310; 0 left out"), Download (a 60-second link), "I uploaded it to the bank" (release, with its preview), and replaced files with who voided them and why.

### 5.5 Payslips: PDFs, the worker app and notices (after 5.3; built beside 5.4, wired to release when 5.4 lands)
- Migration `20261122150000_payslip_documents.sql`.
- `payslip_documents` (payslip, storage_path, sha256, made_at) and the private bucket `payslips` at `{organisation_id}/{run_id}/{payslip_id}.pdf`, 60-second signed URLs (the worker their own released payslip; owner, hr, finance any).
- `src/server/payroll/payslip-pdf.tsx` with `@react-pdf/renderer`: company name and logo, period and pay date, What you earned, Taken out, Your employer also paid, This year so far, masked bank account and RSA PIN, and the rule set's name; no illustration (DESIGN_SYSTEM).
- At release: make every PDF (chunked, idempotent), then publish: an inbox item per worker and the email per open question 7, inside the caps.
- Reads: `my_payslips` (the worker's released payslips, newest first, with year-to-date totals from posted payslips in the calendar year).
- Screen `/m/payslips` per WkPayslip: You received, Paid to GTBank ••••7712 on 25 Oct, What you earned, Taken out, Your employer also paid, This year so far, the rent line ("Tax uses your rent declaration of ₦360,000 a year"), Download PDF, Ask HR (a query to HR from the worker, reusing 4.6's text rules, kind `other`); month switcher; the `payslip-empty` illustration (96) when there are none. Manager side: each payslip on the run with its PDF.
- Tests: unit (PDF renders the golden Musa Ibrahim figures; masking), RLS (a worker reads only their own released payslips; a draft or approved-but-unreleased payslip is invisible; the bucket refuses another worker's file), Playwright: a worker opens the October payslip at 390px and downloads the PDF.
- **security-reviewer** (personal data on the payslip) and **money-reviewer** (year-to-date sums).

**Accept:** after release, Musa Ibrahim sees "You received ₦104,740" on the phone with ₦120,000 gross, PAYE ₦5,660 and pension ₦9,600, and downloads the same figures as a PDF.

As built in 5.5 (migration `20261122150000_payslip_documents.sql`):
- **Refusal codes** MLPD1 (documents are kept as written), MLPD2 (the run isn't released), MLPD3 (the PDF isn't made yet), MLPD4 (a document or notice that doesn't match its payslip, or a file that isn't in the bucket).
- **payslip_documents** is insert-only (and the file is never overwritten: the server uploads without upsert and, when a file is already at the path, records that file's hash and size; `record_payslip_document` checks the stored size, records one payslip at a time under an advisory lock, and returns the latest row unchanged when it already holds that file; explicit deny policies for insert, update and delete; audited once, as `payroll.payslip_pdf_made`) for every role, the secret key and the database owner (ENABLE ALWAYS guards and a truncate guard, as 5.3's). The path `{organisation_id}/{run_id}/{payslip_id}.pdf` is fixed from the row's ids; `record_payslip_document` (secret key only) refuses a run not released and a file that isn't in the bucket; making a PDF again adds a row and the newest row is the document.
- **The bucket** `payslips` (PDF, 5 MB) has no Storage policy at all: no signed-in role reads, lists, signs or writes it. `open_payslip_document(org, payslip)` says yes (the worker their own released payslip; owner, hr and finance any; anyone else gets P0002) and audits `payroll.payslip_downloaded` with ids only; then the server signs a 60-second URL with the secret key.
- **Workers** read payslips only through `my_payslips(org)` (their own worker record in the organisation, released runs only, 36 newest); RLS on `payslips` stays owner, hr and finance, so drafts, runs in review and approved runs not released are invisible to workers either way. The view carries no manager ids, TIN, NIN, BVN or full numbers: bank and RSA PIN are last 4 only. Year to date sums (bigint) the worker's payslips of released runs in the calendar year of the pay date, up to and including this one in my_payslips' order (pay date, approval time, id), so an approved run not released never shows through. It is frozen with the payslip's first PDF in `payslip_snapshots` (insert-only, one row per payslip, taken by `payslip_pdf_views` before rendering), together with the bank name, bank last 4 and RSA PIN last 4 as they were then; the screen and every later PDF read the snapshot, and the live figures only until it exists. Job title and company details are read live. The rent line uses the rent the tax used (the trace's `rent_relief` step), not today's declaration.
- **Bank on the payslip** is the bank name and last 4 the released run's bank file paid (5.4's payout item of the active batch), or the worker record when no item paid it (left out), frozen with the payslip's first PDF. 5.4's migration replaces `private.payslip_view` for this.
- **Publishing** is `publishPayslips(org, run, { actorId })` in `src/server/payroll/payslip-documents.ts`: PDFs not made yet, 8 at a time, uploaded and recorded; then one inbox item per payslip with a PDF (`inbox_items.payslip_id`, unique, only to that payslip's worker, only once released), with notifyWorker's email inside the caps. Title "Your October 2026 payslip is ready", no amounts, no attachment. Idempotent. "Finish publishing" on `/app/payroll/[id]/payslips` (owner, finance) runs it again for what is missing. **Wiring:** 5.4's release hook calls `publishPayslips(org, run, { actorId: released_by })` after `release_payroll_run` (in `after()`).
- **Ask HR** from a payslip is a `worker_change_requests` row with topic `other` ("About my October 2026 payslip: ..."), the question checked with 4.6's query text rules; HR answers it on the worker's page. (4.6's `staff_queries` are raised by managers to workers, so they don't fit a worker's question.)
- **The PDF** embeds Inter (SIL OFL, `src/server/payroll/fonts/`) so ₦ renders; Next traces the fonts for `/app/payroll/**`.

### 5.6 Statutory schedules and remittances (after 5.3)
- Migration `20261122160000_statutory_remittances.sql`.
- `statutory_remittances`: run, kind (paye, pension, nhf, nsitf, itf), `authority_key` (the tax state for PAYE, the PFA name for pension, null for the rest), amount (the sum of the payslip lines: employee and employer pension together for a PFA), currency, due_date (open question 13), paid_at, paid_amount, reference, recorded_by, evidence_path. Made at approval for each kind and authority with an amount above 0. Insert-only for amounts; payment is recorded once, and a wrong record is voided by a new row with a reason.
- Schedules: CSV per authority (`src/server/payroll/schedules/`): PAYE by tax state (staff ID, name, TIN, gross, taxable, PAYE), pension by PFA (staff ID, name, RSA PIN decrypted on the server, employee and employer amounts), NHF, NSITF and ITF (counts and bases). Files with RSA PINs go to the private bucket `payroll-files` like the bank file; downloads audited; never logged.
- Receipts: private bucket `payroll-evidence` (PDF, PNG, JPG checked by magic bytes, as contract documents).
- Screen: `/app/payroll/remittances`: each kind and authority with amount, due date and status (due, overdue worked out on read, paid with receipt), Download schedule, Record payment with receipt upload; the run's summary shows "PAYE to Lagos State IRS ₦1,226,300" and "Pension to 6 PFAs".
- Tests: unit (grouping by state and PFA; the golden statutory totals: pension ₦156,600, NSITF ₦8,700, ITF ₦8,700; due date of pension skipping weekends and holidays), RLS (isolation, who records, insert-only, the evidence bucket by path), Playwright: download the pension schedule and record a payment with a receipt.
- **money-reviewer** and **security-reviewer** (RSA PINs in schedules, receipts in storage).

**Accept:** the approved October run shows pension ₦156,600, NSITF ₦8,700 and ITF ₦8,700 as the golden fixture says, and HR records the pension payment with its receipt.

### 5.7 Corrections, reversals, off-cycle runs and arrears (after 5.4, 5.5 and 5.6)
- **Carried from 5.4:** a supplementary bank file for workers left out of a released run's file (their items are listed as outstanding on the Pay step until then).
- Migration `20261122170000_payroll_corrections.sql`.
- `payroll_runs.kind` gains off_cycle and reversal; `reverses_run_id`.
- `reverse_payroll_run(org, run, reason)`: before release only (the bank file wasn't used): a reversal run with negative copies of every payslip, prepared by one person and approved by a second (the same two-person checks); the original becomes reversed, its sources free again, its active batch voided, its remittances voided, and `timesheet_period_posted` stops counting it. After release, money has gone: corrections are adjustments in the next run or an off-cycle run, never a reversal.
- Off-cycle runs for chosen workers (a leaver's final pay, a missed worker, a correction): same steps, same engine, their own payslips and bank file.
- **Carried from 5.3 (leave is locked in posted periods until these land):** leave arrears (leave approved after posting is deducted in the next run), a refund for leave cancelled after posting, and a deduction for leave approved after posting; then lift 5.3's MLTA5 refusal in `cancel_leave_request`, `decide_leave_line_manager` and `decide_leave_hr`.
- Arrears end to end: an approved day from a posted period is picked up by the next run's earnings (5.1's rule), with its source recorded; a correction to a posted payslip is an adjustment line naming the payslip it corrects.
- Outstanding carried deductions shown and settled across runs (open question 6).
- Tests: RLS (reversal needs two people; a released run can't be reversed; reversal frees sources and unlocks the period; an off-cycle run can't pay a source already paid), unit (negative copies sum to minus the original; arrears priced at the day's rate), Playwright: reverse an approved run before release; run an off-cycle final pay.
- **money-reviewer** and **security-reviewer.**

**Accept:** an approved run reversed before release leaves the period open and its days payable again, and a day approved after posting pays in the next run as arrears, once.

## Order and waves

```
5.0 rule sets + engine ─┐
                        ├── 5.2 run ── 5.3 approval, lock ──┬── 5.4 bank file, release ──┐
5.1 inputs + earnings ──┘                                    ├── 5.5 payslips ────────────┼── 5.7 corrections
                                                             └── 5.6 statutory ───────────┘
```

At most three agents at once:
- **Wave 1:** 5.0 and 5.1, in parallel against the stage contract in "Calculation design".
- **Wave 2:** 5.2, from 5.1's branch with 5.0 merged in (or from `main` once both land).
- **Wave 3:** 5.3, from 5.2's open branch.
- **Wave 4:** 5.4, 5.5 and 5.6, each from 5.3's branch (5.5 wires its publication to `release_payroll_run` once 5.4 lands).
- **Wave 5:** 5.7, with 5.4, 5.5 and 5.6 merged.

Migrations in order: `20261122100000` (5.0), `20261122110000` (5.1), `20261122120000` (5.2), `20261122130000` (5.3), `20261122140000` (5.4), `20261122150000` (5.5), `20261122160000` (5.6), `20261122170000` (5.7). A fix-up migration takes the next free minute in its own hour (for example `20261122120500`).

Reviews: **money-reviewer** on every slice (5.0 to 5.7). **security-reviewer** on 5.1 to 5.7 (definer reads of pay and work records, two-person checks, private buckets, decrypted account numbers and RSA PINs, worker access to payslips).

No new crons. New buckets: `payroll-files`, `payslips`, `payroll-evidence`.

### Estimated time (at the Phase 3 and 4 pace)

Phase 3 took about 14 hours for 9 slices and Phase 4 about 16 hours for 10. A slice takes build, CI, review, fixes and CI again. Phase 5 adds the money-reviewer to every slice, so each slice runs about 30 to 45 minutes longer than its Phase 4 equivalent. Sizes: M as 4.0 and 4.1, L as 4.2 to 4.4.

| Wave | Slices | Size | Runs | Time |
| --- | --- | --- | --- | --- |
| 1 | 5.0 rule sets and engine · 5.1 pay inputs and earnings | M · L | in parallel | 4 to 5 h |
| 2 | 5.2 payroll run | L | alone, started from 5.1's branch | 3.5 to 4 h |
| 3 | 5.3 approval, posting and the period lock | M | alone | 2.5 to 3 h |
| 4 | 5.4 bank file · 5.5 payslips · 5.6 statutory | L · M · M | in parallel | 4 to 5 h |
| 5 | 5.7 corrections, reversals, off-cycle runs | L | alone | 3.5 to 4 h |
| | Sign-off and live-site checklist | | | 0.5 h |
| | **Total** | | | **18 to 21.5 h** |

Starting each wave from the previous slice's open branch (the build-speed rule) overlaps the waves by about an hour each, which brings the total to about 17 to 21 hours of continuous running: one day and night, or 1.5 to 2 days with breaks. Waves 2, 3 and 5 are single slices on the critical path, so more agents would not shorten them. The risks that stretch it: the golden test failing on a rule nobody has confirmed (5.0), the local database stack failing (it slowed Phase 4), and session restarts.

## Illustrations
- `payroll-ready` (160) when a run waits for approval (5.2), and `payslip-empty` (96) on `/m/payslips` with none yet (5.5). Both slots are already in DESIGN_SYSTEM.md's table; draw them in `src/components/illustrations/` if they aren't drawn yet.

## Phase 5 done when
- The app reproduces `fixtures/october-2026-golden.json` exactly (BUILD_PLAN): the engine's unit test (5.0), the end-to-end database test through run and approval (5.3), and the statutory totals (5.6), every figure compared in kobo.
- Gross to net has a trace for every worker, shown by Explain on the run and summarised on the payslip.
- A run can't be approved by the person who prepared it, and can't be approved after its inputs changed.
- Approved payslips, lines and sources can't be edited or deleted by anyone; corrections are reversals (before release) or adjustments and off-cycle runs.
- Posting locks the pay period: reopening or disputing a timesheet day in it is refused.
- The bank file has control totals, refuses a last-4 mismatch, sits in a private bucket behind 60-second links, and no account number appears in a log.
- Workers read their released payslips and download the PDF on the phone; nobody else's.
- Every statutory figure shows "confirm with a tax adviser before the first live payroll" until the adviser's confirmation is recorded.
- Every Phase 5 table is in the isolation test; every Server Action is in the capability registry, all payroll writes `agent: false`, and every money write has a preview.
- `/app/payroll`, its run pages, Settings > Payroll rules, `/app/payroll/remittances` and `/m/payslips` work at 390px and 1440px.

## Needed from the owner
- **The tax adviser's confirmation** of the 2026 PAYE bands and method, rent relief, pension, NHF (and whether it is optional), NSITF, ITF, the daily-worker exemption, the minimum-wage question, the pension and tax treatment of overtime and one-off pay, and the remittance due dates (open questions 1, 3, 6, 9 to 14), before Phase 5 ends (BUILD_PLAN "Open decisions"). Recorded on the rule set with `confirm_tax_rule_set`.
- **Each pilot's bank bulk-payment template** (a blank file and a filled sample with fake numbers), to add as formats in 5.4 or after. Until then the generic CSV is the only format.
- A sample bank statement export from each pilot (needed for Phase 6, and to match payout debits).
- Answers to open questions 1 to 8 and 15 (the defaults are built meanwhile).
- Resend Pro before the first live payroll release (open question 7).

## Carried forward
From earlier phases, closed in this phase:
- `private.timesheet_period_posted` returns false (4.3): replaced in 5.3 (and 5.0's `tax_rule_set_in_posted_run`).
- `leave_request_pay.pay_percent` and `pay_below_service` are stored for payroll (4.4): read in 5.1.
- Pay from approved timesheet lines and leave, overtime rounding, public-holiday work (RULES_NIGERIA open points 1 and 2) (Phase 4 "Still open"): 5.1, with open questions 1 and 2.
- `worker_bank_details_as_of` returns the bank code (Phase 2): 5.4.
- Bank file and release decrypt each account number and refuse a last-4 mismatch, including first-import details (Phase 1): 5.4; "Not checked" details are an anomaly in 5.2.
- Backdated pay changes (Phase 1 decision 17): 5.3.
- Pay rates readable by admin and ops_manager (Phase 1 policy): closed in 5.1 by the owner's decision of 23 Nov 2026. Pay rates are read by owner, hr and finance (and the worker their own) and changed by owner and hr; admins add employees without pay; the people import is owner and hr only. Migration `20261122110000_pay_inputs.sql`.
- `private.worker_has_work_records` gains payslips: 5.3.

Still open for later phases (from the Phase 4 sign-off and earlier):
- Phase 6: price Work Units from the rate card in force on their date; match payout debits from bank statements to `payout_items` (status matched); the rest as in PHASE_2.md.
- Phase 7: actual labour cost per Work Unit and site from posted payslips (sources and levies per line make this possible).
- Phase 8: special project and task overtime multipliers (`pay_ot_multiplier_bps`); 5.1 uses 1.0× until then.
- Consider refusing payroll release while company setup is unfinished (Phase 1).
- Unicode hardening of the inbox and query text rules: refuse `\p{Cf}` and count digits after NFKC (applies to "Ask HR" too).
- Hide manager user ids from workers in what the worker app reads (payslip reads in 5.5 return no manager ids).
- A crew group photo viewer for managers (from Phase 3).
- Replacing a past-day night shift from the board (from Phase 3).
- The HR file's "Timesheet exceptions by period" placeholder (`hr-file-timesheet-placeholder`); it can read `timesheet_review_days`.
- Crons: `vercel.json` has 7 daily crons; Phase 5 adds none. Check Hobby's cron limit before adding more.
- Supabase Pro before the first pilot (selfies, photos, and now payslip PDFs and bank files in storage).
- A manager inbox, so payroll notices to Finance and HR don't spend email.
- Leave attachments (medical certificates) with a private bucket and signed URLs.
- The Phase 2 and 3 low hardening follow-ups.
