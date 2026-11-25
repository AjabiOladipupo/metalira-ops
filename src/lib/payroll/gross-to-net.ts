import { applyBps, BPS_DENOMINATOR, roundHalfUp, sumKobo, type Kobo } from "@/lib/money";

import {
  isNegativeEarning,
  isRegularEarning,
  type AnomalyCode,
  type GrossToNetInput,
  type GrossToNetOptions,
  type PayslipLine,
  type PayslipResult,
  type YearToDate,
} from "./contract";
import { annualPaye, roundFraction, type AnnualPaye, type Fraction } from "./paye";
import {
  SALARY_COMPONENTS,
  formatBps,
  formatComponents,
  type RuleSet,
  type SalaryComponent,
} from "./rule-set";
import { traceLess, traceNaira, traceStep, type TraceStep } from "./trace";

/**
 * Gross to net (slice 5.0; docs/PHASE_5.md "Gross to net (5.0)"; slice 5.9a, the tax adviser's
 * answers of 24 Nov 2026). Pure, `bigint` only.
 *
 * Per worker, in this order, each line rounded once, half up (RULES_NIGERIA "Rounding"):
 * 1. Gross = Σ earning lines (a leave deduction and a pre-tax clawback are negative lines).
 * 2. Daily workers, only when the rule set exempts them (NTA 2025 v1): no PAYE, pension, NHF,
 *    NSITF or ITF; net = gross − other deductions; employer cost = gross. From NTA 2025 v2 they
 *    pay like everyone else (owner decision, slice 5.9a).
 * 3. Pension base = Σ pensionable lines (v2: the consolidated daily pay too); employee pension =
 *    base × 8%; employer = base × 10%. v2: none when the company has fewer than 3 employees on
 *    the pay date (`options.pensionApplies`).
 * 4. NHF = Σ NHF-base lines × 2.5% where opted in; v2 also needs an NHF number on file and gross
 *    pay at or above the monthly minimum wage, else it isn't taken and the run flags it.
 * 5. PAYE, cumulative year to date (slice 5.9a, every run; with nothing earlier in the year it is
 *    exactly the month annualised, so the golden fixture still holds): chargeable pay = taxable
 *    lines − employee pension − NHF; C = the year's chargeable pay so far (standing payslips,
 *    the opening balance) + this payslip's; m = months elapsed; annualised taxable = C × 12 ÷ m
 *    − annual reliefs (rent relief; v2's NHIS and life assurance), floored at 0; tax due to date
 *    = band tax on it × m ÷ 12; PAYE = tax due to date − PAYE already withheld this year,
 *    rounded once, half up, to the kobo, never below ₦0 (an over-withholding is carried on the
 *    trace and flagged). v2: a worker whose annualised total income (the year's gross × 12 ÷ m)
 *    is at or below the yearly minimum wage owes no tax.
 * 6. Net before other deductions = gross − PAYE − employee pension − NHF (always in full). The
 *    carried deduction, then other deductions in the order added, are each cut to what fits so
 *    net pay is at least ₦0 and, v2, so together they are at most a third of gross (Labour Act
 *    s.5(7)); the rest is carried forward and flagged (open question 6's default).
 * 7. NSITF = base × 1% (v2: regular pay only, the lines `isRegularEarning` names); ITF = gross ×
 *    1% when ITF applies; employer cost = gross + employer pension + NSITF + ITF.
 *
 * The rates come from the rule set (docs/RULES_NIGERIA.md and the adviser's answers), never from
 * this file.
 */

/** A salary component's code ("basic", ...), whose base membership the rule set decides. */
function salaryComponent(code: string): SalaryComponent | null {
  return (SALARY_COMPONENTS as readonly string[]).includes(code) ? (code as SalaryComponent) : null;
}

export class PayrollInputError extends Error {
  override name = "PayrollInputError";
}

const REF = {
  gross: "PHASE_5 gross to net step 1",
  daily: "RULES_NIGERIA pay policy: daily workers",
  pension: "RULES_NIGERIA pension (PRA 2014)",
  nhf: "RULES_NIGERIA NHF",
  paye: "RULES_NIGERIA PAYE (Nigeria Tax Act 2025)",
  rent: "RULES_NIGERIA PAYE: rent relief",
  rounding: "RULES_NIGERIA rounding",
  deductions: "PHASE_5 open question 6",
  levies: "RULES_NIGERIA employer levies",
  ytd: "Tax adviser 24 Nov 2026: cumulative PAYE (NTA 2025, NTAA 2025)",
  minimumWage: "Tax adviser 24 Nov 2026: minimum-wage exemption",
  reliefs: "Tax adviser 24 Nov 2026: reliefs on verified proof",
  pensionRules: "Tax adviser 24 Nov 2026: pension (PRA 2014)",
  nhfConditions: "Tax adviser 24 Nov 2026: NHF Act",
  nsitf: "Tax adviser 24 Nov 2026: NSITF on regular pay (ECA 2010)",
  cap: "Labour Act s.5(7), owner decision pending a lawyer",
} as const;

function assertInput(input: GrossToNetInput): void {
  for (const line of input.earnings) {
    if (isNegativeEarning(line.code)) {
      if (line.amountKobo > 0n) throw new PayrollInputError(`A ${line.code} line is never positive.`);
    } else if (line.amountKobo < 0n) {
      throw new PayrollInputError(`An earning line (${line.code}) is never negative.`);
    }
  }
  for (const d of input.deductions) {
    if (d.amountKobo < 0n) throw new PayrollInputError("A deduction is never negative.");
  }
  if (input.carriedDeductionKobo < 0n)
    throw new PayrollInputError("A carried deduction is never negative.");
  if (input.annualRentKobo < 0n) throw new PayrollInputError("Declared rent is never negative.");
  if (
    input.reliefs &&
    (input.reliefs.nhisAnnualKobo < 0n || input.reliefs.lifeAssuranceAnnualKobo < 0n)
  ) {
    throw new PayrollInputError("A relief is never negative.");
  }
}

function assertYearToDate(ytd: YearToDate): void {
  if (!Number.isInteger(ytd.monthsElapsed) || ytd.monthsElapsed < 1 || ytd.monthsElapsed > 12)
    throw new PayrollInputError("Months elapsed in the tax year are 1 to 12.");
  if (ytd.payeKobo < 0n || (ytd.opening !== null && ytd.opening.payeKobo < 0n))
    throw new PayrollInputError("PAYE withheld is never negative.");
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10" → "October 2026". */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? month} ${y}`;
}

export function grossToNet(
  input: GrossToNetInput,
  rules: RuleSet,
  options: GrossToNetOptions,
): PayslipResult {
  assertInput(input);
  const r = rules.rules;
  const adviser = r.adviser;
  const ytd = options.yearToDate ?? null;
  if (ytd) assertYearToDate(ytd);
  const trace: TraceStep[] = [...(options.priorTrace ?? [])];
  const lines: PayslipLine[] = [];
  const flags: AnomalyCode[] = [];

  trace.push(
    traceStep(
      "rule_set",
      `Rule set ${rules.name}`,
      "The version in force on the run's pay date, for the whole run",
      null,
      "PHASE_5 decision 15",
      { rule_set: rules.name, rule_set_id: options.ruleSetId ?? "starting values, not yet saved" },
    ),
  );

  // The rule set decides which salary components count toward the pension and NHF bases; a
  // line's own flag counts only for other codes (overtime, adjustments, leave deductions). From
  // NTA 2025 v2 a daily rate's consolidated pay counts toward the pension base (it has no split).
  const earnings = input.earnings.map((e) => {
    const component = salaryComponent(e.code);
    const dailyPensionable = e.code === "daily_pay" && adviser?.dailyPayPensionable === true;
    if (!component && !dailyPensionable) return e;
    const pensionable = component ? r.pension.base.includes(component) : true;
    const nhfBase = component ? r.nhf.base.includes(component) : e.nhfBase;
    if (pensionable !== e.pensionable || nhfBase !== e.nhfBase) {
      trace.push(
        traceStep(
          "base_override",
          `${e.label}: counted as ${rules.name} sets`,
          `Pension base: ${pensionable ? "in" : "out"}; NHF base: ${nhfBase ? "in" : "out"}`,
          e.amountKobo,
          dailyPensionable ? REF.pensionRules : REF.pension,
          {
            code: e.code,
            line_pensionable: e.pensionable,
            line_nhf_base: e.nhfBase,
            pensionable,
            nhf_base: nhfBase,
          },
        ),
      );
    }
    return { ...e, pensionable, nhfBase };
  });

  // 1. Gross.
  for (const e of earnings) {
    lines.push({
      code: e.code,
      kind: "earning",
      label: e.label,
      amountKobo: e.amountKobo,
      pensionable: e.pensionable,
      taxable: e.taxable,
      sources: e.sources,
    });
  }
  const gross = sumKobo(earnings.map((e) => e.amountKobo));
  if (gross < 0n)
    throw new PayrollInputError("Gross pay is below ₦0: a leave deduction or clawback exceeds pay.");
  trace.push(
    traceStep("gross", "Gross pay", `${earnings.length} earning lines added`, gross, REF.gross, {
      lines: earnings.length,
    }),
  );

  const exempt = input.employmentType === "daily" && r.dailyWorkersExempt;
  const pensionApplies = options.pensionApplies ?? true;

  let pensionBase = 0n;
  let pensionEmployee = 0n;
  let pensionEmployer = 0n;
  let nhf = 0n;
  let nhfTaken = false;
  let paye = 0n;

  if (exempt) {
    trace.push(
      traceStep(
        "daily_worker",
        "Daily worker: no PAYE, pension, NHF, NSITF or ITF",
        "Left out of the levy base",
        0n,
        REF.daily,
      ),
    );
  } else {
    // 3. Pension.
    if (pensionApplies) {
      pensionBase = sumKobo(earnings.filter((e) => e.pensionable).map((e) => e.amountKobo));
      if (pensionBase < 0n) throw new PayrollInputError("The pension base is below ₦0.");
      pensionEmployee = applyBps(pensionBase, r.pension.employeeBps);
      pensionEmployer = applyBps(pensionBase, r.pension.employerBps);
      trace.push(
        traceStep(
          "pension_base",
          "Pension base",
          `${formatComponents(r.pension.base)}, and any other pensionable line, this month`,
          pensionBase,
          REF.pension,
        ),
        traceStep(
          "pension_employee",
          `Employee pension ${formatBps(r.pension.employeeBps)}`,
          `${traceNaira(pensionBase)} × ${formatBps(r.pension.employeeBps)}, rounded half up`,
          pensionEmployee,
          REF.pension,
          { base_kobo: pensionBase.toString(), rate_bps: r.pension.employeeBps },
        ),
      );
    } else {
      trace.push(
        traceStep(
          "pension_threshold",
          "No pension: the company has too few employees",
          `Pension applies from ${adviser?.pensionMinEmployees ?? 1} employees on the pay date`,
          0n,
          REF.pensionRules,
          { min_employees: adviser?.pensionMinEmployees ?? 1 },
        ),
      );
    }

    // 4. NHF.
    if (input.nhfOptIn) {
      const needs = adviser !== null && adviser.nhfNeedsNumberAndMinimumWage;
      const noNumber = needs && input.nhfNumberOnFile === false;
      const belowMinimum = needs && gross < adviser.minimumWageMonthlyKobo;
      if (noNumber || belowMinimum) {
        flags.push("nhf_not_deducted");
        trace.push(
          traceStep(
            "nhf_not_deducted",
            "NHF not taken",
            noNumber
              ? "Opted in, but no NHF number is on file"
              : `Pay ${traceNaira(gross)} is below the minimum wage of ${traceNaira(adviser!.minimumWageMonthlyKobo)}`,
            0n,
            REF.nhfConditions,
            { no_number: noNumber, below_minimum_wage: belowMinimum },
          ),
        );
      } else {
        const nhfBase = sumKobo(earnings.filter((e) => e.nhfBase).map((e) => e.amountKobo));
        if (nhfBase < 0n) throw new PayrollInputError("The NHF base is below ₦0.");
        nhf = applyBps(nhfBase, r.nhf.rateBps);
        nhfTaken = true;
        trace.push(
          traceStep(
            "nhf",
            `NHF ${formatBps(r.nhf.rateBps)}`,
            `${traceNaira(nhfBase)} ${formatComponents(r.nhf.base)} × ${formatBps(r.nhf.rateBps)}, rounded half up`,
            nhf,
            REF.nhf,
            { base_kobo: nhfBase.toString(), rate_bps: r.nhf.rateBps, opted_in: true },
          ),
        );
      }
    }

    // 5. PAYE, cumulative year to date, exact. Everything is scaled by 10,000 so the rent relief
    //    (a rate in basis points) stays whole.
    const taxableMonthly = sumKobo(earnings.filter((e) => e.taxable).map((e) => e.amountKobo));
    const allTaxable = taxableMonthly === gross;
    const chargeableThis = taxableMonthly - pensionEmployee - nhf;
    const m = BigInt(ytd?.monthsElapsed ?? 1);
    const opening = ytd?.opening ?? null;
    const chargeableToDate =
      (ytd?.chargeableKobo ?? 0n) + (opening?.chargeableKobo ?? 0n) + chargeableThis;
    const grossToDate = (ytd?.grossKobo ?? 0n) + (opening?.grossKobo ?? 0n) + gross;
    const withheld = (ytd?.payeKobo ?? 0n) + (opening?.payeKobo ?? 0n);
    const earlier = ytd?.payslips ?? 0;
    // Nothing earlier in the year: the month annualised, shown as 5.0 showed it.
    const simple = m === 1n && earlier === 0 && opening === null;

    const reliefRaw = input.annualRentKobo * BigInt(r.rentRelief.rateBps);
    const reliefCap = r.rentRelief.capKobo * BPS_DENOMINATOR;
    const rentScaled = reliefRaw < reliefCap ? reliefRaw : reliefCap;
    const nhisAnnual = adviser?.reliefs.nhis ? (input.reliefs?.nhisAnnualKobo ?? 0n) : 0n;
    const lifeAnnual = adviser?.reliefs.lifeAssurance
      ? (input.reliefs?.lifeAssuranceAnnualKobo ?? 0n)
      : 0n;
    const reliefsScaled = rentScaled + (nhisAnnual + lifeAnnual) * BPS_DENOMINATOR;
    const relief: Fraction = { num: rentScaled, den: BPS_DENOMINATOR };

    // Annualised taxable = C × 12 ÷ m − reliefs, exact: (C × 12 × 10,000 − reliefs × 10,000 × m)
    // ÷ (m × 10,000). With m = 1 it is 5.0's month annualised, to the kobo.
    let taxableNum = chargeableToDate * 12n * BPS_DENOMINATOR - reliefsScaled * m;
    const floored = taxableNum < 0n;
    if (floored) taxableNum = 0n;
    const taxable: Fraction = { num: taxableNum, den: m * BPS_DENOMINATOR };

    if (ytd) {
      trace.push(
        traceStep(
          "year_to_date",
          `Tax year so far: ${ytd.monthsElapsed} ${ytd.monthsElapsed === 1 ? "month" : "months"} from ${monthLabel(ytd.fromMonth)}`,
          `${earlier} earlier ${earlier === 1 ? "payslip" : "payslips"} this year${opening ? `, and the opening balance to ${monthLabel(opening.asOfMonth)}` : ""}; chargeable pay to date ${traceNaira(chargeableToDate)}`,
          chargeableToDate,
          REF.ytd,
          {
            months: ytd.monthsElapsed,
            from_month: ytd.fromMonth,
            payslips: earlier,
            earlier_chargeable_kobo: ytd.chargeableKobo.toString(),
            earlier_gross_kobo: ytd.grossKobo.toString(),
            earlier_paye_kobo: ytd.payeKobo.toString(),
            opening_balance_id: opening?.id ?? "",
            opening_chargeable_kobo: (opening?.chargeableKobo ?? 0n).toString(),
            opening_gross_kobo: (opening?.grossKobo ?? 0n).toString(),
            opening_paye_kobo: (opening?.payeKobo ?? 0n).toString(),
            this_chargeable_kobo: chargeableThis.toString(),
            relief_ids: [...(ytd.reliefIds ?? [])].sort().join(","),
          },
        ),
      );
    }

    if (simple) {
      const annualTaxablePay = 12n * taxableMonthly;
      trace.push(
        traceStep(
          "annual_gross",
          `${allTaxable ? "Gross pay" : "Taxable pay"} (${traceNaira(taxableMonthly)} × 12)`,
          `${traceNaira(taxableMonthly)} × 12`,
          annualTaxablePay,
          REF.paye,
          { monthly_kobo: taxableMonthly.toString() },
        ),
        traceStep(
          "annual_pension",
          `Less employee pension ${formatBps(r.pension.employeeBps)}`,
          `${traceNaira(pensionEmployee)} × 12 = ${traceLess(12n * pensionEmployee)}`,
          12n * pensionEmployee,
          REF.paye,
          { monthly_kobo: pensionEmployee.toString() },
        ),
      );
      if (nhfTaken) {
        trace.push(
          traceStep(
            "annual_nhf",
            `Less NHF ${formatBps(r.nhf.rateBps)}`,
            `${traceNaira(nhf)} × 12 = ${traceLess(12n * nhf)}`,
            12n * nhf,
            REF.paye,
            { monthly_kobo: nhf.toString() },
          ),
        );
      }
    } else {
      const annualised: Fraction = { num: chargeableToDate * 12n, den: m };
      trace.push(
        traceStep(
          "annual_gross",
          `Chargeable pay to date, annualised (${traceNaira(chargeableToDate)} × 12 ÷ ${m})`,
          "Taxable pay less employee pension and NHF this tax year, scaled to a full year",
          roundFraction(annualised),
          REF.ytd,
          {
            chargeable_to_date_kobo: chargeableToDate.toString(),
            months: Number(m),
            exact_num: annualised.num.toString(),
            exact_den: annualised.den.toString(),
          },
        ),
      );
    }

    const capped = reliefRaw >= reliefCap && input.annualRentKobo > 0n;
    trace.push(
      traceStep(
        "rent_relief",
        input.annualRentKobo > 0n
          ? `Less rent relief, ${formatBps(r.rentRelief.rateBps)} of ${traceNaira(input.annualRentKobo)} rent (cap ${traceNaira(r.rentRelief.capKobo)})`
          : "Rent relief (no rent declared)",
        input.annualRentKobo > 0n
          ? capped
            ? `${formatBps(r.rentRelief.rateBps)} of ${traceNaira(input.annualRentKobo)} is over the cap, so ${traceNaira(r.rentRelief.capKobo)}`
            : `${traceNaira(input.annualRentKobo)} × ${formatBps(r.rentRelief.rateBps)}`
          : adviser?.reliefs.rentProofRequired
            ? "No rent with verified proof"
            : "No rent declared",
        roundFraction(relief),
        REF.rent,
        {
          annual_rent_kobo: input.annualRentKobo.toString(),
          rate_bps: r.rentRelief.rateBps,
          cap_kobo: r.rentRelief.capKobo.toString(),
          capped,
          exact_num: relief.num.toString(),
          exact_den: relief.den.toString(),
        },
      ),
    );
    if (nhisAnnual > 0n) {
      trace.push(
        traceStep(
          "nhis_relief",
          "Less NHIS or NHIA contributions (verified)",
          `${traceNaira(nhisAnnual)} a year`,
          nhisAnnual,
          REF.reliefs,
          { annual_kobo: nhisAnnual.toString() },
        ),
      );
    }
    if (lifeAnnual > 0n) {
      trace.push(
        traceStep(
          "life_assurance_relief",
          "Less life assurance or deferred annuity premiums (verified)",
          `${traceNaira(lifeAnnual)} a year`,
          lifeAnnual,
          REF.reliefs,
          { annual_kobo: lifeAnnual.toString() },
        ),
      );
    }
    trace.push(
      traceStep(
        "taxable",
        simple ? "Taxable income" : "Taxable income for the year, annualised",
        floored
          ? "Below ₦0 after reliefs, so ₦0"
          : simple
            ? "Yearly pay less pension, NHF and rent relief"
            : "Annualised chargeable pay less the year's reliefs",
        roundFraction(taxable),
        REF.paye,
        { floored, exact_num: taxable.num.toString(), exact_den: taxable.den.toString() },
      ),
    );

    // Minimum-wage exemption (v2): annualised total income G × 12 ÷ m at or below 12 × the
    // monthly minimum wage, that is G ≤ minimum wage × m.
    const exemptMinimum = adviser !== null && grossToDate <= adviser.minimumWageMonthlyKobo * m;
    if (adviser !== null) {
      trace.push(
        traceStep(
          "minimum_wage",
          exemptMinimum
            ? "At or below the minimum wage: no PAYE"
            : "Above the minimum wage: the bands apply",
          `Total income to date ${traceNaira(grossToDate)} × 12 ÷ ${m}, against ${traceNaira(adviser.minimumWageMonthlyKobo * 12n)} a year`,
          null,
          REF.minimumWage,
          {
            gross_to_date_kobo: grossToDate.toString(),
            months: Number(m),
            minimum_wage_monthly_kobo: adviser.minimumWageMonthlyKobo.toString(),
            exempt: exemptMinimum,
          },
        ),
      );
    }

    // 6. PAYE.
    const annual: AnnualPaye = exemptMinimum
      ? { tax: { num: 0n, den: taxable.den * BPS_DENOMINATOR }, portions: [] }
      : annualPaye(taxable, r.payeBands);
    for (const p of annual.portions) {
      trace.push(
        traceStep(
          "paye_band",
          `${formatBps(p.rateBps)} on ${traceNaira(roundFraction(p.portion))}`,
          p.widthKobo === null
            ? `Income above ${traceNaira(p.lowerKobo)}`
            : `Band from ${traceNaira(p.lowerKobo)}, width ${traceNaira(p.widthKobo)}`,
          roundFraction(p.tax),
          REF.paye,
          {
            band: p.band,
            rate_bps: p.rateBps,
            portion_num: p.portion.num.toString(),
            portion_den: p.portion.den.toString(),
            tax_num: p.tax.num.toString(),
            tax_den: p.tax.den.toString(),
          },
        ),
      );
    }
    trace.push(
      traceStep(
        "annual_tax",
        "Tax for the year",
        exemptMinimum ? "None: at or below the minimum wage" : "The bands added, kept exact",
        roundFraction(annual.tax),
        REF.paye,
        { exact_num: annual.tax.num.toString(), exact_den: annual.tax.den.toString() },
      ),
    );
    // Tax due to date = annual tax × m ÷ 12; PAYE = that − withheld, rounded once.
    const dueDen = annual.tax.den * 12n;
    const dueNum = annual.tax.num * m;
    const exactNum = dueNum - withheld * dueDen;
    let shortfall = 0n;
    if (exactNum >= 0n) {
      paye = roundHalfUp(exactNum, dueDen);
    } else {
      shortfall = roundHalfUp(-exactNum, dueDen);
    }
    if (simple) {
      trace.push(
        traceStep(
          "paye",
          "PAYE this month",
          "Tax for the year ÷ 12, rounded half up to the kobo once",
          paye,
          REF.rounding,
        ),
      );
    } else {
      trace.push(
        traceStep(
          "tax_to_date",
          `Tax due to date (${m} of 12 months)`,
          `Tax for the year × ${m} ÷ 12, kept exact`,
          roundHalfUp(dueNum, dueDen),
          REF.ytd,
          { exact_num: dueNum.toString(), exact_den: dueDen.toString(), months: Number(m) },
        ),
        traceStep(
          "paye_withheld",
          "Less PAYE already withheld this year",
          `${earlier} earlier ${earlier === 1 ? "payslip" : "payslips"}${opening ? " and the opening balance" : ""}`,
          withheld,
          REF.ytd,
        ),
        traceStep(
          "paye",
          "PAYE on this payslip",
          shortfall > 0n
            ? `More than the tax due to date was withheld, so ₦0 (${traceNaira(shortfall)} over)`
            : "Tax due to date less PAYE withheld, rounded half up to the kobo once",
          paye,
          REF.rounding,
        ),
      );
    }
    if (shortfall > 0n) {
      flags.push("paye_overwithheld");
      trace.push(
        traceStep(
          "paye_overwithheld",
          "PAYE withheld this year is more than the tax due to date",
          "Not refunded on this payslip (never below ₦0); carried on the trace for HR",
          shortfall,
          REF.ytd,
          { shortfall_kobo: shortfall.toString() },
        ),
      );
    }

    lines.push(
      {
        code: "paye",
        kind: "statutory",
        label: "PAYE",
        amountKobo: paye,
        pensionable: false,
        taxable: false,
        sources: [],
      },
      {
        code: "pension_employee",
        kind: "statutory",
        label: `Employee pension ${formatBps(r.pension.employeeBps)}`,
        amountKobo: pensionEmployee,
        pensionable: false,
        taxable: false,
        sources: [],
      },
    );
    if (nhfTaken) {
      lines.push({
        code: "nhf",
        kind: "statutory",
        label: `NHF ${formatBps(r.nhf.rateBps)}`,
        amountKobo: nhf,
        pensionable: false,
        taxable: false,
        sources: [],
      });
    }
  }

  // 7. Net, with other deductions cut to fit (and, v2, capped at a third of gross).
  const netBefore = gross - paye - pensionEmployee - nhf;
  if (netBefore < 0n) {
    throw new PayrollInputError(
      "Statutory deductions exceed gross pay; check the earning lines' flags.",
    );
  }
  trace.push(
    traceStep(
      "net_before_deductions",
      "Pay after tax and pension",
      exempt ? "Gross pay" : "Gross − PAYE − employee pension − NHF",
      netBefore,
      REF.gross,
    ),
  );

  // The cap rounds down, so the deductions never pass the fraction.
  const cap = adviser
    ? (gross * BigInt(adviser.deductionCap.numerator)) / BigInt(adviser.deductionCap.denominator)
    : null;
  if (adviser && cap !== null && (input.carriedDeductionKobo > 0n || input.deductions.length > 0)) {
    trace.push(
      traceStep(
        "deduction_cap",
        `Other deductions at most ${adviser.deductionCap.numerator}/${adviser.deductionCap.denominator} of gross`,
        `${traceNaira(gross)} × ${adviser.deductionCap.numerator} ÷ ${adviser.deductionCap.denominator}, rounded down`,
        cap,
        REF.cap,
      ),
    );
  }

  let room = netBefore;
  let capRoom = cap;
  let other = 0n;
  let carriedForward = 0n;
  let wasCut = false;
  let wasCapped = false;
  const take = (wanted: Kobo): Kobo => {
    let taken = wanted < room ? wanted : room;
    if (taken < wanted) wasCut = true;
    if (capRoom !== null && taken > capRoom) {
      taken = capRoom;
      wasCapped = true;
    }
    room -= taken;
    if (capRoom !== null) capRoom -= taken;
    other += taken;
    carriedForward += wanted - taken;
    return taken;
  };

  if (input.carriedDeductionKobo > 0n) {
    const taken = take(input.carriedDeductionKobo);
    lines.push({
      code: "carried_deduction",
      kind: "deduction",
      label: "Outstanding deduction from earlier pay",
      amountKobo: taken,
      pensionable: false,
      taxable: false,
      sources: [],
    });
    trace.push(
      traceStep(
        "carried_deduction",
        "Less outstanding deduction",
        taken === input.carriedDeductionKobo
          ? traceNaira(taken)
          : `${traceNaira(input.carriedDeductionKobo)} due, ${traceNaira(taken)} fits`,
        taken,
        REF.deductions,
        { wanted_kobo: input.carriedDeductionKobo.toString() },
      ),
    );
  }
  for (const d of input.deductions) {
    const taken = take(d.amountKobo);
    lines.push({
      code: d.code ?? "deduction",
      kind: "deduction",
      label: d.label,
      amountKobo: taken,
      pensionable: false,
      taxable: false,
      sources: d.sources,
    });
    trace.push(
      traceStep(
        d.code ?? "deduction",
        `Less ${d.label}`,
        taken === d.amountKobo
          ? traceNaira(taken)
          : `${traceNaira(d.amountKobo)} due, ${traceNaira(taken)} fits`,
        taken,
        REF.deductions,
        { wanted_kobo: d.amountKobo.toString() },
      ),
    );
  }
  if (wasCut) flags.push("deduction_cut");
  if (wasCapped) flags.push("deduction_capped");
  const net = netBefore - other;
  trace.push(
    traceStep(
      "net",
      "Net pay",
      carriedForward > 0n
        ? `${traceNaira(carriedForward)} of deductions carried to the next run${wasCapped ? " (over the cap)" : ""}`
        : "Pay after tax and pension, less other deductions",
      net,
      REF.deductions,
      { carried_forward_kobo: carriedForward.toString() },
    ),
  );

  // 8. Employer pension and levies.
  let nsitf = 0n;
  let itf = 0n;
  if (!exempt) {
    const regularOnly = adviser?.nsitfRegularOnly === true;
    let nsitfBase = regularOnly
      ? sumKobo(earnings.filter((e) => isRegularEarning(e.code)).map((e) => e.amountKobo))
      : gross;
    if (nsitfBase < 0n) nsitfBase = 0n;
    nsitf = applyBps(nsitfBase, r.nsitf.rateBps);
    itf = options.itfApplies ? applyBps(gross, r.itf.rateBps) : 0n;
    lines.push(
      {
        code: "pension_employer",
        kind: "employer",
        label: `Employer pension ${formatBps(r.pension.employerBps)}`,
        amountKobo: pensionEmployer,
        pensionable: false,
        taxable: false,
        sources: [],
      },
      {
        code: "nsitf",
        kind: "employer",
        label: `NSITF ${formatBps(r.nsitf.rateBps)}`,
        amountKobo: nsitf,
        pensionable: false,
        taxable: false,
        sources: [],
      },
    );
    if (options.itfApplies) {
      lines.push({
        code: "itf",
        kind: "employer",
        label: `ITF ${formatBps(r.itf.rateBps)}`,
        amountKobo: itf,
        pensionable: false,
        taxable: false,
        sources: [],
      });
    }
    trace.push(
      traceStep(
        "pension_employer",
        `Employer pension ${formatBps(r.pension.employerBps)}`,
        pensionApplies
          ? `${traceNaira(pensionBase)} × ${formatBps(r.pension.employerBps)}, rounded half up`
          : "No pension: the company has too few employees",
        pensionEmployer,
        REF.pension,
        { base_kobo: pensionBase.toString(), rate_bps: r.pension.employerBps },
      ),
      traceStep(
        "nsitf",
        `NSITF ${formatBps(r.nsitf.rateBps)}`,
        regularOnly
          ? `${traceNaira(nsitfBase)} regular pay × ${formatBps(r.nsitf.rateBps)}, rounded half up`
          : `${traceNaira(gross)} × ${formatBps(r.nsitf.rateBps)}, rounded half up`,
        nsitf,
        regularOnly ? REF.nsitf : REF.levies,
        { base_kobo: nsitfBase.toString(), rate_bps: r.nsitf.rateBps, regular_only: regularOnly },
      ),
      traceStep(
        "itf",
        options.itfApplies ? `ITF ${formatBps(r.itf.rateBps)}` : "ITF does not apply this run",
        options.itfApplies
          ? `${traceNaira(gross)} × ${formatBps(r.itf.rateBps)}, rounded half up`
          : `Under ${r.itf.minStaff} employees on the pay date, and no ₦50m turnover flag`,
        itf,
        REF.levies,
        { base_kobo: gross.toString(), rate_bps: r.itf.rateBps, applies: options.itfApplies },
      ),
    );
  }
  const employerCost = gross + pensionEmployer + nsitf + itf;
  trace.push(
    traceStep(
      "employer_cost",
      "Cost to the employer",
      exempt ? "Gross pay" : "Gross + employer pension + NSITF + ITF",
      employerCost,
      REF.levies,
    ),
  );

  return {
    grossKobo: gross,
    payeKobo: paye,
    pensionEmployeeKobo: pensionEmployee,
    nhfKobo: nhf,
    otherDeductionsKobo: other,
    netKobo: net,
    carriedForwardKobo: carriedForward,
    pensionEmployerKobo: pensionEmployer,
    nsitfKobo: nsitf,
    itfKobo: itf,
    employerCostKobo: employerCost,
    lines,
    trace,
    flags,
  };
}
