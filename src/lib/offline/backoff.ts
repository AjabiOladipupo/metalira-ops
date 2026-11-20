/**
 * Exponential backoff for queue retries: 5 s, 10 s, 20 s ... capped at 15 minutes, with up to
 * 20% random jitter so a site full of phones coming back online does not retry in lockstep.
 * There is no attempt limit: a punch is never dropped for being slow to send.
 */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
const JITTER = 0.2;

/** Delay before the next try after `attempts` failures (1 or more). `random` is in [0, 1). */
export function backoffDelay(attempts: number, random: number = Math.random()): number {
  const n = Math.max(1, Math.floor(attempts));
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 30));
  const jitter = 1 - JITTER * Math.min(Math.max(random, 0), 1);
  return Math.round(exp * jitter);
}
