import "server-only";

import { z } from "zod";

import { lagosToday } from "@/lib/dates";
import { MANAGER_ROLES } from "@/lib/roles";
import { COMPANY_BANK_REQUESTERS, COMPANY_BANK_REVEALERS } from "@/lib/company-bank";
import {
  decideCompanyBankSpec,
  requestCompanyBankSpec,
  withdrawCompanyBankSpec,
} from "@/server/billing/company-bank";
import { lookupBankAccountSchema } from "@/server/billing/schemas";
import { listClients, loadClientsSummary } from "@/server/business/clients-data";
import {
  CLIENT_READERS,
  addContactSpec,
  createClientSpec,
  quickAddClientSpec,
  removeContactSpec,
  setClientStatusSpec,
  setClientTaxSpec,
  updateClientSpec,
  updateContactSpec,
} from "@/server/business/clients";
import {
  CONTRACT_READERS,
  addRateCardVersionSpec,
  cancelRateCardVersionSpec,
  createContractSpec,
  saveDraftRateCardSpec,
  updateContractSpec,
} from "@/server/business/contracts";
import {
  listContracts,
  loadContractsSummary,
  organisationToday,
} from "@/server/business/contracts-data";
import {
  confirmContractDocumentSpec,
  contractDocumentLink,
  removeContractDocumentSpec,
  startContractDocumentSpec,
} from "@/server/business/contract-documents";
import {
  listContractDocuments,
  loadContractDocumentsSummary,
} from "@/server/business/contract-documents-data";
import {
  addHeadcountSpec,
  removeHeadcountSpec,
  updateHeadcountSpec,
} from "@/server/business/headcount";
import {
  contractWeek,
  loadHeadcountContext,
  loadHeadcountSummary,
} from "@/server/business/headcount-data";
import { contractIdSchema } from "@/server/business/headcount-schemas";
import { activateContractSpec, endContractSpec } from "@/server/business/activation";
import {
  loadPosts,
  loadRequiredShifts,
  loadRequiredShiftsSummary,
} from "@/server/business/activation-data";
import {
  addPostSpec,
  cancelRequirementChangeSpec,
  changeRequirementSpec,
  closePostSpec,
  postIdSchema,
} from "@/server/business/live-changes";
import { loadPostDetail } from "@/server/business/live-changes-data";
import {
  advanceSetupSpec,
  completeSetupSpec,
  saveBusinessSpec,
  saveInvoicesSpec,
  savePlanSpec,
  setModulesSpec,
  uploadLogoSpec,
} from "@/server/identity/company-mutations";
import { decideOwnerChangeSpec, requestOwnerChangeSpec } from "@/server/identity/owners";
import {
  magicLinkSchema,
  newPasswordSchema,
  signInPasswordSchema,
  signUpSchema,
  switchOrganisationSchema,
} from "@/server/identity/schemas";
import {
  cancelSpec,
  changeRoleSpec,
  inviteSpec,
  removeSpec,
  resendSpec,
} from "@/server/identity/team";
import { workerSignInSchema } from "@/server/identity/worker-sign-in";
import { createInvitesSpec } from "@/server/identity/worker-invites";
import { inviteBulkSpec, previewInviteBulkSpec } from "@/server/identity/worker-invite-bulk";
import { bulkApproveLeaveSpec, previewBulkLeaveSpec } from "@/server/people/leave-bulk";
import {
  bulkApproveTimesheetSpec,
  previewBulkTimesheetSpec,
} from "@/server/workforce/timesheet-bulk";
import {
  decideBankChangeSpec,
  requestBankChangeSpec,
  withdrawBankChangeSpec,
} from "@/server/people/bank-changes";
import {
  approveOnboardingSpec,
  cancelOnboardingSpec,
  inviteOnboardingSpec,
  resendOnboardingSpec,
} from "@/server/people/self-onboarding";
import { lookupWorkerBankSchema } from "@/server/people/bank-lookups";
import { resolveChangeRequestSpec } from "@/server/people/change-requests";
import { createDepartmentSpec, updateDepartmentSpec } from "@/server/people/departments";
import {
  CALENDAR_READERS,
  addEntitlementVersionSpec,
  addHolidaySpec,
  applyPresetSpec,
  copyHolidaysSpec,
  createLeaveTypeSpec,
  removeHolidaySpec,
  saveLeaveTypeSpec,
  setWorkWeekSpec,
} from "@/server/people/leave-setup";
import { loadHolidays, loadLeaveSetupSummary } from "@/server/people/leave-setup-data";
import {
  PAYROLL_RULES_READERS,
  addRuleSetVersionSpec,
  confirmRuleSetSpec,
} from "@/server/payroll/rule-sets";
import { loadPayrollRulesSummary } from "@/server/payroll/rule-sets-data";
import { holidayYearSchema } from "@/server/people/leave-setup-schemas";
import { loadBalances, loadLeaveRequests, loadLeaveSummary } from "@/server/people/leave-data";
import {
  BALANCE_READERS,
  LEAVE_READERS,
  adjustLeaveSpec,
  cancelLeaveSpec,
  decideHrSpec,
  decideLineManagerSpec,
} from "@/server/people/leave-requests";
import {
  cancelOwnLeaveSchema,
  decideLeaveSchema,
  leaveBalancesSchema,
  leaveListSchema,
  requestLeaveSchema,
} from "@/server/people/leave-request-schemas";
import {
  applyImportFixSpec,
  cancelImportSpec,
  checkImportSpec,
  commitImportSpec,
  startImportSpec,
} from "@/server/people/imports/batches";
import { saveMappingSpec } from "@/server/people/mapping";
import {
  bulkDepartmentSpec,
  bulkEndEmploymentSpec,
  bulkLineManagerSpec,
  previewBulkEndSpec,
  previewBulkReassignSpec,
} from "@/server/people/bulk";
import { bulkMapSpec, previewBulkMapSpec } from "@/server/people/bulk-mapping";
import { checkWorkerBankSchema } from "@/server/people/schemas";
import {
  ownBankChangeSchema,
  ownBankLookupSchema,
  ownChangeRequestSchema,
} from "@/server/people/own-requests";
import { unlockSignInSpec } from "@/server/people/sign-in-status";
import { TEAM_READERS, loadTeamMembers, loadTeamSummary } from "@/server/people/team";
import { loadMyTeamSummary } from "@/server/people/team-board";
import { teamAssignShiftSpec, teamRemoveAssignmentSpec } from "@/server/people/team-roster";
import {
  HR_FILE_READERS,
  closeQuerySpec,
  followUpQuerySpec,
  loadQueriesSummary,
  raiseQuerySpec,
  replyToQuerySchema,
  withdrawQuerySpec,
} from "@/server/people/queries";
import {
  decideStaffIdCorrectionSpec,
  requestStaffIdCorrectionSpec,
  withdrawStaffIdCorrectionSpec,
} from "@/server/people/staff-id-corrections";
import {
  addPayRateSpec,
  cancelPayRateSpec,
  createWorkerSpec,
  endEmploymentSpec,
  PEOPLE_EDITORS,
  updateWorkerSpec,
} from "@/server/people/workers";
import { listSitesWithoutGeofence, loadSitesSummary } from "@/server/sites/sites-data";
import { saveAttendanceSpec, loadAttendanceSettings } from "@/server/identity/attendance-settings";
import { consentKindSchema } from "@/server/workforce/consents";
import { CONSENT_READERS, loadConsentsSummary } from "@/server/workforce/consents-data";
import { PUNCH_SUMMARY_READERS, loadTodayPunchSummary } from "@/server/workforce/clock-data";
import {
  BOARD_READERS,
  boardInputSchema,
  loadAttendanceBoard,
} from "@/server/workforce/attendance-board";
import { SELFIE_READERS, selfieLinkSchema } from "@/server/workforce/punch-selfie-link";
import { recordPunchSchema, uploadSelfieSchema } from "@/server/workforce/punches";
import { recordCrewPunchSchema, uploadCrewPhotoSchema } from "@/server/workforce/crew";
import { CREW_SUMMARY_READERS, loadTodayCrewSummary } from "@/server/workforce/crew-data";
import { loadCrewSummary } from "@/server/workforce/crew-team";
import { recordCheckpointScanSchema } from "@/server/workforce/checkpoint-scans";
import {
  PATROL_READERS,
  loadPatrolDay,
  loadPatrolSettings,
  loadPatrolSummary,
} from "@/server/workforce/patrol-data";
import { markReadSchema } from "@/server/workforce/inbox";
import {
  addCheckpointSpec,
  createSiteSpec,
  moveCheckpointSpec,
  renameCheckpointSpec,
  retireCheckpointSpec,
  rotateCheckpointQrSpec,
  setGeofenceSpec,
  setSiteStatusSpec,
  updateSiteSpec,
} from "@/server/sites/sites";
import {
  ROSTER_EDITORS,
  assignShiftSpec,
  copyLastWeekSpec,
  publishRosterSchema,
  publishRosterSpec,
  removeAssignmentSpec,
  resendPublishNoticesSpec,
} from "@/server/workforce/roster";
import {
  loadMyPublishedShifts,
  loadPublicationStatus,
} from "@/server/workforce/roster-publish-data";
import {
  loadRosterCandidates,
  loadRosterSettings,
  loadRosterSummary,
  loadRosterWeek,
} from "@/server/workforce/roster-data";
import { TIMESHEET_READERS, addCorrectionSpec } from "@/server/workforce/timesheets";
import {
  approveCleanSpec,
  approveLineSchema,
  approveLineSpec,
  disputeLineSchema,
  rejectLineSchema,
  rejectLineSpec,
  reopenLineSpec,
} from "@/server/workforce/timesheet-approval";
import { loadReviewSummary, periodInput } from "@/server/workforce/timesheet-review-data";
import { PAYROLL_READERS, loadPayInputsSummary } from "@/server/payroll/inputs";
import { loadPayslipTrace, loadRunSummary } from "@/server/payroll/run-data";
import { bankFileIdSchema, downloadBankFileSpec, makeBankFileSpec } from "@/server/payroll/payouts";
import { loadPayoutSummary } from "@/server/payroll/payouts-data";
import { releaseRunSpec } from "@/server/payroll/release";
import {
  addCorrectionSpec as addPayrollCorrectionSpec,
  approveReversalSpec,
  reverseRunSpec,
} from "@/server/payroll/reversal";
import { loadCarriedDeductionsSummary } from "@/server/payroll/carried-data";
import {
  previewRefundSchema,
  recordOffsetSpec,
  recordRefundSpec,
  startRefundReceiptSpec,
} from "@/server/payroll/remittance-resolutions";
import {
  confirmSupplementSpec,
  downloadSupplementSpec,
  makeSupplementSpec,
  supplementIdSchema,
} from "@/server/payroll/supplements";
import { loadOfficialHolidayYear } from "@/server/payroll/official-holidays";
import { loadRemittanceSummary } from "@/server/payroll/remittance-data";
import {
  REMITTANCE_RECORDERS,
  previewPaymentSchema,
  receiptLinkSchema,
  recordPaymentSpec,
  remittanceIdSchema,
  setDueDaysSpec,
  startReceiptSpec,
  voidPaymentSpec,
} from "@/server/payroll/remittances";
import { PAYSLIP_PUBLISHERS } from "@/server/payroll/payslip-documents";
import { addFinalPayItemSpec } from "@/server/payroll/final-pay";
import { setHolidayPaySpec } from "@/server/payroll/holiday-pay";
import {
  declareReliefSpec,
  importOpeningSpec,
  itfFlagSpec,
  nhfNumberSpec,
  proofLinkSpec,
  recordOpeningSpec,
  recordProofSpec,
  startProofSpec,
  verifyReliefSpec,
} from "@/server/payroll/tax-records";
import {
  askHrSchema,
  downloadPayslipSpec,
  payslipIdSchema,
  publishPayslipsSpec,
} from "@/server/payroll/payslips";
import {
  acknowledgeSpec,
  addAdjustmentSpec,
  approveRunSpec,
  carryInstalmentSpec,
  createOffCycleRunSpec,
  createRunSpec,
  discardOffCycleRunSpec,
  recalculateRunSpec,
  removeAdjustmentSpec,
  returnRunSpec,
  submitRunSpec,
} from "@/server/payroll/runs";
import {
  loadTimesheetLines,
  loadTimesheetSummary,
  summariseLines,
  timesheetRangeInput,
  timesheetSummaryInput,
} from "@/server/workforce/timesheets-data";
import { rankCandidates } from "@/lib/roster-suggestions";
import { mondayOf } from "@/lib/roster";

import {
  previewAddContact,
  previewAddRateCardVersion,
  previewCreateClient,
  previewCreateContract,
  previewMoveCheckpoint,
  previewQuickAddClient,
  previewRemoveContractDocument,
  previewSaveDraftRateCard,
  previewSetClientTax,
  previewUpdateContract,
  previewAddHeadcount,
  previewRemoveHeadcount,
  previewUpdateHeadcount,
} from "./previews";
import { previewActivateContract, previewEndContract } from "./activation-previews";
import {
  previewApproveOnboarding,
  previewCancelOnboarding,
  previewInviteOnboarding,
  previewResendOnboarding,
} from "./onboarding-previews";
import { previewSetModules } from "./company-previews";
import { previewAddPayrollFinalPayItem, previewSetPayrollHolidayPay } from "./leavers-previews";
import {
  previewAddPost,
  previewCancelRequirementChange,
  previewChangeRequirement,
  previewClosePost,
} from "./live-change-previews";
import {
  previewEntitlement,
  previewHolidayCopy,
  previewHrLeaveDecision,
  previewPreset,
} from "./leave-previews";
import {
  previewAcknowledgePayrollAnomalies,
  previewAddPayrollAdjustment,
  previewAddPayrollCorrection,
  previewApprovePayrollReversal,
  previewReversePayrollRun,
  previewAddRuleSetVersion,
  previewApprovePayrollRun,
  previewCarryPayrollInstalment,
  previewConfirmPayrollSupplement,
  previewCreateOffCyclePayrollRun,
  previewCreatePayrollRun,
  previewDiscardOffCyclePayrollRun,
  previewMakePayrollBankFile,
  previewMakePayrollSupplement,
  previewRecalculatePayrollRun,
  previewReleasePayrollRun,
  previewRemovePayrollAdjustment,
  previewRecordRemittancePayment,
  previewRemittanceOffset,
  previewRemittanceRefund,
  previewReturnPayrollRun,
  previewSubmitPayrollRun,
  previewVoidRemittancePayment,
  previewDeclarePayrollRelief,
  previewImportOpeningBalances,
  previewRecordOpeningBalance,
  previewSetItfTurnover,
  previewSetNhfNumber,
  previewVerifyPayrollRelief,
} from "./payroll-previews";
import {
  previewBulkDepartment,
  previewBulkEnd,
  previewBulkLineManager,
  previewBulkMap,
} from "./people-bulk-previews";
import { previewBulkLeave, previewBulkTimesheet, previewInviteBulk } from "./list-bulk-previews";
import { previewCopyWeek, previewPublishWeek } from "./roster-previews";
import { previewApproveClean, previewCorrection } from "./timesheet-previews";
import { fromSpec, type ActionRef, type Capability } from "./types";

/**
 * Every capability the product has, by stable name (slice 2.1, Lira groundwork; the rules are in
 * ./types.ts and docs/LIRA.md). Each exported Server Action in a `"use server"` module under
 * src/ must appear here exactly once (tests/unit/capabilities/registry.test.ts), so a new action
 * can't ship without a name, a description, its roles and its kind.
 *
 * Adding an action: register it next to its module's other entries, take `input` and `roles`
 * from its `mutate()` spec with `fromSpec`, and give a write that changes several rows or money
 * a `preview` (./previews.ts) before marking it `agent: true`.
 */

const NO_PAYROLL =
  "Lira never prepares, changes, submits, approves or releases payroll (docs/PHASE_5.md decision 8).";

const TAX_RECORDS_NOTE =
  "Opening balances, reliefs and their proofs change what PAYE withholds: a person enters and verifies them with the documents in hand (docs/PHASE_5.md decision 8).";

const REMITTANCE_NOTE =
  "Recording a statutory remittance is a person's step with the bank's receipt in hand; Lira never records payments or moves money (docs/LIRA.md).";

const payslipInput = z.object({ payslipId: z.uuid() });

const at = (module: string, name: string): ActionRef => ({
  module: `src/server/${module}.ts`,
  export: name,
});

const AUTH = "Sign-in and account flows are never run by the agent.";
const NO_PREVIEW = "Changes several rows or money and has no preview yet.";
const SECOND_APPROVER = "Decides a two-person request: the agent is never the second approver.";
const REVEAL = "Shows personal data in full: the agent sees masked values only.";
const LOOKUP =
  "Exposes an account holder's name from the bank network (personal data), and each lookup is rate-limited and may cost money: people only.";
const RATES = "Changes what clients are billed (kind money): kept to people.";
const FILES = "Takes a file from the person's device: uploads are made on the screen.";
const OPEN_FILE = "Hands out a link to a stored file: the agent never opens or passes on files.";
const GO_LIVE =
  "Makes a contract live or ends it, which starts or stops rosters and billing: kept to people for now (the owner may enable it later).";
const LIVE_CHANGE =
  "Changes a live contract's staffing over several dated rows, which rosters and billing follow: kept to people for now (the owner may enable it later).";
const COPY_WEEK =
  "Writes a whole week of assignments at once: kept to people for now, with its preview on the screen (the owner may enable it later).";
const PUBLISH_WEEK =
  "Publishes a whole week and tells every affected worker by inbox and email: kept to people for now, with its preview on the screen (the owner may enable it later).";
const QUERY_DECISION =
  "A query is a disciplinary record about a person: raising, following up and closing one are a manager's decision.";
const APPROVE_TIMESHEET =
  "Approving, rejecting or reopening a day decides what a person is paid and a client is billed: a person's decision (owner, Phase 4), with the preview on the screen.";
const BULK_PEOPLE =
  "Changes many employees at once (owner decision, slice U.1): a person confirms the preview on the screen.";
const BULK_LIST =
  "Approves, resends or cancels many rows at once (owner decision, slice U.2): a person confirms the preview on the screen.";
const ONBOARDING =
  "Grants access or adds an employee with personal data (slice U.4): kept to the owner and HR.";
const PERSONAL =
  "Takes personal data (NIN, bank, RSA PIN) as input: the agent sees masked values only.";

/** A contract's id, for the document reads. */
const contractIdInput = z.object({ contractId: z.uuid("Choose a contract") });
const documentIdInput = z.object({ documentId: z.uuid("Choose a document") });

/** A site and week on the roster (slice 3.2). */
const rosterWeekInput = z.object({
  siteId: z.uuid("Choose a site"),
  weekStart: z.iso.date("Choose a week").optional(),
});
/** One site and, optionally, a day (today in the company's zone when left out; slice 3.8). */
const patrolDayInput = z.object({
  siteId: z.uuid(),
  day: z.iso.date("Choose a day").optional(),
});
/** The worker's own published shifts, at most 62 days (slice 3.3). */
const myShiftsInput = z
  .object({ from: z.iso.date("Choose a day"), to: z.iso.date("Choose a day") })
  .refine((v) => v.from <= v.to, "Choose a from day on or before the to day");
const rosterSummaryInput = z.object({ weekStart: z.iso.date("Choose a week").optional() });
const rosterSuggestionsInput = z.object({
  postId: z.uuid("Choose a post"),
  date: z.iso.date("Choose a day"),
});

/** Posts, roster requirements and required shifts are read by every manager role (slice 2.7). */
const POST_READERS = ["owner", "admin", "hr", "finance", "ops_manager", "line_manager"] as const;

export const CAPABILITIES: readonly Capability[] = [
  // -------------------------------------------------------------------------
  // Sign-in and account (identity/actions.ts, password-actions.ts)
  // -------------------------------------------------------------------------
  {
    name: "auth.sign_in_password",
    description: "Signs a manager in with email and password.",
    kind: "write",
    audience: "public",
    roles: [],
    input: signInPasswordSchema,
    changes: "none",
    action: at("identity/actions", "signInWithPassword"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "auth.send_magic_link",
    description: "Emails a sign-in link.",
    kind: "write",
    audience: "public",
    roles: [],
    input: magicLinkSchema,
    changes: "none",
    action: at("identity/actions", "sendMagicLink"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "auth.sign_up",
    description: "Starts an owner account and sends the email link that confirms it.",
    kind: "write",
    audience: "public",
    roles: [],
    input: signUpSchema,
    changes: "none",
    action: at("identity/actions", "signUp"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "auth.sign_out",
    description: "Signs the manager out.",
    kind: "write",
    audience: "manager",
    roles: MANAGER_ROLES,
    input: null,
    changes: "none",
    action: at("identity/actions", "signOut"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "session.switch_company",
    description: "Makes another of the manager's companies the active one.",
    kind: "write",
    audience: "manager",
    roles: MANAGER_ROLES,
    input: switchOrganisationSchema,
    changes: "none",
    action: at("identity/actions", "switchOrganisation"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "account.set_password",
    description: "Chooses a password after an email link, and for a new owner names the company.",
    kind: "write",
    audience: "public",
    roles: [],
    input: newPasswordSchema,
    changes: "many",
    action: at("identity/password-actions", "setPasswordAction"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "account.send_set_password_link",
    description: "Signs out and emails a link to choose a password.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "none",
    action: at("identity/password-actions", "sendSetPasswordLinkAction"),
    agent: false,
    agentNote: AUTH,
  },

  // -------------------------------------------------------------------------
  // Company setup and settings (identity/company-actions.ts)
  // -------------------------------------------------------------------------
  {
    name: "company.save_plan",
    description: "Chooses the company's plan and expected headcount.",
    kind: "write",
    audience: "manager",
    ...fromSpec(savePlanSpec),
    changes: "one",
    action: at("identity/company-actions", "savePlan"),
    agent: false,
    agentNote: "Plan and billing choices stay with the owner.",
  },
  {
    name: "company.save_business",
    description:
      "Saves the company's business details: what it does, names, RC number, TIN, address, pay days.",
    kind: "write",
    audience: "manager",
    ...fromSpec(saveBusinessSpec),
    changes: "one",
    action: at("identity/company-actions", "saveBusiness"),
    agent: true,
  },
  {
    name: "company.save_invoices",
    description: "Saves the invoice email and payment terms.",
    kind: "write",
    audience: "manager",
    ...fromSpec(saveInvoicesSpec),
    changes: "one",
    action: at("identity/company-actions", "saveInvoices"),
    agent: true,
  },
  {
    name: "company.set_modules",
    description:
      "Switches Shifts, People and Payroll on or off for the company. Turning one off hides its pages and deletes nothing.",
    kind: "write",
    audience: "manager",
    ...fromSpec(setModulesSpec),
    changes: "one",
    action: at("identity/company-actions", "saveModules"),
    preview: previewSetModules,
    agent: true,
  },
  {
    name: "setup.continue_from_clients",
    description:
      "Moves company setup on from the clients step (to Employees, or finishes setup for a services business).",
    kind: "write",
    audience: "manager",
    ...fromSpec(advanceSetupSpec),
    changes: "one",
    action: at("identity/company-actions", "continueFromClients"),
    agent: false,
    agentNote: "Setup progress is the owner's own click.",
  },
  {
    name: "setup.finish",
    description: "Marks company setup complete.",
    kind: "write",
    audience: "manager",
    ...fromSpec(completeSetupSpec),
    changes: "one",
    action: at("identity/company-actions", "finishSetup"),
    agent: false,
    agentNote: "Setup progress is the owner's own click.",
  },
  {
    name: "company.upload_logo",
    description: "Uploads the company logo for payslips, invoices and the app.",
    kind: "write",
    audience: "manager",
    ...fromSpec(uploadLogoSpec),
    changes: "one",
    action: at("identity/company-actions", "uploadLogo"),
    agent: false,
    agentNote: "Takes a file upload.",
  },

  {
    name: "company.save_attendance",
    description:
      "Sets how many minutes late a clock-in may be, and when a missing one is a no-show.",
    kind: "write",
    audience: "manager",
    ...fromSpec(saveAttendanceSpec),
    changes: "one",
    action: at("identity/attendance-actions", "saveAttendance"),
    agent: true,
  },
  {
    name: "company.attendance_settings",
    description: "Reads the late grace period and the no-show time, in minutes.",
    kind: "read",
    audience: "manager",
    roles: ["owner", "admin", "hr", "finance", "ops_manager", "line_manager"],
    input: null,
    changes: "none",
    action: null,
    read: ({ organisationId }) => loadAttendanceSettings(organisationId),
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Team and owners (identity/team-actions.ts)
  // -------------------------------------------------------------------------
  {
    name: "team.invite",
    description: "Invites a manager to the company by email with one role.",
    kind: "write",
    audience: "manager",
    ...fromSpec(inviteSpec),
    changes: "one",
    action: at("identity/team-actions", "inviteManagerAction"),
    agent: false,
    agentNote: "Grants access to the company: kept to people.",
  },
  {
    name: "owners.request_change",
    description:
      "Asks to add, remove or demote an owner; waits for another owner when there are two.",
    kind: "write",
    audience: "manager",
    ...fromSpec(requestOwnerChangeSpec),
    changes: "many",
    action: at("identity/team-actions", "requestOwnerChangeAction"),
    agent: false,
    agentNote: "Ownership changes are kept to people.",
  },
  {
    name: "owners.decide_change",
    description: "Approves or refuses another owner's request to change the owners.",
    kind: "write",
    audience: "manager",
    ...fromSpec(decideOwnerChangeSpec),
    changes: "many",
    action: at("identity/team-actions", "decideOwnerChangeAction"),
    agent: false,
    agentNote: SECOND_APPROVER,
  },
  {
    name: "team.resend_invite",
    description: "Sends a pending manager invite again with a new link.",
    kind: "write",
    audience: "manager",
    ...fromSpec(resendSpec),
    changes: "one",
    action: at("identity/team-actions", "resendInviteAction"),
    agent: false,
    agentNote: "Grants access to the company: kept to people.",
  },
  {
    name: "team.cancel_invite",
    description: "Cancels a pending manager invite.",
    kind: "write",
    audience: "manager",
    ...fromSpec(cancelSpec),
    changes: "one",
    action: at("identity/team-actions", "cancelInviteAction"),
    agent: true,
  },
  {
    name: "team.change_role",
    description: "Changes a manager's role in the company.",
    kind: "write",
    audience: "manager",
    ...fromSpec(changeRoleSpec),
    changes: "one",
    action: at("identity/team-actions", "changeRoleAction"),
    agent: false,
    agentNote: "Changes access to the company: kept to people.",
  },
  {
    name: "team.remove_member",
    description: "Removes a manager from the company.",
    kind: "write",
    audience: "manager",
    ...fromSpec(removeSpec),
    changes: "one",
    action: at("identity/team-actions", "removeMemberAction"),
    agent: false,
    agentNote: "Changes access to the company: kept to people.",
  },
  {
    name: "team.accept_invite",
    description: "Accepts a manager invite from its link, setting a name and password if new.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "many",
    action: at("identity/team-actions", "acceptTeamInviteAction"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "team.sign_up_for_invite",
    description: "Emails a sign-in link to the address an invite was sent to.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "none",
    action: at("identity/team-actions", "signUpForInviteAction"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "team.sign_out_for_invite",
    description: "Signs out so an invite can be accepted with another account.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "none",
    action: at("identity/team-actions", "signOutForInviteAction"),
    agent: false,
    agentNote: AUTH,
  },

  // -------------------------------------------------------------------------
  // Worker app sign-in (identity/worker-actions.ts)
  // -------------------------------------------------------------------------
  {
    name: "worker.sign_in",
    description: "Signs a worker in with company code, staff ID and PIN.",
    kind: "write",
    audience: "public",
    roles: [],
    input: workerSignInSchema,
    changes: "many",
    action: at("identity/worker-actions", "signInWorker"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "worker.accept_invite",
    description: "Sets a worker's PIN from an invite and signs them in.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "many",
    action: at("identity/worker-actions", "acceptWorkerInvite"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "worker.sign_out",
    description: "Signs the worker out of the worker app.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: null,
    changes: "none",
    action: at("identity/worker-actions", "signOutWorker"),
    agent: false,
    agentNote: AUTH,
  },

  // -------------------------------------------------------------------------
  // Worker invites (identity/worker-invite-actions.ts)
  // -------------------------------------------------------------------------
  {
    name: "people.email_invites",
    description: "Emails worker app invites to the chosen employees who have an email.",
    kind: "write",
    audience: "manager",
    ...fromSpec(createInvitesSpec),
    changes: "many",
    action: at("identity/worker-invite-actions", "emailWorkerInvites"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "people.print_invites",
    description: "Makes a printable sheet of worker app invites for the chosen employees.",
    kind: "write",
    audience: "manager",
    ...fromSpec(createInvitesSpec),
    changes: "many",
    action: at("identity/worker-invite-actions", "createInviteSheet"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  // Bulk resend and cancel (identity/worker-invite-bulk-actions.ts, slice U.2)
  {
    name: "people.bulk_invites",
    description:
      "Resends or cancels the invites of up to 500 chosen workers; resends follow the email caps and the rest are skipped.",
    kind: "write",
    audience: "manager",
    ...fromSpec(inviteBulkSpec),
    changes: "many",
    action: at("identity/worker-invite-bulk-actions", "inviteBulkAction"),
    preview: previewInviteBulk,
    agent: false,
    agentNote: BULK_LIST,
  },
  {
    name: "people.preview_bulk_invites",
    description:
      "Lists which chosen workers' invites a bulk resend or cancel would change, and who is skipped and why.",
    kind: "read",
    audience: "manager",
    ...fromSpec(previewInviteBulkSpec),
    changes: "none",
    action: at("identity/worker-invite-bulk-actions", "previewInviteBulkAction"),
    agent: false,
    agentNote: BULK_LIST,
  },

  // -------------------------------------------------------------------------
  // People (people/actions.ts)
  // -------------------------------------------------------------------------
  {
    name: "people.create_worker",
    description: "Adds an employee with their first pay rate; bank details wait for approval.",
    kind: "money",
    audience: "manager",
    ...fromSpec(createWorkerSpec),
    changes: "many",
    action: at("people/actions", "createWorkerAction"),
    agent: false,
    agentNote: PERSONAL,
  },
  {
    name: "people.update_worker",
    description: "Changes an employee's details, job and mapping.",
    kind: "write",
    audience: "manager",
    ...fromSpec(updateWorkerSpec),
    changes: "one",
    action: at("people/actions", "updateWorkerAction"),
    agent: false,
    agentNote: PERSONAL,
  },
  {
    name: "people.change_pay",
    description: "Adds a dated pay rate from a chosen day; the current one closes the day before.",
    kind: "money",
    audience: "manager",
    ...fromSpec(addPayRateSpec),
    changes: "many",
    action: at("people/actions", "changePayAction"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "people.cancel_pay_rate",
    description: "Cancels a pay rate that hasn't started and reopens the one before it.",
    kind: "money",
    audience: "manager",
    ...fromSpec(cancelPayRateSpec),
    changes: "many",
    action: at("people/actions", "cancelPayRateAction"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "people.end_employment",
    description: "Ends an employee's employment on a date and closes their mapping.",
    kind: "write",
    audience: "manager",
    ...fromSpec(endEmploymentSpec),
    changes: "many",
    action: at("people/actions", "endEmploymentAction"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "people.reveal_personal_data",
    description: "Shows one personal data field of an employee in full, and audits it.",
    kind: "read",
    audience: "manager",
    roles: ["owner", "hr", "finance"],
    input: null,
    changes: "none",
    action: at("people/actions", "revealWorkerPii"),
    agent: false,
    agentNote: REVEAL,
  },
  {
    name: "departments.create",
    description: "Adds a department, with its head if one is chosen.",
    kind: "write",
    audience: "manager",
    ...fromSpec(createDepartmentSpec),
    changes: "one",
    action: at("people/actions", "createDepartmentAction"),
    agent: true,
  },
  {
    name: "departments.update",
    description: "Renames a department or changes its head.",
    kind: "write",
    audience: "manager",
    ...fromSpec(updateDepartmentSpec),
    changes: "one",
    action: at("people/actions", "updateDepartmentAction"),
    agent: true,
  },
  {
    name: "people.save_mapping",
    description: "Sets an employee's department, line manager, sites and projects.",
    kind: "write",
    audience: "manager",
    ...fromSpec(saveMappingSpec),
    changes: "many",
    action: at("people/actions", "saveMappingAction"),
    agent: false,
    agentNote: NO_PREVIEW,
  },

  // -------------------------------------------------------------------------
  // People bulk actions (people/bulk-actions.ts, slice U.1)
  // -------------------------------------------------------------------------
  {
    name: "people.bulk_end_employment",
    description:
      "Ends employment for up to 200 selected employees on one date with one reason, all or nothing.",
    kind: "write",
    audience: "manager",
    ...fromSpec(bulkEndEmploymentSpec),
    changes: "many",
    action: at("people/bulk-actions", "bulkEndEmploymentAction"),
    preview: previewBulkEnd,
    agent: false,
    agentNote: BULK_PEOPLE,
  },
  {
    name: "people.preview_bulk_end",
    description:
      "Lists, per selected employee, the future shifts and leave left after a last working day.",
    kind: "read",
    audience: "manager",
    ...fromSpec(previewBulkEndSpec),
    changes: "none",
    action: at("people/bulk-actions", "previewBulkEndEmploymentAction"),
    agent: false,
    agentNote: BULK_PEOPLE,
  },
  {
    name: "people.bulk_set_line_manager",
    description: "Sets one line manager for the selected employees, all or nothing.",
    kind: "write",
    audience: "manager",
    ...fromSpec(bulkLineManagerSpec),
    changes: "many",
    action: at("people/bulk-actions", "bulkSetLineManagerAction"),
    preview: previewBulkLineManager,
    agent: false,
    agentNote: BULK_PEOPLE,
  },
  {
    name: "people.bulk_set_department",
    description: "Moves the selected employees into one department, all or nothing.",
    kind: "write",
    audience: "manager",
    ...fromSpec(bulkDepartmentSpec),
    changes: "many",
    action: at("people/bulk-actions", "bulkSetDepartmentAction"),
    preview: previewBulkDepartment,
    agent: false,
    agentNote: BULK_PEOPLE,
  },
  {
    name: "people.preview_bulk_reassign",
    description:
      "Lists the selected employees' line manager or department before and after a bulk change.",
    kind: "read",
    audience: "manager",
    ...fromSpec(previewBulkReassignSpec),
    changes: "none",
    action: at("people/bulk-actions", "previewBulkReassignAction"),
    agent: false,
    agentNote: BULK_PEOPLE,
  },

  // Bulk mapping (people/bulk-actions.ts, slice U.3)
  {
    name: "people.bulk_map",
    description:
      "Maps up to 200 selected employees to one site and its projects, replacing or adding, all or nothing.",
    kind: "write",
    audience: "manager",
    ...fromSpec(bulkMapSpec),
    changes: "many",
    action: at("people/bulk-actions", "bulkMapAction"),
    preview: previewBulkMap,
    agent: false,
    agentNote: BULK_PEOPLE,
  },
  // The preview is a dry run of public.bulk_map_workers: it locks the selected workers' rows and
  // writes assignment and audit rows before rolling them back (security review L4). It must stay
  // `agent: false` and editor-only (owner, admin, hr), like the write it previews.
  {
    name: "people.preview_bulk_map",
    description:
      "Lists each selected employee's site and projects now and after a bulk mapping, and who can't be mapped.",
    kind: "read",
    audience: "manager",
    ...fromSpec(previewBulkMapSpec),
    changes: "none",
    action: at("people/bulk-actions", "previewBulkMapAction"),
    agent: false,
    agentNote: BULK_PEOPLE,
  },

  // -------------------------------------------------------------------------
  // Self-onboarding (people/self-onboarding-actions.ts, self-onboarding-public-actions.ts; U.4)
  // -------------------------------------------------------------------------
  {
    name: "onboarding.invite",
    description: "Emails someone a link to fill in their own details, with one fixed role.",
    kind: "write",
    audience: "manager",
    ...fromSpec(inviteOnboardingSpec),
    changes: "one",
    action: at("people/self-onboarding-actions", "inviteToOnboardAction"),
    preview: previewInviteOnboarding,
    agent: false,
    agentNote: ONBOARDING,
  },
  {
    name: "onboarding.resend",
    description: "Sends an onboarding invite again with a new link.",
    kind: "write",
    audience: "manager",
    ...fromSpec(resendOnboardingSpec),
    changes: "one",
    action: at("people/self-onboarding-actions", "resendOnboardingInviteAction"),
    preview: previewResendOnboarding,
    agent: false,
    agentNote: ONBOARDING,
  },
  {
    name: "onboarding.cancel",
    description: "Cancels an onboarding invite and clears any details sent.",
    kind: "write",
    audience: "manager",
    ...fromSpec(cancelOnboardingSpec),
    changes: "one",
    action: at("people/self-onboarding-actions", "cancelOnboardingInviteAction"),
    preview: previewCancelOnboarding,
    agent: false,
    agentNote: ONBOARDING,
  },
  {
    name: "onboarding.approve",
    description:
      "Approves self-onboarding details: adds the member or employee with the invite's role.",
    kind: "money",
    audience: "manager",
    ...fromSpec(approveOnboardingSpec),
    changes: "many",
    action: at("people/self-onboarding-actions", "approveOnboardingAction"),
    preview: previewApproveOnboarding,
    agent: false,
    agentNote: ONBOARDING,
  },
  {
    name: "onboarding.submit_worker",
    description: "Sends a worker's own details from their onboarding link.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "one",
    action: at("people/self-onboarding-public-actions", "submitWorkerOnboardingAction"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "onboarding.email_link",
    description: "Emails a sign-in link to the address an onboarding invite was sent to.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "none",
    action: at("people/self-onboarding-public-actions", "emailOnboardingLinkAction"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "onboarding.submit_manager",
    description: "Sends an invited manager's own details, choosing a password if new.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "one",
    action: at("people/self-onboarding-public-actions", "submitManagerOnboardingAction"),
    agent: false,
    agentNote: AUTH,
  },
  {
    name: "onboarding.sign_out",
    description: "Signs out so an onboarding invite can be used with another account.",
    kind: "write",
    audience: "public",
    roles: [],
    input: null,
    changes: "none",
    action: at("people/self-onboarding-public-actions", "signOutForOnboardingAction"),
    agent: false,
    agentNote: AUTH,
  },

  // -------------------------------------------------------------------------
  // Bank-detail changes (people/bank-change-actions.ts)
  // -------------------------------------------------------------------------
  {
    name: "bank_changes.request",
    description: "Asks to change an employee's bank details; a second person approves.",
    kind: "money",
    audience: "manager",
    ...fromSpec(requestBankChangeSpec),
    changes: "one",
    action: at("people/bank-change-actions", "requestBankChangeAction"),
    agent: false,
    agentNote: PERSONAL,
  },
  {
    name: "bank_changes.decide",
    description: "Approves, refuses or stops a bank-detail change raised by someone else.",
    kind: "money",
    audience: "manager",
    ...fromSpec(decideBankChangeSpec),
    changes: "one",
    action: at("people/bank-change-actions", "decideBankChangeAction"),
    agent: false,
    agentNote: SECOND_APPROVER,
  },
  {
    name: "bank_changes.withdraw",
    description: "Withdraws one's own pending bank-detail change.",
    kind: "money",
    audience: "manager",
    ...fromSpec(withdrawBankChangeSpec),
    changes: "one",
    action: at("people/bank-change-actions", "withdrawBankChangeAction"),
    agent: false,
    agentNote: "Bank details are kept to people.",
  },
  {
    name: "bank_changes.reveal_account",
    description: "Shows the new account number of a bank-detail change in full, and audits it.",
    kind: "read",
    audience: "manager",
    roles: ["owner", "hr", "finance"],
    input: null,
    changes: "none",
    action: at("people/bank-change-actions", "revealBankChangeAccount"),
    agent: false,
    agentNote: REVEAL,
  },
  {
    name: "bank_changes.lookup_account",
    description:
      "Asks the bank network for the account name of a bank and number, for an employee being added or changed.",
    kind: "read",
    audience: "manager",
    roles: [...PEOPLE_EDITORS],
    input: lookupWorkerBankSchema,
    changes: "none",
    action: at("people/bank-change-actions", "lookupWorkerBankAccountAction"),
    agent: false,
    agentNote: LOOKUP,
  },
  {
    name: "people.check_bank_details",
    description:
      "Checks an employee's bank details on file with the bank network and keeps the result on the employee.",
    kind: "write",
    audience: "manager",
    roles: [...PEOPLE_EDITORS],
    input: checkWorkerBankSchema,
    changes: "one",
    action: at("people/bank-change-actions", "checkWorkerBankDetailsAction"),
    agent: false,
    agentNote: LOOKUP,
  },

  // -------------------------------------------------------------------------
  // Company bank account (billing/company-bank-actions.ts, slice 2.3)
  // -------------------------------------------------------------------------
  {
    name: "company_bank.request",
    description:
      "Asks to add or change the account clients pay into; a second person approves, then 72 hours.",
    kind: "write",
    audience: "manager",
    ...fromSpec(requestCompanyBankSpec),
    changes: "one",
    action: at("billing/company-bank-actions", "requestCompanyBankAction"),
    agent: false,
    agentNote: `${PERSONAL} The confirm step uses previewCompanyBankRequest (src/lib/company-bank.ts).`,
  },
  {
    name: "company_bank.decide",
    description:
      "Approves, rejects or stops a company bank account request raised by someone else.",
    kind: "write",
    audience: "manager",
    ...fromSpec(decideCompanyBankSpec),
    changes: "one",
    action: at("billing/company-bank-actions", "decideCompanyBankAction"),
    agent: false,
    agentNote: SECOND_APPROVER,
  },
  {
    name: "company_bank.withdraw",
    description: "Withdraws one's own pending company bank account request.",
    kind: "write",
    audience: "manager",
    ...fromSpec(withdrawCompanyBankSpec),
    changes: "one",
    action: at("billing/company-bank-actions", "withdrawCompanyBankAction"),
    agent: true,
  },
  {
    name: "company_bank.reveal",
    description: "Shows a company bank account number in full, and audits it.",
    kind: "read",
    audience: "manager",
    roles: [...COMPANY_BANK_REVEALERS],
    input: null,
    changes: "none",
    action: at("billing/company-bank-actions", "revealCompanyBankAccount"),
    agent: false,
    agentNote: REVEAL,
  },
  {
    name: "company_bank.lookup_account",
    description:
      "Asks the bank network for the account name of a bank and number, and compares it with the company's names.",
    kind: "read",
    audience: "manager",
    roles: [...COMPANY_BANK_REQUESTERS],
    input: lookupBankAccountSchema,
    changes: "none",
    action: at("billing/company-bank-actions", "lookupCompanyBankAccountAction"),
    agent: false,
    agentNote: LOOKUP,
  },

  // -------------------------------------------------------------------------
  // Change requests, imports, own requests, staff IDs (people/*)
  // -------------------------------------------------------------------------
  {
    name: "people.resolve_change_request",
    description: "Marks a worker's change request done or declined.",
    kind: "write",
    audience: "manager",
    ...fromSpec(resolveChangeRequestSpec),
    changes: "one",
    action: at("people/change-request-actions", "resolveChangeRequestAction"),
    agent: true,
  },
  {
    name: "imports.start",
    description: "Starts an employee import and returns where to upload the file.",
    kind: "write",
    audience: "manager",
    ...fromSpec(startImportSpec),
    changes: "one",
    action: at("people/imports/actions", "startImportUpload"),
    agent: false,
    agentNote: "Takes a file upload.",
  },
  {
    name: "imports.check",
    description: "Checks an uploaded employee file and stores each row's result.",
    kind: "write",
    audience: "manager",
    ...fromSpec(checkImportSpec),
    changes: "many",
    action: at("people/imports/actions", "checkImportUpload"),
    agent: false,
    agentNote: PERSONAL,
  },
  {
    name: "imports.apply_fix",
    description: "Applies a one-click fix to the rows of an import held back for it.",
    kind: "write",
    audience: "manager",
    ...fromSpec(applyImportFixSpec),
    changes: "many",
    action: at("people/imports/actions", "applyImportFix"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "imports.commit",
    description: "Imports the checked rows: employees, first pay rates and mapping.",
    kind: "money",
    audience: "manager",
    ...fromSpec(commitImportSpec),
    changes: "many",
    action: at("people/imports/actions", "commitImport"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "imports.cancel",
    description: "Cancels an import and clears its stored personal data.",
    kind: "write",
    audience: "manager",
    ...fromSpec(cancelImportSpec),
    changes: "many",
    action: at("people/imports/actions", "cancelImport"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "me.request_bank_change",
    description: "A worker asks to change their own bank details; HR approves.",
    kind: "money",
    audience: "worker",
    roles: [],
    input: ownBankChangeSchema,
    changes: "one",
    action: at("people/own-request-actions", "requestOwnBankChangeAction"),
    agent: false,
    agentNote: PERSONAL,
  },
  {
    name: "me.lookup_bank_account",
    description: "Asks the bank network for the account name of a worker's own new account.",
    kind: "read",
    audience: "worker",
    roles: [],
    input: ownBankLookupSchema,
    changes: "none",
    action: at("people/own-request-actions", "lookupOwnBankAccountAction"),
    agent: false,
    agentNote: LOOKUP,
  },
  {
    name: "me.request_change",
    description: "A worker asks HR to change something on their record.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: ownChangeRequestSchema,
    changes: "one",
    action: at("people/own-request-actions", "requestOwnChangeAction"),
    agent: false,
    agentNote: "Worker app only.",
  },
  {
    name: "staff_ids.request_correction",
    description: "Asks to correct an employee's staff ID; a second person approves.",
    kind: "write",
    audience: "manager",
    ...fromSpec(requestStaffIdCorrectionSpec),
    changes: "one",
    action: at("people/staff-id-actions", "requestStaffIdCorrectionAction"),
    agent: true,
  },
  {
    name: "staff_ids.decide_correction",
    description: "Approves or refuses a staff ID correction raised by someone else.",
    kind: "write",
    audience: "manager",
    ...fromSpec(decideStaffIdCorrectionSpec),
    changes: "many",
    action: at("people/staff-id-actions", "decideStaffIdCorrectionAction"),
    agent: false,
    agentNote: SECOND_APPROVER,
  },
  {
    name: "staff_ids.withdraw_correction",
    description: "Withdraws one's own pending staff ID correction.",
    kind: "write",
    audience: "manager",
    ...fromSpec(withdrawStaffIdCorrectionSpec),
    changes: "one",
    action: at("people/staff-id-actions", "withdrawStaffIdCorrectionAction"),
    agent: true,
  },
  {
    name: "people.unlock_sign_in",
    description: "Lifts a worker's phone sign-in lockout after wrong PINs.",
    kind: "write",
    audience: "manager",
    ...fromSpec(unlockSignInSpec),
    changes: "one",
    action: at("people/staff-id-actions", "unlockSignInAction"),
    agent: false,
    agentNote: "Restores sign-in access: kept to people.",
  },

  // -------------------------------------------------------------------------
  // My team (people/team.ts, slice 4.0): a line manager's reportees, safe columns only
  // -------------------------------------------------------------------------
  {
    name: "team.members",
    description:
      "Lists the people who report to the signed-in line manager: job, department, status, start date and mapped sites.",
    kind: "read",
    audience: "manager",
    roles: TEAM_READERS,
    input: null,
    changes: "none",
    action: null,
    // Lira gets no phone numbers or email addresses: it never contacts anyone directly.
    read: async ({ supabase, organisationId }) =>
      (await loadTeamMembers(supabase, organisationId)).map((m) => ({
        ...m,
        phone: null,
        email: null,
      })),
    agent: true,
  },
  {
    name: "team.summary",
    description:
      "Counts the line manager's reportees by status, those clocked in by a supervisor and those with no site.",
    kind: "read",
    audience: "manager",
    roles: TEAM_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadTeamSummary(supabase, organisationId),
    agent: true,
  },
  // My team (people/team-actions.ts, slice 4.7): assign within the crew, and the page's counts.
  {
    name: "team.assign_shift",
    description:
      "Assigns one of the line manager's reportees to an open shift at their team's site.",
    kind: "write",
    audience: "manager",
    ...fromSpec(teamAssignShiftSpec),
    changes: "one",
    action: at("people/team-actions", "assignTeamShiftAction"),
    agent: false,
    agentNote: "Changes a person's roster: the line manager picks the shift.",
  },
  {
    name: "team.remove_shift",
    description:
      "Takes one of the line manager's reportees off a shift at their team's site that hasn't started.",
    kind: "write",
    audience: "manager",
    ...fromSpec(teamRemoveAssignmentSpec),
    changes: "one",
    action: at("people/team-actions", "removeTeamShiftAction"),
    agent: false,
    agentNote: "Changes a person's roster: the line manager decides.",
  },
  {
    name: "team.board_summary",
    description:
      "Counts My team today: on site, late, no-show, on leave, hours, leave and days to decide, queries and open shifts.",
    kind: "read",
    audience: "manager",
    roles: TEAM_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadMyTeamSummary(supabase, organisationId),
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Queries and the HR file (people/query-actions.ts, slice 4.6)
  // -------------------------------------------------------------------------
  {
    name: "queries.raise",
    description:
      "Raises a disciplinary or HR query about one employee with a reply-by date, and tells them in the app.",
    kind: "write",
    audience: "manager",
    ...fromSpec(raiseQuerySpec),
    changes: "one",
    action: at("people/query-actions", "raiseQueryAction"),
    agent: false,
    agentNote: QUERY_DECISION,
  },
  {
    name: "queries.follow_up",
    description: "Adds a manager's follow-up to an open query; the employee is told in the app.",
    kind: "write",
    audience: "manager",
    ...fromSpec(followUpQuerySpec),
    changes: "one",
    action: at("people/query-actions", "followUpQueryAction"),
    agent: false,
    agentNote: QUERY_DECISION,
  },
  {
    name: "queries.close",
    description: "Closes an open query with an outcome note that stays on the employee's HR file.",
    kind: "write",
    audience: "manager",
    ...fromSpec(closeQuerySpec),
    changes: "one",
    action: at("people/query-actions", "closeQueryAction"),
    agent: false,
    agentNote: QUERY_DECISION,
  },
  {
    name: "queries.withdraw",
    description:
      "Withdraws a query the signed-in manager raised, with a reason kept on the HR file.",
    kind: "write",
    audience: "manager",
    ...fromSpec(withdrawQuerySpec),
    changes: "one",
    action: at("people/query-actions", "withdrawQueryAction"),
    agent: false,
    agentNote: QUERY_DECISION,
  },
  {
    name: "queries.summary",
    description:
      "Counts the queries the manager may see: open, overdue, replied and raised in the last 30 days.",
    kind: "read",
    audience: "manager",
    roles: HR_FILE_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) =>
      loadQueriesSummary(supabase, organisationId, lagosToday()),
    agent: true,
  },
  {
    name: "me.reply_to_query",
    description: "A worker replies to a query from their line manager or HR in the worker app.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: replyToQuerySchema,
    changes: "one",
    action: at("people/query-actions", "replyToQueryAction"),
    agent: false,
    agentNote: "A reply is the worker's own words, written in the worker app.",
  },

  // -------------------------------------------------------------------------
  // Consents and inbox (workforce/consent-actions.ts, inbox-actions.ts, slice 3.1)
  // -------------------------------------------------------------------------
  {
    name: "me.accept_consent",
    description: "A worker agrees to share their location or take a selfie at clock-in.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: consentKindSchema,
    changes: "one",
    action: at("workforce/consent-actions", "acceptConsentAction"),
    agent: false,
    agentNote: "Consent is the worker's own choice, made in the worker app.",
  },
  {
    name: "me.withdraw_consent",
    description:
      "A worker withdraws their location or selfie consent; their supervisor clocks them in.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: consentKindSchema,
    changes: "one",
    action: at("workforce/consent-actions", "withdrawConsentAction"),
    agent: false,
    agentNote: "Consent is the worker's own choice, made in the worker app.",
  },
  {
    name: "me.mark_inbox_read",
    description: "A worker marks one inbox message, or all of them, as read.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: markReadSchema,
    changes: "many",
    action: at("workforce/inbox-actions", "markInboxReadAction"),
    agent: false,
    agentNote: "Worker app only.",
  },
  // -------------------------------------------------------------------------
  // Clock in and out (workforce/punch-actions.ts, slice 3.5)
  // -------------------------------------------------------------------------
  {
    name: "me.record_punch",
    description:
      "Records a worker's clock-in or clock-out from the phone's queue: server-corrected time, site check and flags.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: recordPunchSchema,
    changes: "one",
    action: at("workforce/punch-actions", "recordPunchAction"),
    agent: false,
    agentNote: "A punch is the worker's own, made on their phone at the site.",
  },
  {
    name: "me.upload_punch_selfie",
    description: "Takes the selfie of a clock-in the worker just recorded.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: uploadSelfieSchema,
    changes: "one",
    action: at("workforce/punch-actions", "uploadPunchSelfieAction"),
    agent: false,
    agentNote: "A selfie is the worker's own, taken on their phone.",
  },
  {
    name: "punches.selfie_link",
    description: "Opens a clock-in selfie for 60 seconds, for a manager who may see it.",
    kind: "read",
    audience: "manager",
    roles: SELFIE_READERS,
    input: selfieLinkSchema,
    changes: "none",
    action: at("workforce/punch-actions", "punchSelfieLinkAction"),
    agent: false,
    agentNote: PERSONAL,
  },
  {
    name: "attendance.today_summary",
    description:
      "Counts today's clock-ins and clock-outs, and how many carry each flag (outside, late, no selfie and so on).",
    kind: "read",
    audience: "manager",
    roles: PUNCH_SUMMARY_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadTodayPunchSummary(supabase, organisationId),
    agent: true,
  },
  // -------------------------------------------------------------------------
  // Crew clock-in (workforce/crew-actions.ts, slice 3.6)
  // -------------------------------------------------------------------------
  {
    name: "crew.record_punch",
    description:
      "Records a supervisor's crew clock-in or clock-out from the phone's queue: one punch per person, marked by supervisor.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: recordCrewPunchSchema,
    changes: "many",
    action: at("workforce/crew-actions", "recordCrewPunchAction"),
    agent: false,
    agentNote:
      "A crew punch is made by the supervisor at the site, on their phone; the database checks the crew and the shift.",
  },
  {
    name: "crew.upload_photo",
    description: "Takes the group photo of a crew clock-in the supervisor just recorded.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: uploadCrewPhotoSchema,
    changes: "one",
    action: at("workforce/crew-actions", "uploadCrewPhotoAction"),
    agent: false,
    agentNote: "A group photo is taken on the supervisor's phone, only when everyone in it agreed.",
  },
  {
    name: "attendance.crew_summary",
    description:
      "Counts today's crew clock-ins and clock-outs by supervisors, and how many had no group photo or were off site.",
    kind: "read",
    audience: "manager",
    roles: CREW_SUMMARY_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadTodayCrewSummary(supabase, organisationId),
    agent: true,
  },
  // -------------------------------------------------------------------------
  // My team in the worker app (workforce/crew-team-actions.ts, slice 4.7b)
  // -------------------------------------------------------------------------
  {
    name: "crew_team.summary",
    description: "Counts a supervisor's crew days to approve and leave requests waiting at step 1.",
    kind: "read",
    audience: "worker",
    roles: [],
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadCrewSummary(supabase, organisationId),
    agent: false,
    agentNote: "Worker-app reads are for the supervisor on their phone; the agent serves managers.",
  },
  {
    name: "crew_team.approve_day",
    description:
      "Lets a worker-supervisor approve one of their crew's timesheet days from the worker app. Never their own day.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: approveLineSchema,
    changes: "many",
    action: at("workforce/crew-team-actions", "approveCrewDayAction"),
    agent: false,
    agentNote: APPROVE_TIMESHEET,
  },
  {
    name: "crew_team.reject_day",
    description:
      "Lets a worker-supervisor reject one of their crew's timesheet days with a reason; the worker is told.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: rejectLineSchema,
    changes: "one",
    action: at("workforce/crew-team-actions", "rejectCrewDayAction"),
    agent: false,
    agentNote: APPROVE_TIMESHEET,
  },
  {
    name: "crew_team.decide_leave",
    description:
      "Lets a worker-supervisor approve or decline step 1 of a crew member's leave from the worker app; HR decides next.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: decideLeaveSchema,
    changes: "many",
    action: at("workforce/crew-team-actions", "decideCrewLeaveAction"),
    agent: false,
    agentNote: "Deciding a person's leave is a manager's decision, made on the screen.",
  },
  // -------------------------------------------------------------------------
  // Patrol checkpoint scans (workforce/checkpoint-scan-actions.ts, slice 3.8)
  // -------------------------------------------------------------------------
  {
    name: "me.checkpoint_scan_context",
    description:
      "Tells the checkpoint scan page who is signed in and whether they may scan (Shifts on, location agreed).",
    kind: "read",
    audience: "worker",
    roles: [],
    input: null,
    changes: "none",
    action: at("workforce/checkpoint-scan-actions", "checkpointScanContextAction"),
    agent: false,
    agentNote: "Worker app only.",
  },
  {
    name: "me.record_checkpoint_scan",
    description:
      "Records a patrol guard's checkpoint scan from the phone's queue: the checkpoint, the shift, the time and the site check.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: recordCheckpointScanSchema,
    changes: "one",
    action: at("workforce/checkpoint-scan-actions", "recordCheckpointScanAction"),
    agent: false,
    agentNote: "A scan is the worker's own, made with their phone at the checkpoint.",
  },
  {
    name: "patrols.day",
    description:
      "Lists one site's checkpoint scans on a day: who scanned each checkpoint and when, and which were not scanned.",
    kind: "read",
    audience: "manager",
    roles: PATROL_READERS,
    input: patrolDayInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { siteId, day } = patrolDayInput.parse(input);
      const { timeZone, today } = await loadPatrolSettings(supabase, organisationId);
      return loadPatrolDay(supabase, organisationId, siteId, day ?? today, timeZone);
    },
    agent: true,
  },
  {
    name: "patrols.today_summary",
    description:
      "Counts today's checkpoint scans per site, how many checkpoints were scanned and how many scans need a look.",
    kind: "read",
    audience: "manager",
    roles: PATROL_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadPatrolSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "attendance.live_board",
    description:
      "Shows who is on site, late, a no-show, starting in 2 hours or clocked out today, by worker and site.",
    kind: "read",
    audience: "manager",
    roles: BOARD_READERS,
    input: boardInputSchema,
    changes: "none",
    action: at("workforce/board-actions", "attendanceBoardAction"),
    // Lira gets the board without phone numbers, not even the last four digits: it never
    // dials anyone (security review L1).
    read: async ({ supabase, organisationId }) => {
      const board = await loadAttendanceBoard(supabase, organisationId);
      return {
        ...board,
        rows: board.rows.map((row) => ({ ...row, phone: null, phoneLast4: null })),
      };
    },
    agent: true,
  },
  {
    name: "me.published_shifts",
    description:
      "A worker reads their own published shifts between two days, with the post and site names.",
    kind: "read",
    audience: "worker",
    roles: [],
    input: myShiftsInput,
    changes: "none",
    action: null,
    read: async ({ supabase }, input) => {
      const { from, to } = myShiftsInput.parse(input);
      return loadMyPublishedShifts(supabase, from, to);
    },
    agent: false,
    agentNote: "Worker app only.",
  },
  {
    name: "consents.summary",
    description: "Counts active workers who agreed to location and to selfies at clock-in.",
    kind: "read",
    audience: "manager",
    roles: CONSENT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadConsentsSummary(supabase, organisationId),
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Clients and contacts (business/actions.ts, slice 2.1)
  // -------------------------------------------------------------------------
  {
    name: "clients.summary",
    description: "Counts the company's clients: active, archived, needing details, and sites.",
    kind: "read",
    audience: "manager",
    roles: CLIENT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadClientsSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "clients.list",
    description: "Lists clients with their status, site count and primary billing email.",
    kind: "read",
    audience: "manager",
    roles: CLIENT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => listClients(supabase, organisationId),
    agent: true,
  },
  {
    name: "clients.create",
    description: "Adds a client with its billing details and, optionally, a billing contact.",
    kind: "write",
    audience: "manager",
    ...fromSpec(createClientSpec),
    changes: "many",
    action: at("business/actions", "createClientAction"),
    preview: previewCreateClient,
    agent: true,
  },
  {
    name: "clients.update",
    description:
      "Changes a client's name, registered name, RC number, TIN, address, terms or notes.",
    kind: "write",
    audience: "manager",
    ...fromSpec(updateClientSpec),
    changes: "one",
    action: at("business/actions", "updateClientAction"),
    agent: true,
  },
  {
    name: "clients.set_status",
    description: "Archives a client, or restores an archived one.",
    kind: "write",
    audience: "manager",
    ...fromSpec(setClientStatusSpec),
    changes: "one",
    action: at("business/actions", "setClientStatusAction"),
    agent: true,
  },
  {
    name: "clients.set_tax",
    description:
      "Sets whether a client deducts WHT and whether it pays the VAT to the tax authority.",
    kind: "money",
    audience: "manager",
    ...fromSpec(setClientTaxSpec),
    changes: "one",
    action: at("business/actions", "setClientTaxAction"),
    preview: previewSetClientTax,
    agent: false,
    agentNote: "Changes what payments are expected to carry (kind money): kept to people.",
  },
  {
    name: "clients.quick_add",
    description: "Adds a client with its billing email and a first site, as in company setup.",
    kind: "write",
    audience: "manager",
    ...fromSpec(quickAddClientSpec),
    changes: "many",
    action: at("business/actions", "quickAddClientAction"),
    preview: previewQuickAddClient,
    agent: true,
  },
  {
    name: "contacts.add",
    description: "Adds a billing, approver or operations contact to a client.",
    kind: "write",
    audience: "manager",
    ...fromSpec(addContactSpec),
    changes: "many",
    action: at("business/actions", "addContactAction"),
    preview: previewAddContact,
    agent: true,
  },
  {
    name: "contacts.update",
    description: "Changes a contact's name, email or phone, or makes them the primary.",
    kind: "write",
    audience: "manager",
    ...fromSpec(updateContactSpec),
    changes: "many",
    action: at("business/actions", "updateContactAction"),
    agent: false,
    agentNote: "Making a contact primary demotes another; needs a preview first.",
  },
  {
    name: "contacts.remove",
    description: "Removes a contact from a client; the next contact of that role becomes primary.",
    kind: "write",
    audience: "manager",
    ...fromSpec(removeContactSpec),
    changes: "many",
    action: at("business/actions", "removeContactAction"),
    agent: false,
    agentNote: "Promotes another contact; needs a preview first.",
  },

  // -------------------------------------------------------------------------
  // Sites, geofences and checkpoints (sites/actions.ts, slice 2.2)
  // -------------------------------------------------------------------------
  {
    name: "sites.summary",
    description: "Counts active sites, those without a geofence or address, and their checkpoints.",
    kind: "read",
    audience: "manager",
    roles: CLIENT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadSitesSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "sites.without_geofence",
    description: "Lists active sites with no geofence yet, by client, with a link to each.",
    kind: "read",
    audience: "manager",
    roles: CLIENT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => listSitesWithoutGeofence(supabase, organisationId),
    agent: true,
  },
  {
    name: "sites.create",
    description: "Adds a site to a client with its address, state and landmark.",
    kind: "write",
    audience: "manager",
    ...fromSpec(createSiteSpec),
    changes: "one",
    action: at("sites/actions", "createSiteAction"),
    agent: true,
  },
  {
    name: "sites.update",
    description: "Changes a site's name, address, state or landmark.",
    kind: "write",
    audience: "manager",
    ...fromSpec(updateSiteSpec),
    changes: "one",
    action: at("sites/actions", "updateSiteAction"),
    agent: true,
  },
  {
    name: "sites.set_geofence",
    description:
      "Sets a site's geofence: a pin with a radius of 25 to 2,000 m, or a drawn outline.",
    kind: "write",
    audience: "manager",
    ...fromSpec(setGeofenceSpec),
    changes: "one",
    action: at("sites/actions", "setGeofenceAction"),
    agent: true,
  },
  {
    name: "sites.set_status",
    description: "Archives a site, or restores an archived one.",
    kind: "write",
    audience: "manager",
    ...fromSpec(setSiteStatusSpec),
    changes: "one",
    action: at("sites/actions", "setSiteStatusAction"),
    agent: true,
  },
  {
    name: "checkpoints.add",
    description: "Adds a QR checkpoint at the end of a site's patrol round.",
    kind: "write",
    audience: "manager",
    ...fromSpec(addCheckpointSpec),
    changes: "one",
    action: at("sites/actions", "addCheckpointAction"),
    agent: true,
  },
  {
    name: "checkpoints.rename",
    description: "Renames a site's QR checkpoint.",
    kind: "write",
    audience: "manager",
    ...fromSpec(renameCheckpointSpec),
    changes: "one",
    action: at("sites/actions", "renameCheckpointAction"),
    agent: true,
  },
  {
    name: "checkpoints.move",
    description: "Moves a checkpoint one place earlier or later in the site's patrol round.",
    kind: "write",
    audience: "manager",
    ...fromSpec(moveCheckpointSpec),
    changes: "many",
    action: at("sites/actions", "moveCheckpointAction"),
    preview: previewMoveCheckpoint,
    agent: true,
  },
  {
    name: "checkpoints.retire",
    description: "Retires a checkpoint for good; its history stays and its code stops counting.",
    kind: "write",
    audience: "manager",
    ...fromSpec(retireCheckpointSpec),
    changes: "one",
    action: at("sites/actions", "retireCheckpointAction"),
    agent: true,
  },
  {
    name: "checkpoints.rotate_qr",
    description: "Gives a checkpoint a new QR code so the old printout stops working.",
    kind: "write",
    audience: "manager",
    ...fromSpec(rotateCheckpointQrSpec),
    changes: "one",
    action: at("sites/actions", "rotateCheckpointQrAction"),
    agent: false,
    agentNote: "Voids the code posted at the site until a new sheet is printed: kept to people.",
  },
  // -------------------------------------------------------------------------
  // Contracts, rate cards and WHT (business/contract-actions.ts, slice 2.4)
  // -------------------------------------------------------------------------
  {
    name: "contracts.summary",
    description:
      "Counts contracts by status, and those with no rate card or a rate change scheduled.",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }) =>
      loadContractsSummary(
        supabase,
        organisationId,
        await organisationToday(supabase, organisationId),
      ),
    agent: true,
  },
  {
    name: "contracts.list",
    description: "Lists contracts with their client, type, status, dates and rate card versions.",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => listContracts(supabase, organisationId),
    agent: true,
  },
  {
    name: "contracts.create",
    description: "Adds a draft contract for a client with its type, dates, terms, VAT and sites.",
    kind: "write",
    audience: "manager",
    ...fromSpec(createContractSpec),
    changes: "many",
    action: at("business/contract-actions", "createContractAction"),
    preview: previewCreateContract,
    agent: true,
  },
  {
    name: "contracts.update",
    description: "Changes a draft contract's terms, dates and sites.",
    kind: "write",
    audience: "manager",
    ...fromSpec(updateContractSpec),
    changes: "many",
    action: at("business/contract-actions", "updateContractAction"),
    preview: previewUpdateContract,
    agent: true,
  },
  {
    name: "rate_cards.save_draft",
    description: "Saves the rate card of a draft contract, replacing what was there.",
    kind: "money",
    audience: "manager",
    ...fromSpec(saveDraftRateCardSpec),
    changes: "many",
    action: at("business/contract-actions", "saveDraftRateCardAction"),
    preview: previewSaveDraftRateCard,
    agent: false,
    agentNote: RATES,
  },
  {
    name: "rate_cards.add_version",
    description: "Changes a contract's rates from a date; the current rates end the day before.",
    kind: "money",
    audience: "manager",
    ...fromSpec(addRateCardVersionSpec),
    changes: "many",
    action: at("business/contract-actions", "addRateCardVersionAction"),
    preview: previewAddRateCardVersion,
    agent: false,
    agentNote: RATES,
  },
  {
    name: "rate_cards.cancel_version",
    description: "Cancels a rate change that hasn't started and reopens the rates before it.",
    kind: "money",
    audience: "manager",
    ...fromSpec(cancelRateCardVersionSpec),
    changes: "many",
    action: at("business/contract-actions", "cancelRateCardVersionAction"),
    agent: false,
    agentNote: RATES,
  },
  // -------------------------------------------------------------------------
  // Contract documents (business/contract-document-actions.ts, slice 2.6)
  // -------------------------------------------------------------------------
  {
    name: "contract_documents.summary",
    description:
      "Counts documents on file by kind, and active contracts with no signed contract on file.",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadContractDocumentsSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "contract_documents.list",
    description: "Lists a contract's documents: kind, title, file name, size and who uploaded it.",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: contractIdInput,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }, input) =>
      listContractDocuments(supabase, organisationId, (input as { contractId: string }).contractId),
    agent: true,
  },
  {
    name: "contract_documents.open",
    description: "Makes a 60-second link that opens or downloads one document on file.",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: documentIdInput,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }, input) =>
      contractDocumentLink(supabase, organisationId, (input as { documentId: string }).documentId),
    agent: false,
    agentNote: OPEN_FILE,
  },
  {
    name: "contract_documents.start_upload",
    description: "Starts a document upload on a contract and returns where the file goes.",
    kind: "write",
    audience: "manager",
    ...fromSpec(startContractDocumentSpec),
    changes: "one",
    action: at("business/contract-document-actions", "startContractDocumentUpload"),
    agent: false,
    agentNote: FILES,
  },
  {
    name: "contract_documents.confirm_upload",
    description: "Checks an uploaded document's type from its bytes and puts it on file.",
    kind: "write",
    audience: "manager",
    ...fromSpec(confirmContractDocumentSpec),
    changes: "one",
    action: at("business/contract-document-actions", "confirmContractDocumentUpload"),
    agent: false,
    agentNote: FILES,
  },
  {
    name: "contract_documents.remove",
    description: "Marks a contract document removed with a reason; its file stops opening.",
    kind: "write",
    audience: "manager",
    ...fromSpec(removeContractDocumentSpec),
    changes: "one",
    action: at("business/contract-document-actions", "removeContractDocumentAction"),
    preview: previewRemoveContractDocument,
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Headcount (business/headcount-actions.ts, slice 2.5)
  // -------------------------------------------------------------------------
  {
    name: "headcount.summary",
    description:
      "Counts headcount rows and shifts a week, and the contracts with rows that have no rate.",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: null,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }) =>
      loadHeadcountSummary(
        supabase,
        organisationId,
        await organisationToday(supabase, organisationId),
      ),
    agent: true,
  },
  {
    name: "headcount.for_contract",
    description:
      "Lists a contract's headcount by site with shifts a week, the weekly total and rows with no rate.",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: contractIdSchema,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { contractId } = contractIdSchema.parse(input);
      const { contract, lines, siteNames } = await loadHeadcountContext(
        supabase,
        organisationId,
        contractId,
      );
      if (!contract) return null;
      return {
        status: contract.status,
        sites: Object.fromEntries(siteNames),
        week: contractWeek(contract, lines, await organisationToday(supabase, organisationId)),
      };
    },
    agent: true,
  },
  {
    name: "headcount.add",
    description:
      "Adds a post to a draft contract's headcount: site, role, band, days, hours and people.",
    kind: "write",
    audience: "manager",
    ...fromSpec(addHeadcountSpec),
    changes: "one",
    action: at("business/headcount-actions", "addHeadcountAction"),
    preview: previewAddHeadcount,
    agent: true,
  },
  {
    name: "headcount.update",
    description: "Changes one headcount row of a draft contract.",
    kind: "write",
    audience: "manager",
    ...fromSpec(updateHeadcountSpec),
    changes: "one",
    action: at("business/headcount-actions", "updateHeadcountAction"),
    preview: previewUpdateHeadcount,
    agent: true,
  },
  {
    name: "headcount.remove",
    description: "Removes one headcount row from a draft contract.",
    kind: "write",
    audience: "manager",
    ...fromSpec(removeHeadcountSpec),
    changes: "one",
    action: at("business/headcount-actions", "removeHeadcountAction"),
    preview: previewRemoveHeadcount,
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Activation, posts and required shifts (business/activation-actions.ts, slice 2.7)
  // -------------------------------------------------------------------------
  {
    name: "contracts.activate",
    description:
      "Makes a draft contract live: checks it, then opens a post and roster requirement per headcount row.",
    kind: "write",
    audience: "manager",
    ...fromSpec(activateContractSpec),
    changes: "many",
    action: at("business/activation-actions", "activateContractAction"),
    preview: previewActivateContract,
    agent: false,
    agentNote: GO_LIVE,
  },
  {
    name: "contracts.end",
    description:
      "Ends a live contract on a last day, closing its posts, roster requirements and rate card.",
    kind: "write",
    audience: "manager",
    ...fromSpec(endContractSpec),
    changes: "many",
    action: at("business/activation-actions", "endContractAction"),
    preview: previewEndContract,
    agent: false,
    agentNote: GO_LIVE,
  },
  {
    name: "posts.for_contract",
    description:
      "Lists a live contract's posts with the site, days, hours and people required in force today.",
    kind: "read",
    audience: "manager",
    roles: POST_READERS,
    input: contractIdSchema,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { contractId } = contractIdSchema.parse(input);
      return loadPosts(
        supabase,
        organisationId,
        contractId,
        await organisationToday(supabase, organisationId),
      );
    },
    agent: true,
  },
  {
    name: "required_shifts.summary",
    description:
      "Counts the shifts and people required over the next 7 days across live contracts.",
    kind: "read",
    audience: "manager",
    roles: POST_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadRequiredShiftsSummary(supabase, organisationId),
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Changes to a live contract (business/live-changes-actions.ts, slice 2.8)
  // -------------------------------------------------------------------------
  {
    name: "posts.change_requirement",
    description:
      "Changes a live post's people, days or hours from a date, closing the version in force the day before.",
    kind: "write",
    audience: "manager",
    ...fromSpec(changeRequirementSpec),
    changes: "many",
    action: at("business/live-changes-actions", "changeRequirementAction"),
    preview: previewChangeRequirement,
    agent: false,
    agentNote: LIVE_CHANGE,
  },
  {
    name: "posts.cancel_requirement_change",
    description:
      "Cancels a scheduled headcount change on a live post before it starts; the version before it runs on.",
    kind: "write",
    audience: "manager",
    ...fromSpec(cancelRequirementChangeSpec),
    changes: "many",
    action: at("business/live-changes-actions", "cancelRequirementChangeAction"),
    preview: previewCancelRequirementChange,
    agent: false,
    agentNote: LIVE_CHANGE,
  },
  {
    name: "posts.add",
    description:
      "Adds a post to a live contract from a date, with its days, hours and people (and its site when asked).",
    kind: "write",
    audience: "manager",
    ...fromSpec(addPostSpec),
    changes: "many",
    action: at("business/live-changes-actions", "addPostAction"),
    preview: previewAddPost,
    agent: false,
    agentNote: LIVE_CHANGE,
  },
  {
    name: "posts.close",
    description:
      "Closes a live post after its last day staffed, with a reason; later scheduled changes are removed.",
    kind: "write",
    audience: "manager",
    ...fromSpec(closePostSpec),
    changes: "many",
    action: at("business/live-changes-actions", "closePostAction"),
    preview: previewClosePost,
    agent: false,
    agentNote: LIVE_CHANGE,
  },
  {
    name: "posts.history",
    description:
      "Shows every requirement version of one post and the changes made to it (reasons left out).",
    kind: "read",
    audience: "manager",
    roles: CONTRACT_READERS,
    input: postIdSchema,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { postId } = postIdSchema.parse(input);
      const detail = await loadPostDetail(supabase, organisationId, postId);
      // Closing reasons and notes stay with people: the agent gets what changed and when.
      return detail && { ...detail, changes: detail.changes.map((c) => ({ ...c, reason: null })) };
    },
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Roster (workforce/roster-actions.ts, slice 3.2)
  // -------------------------------------------------------------------------
  {
    name: "roster.week",
    description:
      "Shows one site's roster for a week: each post's people required and assigned per day, and the uncovered shifts.",
    kind: "read",
    audience: "manager",
    roles: ROSTER_EDITORS,
    input: rosterWeekInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { siteId, weekStart } = rosterWeekInput.parse(input);
      const [today, settings] = await Promise.all([
        organisationToday(supabase, organisationId),
        loadRosterSettings(supabase, organisationId),
      ]);
      const { week } = await loadRosterWeek(
        supabase,
        organisationId,
        siteId,
        mondayOf(weekStart ?? today),
        settings.timeZone,
      );
      return week;
    },
    agent: true,
  },
  {
    name: "roster.summary",
    description:
      "Counts the shifts required, covered and open for a week, per site (this week unless a week is given).",
    kind: "read",
    audience: "manager",
    roles: ROSTER_EDITORS,
    input: rosterSummaryInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { weekStart } = rosterSummaryInput.parse(input ?? {});
      const today = await organisationToday(supabase, organisationId);
      return loadRosterSummary(supabase, organisationId, today, weekStart);
    },
    agent: true,
  },
  {
    name: "roster.suggestions",
    description:
      "Ranks who could cover one post on a day: mapped and under the weekly hours first; skips approved leave, marks pending.",
    kind: "read",
    audience: "manager",
    roles: ROSTER_EDITORS,
    input: rosterSuggestionsInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { postId, date } = rosterSuggestionsInput.parse(input);
      const settings = await loadRosterSettings(supabase, organisationId);
      const [shifts, candidates] = await Promise.all([
        loadRequiredShifts(supabase, organisationId, date, date),
        loadRosterCandidates(supabase, organisationId, mondayOf(date)),
      ]);
      const shift = shifts.find((s) => s.postId === postId);
      if (!shift) return { required: false, suggestions: [] };
      const ranked = rankCandidates(
        {
          postId,
          siteId: shift.siteId,
          date,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          weekStart: mondayOf(date),
        },
        candidates.workers,
        candidates.booked,
        {
          weeklyStandardMinutes: settings.weeklyStandardMinutes,
          timeZone: settings.timeZone,
          leave: candidates.leave,
        },
      );
      return { required: true, suggestions: ranked.filter((s) => s.eligible).slice(0, 10) };
    },
    agent: true,
  },
  {
    name: "roster.assign",
    description:
      "Assigns one employee to a post on a day; refused for leavers, approved leave, closed posts, full or overlapping shifts.",
    kind: "write",
    audience: "manager",
    ...fromSpec(assignShiftSpec),
    changes: "one",
    action: at("workforce/roster-actions", "assignShiftAction"),
    agent: true,
  },
  {
    name: "roster.remove_assignment",
    description:
      "Takes an employee off a shift, with an optional reason; the assignment is kept, marked removed.",
    kind: "write",
    audience: "manager",
    ...fromSpec(removeAssignmentSpec),
    changes: "one",
    action: at("workforce/roster-actions", "removeAssignmentAction"),
    agent: true,
  },
  {
    name: "roster.copy_last_week",
    description:
      "Copies last week's assignments at a site into this week, listing every one it can't copy and why.",
    kind: "write",
    audience: "manager",
    ...fromSpec(copyLastWeekSpec),
    changes: "many",
    action: at("workforce/roster-actions", "copyLastWeekAction"),
    preview: previewCopyWeek,
    agent: false,
    agentNote: COPY_WEEK,
  },
  {
    name: "roster.publication_status",
    description:
      "Says whether a site's week is published, which version and when, and which post-days changed since.",
    kind: "read",
    audience: "manager",
    roles: ROSTER_EDITORS,
    input: publishRosterSchema,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { siteId, weekStart } = publishRosterSchema.parse(input);
      return loadPublicationStatus(supabase, organisationId, siteId, weekStart);
    },
    agent: true,
  },
  {
    name: "roster.publish",
    description:
      "Publishes a site's week as the next version and tells each worker whose shifts are new or changed.",
    kind: "write",
    audience: "manager",
    ...fromSpec(publishRosterSpec),
    changes: "many",
    action: at("workforce/roster-actions", "publishRosterAction"),
    preview: previewPublishWeek,
    agent: false,
    agentNote: PUBLISH_WEEK,
  },
  {
    name: "roster.resend_notices",
    description:
      "Tells the workers the latest published version affected who have no message for it yet.",
    kind: "write",
    audience: "manager",
    ...fromSpec(resendPublishNoticesSpec),
    changes: "many",
    action: at("workforce/roster-actions", "resendPublishNoticesAction"),
    agent: false,
    agentNote:
      "Sends messages and emails to workers after a publish whose notices failed: kept to people, from the publish result.",
  },

  // -------------------------------------------------------------------------
  // Leave setup and the company calendar (people/leave-setup-actions.ts, slice 4.1)
  // -------------------------------------------------------------------------
  {
    name: "leave.setup_summary",
    description:
      "Lists the leave types with today's days a year, scheduled changes, the working week and holiday counts.",
    kind: "read",
    audience: "manager",
    roles: CALENDAR_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadLeaveSetupSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "calendar.holidays",
    description: "Lists a year's public holidays, and the ones removed from it.",
    kind: "read",
    audience: "manager",
    roles: CALENDAR_READERS,
    input: holidayYearSchema,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { year } = holidayYearSchema.parse(input);
      return loadHolidays(supabase, organisationId, year);
    },
    agent: true,
  },
  {
    name: "calendar.official_holidays",
    description:
      "Lists a year's official federal and state holidays, kept by Metalira, that statutory deadlines skip.",
    kind: "read",
    audience: "manager",
    roles: CALENDAR_READERS,
    input: holidayYearSchema,
    changes: "none",
    action: null,
    // Slice 5.9b: platform-wide reference data, read-only for every company.
    read: async ({ supabase }, input) => {
      const { year } = holidayYearSchema.parse(input);
      return loadOfficialHolidayYear(supabase, year);
    },
    agent: true,
  },
  {
    name: "calendar.add_holiday",
    description: "Adds a public holiday on a date; refused when that date is already a holiday.",
    kind: "write",
    audience: "manager",
    ...fromSpec(addHolidaySpec),
    changes: "one",
    action: at("people/leave-setup-actions", "addHolidayAction"),
    agent: true,
  },
  {
    name: "calendar.remove_holiday",
    description: "Removes a public holiday; the row is kept, marked removed, with who and when.",
    kind: "write",
    audience: "manager",
    ...fromSpec(removeHolidaySpec),
    changes: "one",
    action: at("people/leave-setup-actions", "removeHolidayAction"),
    agent: true,
  },
  {
    name: "calendar.copy_holidays",
    description:
      "Copies one year's holidays into another on the same dates, listing each one it can't copy.",
    kind: "write",
    audience: "manager",
    ...fromSpec(copyHolidaysSpec),
    changes: "many",
    action: at("people/leave-setup-actions", "copyHolidaysAction"),
    preview: previewHolidayCopy,
    agent: true,
  },
  {
    name: "calendar.set_work_week",
    description: "Sets the company's working days, which leave counts when a worker has no roster.",
    kind: "write",
    audience: "manager",
    ...fromSpec(setWorkWeekSpec),
    changes: "one",
    action: at("people/leave-setup-actions", "setWorkWeekAction"),
    agent: true,
  },
  {
    name: "leave.create_type",
    description: "Adds a leave type of the company's own with its days a year from 1 January.",
    kind: "write",
    audience: "manager",
    ...fromSpec(createLeaveTypeSpec),
    changes: "one",
    action: at("people/leave-setup-actions", "createLeaveTypeAction"),
    agent: true,
  },
  {
    name: "leave.save_type",
    description:
      "Changes a leave type's name, counting, pay, certificate rule, minimum service or status.",
    kind: "write",
    audience: "manager",
    ...fromSpec(saveLeaveTypeSpec),
    changes: "one",
    action: at("people/leave-setup-actions", "saveLeaveTypeAction"),
    agent: true,
  },
  {
    name: "leave.add_entitlement_version",
    description:
      "Changes a leave type's days a year, carry-over or pay from tomorrow or a future 1 January.",
    kind: "write",
    audience: "manager",
    ...fromSpec(addEntitlementVersionSpec),
    changes: "many",
    action: at("people/leave-setup-actions", "addEntitlementVersionAction"),
    preview: previewEntitlement,
    agent: true,
  },
  {
    name: "leave.apply_preset",
    description:
      "Applies leave preset A or B: adds its types and versions the days of those the company has.",
    kind: "write",
    audience: "manager",
    ...fromSpec(applyPresetSpec),
    changes: "many",
    action: at("people/leave-setup-actions", "applyPresetAction"),
    preview: previewPreset,
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Payroll rules (payroll/rule-sets-actions.ts, slice 5.0)
  // -------------------------------------------------------------------------
  {
    name: "payroll.rules_summary",
    description:
      "Names the payroll rule set in force, its start, whether the tax adviser confirmed it, and versions scheduled.",
    kind: "read",
    audience: "manager",
    roles: PAYROLL_RULES_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadPayrollRulesSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "payroll.add_rule_set_version",
    description:
      "Adds a dated version of the PAYE bands, reliefs, pension, NHF, levies and pay policy from tomorrow or later.",
    kind: "money",
    audience: "manager",
    ...fromSpec(addRuleSetVersionSpec),
    changes: "many",
    action: at("payroll/rule-sets-actions", "addRuleSetVersionAction"),
    preview: previewAddRuleSetVersion,
    agent: false,
    agentNote:
      "Changes how every payslip is worked out: kept to the owner or HR, on the screen, after the tax adviser's advice.",
  },
  {
    name: "payroll.confirm_rule_set",
    description:
      "Records, once, that the company's tax adviser confirmed a version of the payroll rules.",
    kind: "write",
    audience: "manager",
    ...fromSpec(confirmRuleSetSpec),
    changes: "one",
    action: at("payroll/rule-sets-actions", "confirmRuleSetAction"),
    agent: false,
    agentNote: "A statement about the tax adviser's advice: only the owner can make it.",
  },
  {
    name: "payroll.set_holiday_pay",
    description:
      "Sets the company's public-holiday pay multiplier on the overtime rate from tomorrow or later (default 1.0x).",
    kind: "money",
    audience: "manager",
    ...fromSpec(setHolidayPaySpec),
    changes: "one",
    action: at("payroll/leavers-actions", "setHolidayPayAction"),
    preview: previewSetPayrollHolidayPay,
    agent: false,
    agentNote:
      "Changes how holiday work is paid: a company decision under its contracts, kept to the owner or HR on the screen.",
  },

  // -------------------------------------------------------------------------
  // Timesheets (workforce/timesheet-actions.ts, slice 4.2)
  // -------------------------------------------------------------------------
  {
    name: "timesheets.summary",
    description:
      "Counts a pay period's timesheet days: pending, approved, flagged, no clock-out, no-show, minutes worked and overtime.",
    kind: "read",
    audience: "manager",
    roles: TIMESHEET_READERS,
    input: timesheetSummaryInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { date } = timesheetSummaryInput.parse(input ?? {});
      return loadTimesheetSummary(supabase, organisationId, date);
    },
    agent: true,
  },
  {
    name: "timesheets.days",
    description:
      "Lists the timesheet days between two dates with their minutes, exceptions and status.",
    kind: "read",
    audience: "manager",
    roles: TIMESHEET_READERS,
    input: timesheetRangeInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { from, to } = timesheetRangeInput.parse(input);
      const lines = await loadTimesheetLines(supabase, organisationId, from, to, 2000);
      return { summary: summariseLines(lines, { start: from, end: to }), days: lines };
    },
    agent: true,
  },
  {
    name: "timesheets.correct",
    description:
      "Corrects one timesheet day with a reason (clock-in, clock-out, minutes or a punch set aside); never your own day.",
    kind: "write",
    audience: "manager",
    ...fromSpec(addCorrectionSpec),
    changes: "one",
    action: at("workforce/timesheet-actions", "addTimesheetCorrectionAction"),
    // Slice 4.3 (must-do 4): the preview shows the minutes now against after the correction.
    preview: previewCorrection,
    agent: true,
  },

  // -------------------------------------------------------------------------
  // Timesheet approval and Work Units (workforce/timesheet-approval-actions.ts, slice 4.3)
  // -------------------------------------------------------------------------
  {
    name: "timesheets.review",
    description:
      "Counts a pay period's days to decide, clean, flagged, disputed and approved, with Work Units made and billable.",
    kind: "read",
    audience: "manager",
    roles: TIMESHEET_READERS,
    input: periodInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { period } = periodInput.parse(input ?? {});
      return loadReviewSummary(supabase, organisationId, period);
    },
    agent: true,
  },
  {
    name: "timesheets.approve",
    description:
      "Approves one timesheet day; on a post with minutes it makes the day's Work Unit. Never your own day.",
    kind: "write",
    audience: "manager",
    ...fromSpec(approveLineSpec),
    changes: "many",
    action: at("workforce/timesheet-approval-actions", "approveTimesheetLineAction"),
    agent: false,
    agentNote: APPROVE_TIMESHEET,
  },
  // Bulk approve (workforce/timesheet-bulk-actions.ts, slice U.2)
  {
    name: "timesheets.bulk_approve",
    description:
      "Approves up to 500 selected timesheet days; flagged days and any that fail a check are skipped and listed.",
    kind: "write",
    audience: "manager",
    ...fromSpec(bulkApproveTimesheetSpec),
    changes: "many",
    action: at("workforce/timesheet-bulk-actions", "bulkApproveTimesheetAction"),
    preview: previewBulkTimesheet,
    agent: false,
    agentNote: BULK_LIST,
  },
  {
    name: "timesheets.preview_bulk_approve",
    description:
      "Lists which selected timesheet days a bulk approve would approve, and which it skips and why.",
    kind: "read",
    audience: "manager",
    ...fromSpec(previewBulkTimesheetSpec),
    changes: "none",
    action: at("workforce/timesheet-bulk-actions", "previewBulkTimesheetAction"),
    agent: false,
    agentNote: BULK_LIST,
  },
  {
    name: "timesheets.reject",
    description:
      "Rejects one timesheet day with a reason and tells the worker. Never your own day.",
    kind: "write",
    audience: "manager",
    ...fromSpec(rejectLineSpec),
    changes: "one",
    action: at("workforce/timesheet-approval-actions", "rejectTimesheetLineAction"),
    agent: false,
    agentNote: APPROVE_TIMESHEET,
  },
  {
    name: "timesheets.approve_clean",
    description:
      "Approves the clean days of a pay period at once and lists the rest by name for a person to decide.",
    kind: "write",
    audience: "manager",
    ...fromSpec(approveCleanSpec),
    changes: "many",
    action: at("workforce/timesheet-approval-actions", "approveCleanTimesheetLinesAction"),
    preview: previewApproveClean,
    agent: false,
    agentNote: APPROVE_TIMESHEET,
  },
  {
    name: "timesheets.reopen",
    description:
      "Reopens an approved or rejected day with a reason, cancelling its Work Unit so it can be decided again.",
    kind: "write",
    audience: "manager",
    ...fromSpec(reopenLineSpec),
    changes: "many",
    action: at("workforce/timesheet-approval-actions", "reopenTimesheetLineAction"),
    agent: false,
    agentNote: APPROVE_TIMESHEET,
  },
  {
    name: "timesheets.dispute",
    description:
      "Lets a worker say a day on their timesheet is wrong, with a reason, from the worker app.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: disputeLineSchema,
    changes: "many",
    action: at("workforce/timesheet-approval-actions", "disputeTimesheetLineAction"),
    agent: false,
    agentNote: "A worker's own statement about their day, sent from their phone.",
  },
  // -------------------------------------------------------------------------
  // Payroll inputs (payroll/inputs.ts, slice 5.1)
  // -------------------------------------------------------------------------
  {
    name: "payroll.inputs",
    description:
      "Counts a pay period's payroll inputs: workers by pay type, approved days and minutes, leave and holidays.",
    kind: "read",
    audience: "manager",
    roles: PAYROLL_READERS,
    input: periodInput,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { period } = periodInput.parse(input ?? {});
      return loadPayInputsSummary(
        supabase,
        organisationId,
        period ?? (await organisationToday(supabase, organisationId)),
      );
    },
    agent: false,
    agentNote:
      "Lira does nothing in Payroll (docs/PHASE_5.md decision 8); payroll inputs stay with owner, HR and finance.",
  },
  // -------------------------------------------------------------------------
  // The payroll run (payroll/run-actions.ts, slice 5.2)
  // -------------------------------------------------------------------------
  {
    name: "payroll.run_summary",
    description:
      "Counts payroll runs and gives the latest run's period, status, workers, open anomalies and totals.",
    kind: "read",
    audience: "manager",
    roles: PAYROLL_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadRunSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "payroll.payslip_explain",
    description:
      "Gives one payslip's step-by-step trace from Explain: how gross, pension, PAYE and net were worked out.",
    kind: "read",
    audience: "manager",
    roles: PAYROLL_READERS,
    input: payslipInput,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }, input) =>
      loadPayslipTrace(supabase, organisationId, payslipInput.parse(input).payslipId),
    agent: true,
  },
  {
    name: "payroll.create_run",
    description:
      "Prepares a pay period's payroll run with the rule set in force on its pay date and works out every payslip.",
    kind: "money",
    audience: "manager",
    ...fromSpec(createRunSpec),
    changes: "many",
    action: at("payroll/run-actions", "createRunAction"),
    preview: previewCreatePayrollRun,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  // Off-cycle runs (payroll/run-actions.ts, slice 5.7b)
  {
    name: "payroll.create_off_cycle_run",
    description:
      "Prepares an off-cycle run for chosen workers (final pay, missed worker, correction or one-off) and works it out.",
    kind: "money",
    audience: "manager",
    ...fromSpec(createOffCycleRunSpec),
    changes: "many",
    action: at("payroll/run-actions", "createOffCycleRunAction"),
    preview: previewCreateOffCyclePayrollRun,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.discard_off_cycle_run",
    description:
      "Discards an off-cycle draft with a reason: its draft payslips and one-off items are removed and nobody is paid by it.",
    kind: "money",
    audience: "manager",
    ...fromSpec(discardOffCycleRunSpec),
    changes: "many",
    action: at("payroll/run-actions", "discardOffCycleRunAction"),
    preview: previewDiscardOffCyclePayrollRun,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.recalculate_run",
    description:
      "Works out a draft payroll run again from current pay rates, timesheets, leave and adjustments.",
    kind: "money",
    audience: "manager",
    ...fromSpec(recalculateRunSpec),
    changes: "many",
    action: at("payroll/run-actions", "recalculateRunAction"),
    preview: previewRecalculatePayrollRun,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.add_adjustment",
    description:
      "Adds a one-off or recurring earning or deduction for one worker to a draft run, with a reason.",
    kind: "money",
    audience: "manager",
    ...fromSpec(addAdjustmentSpec),
    changes: "many",
    action: at("payroll/run-actions", "addAdjustmentAction"),
    preview: previewAddPayrollAdjustment,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.carry_instalment",
    description:
      "Carries a recurring item's next instalment onto a draft run in the same series, so it is never paid twice.",
    kind: "money",
    audience: "manager",
    ...fromSpec(carryInstalmentSpec),
    changes: "many",
    action: at("payroll/run-actions", "carryInstalmentAction"),
    preview: previewCarryPayrollInstalment,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.remove_adjustment",
    description:
      "Removes an earning or deduction from a draft run, with a reason, and recalculates.",
    kind: "money",
    audience: "manager",
    ...fromSpec(removeAdjustmentSpec),
    changes: "many",
    action: at("payroll/run-actions", "removeAdjustmentAction"),
    preview: previewRemovePayrollAdjustment,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.add_final_pay_item",
    description:
      "Adds pay in lieu of leave or notice, a gratuity or a redundancy payment to a leaver's final-pay draft, with a reason.",
    kind: "money",
    audience: "manager",
    ...fromSpec(addFinalPayItemSpec),
    changes: "many",
    action: at("payroll/leavers-actions", "addFinalPayItemAction"),
    preview: previewAddPayrollFinalPayItem,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.acknowledge_anomalies",
    description:
      "Acknowledges warnings on a draft run, such as open timesheet days paid next run; blocking ones are fixed.",
    kind: "money",
    audience: "manager",
    ...fromSpec(acknowledgeSpec),
    changes: "many",
    action: at("payroll/run-actions", "acknowledgeAnomaliesAction"),
    preview: previewAcknowledgePayrollAnomalies,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.submit_run",
    description:
      "Submits a draft run for approval once nothing blocks it and every warning is acknowledged; emails Finance.",
    kind: "money",
    audience: "manager",
    ...fromSpec(submitRunSpec),
    changes: "many",
    action: at("payroll/run-actions", "submitRunAction"),
    preview: previewSubmitPayrollRun,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.return_run",
    description: "Finance or the owner returns a submitted run to HR as a draft, with a reason.",
    kind: "money",
    audience: "manager",
    ...fromSpec(returnRunSpec),
    changes: "many",
    action: at("payroll/run-actions", "returnRunAction"),
    preview: previewReturnPayrollRun,
    agent: false,
    agentNote:
      "A decision on a submitted payroll run is a person's (docs/PHASE_5.md decision 8), made on the screen.",
  },
  {
    name: "payroll.approve_run",
    description:
      "Finance or the owner approves a submitted run after re-checking its inputs, posting payslips and locking the period.",
    kind: "money",
    audience: "manager",
    ...fromSpec(approveRunSpec),
    changes: "many",
    action: at("payroll/run-actions", "approveRunAction"),
    preview: previewApprovePayrollRun,
    agent: false,
    agentNote:
      "Approving payroll is a second person's decision (docs/PHASE_5.md decision 8, rule 10), made on the screen; Lira never approves or releases payroll.",
  },
  // -------------------------------------------------------------------------
  // Reversal and corrections (payroll/reversal-actions.ts, slice 5.7a)
  // -------------------------------------------------------------------------
  {
    name: "payroll.reverse_run",
    description:
      "Finance or the owner asks for an approved, unreleased run to be reversed, with a reason; a second person approves it.",
    kind: "money",
    audience: "manager",
    ...fromSpec(reverseRunSpec),
    changes: "many",
    action: at("payroll/reversal-actions", "reverseRunAction"),
    preview: previewReversePayrollRun,
    agent: false,
    agentNote:
      "Reversing payroll is a person's decision with a reason (docs/PHASE_5.md decision 8, rule 5); Lira never reverses payroll.",
  },
  {
    name: "payroll.approve_reversal",
    description:
      "A second person approves a reversal: the run is reversed, its bank file and remittances voided, and its period reopened.",
    kind: "money",
    audience: "manager",
    ...fromSpec(approveReversalSpec),
    changes: "many",
    action: at("payroll/reversal-actions", "approveReversalAction"),
    preview: previewApprovePayrollReversal,
    agent: false,
    agentNote:
      "Approving a reversal is a second person's decision (rule 10), made on the screen; Lira never approves payroll.",
  },
  {
    name: "payroll.add_correction",
    description:
      "Adds an earning or deduction to a draft run that corrects a released payslip of the same worker, then recalculates.",
    kind: "money",
    audience: "manager",
    ...fromSpec(addPayrollCorrectionSpec),
    changes: "many",
    action: at("payroll/reversal-actions", "addCorrectionAction"),
    preview: previewAddPayrollCorrection,
    agent: false,
    agentNote: NO_PAYROLL,
  },
  // -------------------------------------------------------------------------
  // The bank file and release (payroll/payout-actions.ts, slice 5.4)
  // -------------------------------------------------------------------------
  {
    name: "payroll.bank_file_summary",
    description:
      "Gives the latest posted run's status and its bank file's control totals: workers paid, total and workers left out.",
    kind: "read",
    audience: "manager",
    roles: PAYROLL_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadPayoutSummary(supabase, organisationId),
    agent: true,
  },
  {
    name: "payroll.make_bank_file",
    description:
      "Makes an approved run's bank file, checking each account's last 4 digits; a new file voids the old with a reason.",
    kind: "money",
    audience: "manager",
    ...fromSpec(makeBankFileSpec),
    changes: "many",
    action: at("payroll/payout-actions", "makeBankFileAction"),
    preview: previewMakePayrollBankFile,
    agent: false,
    agentNote:
      "Lira never makes, downloads or releases a bank file (docs/PHASE_5.md decision 8; docs/LIRA.md: never moves money). It holds account numbers.",
  },
  {
    name: "payroll.download_bank_file",
    description:
      "Opens the run's current bank file for 60 seconds, for an owner or Finance; audited.",
    kind: "read",
    audience: "manager",
    roles: fromSpec(downloadBankFileSpec).roles,
    input: bankFileIdSchema,
    changes: "none",
    action: at("payroll/payout-actions", "downloadBankFileAction"),
    agent: false,
    agentNote:
      "The bank file holds account numbers (CLAUDE.md rule 9): only a person downloads it, on the screen.",
  },
  {
    name: "payroll.release_run",
    description:
      "Finance or the owner confirms an approved run's bank file went to the bank, releasing the run and its payslips.",
    kind: "money",
    audience: "manager",
    ...fromSpec(releaseRunSpec),
    changes: "many",
    action: at("payroll/payout-actions", "releaseRunAction"),
    preview: previewReleasePayrollRun,
    agent: false,
    agentNote:
      "Releasing payroll is a person's confirmation, never anyone who prepared the run (rule 10); Lira never releases payroll.",
  },
  // -------------------------------------------------------------------------
  // Supplementary payout files and carried deductions (payroll/payout-actions.ts, slice 5.7c)
  // -------------------------------------------------------------------------
  {
    name: "payroll.make_supplementary_file",
    description:
      "Makes a bank file for workers a released run's file left out, once their bank details are in force.",
    kind: "money",
    audience: "manager",
    ...fromSpec(makeSupplementSpec),
    changes: "many",
    action: at("payroll/payout-actions", "makeSupplementAction"),
    preview: previewMakePayrollSupplement,
    agent: false,
    agentNote:
      "Lira never makes, downloads or confirms a bank file (docs/PHASE_5.md decision 8; docs/LIRA.md: never moves money). It holds account numbers.",
  },
  {
    name: "payroll.download_supplementary_file",
    description:
      "Opens a supplementary bank file for 60 seconds, for an owner or Finance; audited.",
    kind: "read",
    audience: "manager",
    roles: fromSpec(downloadSupplementSpec).roles,
    input: supplementIdSchema,
    changes: "none",
    action: at("payroll/payout-actions", "downloadSupplementAction"),
    agent: false,
    agentNote:
      "A supplementary bank file holds account numbers (CLAUDE.md rule 9): only a person downloads it, on the screen.",
  },
  {
    name: "payroll.confirm_supplementary_file",
    description:
      "Finance or the owner confirms a supplementary bank file went to the bank; never its maker or the run's preparer.",
    kind: "money",
    audience: "manager",
    ...fromSpec(confirmSupplementSpec),
    changes: "many",
    action: at("payroll/payout-actions", "confirmSupplementAction"),
    preview: previewConfirmPayrollSupplement,
    agent: false,
    agentNote:
      "Confirming a payment went to the bank is a person's statement (rule 10); Lira never confirms or releases payroll.",
  },
  {
    name: "payroll.carried_deductions_summary",
    description:
      "Gives the total of carried deductions still owed and how many workers owe one, across posted runs.",
    kind: "read",
    audience: "manager",
    roles: PAYROLL_READERS,
    input: null,
    changes: "none",
    action: null,
    read: ({ supabase, organisationId }) => loadCarriedDeductionsSummary(supabase, organisationId),
    agent: false,
    agentNote:
      "Carried deductions are amounts owed by named people from their pay; a person reads them on the payroll page (security review L3).",
  },
  // -------------------------------------------------------------------------
  // Payslips: PDFs, the worker app and notices (payroll/payslip-actions.ts, slice 5.5)
  // -------------------------------------------------------------------------
  {
    name: "payroll.payslip_pdf",
    description:
      "Opens one payslip's PDF through a 60-second link for owner, HR or finance, and records the download.",
    kind: "read",
    audience: "manager",
    ...fromSpec(downloadPayslipSpec),
    changes: "none",
    action: at("payroll/payslip-actions", "downloadPayslipAction"),
    agent: false,
    agentNote:
      "A payslip PDF holds a person's pay; it is downloaded by a person on the screen, never by Lira.",
  },
  {
    name: "payroll.publish_payslips",
    description:
      "Makes the payslip PDFs and worker notices a released run is still missing, without repeating any.",
    kind: "write",
    audience: "manager",
    roles: PAYSLIP_PUBLISHERS,
    input: publishPayslipsSpec.schema,
    changes: "many",
    action: at("payroll/payslip-actions", "publishPayslipsAction"),
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "me.payslip_pdf",
    description: "A worker downloads their own released payslip as a PDF through a 60-second link.",
    kind: "read",
    audience: "worker",
    roles: [],
    input: payslipIdSchema,
    changes: "none",
    action: at("payroll/payslip-actions", "downloadMyPayslipAction"),
    agent: false,
    agentNote: "Worker app only.",
  },
  {
    name: "me.ask_hr_about_payslip",
    description: "A worker asks HR a question about one of their payslips from the worker app.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: askHrSchema,
    changes: "one",
    action: at("payroll/payslip-actions", "askHrAboutPayslipAction"),
    agent: false,
    agentNote: "A question is the worker's own words, written in the worker app.",
  },
  // -------------------------------------------------------------------------
  // Payroll tax records (payroll/tax-records-actions.ts, slice 5.9a)
  // -------------------------------------------------------------------------
  {
    name: "payroll.record_opening_balance",
    description:
      "Records or corrects a worker's opening balance for the tax year: gross, chargeable pay, PAYE and pension to a month.",
    kind: "money",
    audience: "manager",
    ...fromSpec(recordOpeningSpec),
    changes: "one",
    action: at("payroll/tax-records-actions", "recordOpeningBalanceAction"),
    preview: previewRecordOpeningBalance,
    agent: false,
    agentNote: TAX_RECORDS_NOTE,
  },
  {
    name: "payroll.import_opening_balances",
    description:
      "Imports opening balances for many workers at go-live from pasted rows, correcting any already on file.",
    kind: "money",
    audience: "manager",
    ...fromSpec(importOpeningSpec),
    changes: "many",
    action: at("payroll/tax-records-actions", "importOpeningBalancesAction"),
    preview: previewImportOpeningBalances,
    agent: false,
    agentNote: TAX_RECORDS_NOTE,
  },
  {
    name: "payroll.declare_relief",
    description:
      "Declares or corrects a worker's rent, NHIS or life assurance relief for a tax year, counted once verified.",
    kind: "money",
    audience: "manager",
    ...fromSpec(declareReliefSpec),
    changes: "one",
    action: at("payroll/tax-records-actions", "declareReliefAction"),
    preview: previewDeclarePayrollRelief,
    agent: false,
    agentNote: TAX_RECORDS_NOTE,
  },
  {
    name: "payroll.start_relief_proof",
    description: "Prepares the upload of a relief's proof file to the private proof store.",
    kind: "write",
    audience: "manager",
    ...fromSpec(startProofSpec),
    changes: "none",
    action: at("payroll/tax-records-actions", "startReliefProofAction"),
    agent: false,
    agentNote: FILES,
  },
  {
    name: "payroll.record_relief_proof",
    description: "Checks an uploaded proof file by its bytes and records it against the relief.",
    kind: "write",
    audience: "manager",
    ...fromSpec(recordProofSpec),
    changes: "one",
    action: at("payroll/tax-records-actions", "recordReliefProofAction"),
    agent: false,
    agentNote: FILES,
  },
  {
    name: "payroll.verify_relief",
    description:
      "Verifies or rejects a relief's proof, which decides whether PAYE counts the relief.",
    kind: "money",
    audience: "manager",
    ...fromSpec(verifyReliefSpec),
    changes: "one",
    action: at("payroll/tax-records-actions", "verifyReliefAction"),
    preview: previewVerifyPayrollRelief,
    agent: false,
    agentNote: TAX_RECORDS_NOTE,
  },
  {
    name: "payroll.open_relief_proof",
    description: "Gives a 60-second link to a relief's proof file, audited.",
    kind: "write",
    audience: "manager",
    ...fromSpec(proofLinkSpec),
    changes: "none",
    action: at("payroll/tax-records-actions", "reliefProofLinkAction"),
    agent: false,
    agentNote: OPEN_FILE,
  },
  {
    name: "payroll.set_nhf_number",
    description:
      "Records or removes a worker's NHF number (masked to the last 4); NHF is deducted only with one on file.",
    kind: "money",
    audience: "manager",
    ...fromSpec(nhfNumberSpec),
    changes: "one",
    action: at("payroll/tax-records-actions", "setNhfNumberAction"),
    preview: previewSetNhfNumber,
    agent: false,
    agentNote: REVEAL,
  },
  {
    name: "payroll.set_itf_turnover",
    description:
      "Sets whether the company's turnover is N50 million or more, which makes ITF apply whatever the headcount.",
    kind: "money",
    audience: "manager",
    ...fromSpec(itfFlagSpec),
    changes: "one",
    action: at("payroll/tax-records-actions", "setItfTurnoverAction"),
    preview: previewSetItfTurnover,
    agent: false,
    agentNote: TAX_RECORDS_NOTE,
  },
  // -------------------------------------------------------------------------
  // Statutory remittances (payroll/remittance-actions.ts, slice 5.6)
  // -------------------------------------------------------------------------
  {
    name: "payroll.remittances_summary",
    description:
      "Counts statutory remittances paid, due, overdue and past the PAYE penalty date, with the total still owed.",
    kind: "read",
    audience: "manager",
    roles: REMITTANCE_RECORDERS,
    input: null,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }) =>
      loadRemittanceSummary(
        supabase,
        organisationId,
        await organisationToday(supabase, organisationId),
      ),
    agent: true,
  },
  {
    name: "payroll.preview_remittance_payment",
    description:
      "Works out what recording a remittance payment will do, against the amount due, without saving.",
    kind: "read",
    audience: "manager",
    roles: REMITTANCE_RECORDERS,
    input: previewPaymentSchema,
    changes: "none",
    action: at("payroll/remittance-actions", "previewRemittancePaymentAction"),
    agent: false,
    agentNote: REMITTANCE_NOTE,
  },
  {
    name: "payroll.start_remittance_receipt",
    description: "Prepares the upload of a remittance's receipt to the private evidence store.",
    kind: "write",
    audience: "manager",
    ...fromSpec(startReceiptSpec),
    changes: "none",
    action: at("payroll/remittance-actions", "startRemittanceReceiptAction"),
    agent: false,
    agentNote: REMITTANCE_NOTE,
  },
  {
    name: "payroll.record_remittance_payment",
    description:
      "Records, once, that a statutory remittance was paid, with the date, amount, reference and receipt.",
    kind: "money",
    audience: "manager",
    ...fromSpec(recordPaymentSpec),
    changes: "many",
    action: at("payroll/remittance-actions", "recordRemittancePaymentAction"),
    preview: previewRecordRemittancePayment,
    agent: false,
    agentNote: REMITTANCE_NOTE,
  },
  {
    name: "payroll.void_remittance_payment",
    description:
      "Voids a wrong remittance payment record with a reason, so the right one can be recorded.",
    kind: "money",
    audience: "manager",
    ...fromSpec(voidPaymentSpec),
    changes: "one",
    action: at("payroll/remittance-actions", "voidRemittancePaymentAction"),
    preview: previewVoidRemittancePayment,
    agent: false,
    agentNote: REMITTANCE_NOTE,
  },
  {
    name: "payroll.set_remittance_due_days",
    description:
      "Sets the company's own PAYE, NHF, NSITF and ITF due days, used only when earlier than the statutory deadline.",
    kind: "write",
    audience: "manager",
    ...fromSpec(setDueDaysSpec),
    changes: "one",
    action: at("payroll/remittance-actions", "setRemittanceDueDaysAction"),
    agent: false,
    agentNote: NO_PAYROLL,
  },
  {
    name: "payroll.download_schedule",
    description:
      "Gives the page that streams a remittance's schedule (TINs or RSA PINs), never stored, audited on download.",
    kind: "read",
    audience: "manager",
    roles: REMITTANCE_RECORDERS,
    input: remittanceIdSchema,
    changes: "none",
    action: null,
    // Only where the file is: the route (/app/payroll/remittances/[id]/schedule) makes and
    // audits it for a person on the screen.
    read: async (_ctx, input) => ({
      href: `/app/payroll/remittances/${remittanceIdSchema.parse(input).remittanceId}/schedule`,
    }),
    agent: false,
    agentNote:
      "Schedules carry TINs and RSA PINs; Lira never downloads payroll files (docs/PHASE_5.md decision 8).",
  },
  {
    name: "payroll.preview_remittance_refund",
    description:
      "Works out what recording a refund of a payment on a voided remittance will do, without saving.",
    kind: "read",
    audience: "manager",
    roles: REMITTANCE_RECORDERS,
    input: previewRefundSchema,
    changes: "none",
    action: at("payroll/remittance-actions", "previewRemittanceRefundAction"),
    agent: false,
    agentNote: REMITTANCE_NOTE,
  },
  {
    name: "payroll.start_refund_receipt",
    description: "Prepares the upload of a refund's receipt to the private evidence store.",
    kind: "write",
    audience: "manager",
    ...fromSpec(startRefundReceiptSpec),
    changes: "none",
    action: at("payroll/remittance-actions", "startRefundReceiptAction"),
    agent: false,
    agentNote: REMITTANCE_NOTE,
  },
  {
    name: "payroll.record_remittance_refund",
    description:
      "Records a refund an authority sent back for a payment on a remittance a reversal voided, with its receipt.",
    kind: "money",
    audience: "manager",
    ...fromSpec(recordRefundSpec),
    changes: "one",
    action: at("payroll/remittance-actions", "recordRemittanceRefundAction"),
    preview: previewRemittanceRefund,
    agent: false,
    agentNote: REMITTANCE_NOTE,
  },
  {
    name: "payroll.offset_remittance_payment",
    description:
      "Offsets a payment on a voided remittance against a later remittance to the same authority.",
    kind: "money",
    audience: "manager",
    ...fromSpec(recordOffsetSpec),
    changes: "many",
    action: at("payroll/remittance-actions", "offsetRemittancePaymentAction"),
    preview: previewRemittanceOffset,
    agent: false,
    agentNote:
      "Whether an authority accepts an offset is a person's call with the adviser (RULES_NIGERIA open point 8); Lira never records payments or offsets.",
  },
  {
    name: "payroll.open_remittance_receipt",
    description: "Makes a 60-second link that opens a recorded remittance payment's receipt.",
    kind: "read",
    audience: "manager",
    roles: REMITTANCE_RECORDERS,
    input: receiptLinkSchema,
    changes: "none",
    action: at("payroll/remittance-actions", "remittanceReceiptLinkAction"),
    agent: false,
    agentNote: "Opening a payroll file is a person's step on the screen; Lira never opens files.",
  },
  // -------------------------------------------------------------------------
  // Leave requests and balances (people/leave-request-actions.ts, own-leave-actions.ts, 4.4)
  // -------------------------------------------------------------------------
  {
    name: "leave.summary",
    description:
      "Counts who is on leave today, requests waiting for line managers and HR, and leave starting in 14 days.",
    kind: "read",
    audience: "manager",
    roles: LEAVE_READERS,
    input: null,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }) =>
      loadLeaveSummary(supabase, organisationId, await organisationToday(supabase, organisationId)),
    agent: true,
  },
  {
    name: "leave.requests",
    description:
      "Lists leave requests with dates, days and each step's decision; ops managers see dates and type only.",
    kind: "read",
    audience: "manager",
    roles: LEAVE_READERS,
    input: leaveListSchema,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const filter = leaveListSchema.parse(input ?? {});
      const statuses =
        filter.status === "waiting"
          ? (["pending_line_manager", "pending_hr"] as const)
          : filter.status === "approved"
            ? (["approved"] as const)
            : null;
      const rows = await loadLeaveRequests(supabase, organisationId, {
        statuses: statuses ? [...statuses] : null,
        from: filter.from ?? null,
        to: filter.to ?? null,
      });
      // No reasons or notes: names, dates, days and status only.
      return rows.map((r) => ({
        id: r.id,
        worker: r.workerName,
        type: r.leaveTypeName,
        startDate: r.startDate,
        endDate: r.endDate,
        days: r.days,
        status: r.status,
        yoursToDecide: r.canDecideStep1 || r.canDecideStep2,
      }));
    },
    agent: true,
  },
  {
    name: "leave.balances",
    description:
      "Shows leave balances for the year by worker and type: granted, taken, waiting and left.",
    kind: "read",
    audience: "manager",
    roles: BALANCE_READERS,
    input: leaveBalancesSchema,
    changes: "none",
    action: null,
    read: async ({ supabase, organisationId }, input) => {
      const { workerId, year } = leaveBalancesSchema.parse(input ?? {});
      const today = await organisationToday(supabase, organisationId);
      return loadBalances(
        supabase,
        organisationId,
        year ?? Number(today.slice(0, 4)),
        workerId ? [workerId] : undefined,
      );
    },
    agent: true,
  },
  {
    name: "leave.decide_line_manager",
    description:
      "Step 1: the worker's line manager approves a leave request (on to HR) or declines it with a note.",
    kind: "write",
    audience: "manager",
    ...fromSpec(decideLineManagerSpec),
    changes: "many",
    action: at("people/leave-request-actions", "decideLeaveLineManagerAction"),
    agent: false,
    agentNote: "Approving leave is a person's decision (PHASE_4.md): kept to the line manager.",
  },
  {
    name: "leave.decide_hr",
    description:
      "Step 2: HR approves leave (days off the balance, the worker's shifts in the range opened) or declines it with a note.",
    kind: "write",
    audience: "manager",
    ...fromSpec(decideHrSpec),
    changes: "many",
    action: at("people/leave-request-actions", "decideLeaveHrAction"),
    preview: previewHrLeaveDecision,
    agent: false,
    agentNote:
      "The final leave approval is a person's decision (PHASE_4.md): kept to HR, with its preview on the screen.",
  },
  // Bulk approve (people/leave-bulk-actions.ts, slice U.2)
  {
    name: "leave.bulk_approve",
    description:
      "Approves up to 500 selected leave requests at the caller's step; any that fail a check are skipped and listed.",
    kind: "write",
    audience: "manager",
    ...fromSpec(bulkApproveLeaveSpec),
    changes: "many",
    action: at("people/leave-bulk-actions", "bulkApproveLeaveAction"),
    preview: previewBulkLeave,
    agent: false,
    agentNote: BULK_LIST,
  },
  {
    name: "leave.preview_bulk_approve",
    description:
      "Lists which selected leave requests a bulk approve would approve, and which it skips and why.",
    kind: "read",
    audience: "manager",
    ...fromSpec(previewBulkLeaveSpec),
    changes: "none",
    action: at("people/leave-bulk-actions", "previewBulkLeaveAction"),
    agent: false,
    agentNote: BULK_LIST,
  },
  {
    name: "leave.cancel",
    description:
      "HR cancels a leave request with a reason; cancelling approved leave gives the days back.",
    kind: "write",
    audience: "manager",
    ...fromSpec(cancelLeaveSpec),
    changes: "many",
    action: at("people/leave-request-actions", "cancelLeaveAction"),
    agent: false,
    agentNote: NO_PREVIEW,
  },
  {
    name: "leave.adjust_balance",
    description:
      "HR adds or takes away leave days for one worker, type and year, with a reason kept in the ledger.",
    kind: "write",
    audience: "manager",
    ...fromSpec(adjustLeaveSpec),
    changes: "one",
    action: at("people/leave-request-actions", "adjustLeaveBalanceAction"),
    agent: false,
    agentNote: "Changes a worker's leave balance: kept to HR, who gives the reason.",
  },
  {
    name: "me.request_leave",
    description:
      "A worker asks for leave of one type between two dates; the working days are counted for them.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: requestLeaveSchema,
    changes: "one",
    action: at("people/own-leave-actions", "requestLeaveAction"),
    agent: false,
    agentNote: "Asking for leave is the worker's own request, made in the worker app.",
  },
  {
    name: "me.cancel_leave",
    description: "A worker cancels their own leave request before the final decision.",
    kind: "write",
    audience: "worker",
    roles: [],
    input: cancelOwnLeaveSchema,
    changes: "one",
    action: at("people/own-leave-actions", "cancelOwnLeaveAction"),
    agent: false,
    agentNote: "Cancelling is the worker's own choice, made in the worker app.",
  },
];

/** The capability with this name, or undefined. */
export function findCapability(name: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.name === name);
}
