/** Shared by the page and the service worker (src/sw/sw.ts), which must not bundle Dexie. */

/** Background Sync tag the page registers when it queues an event. */
export const BACKGROUND_SYNC_TAG = "metalira-queue";
/** Message the service worker posts to open pages when Background Sync fires. */
export const DRAIN_MESSAGE = "metalira:drain";
