/**
 * The location and selfie notices a worker agrees to in the worker app (slice 3.1), and their
 * versions. The version is stored with each consent (worker_consents.notice_version), so we can
 * always show which words a worker agreed to.
 *
 * Versions are "major.minor". The database accepts only versions it knows, so every new version
 * MUST be added to private.consent_notice_known in a migration in the same pull request
 * (tests/rls/worker-consents-inbox.test.ts fails otherwise):
 * - Wording only (clearer words, same meaning): bump the minor ("1.0" -> "1.1"). Consents given
 *   under 1.0 still count.
 * - A change of meaning (what is collected, who sees it, how long it is kept): bump the major
 *   ("1.1" -> "2.0") and private.consent_notice_major too. Consents under the old major stop
 *   counting and the worker is asked again (owner's default, pending their answer, 20 Nov 2026).
 * Keep the old words in git history.
 *
 * Owner decision (20 Nov 2026): a worker who doesn't agree is clocked in by their supervisor.
 */

export const CONSENT_KINDS = ["location", "selfie"] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];

export interface ConsentNotice {
  version: string;
  title: string;
  /** Short paragraphs, read top to bottom. */
  body: readonly string[];
  agree: string;
}

export const CONSENT_NOTICES: Record<ConsentKind, ConsentNotice> = {
  location: {
    version: "1.0",
    title: "Location",
    body: [
      "When you clock in or out, the app records where your phone is, once, to check you are at your site.",
      "Your location is not tracked at any other time, and never while you are clocked out.",
      "Your managers and HR see where each clock-in was and whether it was inside your site.",
    ],
    agree: "I agree to share my location when I clock in or out",
  },
  selfie: {
    version: "1.0",
    title: "Selfie",
    body: [
      "When you clock in, the app takes one photo of you to show it was you.",
      "Only your managers and HR see it. Photos are deleted after 90 days unless one is being checked.",
    ],
    agree: "I agree to take a selfie when I clock in",
  },
};

/** The major part of a "major.minor" notice version, or null when it isn't one. */
export function consentVersionMajor(version: string): number | null {
  const match = /^(\d{1,3})\.\d{1,3}$/.exec(version);
  return match ? Number(match[1]) : null;
}

/** Whether a stored consent still counts: given under the current major version. */
export function isCurrentConsentVersion(kind: ConsentKind, version: string): boolean {
  return consentVersionMajor(version) === consentVersionMajor(CONSENT_NOTICES[kind].version);
}

export function isConsentKind(value: unknown): value is ConsentKind {
  return typeof value === "string" && (CONSENT_KINDS as readonly string[]).includes(value);
}
