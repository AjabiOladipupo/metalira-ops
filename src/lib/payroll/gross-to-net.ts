import { applyBps, BPS_DENOMINATOR, sumKobo, type Kobo } from "@/lib/money";

import type {
  AnomalyCode,
  GrossToNetInput,
  GrossToNetOptions,
  PayslipLine,
  PayslipResult,
} from "./contract";
import { annualPaye, monthlyPaye, roundFraction, type Fraction } from "./paye";
import {
  SALARY_COMPONENTS,
  formatBps,
  formatComponents,
  type RuleSet,
  type SalaryComponent,
} from "./rule-set";
import { traceLess, traceNaira, traceStep, type TraceStep } from "./trace";

/**
 * Gross to net (slice 5.0; docs/PHASE_5.md "Gross to net (5.0)"). Pure, `bigint` only.
 *
 * Per worker, in this order, each line rounded once, half up (RULES_NIGERIA "Rounding"):
 * 1. Gross = Σ earning lines.
 * 2. Daily workers (when the rule set exempts them): no PAYE, pension, NHF, NSITF or ITF;
 *    net = gross − other deductions; employer cost = gross.
 * 3. Pension base = Σ pensionable lines; employee pension = base × 8%; employer = base × 10%.
 * 4. NHF = Σ NHF-base lines × 2.5% where opted in, else 0.
 * 5. Annual taxable = 12 × (Σ taxable lines − employee pension − NHF)
 *    − min(annual rent × 20%, ₦500,000), floored at 0, kept exact.
 * 6. Annual tax through the bands as an exact fraction; monthly PAYE = annual tax ÷ 12, rounded
 *    half up once.
 * 7. Net before other deductions = gross − PAYE − employee pension − NHF. The carried deduction,
 *    then other deductions in the order added, are each cut to what fits so net pay is at least
 *    ₦0; the rest is carried forward and flagged (open question 6's default).
 * 8. NSITF = gross × 1%; ITF = gross × 1% when ITF applies; employer cost = gross + employer
 *    pension + NSITF + ITF.
 *
 * The rates come from the rule set (docs/RULES_NIGERIA.md; confirm with a tax adviser before the
 * first live payroll), never from this file.
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
  monthAggregate: "RULES_NIGERIA PAYE: month-aggregate (owner decision, 24 Nov 2026)",
} as const;

function assertInput(input: GrossToNetInput): void {
  for (const line of input.earnings) {
    if (line.code === "leave_deduction") {
      if (line.amountKobo > 0n) throw new PayrollInputError("A leave deduction is never positive.");
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
}

export function grossToNet(
  input: GrossToNetInput,
  rules: RuleSet,
  options: GrossToNetOptions,
): PayslipResult {
  assertInput(input);
  const r = rules.rules;
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
  // line's own flag counts only for other codes (overtime, adjustments, leave deductions).
  const earnings = input.earnings.map((e) => {
    const component = salaryComponent(e.code);
    if (!component) return e;
    const pensionable = r.pension.base.includes(component);
    const nhfBase = r.nhf.base.includes(component);
    if (pensionable !== e.pensionable || nhfBase !== e.nhfBase) {
      trace.push(
        traceStep(
          "base_override",
          `${e.label}: counted as ${rules.name} sets`,
          `Pension base: ${pensionable ? "in" : "out"}; NHF base: ${nhfBase ? "in" : "out"}`,
          e.amountKobo,
          REF.pension,
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
    throw new PayrollInputError("Gross pay is below ₦0: a leave deduction exceeds pay.");
  trace.push(
    traceStep("gross", "Gross pay", `${earnings.length} earning lines added`, gross, REF.gross, {
      lines: earnings.length,
    }),
  );

  const exempt = input.employmentType === "daily" && r.dailyWorkersExempt;

  let pensionBase = 0n;
  let pensionEmployee = 0n;
  let pensionEmployer = 0n;
  let nhf = 0n;
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

    // 4. NHF.
    if (input.nhfOptIn) {
      const nhfBase = sumKobo(earnings.filter((e) => e.nhfBase).map((e) => e.amountKobo));
      if (nhfBase < 0n) throw new PayrollInputError("The NHF base is below ₦0.");
      nhf = applyBps(nhfBase, r.nhf.rateBps);
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

    // 5. Annual taxable income, exact: everything is scaled by 10,000 so the rent relief (a
    //    rate in basis points) stays whole.
    const taxableMonthly = sumKobo(earnings.filter((e) => e.taxable).map((e) => e.amountKobo));
    const allTaxable = taxableMonthly === gross;
    const annualTaxablePay = 12n * taxableMonthly;
    const reliefRaw = input.annualRentKobo * BigInt(r.rentRelief.rateBps);
    const reliefCap = r.rentRelief.capKobo * BPS_DENOMINATOR;
    const reliefScaled = reliefRaw < reliefCap ? reliefRaw : reliefCap;
    const relief: Fraction = { num: reliefScaled, den: BPS_DENOMINATOR };
    // Month-aggregate PAYE (slice 5.7b): the month's other payslips' taxable pay (already less
    // their pension and NHF) joins this one's, so the bands and rent relief apply once a month.
    const month = options.monthToDate;
    const earlierAnnual = month ? 12n * month.taxableKobo : 0n;
    let taxableScaled =
      (annualTaxablePay - 12n * pensionEmployee - 12n * nhf + earlierAnnual) * BPS_DENOMINATOR -
      reliefScaled;
    const floored = taxableScaled < 0n;
    if (floored) taxableScaled = 0n;
    const taxable: Fraction = { num: taxableScaled, den: BPS_DENOMINATOR };

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
    if (input.nhfOptIn) {
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
    if (month) {
      trace.push(
        traceStep(
          "month_to_date",
          `Plus this month's other ${month.payslips === 1 ? "payslip" : "payslips"} (${traceNaira(month.taxableKobo)} × 12)`,
          `Taxable pay less pension and NHF already paid this month: ${traceNaira(month.taxableKobo)} × 12`,
          earlierAnnual,
          REF.monthAggregate,
          { payslips: month.payslips, monthly_kobo: month.taxableKobo.toString() },
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
      traceStep(
        "taxable",
        "Taxable income",
        floored ? "Below ₦0 after reliefs, so ₦0" : "Yearly pay less pension, NHF and rent relief",
        roundFraction(taxable),
        REF.paye,
        { floored, exact_num: taxable.num.toString(), exact_den: taxable.den.toString() },
      ),
    );

    // 6. PAYE.
    const annual = annualPaye(taxable, r.payeBands);
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
    const monthPaye = monthlyPaye(annual.tax);
    trace.push(
      traceStep(
        "annual_tax",
        "Tax for the year",
        "The bands added, kept exact",
        roundFraction(annual.tax),
        REF.paye,
        { exact_num: annual.tax.num.toString(), exact_den: annual.tax.den.toString() },
      ),
    );
    if (month) {
      const owed = monthPaye - month.payeKobo;
      paye = owed > 0n ? owed : 0n;
      trace.push(
        traceStep(
          "paye_month",
          "PAYE for the month",
          "Tax for the year ÷ 12, rounded half up to the kobo once",
          monthPaye,
          REF.rounding,
        ),
        traceStep(
          "paye_earlier",
          "Less PAYE already withheld this month",
          `${month.payslips} other ${month.payslips === 1 ? "payslip" : "payslips"}`,
          month.payeKobo,
          REF.monthAggregate,
        ),
        traceStep(
          "paye",
          "PAYE on this payslip",
          owed > 0n
            ? `${traceNaira(monthPaye)} − ${traceNaira(month.payeKobo)}`
            : "Already withheld this month, so ₦0",
          paye,
          REF.monthAggregate,
        ),
      );
    } else {
      paye = monthPaye;
      trace.push(
        traceStep(
          "paye",
          "PAYE this month",
          "Tax for the year ÷ 12, rounded half up to the kobo once",
          paye,
          REF.rounding,
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
    if (input.nhfOptIn) {
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

  // 7. Net, with other deductions cut to fit.
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

  let room = netBefore;
  let other = 0n;
  let carriedForward = 0n;
  const take = (wanted: Kobo): Kobo => {
    const taken = wanted < room ? wanted : room;
    room -= taken;
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
      code: "deduction",
      kind: "deduction",
      label: d.label,
      amountKobo: taken,
      pensionable: false,
      taxable: false,
      sources: d.sources,
    });
    trace.push(
      traceStep(
        "deduction",
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
  if (carriedForward > 0n) flags.push("deduction_cut");
  const net = room;
  trace.push(
    traceStep(
      "net",
      "Net pay",
      carriedForward > 0n
        ? `${traceNaira(carriedForward)} of deductions carried to the next run`
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
    nsitf = applyBps(gross, r.nsitf.rateBps);
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
        `${traceNaira(pensionBase)} × ${formatBps(r.pension.employerBps)}, rounded half up`,
        pensionEmployer,
        REF.pension,
        { base_kobo: pensionBase.toString(), rate_bps: r.pension.employerBps },
      ),
      traceStep(
        "nsitf",
        `NSITF ${formatBps(r.nsitf.rateBps)}`,
        `${traceNaira(gross)} × ${formatBps(r.nsitf.rateBps)}, rounded half up`,
        nsitf,
        REF.levies,
        { base_kobo: gross.toString(), rate_bps: r.nsitf.rateBps },
      ),
      traceStep(
        "itf",
        options.itfApplies ? `ITF ${formatBps(r.itf.rateBps)}` : "ITF does not apply this run",
        options.itfApplies
          ? `${traceNaira(gross)} × ${formatBps(r.itf.rateBps)}, rounded half up`
          : `Under ${r.itf.minStaff} staff in the levy base, or switched off`,
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
