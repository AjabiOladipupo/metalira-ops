/**
 * The location and selfie notices a worker agrees to in the worker app (slice 3.1), and their
 * versions. The version is stored with each consent (worker_consents.notice_version), so we can
 * always show which words a worker agreed to.
 *
 * Changing what a notice says: keep the old entry's words in git history, bump `version`
 * ("YYYY-MM-DD.n", the day of the change), and decide with the owner whether workers must agree
 * again (slice 3.5 would then compare the stored version). Fixing a typo needs no new version.
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
    version: "2026-11-20.1",
    title: "Location",
    body: [
      "When you clock in or out, the app records where your phone is, once, to check you are at your site.",
      "Your location is not tracked at any other time, and never while you are clocked out.",
      "Your managers and HR see where each clock-in was and whether it was inside your site.",
    ],
    agree: "I agree to share my location when I clock in or out",
  },
  selfie: {
    version: "2026-11-20.1",
    title: "Selfie",
    body: [
      "When you clock in, the app takes one photo of you to show it was you.",
      "Only your managers and HR see it. Photos are deleted after 90 days unless one is being checked.",
    ],
    agree: "I agree to take a selfie when I clock in",
  },
};

export function isConsentKind(value: unknown): value is ConsentKind {
  return typeof value === "string" && (CONSENT_KINDS as readonly string[]).includes(value);
}
