import "server-only";

import { createElement } from "react";
import { z } from "zod";

import { emailAppUrl } from "./config";
import { emailSafeName } from "./index";
import { sendEmail, type SendEmailResult } from "./send";
import {
  StaffIdCorrectionRequestedEmail,
  staffIdCorrectionRequestedSubject,
} from "./templates/staff-id-correction-requested";

/**
 * Emails for staff ID corrections (slice 1.11). Staff IDs are the strict sign-in token
 * (letters, digits, `._/-`), checked again here because they reach an email from Metalira's own
 * domain. One send per correction and recipient (idempotency key), so a retry never sends twice.
 */

const staffId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/);

const requestedSchema = z.object({
  to: z.email(),
  correctionId: z.uuid(),
  workerId: z.uuid(),
  recipientId: z.uuid(),
  organisationName: emailSafeName,
  workerName: emailSafeName,
  requesterName: emailSafeName,
  oldStaffId: staffId,
  newStaffId: staffId,
});

/** To one approver: a staff ID correction is waiting for a second person. */
export async function sendStaffIdCorrectionRequestedEmail(
  input: z.input<typeof requestedSchema>,
): Promise<SendEmailResult> {
  const data = requestedSchema.parse(input);
  const appUrl = emailAppUrl();
  return sendEmail({
    to: data.to,
    subject: staffIdCorrectionRequestedSubject(data.workerName),
    react: createElement(StaffIdCorrectionRequestedEmail, {
      organisationName: data.organisationName,
      workerName: data.workerName,
      oldStaffId: data.oldStaffId,
      newStaffId: data.newStaffId,
      requesterName: data.requesterName,
      reviewUrl: `${appUrl}/app/people/${data.workerId}#contact`,
      appUrl,
    }),
    tags: [{ name: "type", value: "staff_id_correction_requested" }],
    idempotencyKey: `staff-id-correction-requested/${data.correctionId}/${data.recipientId}`,
  });
}
