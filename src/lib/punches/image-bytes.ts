/**
 * Selfie bytes (slice 3.5): what the server accepts into the punch-photos bucket. The type comes
 * from the file's own first bytes, never its name or the browser's MIME type. Isomorphic.
 */

/** The bucket's limit (migration 20261120190000). The phone aims for about 35 KB. */
export const MAX_SELFIE_BYTES = 200 * 1024;
/** The longer side of the photo the phone sends, in pixels. */
export const SELFIE_MAX_SIDE = 480;

export type SelfieExt = "webp" | "jpg";

export const SELFIE_MIME: Record<SelfieExt, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
};

/** The selfie's type from its magic bytes, or null when it is neither WebP nor JPEG. */
export function sniffSelfie(bytes: Uint8Array): SelfieExt | null {
  // JPEG: FF D8 FF.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  // WebP: "RIFF" <size> "WEBP".
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

/** Why the server refuses these bytes, or null when they are a selfie it takes. */
export function selfieProblem(bytes: Uint8Array): "empty" | "too_big" | "not_image" | null {
  if (bytes.length === 0) return "empty";
  if (bytes.length > MAX_SELFIE_BYTES) return "too_big";
  return sniffSelfie(bytes) ? null : "not_image";
}

/** The width and height to draw a photo at, the longer side at most `maxSide`. */
export function scaledSize(
  width: number,
  height: number,
  maxSide: number = SELFIE_MAX_SIDE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The storage path of a punch's selfie: {organisation}/{yyyy-mm of created_at, UTC}/{punch}.{ext}. */
export function selfiePath(input: {
  organisationId: string;
  punchId: string;
  createdAt: string;
  ext: SelfieExt;
}): string {
  const month = new Date(input.createdAt).toISOString().slice(0, 7);
  return `${input.organisationId}/${month}/${input.punchId}.${input.ext}`;
}
