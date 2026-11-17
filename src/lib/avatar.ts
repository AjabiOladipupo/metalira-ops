import "server-only";

import { openPeeps } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";

/**
 * Worker avatars before a photo is uploaded (DESIGN_SYSTEM.md "Illustrations"): the DiceBear
 * `open-peeps` style seeded by worker id, so every worker keeps the same face everywhere.
 * Rendered on the server with no network calls; black ink on white, inverted in dark mode by
 * <WorkerAvatar>.
 *
 * Licences: DiceBear code is MIT; the Open Peeps artwork (Pablo Stanley) is CC0.
 */

// Hair that reads like Metalira's users: coils, locs, braids, close crops, wraps.
const HEADS = [
  "afro",
  "bantuKnots",
  "bun",
  "buns",
  "cornrows",
  "cornrows2",
  "dreads1",
  "dreads2",
  "flatTop",
  "hijab",
  "longAfro",
  "noHair1",
  "noHair2",
  "noHair3",
  "shaved1",
  "shaved2",
  "shaved3",
  "short1",
  "short2",
  "short3",
  "short4",
  "short5",
  "turban",
  "twists",
  "twists2",
] as const;

// Calm, friendly expressions only: no anger, fear or monsters on a staff list.
const FACES = [
  "calm",
  "cute",
  "smile",
  "smileBig",
  "smileTeethGap",
  "driven",
  "explaining",
  "lovingGrin1",
  "cheeky",
] as const;

const GLASSES = ["glasses", "glasses2", "glasses3", "glasses4", "glasses5"] as const;

const INK_OPTIONS = {
  head: [...HEADS],
  face: [...FACES],
  accessories: [...GLASSES],
  accessoriesProbability: 15,
  facialHairProbability: 15,
  maskProbability: 0,
  // White skin and clothes, ink hair: black ink on white, like the scenes.
  skinColor: ["ffffff"],
  clothingColor: ["ffffff"],
  headContrastColor: ["0a0a0a"],
  backgroundColor: ["ffffff"],
  radius: 50,
};

const cache = new Map<string, string>();
const CACHE_LIMIT = 1000;

/** An `data:image/svg+xml` URI for the worker's avatar. Same id, same face, every time. */
export function workerAvatarUri(workerId: string): string {
  const hit = cache.get(workerId);
  if (hit) return hit;
  const uri = createAvatar(openPeeps, { seed: workerId, ...INK_OPTIONS }).toDataUri();
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(workerId, uri);
  return uri;
}
