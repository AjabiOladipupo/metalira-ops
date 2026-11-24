/**
 * Remittance refunds and offsets (slice 5.7c). Pure, in kobo; the same rules as
 * `private.statutory_payment_resolutions_guard`, which checks them again in SQL.
 *
 * When 5.7a reverses a posted run, its remittances are voided, but a payment already made to an
 * authority stays as evidence: the money is with the authority. The person resolves it, wholly
 * or in parts, as either
 *   - a refund received from the authority (with its receipt), or
 *   - an offset against a later remittance to the same authority, which then owes that much less.
 * Which of these an authority allows is not a rule the app knows (RULES_NIGERIA open point 8):
 * it is the person's choice, recorded and audited.
 */

import { sumKobo, type Kobo } from "@/lib/money";

export interface Resolution {
  kind: "refund" | "offset";
  amountKobo: Kobo;
}

export interface PaymentResolution {
  paidKobo: Kobo;
  refundedKobo: Kobo;
  offsetKobo: Kobo;
  /** Still with the authority, neither refunded nor offset yet. */
  unresolvedKobo: Kobo;
}

/** How much of a payment on a voided remittance is refunded, offset and still unresolved. */
export function resolvePayment(
  paidKobo: Kobo,
  resolutions: readonly Resolution[],
): PaymentResolution {
  const refundedKobo = sumKobo(
    resolutions.filter((r) => r.kind === "refund").map((r) => r.amountKobo),
  );
  const offsetKobo = sumKobo(
    resolutions.filter((r) => r.kind === "offset").map((r) => r.amountKobo),
  );
  const unresolved = paidKobo - refundedKobo - offsetKobo;
  return { paidKobo, refundedKobo, offsetKobo, unresolvedKobo: unresolved > 0n ? unresolved : 0n };
}

/**
 * What a remittance owes once offsets are set against it: its amount less the offsets. A payment
 * is then compared with this (paid, part paid, overpaid), and what's outstanding is the gap.
 */
export function dueAfterOffsets(amountKobo: Kobo, offsetsInKobo: Kobo): Kobo {
  const due = amountKobo - offsetsInKobo;
  return due > 0n ? due : 0n;
}

/**
 * The most that can still be offset from a payment against a target: the payment's unresolved
 * amount, capped by what the target still owes (its amount less offsets in and any payment).
 */
export function maxOffset(
  source: PaymentResolution,
  target: { amountKobo: Kobo; offsetsInKobo: Kobo; paidKobo: Kobo | null },
): Kobo {
  const left = target.amountKobo - target.offsetsInKobo - (target.paidKobo ?? 0n);
  const room = left > 0n ? left : 0n;
  return source.unresolvedKobo < room ? source.unresolvedKobo : room;
}

/** The refusal for an amount that can't be resolved, or null. */
export function resolutionRefusal(
  kind: Resolution["kind"],
  amountKobo: Kobo,
  source: PaymentResolution,
  targetRoomKobo?: Kobo,
): string | null {
  if (amountKobo <= 0n) return "Enter an amount above ₦0.";
  if (amountKobo > source.unresolvedKobo) return "That is more than the payment still to resolve.";
  if (kind === "offset" && targetRoomKobo !== undefined && amountKobo > targetRoomKobo) {
    return "That is more than the later remittance still owes.";
  }
  return null;
}
