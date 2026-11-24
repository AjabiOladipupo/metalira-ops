import type { ManagerRole } from "@/lib/roles";

/**
 * Who sees and changes pay (owner decision, 23 Nov 2026; migration 20261122110000_pay_inputs).
 * Pay amounts are personal pay data: owner, hr and finance read them (finance through payroll);
 * owner and hr add and cancel pay versions and import the people file, which carries pay. Admin,
 * ops_manager and line managers see no pay. RLS on pay_rates holds the same line.
 */
export const PAY_READERS = ["owner", "hr", "finance"] as const satisfies readonly ManagerRole[];
export const PAY_EDITORS = ["owner", "hr"] as const satisfies readonly ManagerRole[];
/** The people import carries pay columns, so it follows PAY_EDITORS. */
export const PEOPLE_IMPORTERS = PAY_EDITORS;
/** Who reads payroll inputs and runs (docs/PHASE_5.md "Roles and access"). */
export const PAYROLL_READERS = PAY_READERS;

export function canReadPay(role: ManagerRole): boolean {
  return (PAY_READERS as readonly ManagerRole[]).includes(role);
}

export function canEditPay(role: ManagerRole): boolean {
  return (PAY_EDITORS as readonly ManagerRole[]).includes(role);
}
