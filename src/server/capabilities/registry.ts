import "server-only";

import { z } from "zod";

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
import {
  decideBankChangeSpec,
  requestBankChangeSpec,
  withdrawBankChangeSpec,
} from "@/server/people/bank-changes";
import { lookupWorkerBankSchema } from "@/server/people/bank-lookups";
import { resolveChangeRequestSpec } from "@/server/people/change-requests";
import { createDepartmentSpec, updateDepartmentSpec } from "@/server/people/departments";
import {
  applyImportFixSpec,
  cancelImportSpec,
  checkImportSpec,
  commitImportSpec,
  startImportSpec,
} from "@/server/people/imports/batches";
import { saveMappingSpec } from "@/server/people/mapping";
import { checkWorkerBankSchema } from "@/server/people/schemas";
import {
  ownBankChangeSchema,
  ownBankLookupSchema,
  ownChangeRequestSchema,
} from "@/server/people/own-requests";
import { unlockSignInSpec } from "@/server/people/sign-in-status";
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
  removeAssignmentSpec,
} from "@/server/workforce/roster";
import {
  loadRosterCandidates,
  loadRosterSettings,
  loadRosterSummary,
  loadRosterWeek,
} from "@/server/workforce/roster-data";
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
  previewAddPost,
  previewCancelRequirementChange,
  previewChangeRequirement,
  previewClosePost,
} from "./live-change-previews";
import { previewCopyWeek } from "./roster-previews";
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
    description: "Saves the company's business details: names, RC number, TIN, address.",
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
    name: "setup.continue_from_clients",
    description: "Moves company setup on from the clients step.",
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
      "Ranks who could cover one post on one day: mapped to the site, free then and under the weekly standard hours first.",
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
        { weeklyStandardMinutes: settings.weeklyStandardMinutes, timeZone: settings.timeZone },
      );
      return { required: true, suggestions: ranked.filter((s) => s.eligible).slice(0, 10) };
    },
    agent: true,
  },
  {
    name: "roster.assign",
    description:
      "Assigns one employee to a post on a day; refused for leavers, closed posts, archived sites, full or overlapping shifts.",
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
];

/** The capability with this name, or undefined. */
export function findCapability(name: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.name === name);
}
