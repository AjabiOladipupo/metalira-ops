import { scrubEvent } from "./scrub";

/**
 * Sentry options shared by the browser and the Node server.
 * Error monitoring plus 10% of traces. No session replay and no default PII (rule 9).
 */
export function sharedSentryOptions(environment: string | undefined) {
  return {
    environment: environment ?? "development",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}
