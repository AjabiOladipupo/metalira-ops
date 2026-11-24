import { APP_NAME } from "@/lib/app";
import { EmailButton, EmailHeading, EmailLayout, EmailText } from "../layout";

export type PayrollDecision = "approved" | "returned";

export type PayrollDecidedEmailProps = {
  decision: PayrollDecision;
  organisationName: string | null;
  /** "20 Sep to 19 Oct 2026". */
  period: string;
  /** "25 Oct 2026". */
  payDate: string;
  workers: number;
  deciderName: string | null;
  /** Absolute URL of the run. */
  runUrl: string;
  appUrl: string;
};

export const payrollDecidedSubject = (decision: PayrollDecision, period: string) =>
  decision === "approved"
    ? `Payroll for ${period} is approved`
    : `Payroll for ${period} was returned to you`;

/**
 * Tells the person who prepared a payroll run that a second person approved it or returned it
 * (slice 5.3). Counts, dates and names only: no amounts, no reason text (it is free text and could
 * carry figures), no bank or tax numbers, no attachment (docs/PHASE_5.md rule 8).
 */
export function PayrollDecidedEmail({
  decision,
  organisationName,
  period,
  payDate,
  workers,
  deciderName,
  runUrl,
  appUrl,
}: PayrollDecidedEmailProps) {
  const company = organisationName ?? "your company";
  const who = deciderName ?? "Finance";
  const count = `${workers} ${workers === 1 ? "worker" : "workers"}`;
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={
        decision === "approved"
          ? `${who} approved payroll for ${period}.`
          : `${who} returned payroll for ${period} with a reason.`
      }
      reason={`You received this email because you prepared payroll at ${company} in ${APP_NAME}.`}
    >
      <EmailHeading>
        {decision === "approved" ? "Payroll approved" : "Payroll returned"}
      </EmailHeading>
      {decision === "approved" ? (
        <>
          <EmailText>
            {who} approved payroll for {period}: {count}, paid on {payDate}.
          </EmailText>
          <EmailText>
            The payslips are posted and never change now, and the period&apos;s timesheets are
            locked. Days approved from now on are paid in the next run.
          </EmailText>
        </>
      ) : (
        <>
          <EmailText>
            {who} returned payroll for {period} to you as a draft: {count}, paid on {payDate}.
          </EmailText>
          <EmailText>
            Open the run to read the reason, change what is needed and submit again.
          </EmailText>
        </>
      )}
      <EmailButton href={runUrl}>Open the run</EmailButton>
    </EmailLayout>
  );
}

export default PayrollDecidedEmail;
