/**
 * Self-onboarding invites (slice U.4), the rules both sides share. Pure: safe for client
 * components. The database is the authority (migration 20261122300000_self_onboarding.sql).
 *
 * The inviter picks ONE role. Manager roles become a membership with that role; worker roles
 * become a worker with that job title. The invitee never chooses or changes it.
 */

export const ONBOARDING_ROLES = [
  "hr",
  "finance",
  "ops_manager",
  "line_manager",
  "supervisor",
  "guard",
  "cleaner",
] as const;

export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];

export const ONBOARDING_MANAGER_ROLES = [
  "hr",
  "finance",
  "ops_manager",
  "line_manager",
] as const satisfies readonly OnboardingRole[];

export type OnboardingManagerRole = (typeof ONBOARDING_MANAGER_ROLES)[number];

export const ONBOARDING_ROLE_LABELS: Record<OnboardingRole, string> = {
  hr: "HR",
  finance: "Finance",
  ops_manager: "Operations manager",
  line_manager: "Line manager",
  supervisor: "Supervisor",
  guard: "Guard",
  cleaner: "Cleaner",
};

export const ONBOARDING_ROLE_HINTS: Record<OnboardingRole, string> = {
  hr: "Manager app: people, leave, pay rates and payroll.",
  finance: "Manager app: payroll, invoices and collections.",
  ops_manager: "Manager app: clients, sites, rosters and timesheets.",
  line_manager: "Manager app: their own team's shifts, timesheets and leave.",
  supervisor: "Phone app: a worker who leads a crew.",
  guard: "Phone app: clocks in and out at their site.",
  cleaner: "Phone app: clocks in and out at their site.",
};

/** The job title a worker role gets (the database's private.onboarding_job_title). */
export const ONBOARDING_JOB_TITLES: Record<OnboardingRole, string> = {
  hr: "HR",
  finance: "Finance",
  ops_manager: "Operations manager",
  line_manager: "Line manager",
  supervisor: "Supervisor",
  guard: "Guard",
  cleaner: "Cleaner",
};

export function isOnboardingRole(value: unknown): value is OnboardingRole {
  return typeof value === "string" && (ONBOARDING_ROLES as readonly string[]).includes(value);
}

export function isManagerOnboardingRole(role: OnboardingRole): role is OnboardingManagerRole {
  return (ONBOARDING_MANAGER_ROLES as readonly string[]).includes(role);
}

export type OnboardingStatus = "sent" | "opened" | "submitted" | "approved" | "cancelled";

/** What the list shows: the stored status, or "expired" for an open invite past its date. */
export type OnboardingListStatus = OnboardingStatus | "expired";

export function listStatus(
  status: OnboardingStatus,
  expiresAt: string,
  now: Date = new Date(),
): OnboardingListStatus {
  if ((status === "sent" || status === "opened") && Date.parse(expiresAt) <= now.getTime()) {
    return "expired";
  }
  return status;
}

export const ONBOARDING_STATUS_LABELS: Record<OnboardingListStatus, string> = {
  sent: "Sent",
  opened: "Opened",
  submitted: "Waiting for HR review",
  approved: "Approved",
  cancelled: "Cancelled",
  expired: "Expired",
};

/** Who may invite and approve: the owner or HR (none of the roles offered is owner or admin). */
export const ONBOARDING_STAFF = ["owner", "hr"] as const;

export const MANAGERS_OWNER_ONLY =
  "Only the owner can invite managers. HR invites supervisors, guards and cleaners.";

/**
 * Security review H1: manager roles (HR, finance, ops manager, line manager) are the owner's to
 * invite and approve; HR onboards worker roles only. The database checks the same.
 */
export function canOnboardRole(callerRole: string, role: OnboardingRole): boolean {
  return callerRole === "owner" || !isManagerOnboardingRole(role);
}

/** The roles a caller may offer: all for the owner, worker roles for HR. */
export function rolesFor(callerRole: string): OnboardingRole[] {
  return ONBOARDING_ROLES.filter((role) => canOnboardRole(callerRole, role));
}

/** Invite links: /onboard/<64 hex characters>. */
export const ONBOARDING_PATH = "/onboard";

export function onboardingPath(token: string): string {
  return `${ONBOARDING_PATH}/${token}`;
}

export function isOnboardingToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** The daily email caps the invite shares with every other manager email (src/lib/inbox.ts). */
export function emailsLeft(
  sent: { company: number; overall: number },
  caps: { perCompany: number; overall: number },
): number {
  return Math.max(0, Math.min(caps.perCompany - sent.company, caps.overall - sent.overall));
}
