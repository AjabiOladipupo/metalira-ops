import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type PayrollSubmittedEmailProps = {
  organisationName: string | null;
  /** "20 Sep to 19 Oct 2026". */
  period: string;
  /** "25 Oct 2026". */
  payDate: string;
  workers: number;
  preparerName: string | null;
  /** Absolute URL of the run. */
  runUrl: string;
  appUrl: string;
};

export const payrollSubmittedSubject = (period: string) =>
  `Payroll for ${period} is waiting for your approval`;

/**
 * Tells Finance and the other owners that HR submitted a payroll run (slice 5.2). Counts, dates
 * and names only: no amounts, no bank or tax numbers, no attachment (docs/PHASE_5.md rule 8).
 */
export function PayrollSubmittedEmail({
  organisationName,
  period,
  payDate,
  workers,
  preparerName,
  runUrl,
  appUrl,
}: PayrollSubmittedEmailProps) {
  const company = organisationName ?? "your company";
  const who = preparerName ?? "HR";
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={`${workers} ${workers === 1 ? "payslip" : "payslips"} for ${period} wait for a second person to approve.`}
      reason={`You received this email because you approve payroll at ${company} in ${APP_NAME}.`}
    >
      <EmailHeading>Payroll waiting for approval</EmailHeading>
      <EmailText>
        {who} submitted payroll for {period}: {workers} {workers === 1 ? "worker" : "workers"}, paid
        on {payDate}.
      </EmailText>
      <EmailText>
        A different person from the one who prepared it must approve before any payment file is
        released. The totals and every acknowledged anomaly are on the run.
      </EmailText>
      <EmailButton href={runUrl}>Open the run</EmailButton>
    </EmailLayout>
  );
}

export default PayrollSubmittedEmail;
