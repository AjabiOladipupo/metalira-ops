/**
 * Strips personal data and secrets from Sentry events before they leave the process (rule 9).
 * Shared by the browser and server Sentry configs, so it must stay free of Node-only imports.
 */

export const FILTERED = "[Filtered]";

/**
 * Request headers that never leave the process. Any header whose name passes `isSensitiveKey`
 * (for example `x-supabase-auth` or `x-api-token`) is filtered too.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "apikey",
  "x-debug-token",
  "x-api-key",
  "verif-hash",
  "flutterwave-signature",
  // Client IP and location. Location is collected only with recorded consent (rule 9).
  "forwarded",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
]);

/** Header name patterns that carry client IP or location: `*-forwarded-for`, `x-vercel-ip-*`. */
const SENSITIVE_HEADER_PATTERN = /(forwarded-for$|^x-vercel-ip-|^x-geo-)/;

/** Key parts (snake_case after splitting camelCase) that mark a value as sensitive. */
const SENSITIVE_KEY =
  /(^|_)(nin|bvn|pin|pin_hash|rsa_pin|password|passwd|passcode|secret|token|token_hash|api_key|apikey|auth|authorization|cookie|account_number|account_no|bank_account|nuban|otp)(_|$)/;

/** Encrypted columns end in `_enc` and are never sent, even as ciphertext. */
const ENCRYPTED_KEY = /_enc$/;

/** Keys whose value is a URL: the query string is stripped, as it can carry filters and tokens. */
const URL_KEY = /^(url|http_url|url_full|http_target|from|to|href)$/;

/** Keys whose value is a bare query string: dropped entirely. */
const QUERY_KEY = /^(query|query_string|http_query|url_query)$/;

/** RSA PIN: `PEN` followed by 12 digits. Matched before digit runs so the prefix goes too. */
const RSA_PIN = /PEN\d{12}(?!\d)/gi;

/**
 * Runs of 10 or more digits: NUBAN account numbers, NIN, BVN, Nigerian phone numbers and anything
 * longer. Redacted from free text such as error messages and breadcrumbs.
 */
const LONG_DIGITS = /(?<!\d)(?:\+?234\d{10}|\d{10,})(?!\d)/g;

/**
 * Runs of 64 or more hex characters: raw invite tokens (`/m/invite/<64 hex>`, slice 1.9), token
 * hashes and other key material. The token sits in the URL path, so stripping query strings is not
 * enough. Trace ids (32) and span ids (16) are shorter and stay. A run glued to other hex (such as
 * `%22<token>` in an encoded header) is redacted whole.
 */
const HEX_SECRET = /(?<![0-9a-f])[0-9a-f]{64,}(?![0-9a-f])/gi;

/** Email addresses in free text. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * The query string of a URL or path inside free text, such as a span description
 * (`GET https://x.supabase.co/rest/v1/people?email=eq.a`). Keeps everything up to the `?`.
 */
const URL_QUERY = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?#"'<>]*)\?[^\s#"'<>]*/gi;

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
  return text
    .replace(HEX_SECRET, FILTERED)
    .replace(URL_QUERY, `$1?${FILTERED}`)
    .replace(RSA_PIN, FILTERED)
    .replace(LONG_DIGITS, FILTERED)
    .replace(EMAIL, FILTERED);
}

/**
 * Redacts tokens in the path (invite links: `/m/invite/<token>`) and strips the query string, which
 * can carry tokens (password reset links) and filters.
 */
export function scrubUrl(url: string): string {
  const path = url.replace(HEX_SECRET, FILTERED);
  const q = path.indexOf("?");
  return q === -1 ? path : `${path.slice(0, q)}?${FILTERED}`;
}

/**
 * Returns a copy of `value` with sensitive keys replaced, URL-valued keys stripped of their query
 * string and query-valued keys dropped. With `text` on (the default), free text inside strings is
 * redacted too; turn it off for SDK metadata such as trace ids.
 */
export function scrubValue(value: unknown, { text = true } = {}, depth = 0): unknown {
  if (typeof value === "string") return text ? scrubText(value) : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, { text }, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const k = normaliseKey(key);
    if (isSensitiveKey(key) || (QUERY_KEY.test(k) && inner != null && inner !== "")) {
      out[key] = FILTERED;
    } else if (URL_KEY.test(k) && typeof inner === "string") {
      out[key] = scrubUrl(text ? scrubText(inner) : inner);
    } else {
      out[key] = scrubValue(inner, { text }, depth + 1);
    }
  }
  return out;
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_HEADERS.has(lower) || SENSITIVE_HEADER_PATTERN.test(lower) || isSensitiveKey(name)
  );
}

/** Headers whose value is a URL of the page the request came from, which can hold an invite token. */
const URL_HEADERS = new Set(["referer", "referrer", "next-url"]);

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (isSensitiveHeader(name)) out[name] = FILTERED;
    else if (URL_HEADERS.has(lower) && typeof value === "string") out[name] = scrubUrl(value);
    // Other headers (such as Next's encoded router state) can still carry the path's token.
    else out[name] = typeof value === "string" ? value.replace(HEX_SECRET, FILTERED) : value;
  }
  return out;
}

type Data = Record<string, unknown>;

/** The parts of a Sentry event this scrubber touches. Structural, so it accepts ErrorEvent and TransactionEvent. */
type ScrubbableEvent = {
  message?: string;
  transaction?: string;
  logentry?: { message?: string; params?: unknown[] };
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
    data?: unknown;
    env?: unknown;
  };
  user?: unknown;
  extra?: Data;
  contexts?: Data;
  tags?: Data;
  exception?: {
    values?: Array<{
      value?: string;
      mechanism?: { data?: Data };
      stacktrace?: { frames?: Array<{ vars?: Data }> };
    }>;
  };
  breadcrumbs?: Array<{ message?: string; data?: Data }>;
  spans?: Array<{ description?: string; data?: Data }>;
};

export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.message) event.message = scrubText(event.message);
  if (event.transaction) event.transaction = scrubUrl(scrubText(event.transaction));
  if (event.logentry) {
    const { message, params } = event.logentry;
    if (message) event.logentry.message = scrubText(message);
    if (params) event.logentry.params = scrubValue(params) as unknown[];
  }

  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.env;
    // Bodies arrive as raw strings (JSON, urlencoded, multipart) that key scrubbing cannot reach,
    // and they hold passwords, PINs and identity numbers. Never send them.
    delete request.data;
    if (request.query_string !== undefined) request.query_string = FILTERED;
    if (request.url) request.url = scrubUrl(request.url);
    if (request.headers) request.headers = scrubHeaders(request.headers);
  }

  // sendDefaultPii is off, but keep only an id if anything sets a user.
  if (event.user && typeof event.user === "object" && "id" in event.user) {
    event.user = { id: (event.user as { id: unknown }).id };
  } else if (event.user) {
    delete event.user;
  }

  if (event.extra) event.extra = scrubValue(event.extra) as Data;
  // Contexts and tags hold SDK metadata (trace and span ids), so scrub by key only.
  if (event.contexts) event.contexts = scrubValue(event.contexts, { text: false }) as Data;
  if (event.tags) event.tags = scrubValue(event.tags, { text: false }) as Data;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    if (exception.mechanism?.data) {
      exception.mechanism.data = scrubValue(exception.mechanism.data) as Data;
    }
    // Local variables (only present if includeLocalVariables is ever turned on) are never sent.
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }

  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubText(crumb.message);
    if (crumb.data) crumb.data = scrubValue(crumb.data) as Data;
  }

  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubText(span.description);
    if (span.data) span.data = scrubValue(span.data) as Data;
  }

  return event;
}
