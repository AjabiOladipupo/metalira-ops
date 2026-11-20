/**
 * Phone storage for the queue. Browsers may evict IndexedDB under storage pressure unless the
 * site's storage is persistent, so the app asks for persistence once a worker is signed in, and
 * warns when space is low so punches (and their photos) can still be saved.
 */

/** Warn below this much free space for the site... */
export const LOW_FREE_BYTES = 25 * 1024 * 1024;
/** ...or when this share of the site's quota is used. */
export const LOW_FREE_RATIO = 0.9;

/** True when the estimate says the queue may soon fail to save. Unknown numbers never warn. */
export function isStorageLow(estimate: { usage?: number; quota?: number } | null): boolean {
  if (!estimate) return false;
  const { usage, quota } = estimate;
  if (typeof usage !== "number" || typeof quota !== "number" || quota <= 0) return false;
  return quota - usage < LOW_FREE_BYTES || usage / quota >= LOW_FREE_RATIO;
}

/** Asks the browser to keep the site's storage. Resolves false where unsupported. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** The browser's storage estimate, or null where unsupported. */
export async function storageEstimate(): Promise<StorageEstimate | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
