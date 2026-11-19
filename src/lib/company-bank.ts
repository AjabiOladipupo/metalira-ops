import { formatDateTime } from "@/lib/dates";
import { last4, maskAccount } from "@/lib/mask";
import type { ManagerRole, Role } from "@/lib/roles";

/**
 * The company's own collection bank account (slice 2.3): the account clients pay invoices into.
 * Pure and browser-safe: roles, masking, the hold, and the preview shown before a request is
 * sent. Nothing here reads the database or an account number at rest.
 *
 * Rules (enforced by the database, migration 20261119110000; repeated here so the screen can
 * say what will happen): owner, admin and finance raise a request; an owner or finance user who
 * is not the requester approves it; the account takes effect 72 hours after approval. The first
 * account, added by an owner while company setup is unfinished, takes effect at once.
 */

/** Who may ask to add or change the account. */
export const COMPANY_BANK_REQUESTERS = [
  "owner",
  "admin",
  "finance",
] as const satisfies readonly ManagerRole[];
/** Who may approve, reject or stop a request (never their own). */
export const COMPANY_BANK_APPROVERS = [
  "owner",
  "finance",
] as const satisfies readonly ManagerRole[];
/** Who may see the account number in full, through an audited reveal. */
export const COMPANY_BANK_REVEALERS = [
  "owner",
  "finance",
] as const satisfies readonly ManagerRole[];

/** Hours between approval and the account taking effect. */
export const COMPANY_BANK_HOLD_HOURS = 72;

const HOUR = 3_600_000;

const includes = (list: readonly Role[], role: Role) => list.includes(role);

export function canRequestCompanyBank(role: Role): boolean {
  return includes(COMPANY_BANK_REQUESTERS, role);
}
export function canApproveCompanyBank(role: Role): boolean {
  return includes(COMPANY_BANK_APPROVERS, role);
}
export function canRevealCompanyBank(role: Role): boolean {
  return includes(COMPANY_BANK_REVEALERS, role);
}

/** "GTBank ••••4410 · ADEBAYO FACILITY SERVICES LTD": how an account is named everywhere. */
export function formatCompanyAccount(account: {
  bankName: string;
  accountName: string;
  last4: string;
}): string {
  return `${account.bankName} ${maskAccount(account.last4)} · ${account.accountName}`;
}

/**
 * True when `shownLast4` is the last four digits of `accountNumber`. The database has no key, so
 * the server runs this on approval and on every reveal: what the approver saw is what clients
 * will pay into.
 */
export function last4Matches(accountNumber: string, shownLast4: string): boolean {
  return /^\d{4}$/.test(shownLast4) && last4(accountNumber) === shownLast4;
}

/** When an approval at `approvedAt` takes effect. */
export function holdEndsAt(approvedAt: string | Date): Date {
  const at = typeof approvedAt === "string" ? new Date(approvedAt) : approvedAt;
  if (Number.isNaN(at.getTime())) throw new RangeError("Not a date and time");
  return new Date(at.getTime() + COMPANY_BANK_HOLD_HOURS * HOUR);
}

/** True while an approved account is still waiting out its hold. */
export function holdRunning(appliesAfter: string | null, now: string | Date): boolean {
  if (!appliesAfter) return false;
  return Date.parse(appliesAfter) > new Date(now).getTime();
}

/**
 * The hold countdown in words: "2 days 5 hours left", "3 hours left", "Less than an hour left",
 * or null once the hold has ended. Whole hours, rounded up, so it never says less than is left.
 */
export function holdCountdown(appliesAfter: string, now: string | Date): string | null {
  const left = Date.parse(appliesAfter) - new Date(now).getTime();
  if (Number.isNaN(left)) throw new RangeError("Not a date and time");
  if (left <= 0) return null;
  if (left < HOUR) return "Less than an hour left";
  const hours = Math.ceil(left / HOUR);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [days > 0 ? plural(days, "day") : null, rest > 0 ? plural(rest, "hour") : null];
  return `${parts.filter(Boolean).join(" ")} left`;
}

/** What the company has on file when a request is being written. */
export interface CompanyBankState {
  /** The account in force now, if any. */
  current: { bankName: string; accountName: string; last4: string } | null;
  /** A request is already waiting for approval or on hold. */
  hasOpenRequest: boolean;
  /** Company setup is finished (`organisations.setup_completed_at` is set). */
  setupCompleted: boolean;
  /**
   * An account has already been approved, or the first-account exception has been used: either
   * way the exception is gone.
   */
  firstAccountUsed: boolean;
}

/**
 * True when a request by `role` would be the first account an owner may add alone: an owner,
 * setup unfinished, and no account approved or added that way before. The database decides
 * (under a lock, so two requests at once can't both use it); this mirrors it for the preview.
 */
export function firstAccountAllowed(role: Role, state: CompanyBankState): boolean {
  return role === "owner" && !state.setupCompleted && !state.firstAccountUsed;
}

export interface CompanyBankRequestDraft {
  bankName: string;
  accountName: string;
  /** The full number as typed; only its last four digits leave this function. */
  accountNumber: string;
}

export type CompanyBankPreview =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** `first_account`: in use at once. `needs_approval`: a second person, then the hold. */
      mode: "first_account" | "needs_approval";
      /** The new account, masked. */
      newAccount: string;
      /** The account it replaces, masked, or null when there is none. */
      replaces: string | null;
      /** One sentence on who has to act next. */
      approval: string;
      /** One sentence on when clients' invoices start to show it. */
      effective: string;
      /** If approved the moment the request is sent, the earliest the account takes effect. */
      earliestEffectiveAt: string;
      /** The sentences above with what stays the same meanwhile, for a confirm step. */
      lines: string[];
    };

/**
 * What sending this request will change, and when, for the confirm step (and for Lira's
 * confirmation card later). Pure: same inputs, same answer. It never returns the full number.
 */
export function previewCompanyBankRequest(
  draft: CompanyBankRequestDraft,
  role: Role,
  state: CompanyBankState,
  now: string | Date = new Date(),
): CompanyBankPreview {
  if (!canRequestCompanyBank(role)) {
    return {
      ok: false,
      reason: "Only an owner, an admin or finance can ask to change the company bank account.",
    };
  }
  const digits = draft.accountNumber.replace(/[\s-]/g, "");
  const tail = last4(digits);
  if (!/^\d{10}$/.test(digits) || !tail) {
    return { ok: false, reason: "Bank account numbers are 10 digits" };
  }
  const bankName = draft.bankName.trim();
  const accountName = draft.accountName.trim();
  if (!bankName || !accountName) {
    return { ok: false, reason: "Enter the bank name and the account name" };
  }

  const first = firstAccountAllowed(role, state);
  if (!first && state.hasOpenRequest) {
    return {
      ok: false,
      reason:
        "A bank account request is already waiting. Approve, reject or withdraw it before raising another.",
    };
  }

  const newAccount = formatCompanyAccount({ bankName, accountName, last4: tail });
  const replaces = state.current ? formatCompanyAccount(state.current) : null;
  const at = new Date(now);

  if (first) {
    const approval =
      "This is your first account and setup is not finished, so it needs no second approver. It is recorded in the audit log.";
    const effective = "Clients pay into it as soon as you add it.";
    return {
      ok: true,
      mode: "first_account",
      newAccount,
      replaces,
      approval,
      effective,
      earliestEffectiveAt: at.toISOString(),
      lines: [approval, effective],
    };
  }

  const earliest = holdEndsAt(at);
  const approval =
    "An owner or finance user other than you must approve it. Nothing changes until they do.";
  const effective = `It takes effect ${COMPANY_BANK_HOLD_HOURS} hours after approval: ${formatDateTime(earliest)} Lagos time at the earliest.`;
  const meanwhile = replaces
    ? `Until then invoices keep showing ${replaces}.`
    : "Until then invoices show no bank account.";
  return {
    ok: true,
    mode: "needs_approval",
    newAccount,
    replaces,
    approval,
    effective,
    earliestEffectiveAt: earliest.toISOString(),
    lines: [approval, effective, meanwhile],
  };
}
