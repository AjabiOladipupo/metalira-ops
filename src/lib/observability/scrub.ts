/**
 * Strips personal data and secrets from Sentry events before they leave the process (rule 9).
 * Shared by the browser and server Sentry configs, so it must stay free of Node-only imports.
 */

export const FILTERED = "[Filtered]";

/** Request headers that never leave the process. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-debug-token",
  "x-api-key",
  "verif-hash",
  "flutterwave-signature",
]);

/** Key parts (snake_case after splitting camelCase) that mark a value as sensitive. */
const SENSITIVE_KEY =
  /(^|_)(nin|bvn|pin|pin_hash|rsa_pin|password|passwd|passcode|secret|token|token_hash|api_key|apikey|authorization|cookie|account_number|account_no|bank_account|nuban|otp)(_|$)/;

/** Encrypted columns end in `_enc` and are never sent, even as ciphertext. */
const ENCRYPTED_KEY = /_enc$/;

/**
 * 10 or 11 digit runs: NUBAN account numbers, NIN, BVN and Nigerian phone numbers.
 * Redacted from free text such as error messages and breadcrumbs.
 */
const LONG_DIGITS = /(?<!\d)(?:\+?234\d{10}|\d{10,11})(?!\d)/g;

const MAX_DEPTH = 8;

export function normaliseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  return SENSITIVE_KEY.test(k) || ENCRYPTED_KEY.test(k);
}

export function scrubText(text: string): string {
  return text.replace(LONG_DIGITS, FILTERED);
}

/**
 * Returns a copy of `value` with sensitive keys replaced. With `text` on (the default), long digit
 * runs inside strings are redacted too; turn it off for SDK metadata such as trace ids.
 */
export function scrubValue(value: unknown, { text = true } = {}, depth = 0): unknown {
  if (typeof value === "string") return text ? scrubText(value) : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, { text }, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? FILTERED : scrubValue(inner, { text }, depth + 1);
  }
  return out;
}

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? FILTERED : value;
  }
  return out;
}

/** Strips the query string, which can carry tokens (password reset, invite links). */
function scrubUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?${FILTERED}`;
}

/** The parts of a Sentry event this scrubber touches. Structural, so it accepts ErrorEvent and TransactionEvent. */
type ScrubbableEvent = {
  message?: string;
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
    data?: unknown;
    env?: unknown;
  };
  user?: unknown;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
};

export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.message) event.message = scrubText(event.message);

  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.env;
    if (request.query_string !== undefined) request.query_string = FILTERED;
    if (request.url) request.url = scrubUrl(request.url);
    if (request.headers) request.headers = scrubHeaders(request.headers);
    if (request.data !== undefined) request.data = scrubValue(request.data);
  }

  // sendDefaultPii is off, but keep only an id if anything sets a user.
  if (event.user && typeof event.user === "object" && "id" in event.user) {
    event.user = { id: (event.user as { id: unknown }).id };
  } else if (event.user) {
    delete event.user;
  }

  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;
  // Contexts and tags hold SDK metadata (trace and span ids), so scrub by key only.
  if (event.contexts) {
    event.contexts = scrubValue(event.contexts, { text: false }) as Record<string, unknown>;
  }
  if (event.tags) event.tags = scrubValue(event.tags, { text: false }) as Record<string, unknown>;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
  }

  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubText(crumb.message);
    if (crumb.data) crumb.data = scrubValue(crumb.data) as Record<string, unknown>;
  }

  return event;
}
