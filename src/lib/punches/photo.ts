import { MAX_SELFIE_BYTES, SELFIE_MAX_SIDE, scaledSize } from "./image-bytes";

/**
 * Makes the small selfie the phone queues (slice 3.5): the longer side 480 px, WebP at about
 * 35 KB where the browser can encode it (Chrome, Android), JPEG otherwise (older Safari). Never
 * over the bucket's 200 KB. Browser only.
 */

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Draws `source` at selfie size and encodes it. Null when the browser can't make one small enough. */
export async function compressSelfie(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob | null> {
  const size = scaledSize(width, height, SELFIE_MAX_SIDE);
  if (size.width === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, size.width, size.height);

  for (const quality of [0.6, 0.45, 0.3]) {
    let blob = await toBlob(canvas, "image/webp", quality);
    // A browser without a WebP encoder hands back PNG: use JPEG instead.
    if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality + 0.1);
    if (blob && (blob.type === "image/webp" || blob.type === "image/jpeg") && blob.size <= MAX_SELFIE_BYTES) {
      return blob;
    }
  }
  return null;
}

/** A selfie from a picked or captured file (the camera app fallback). */
export async function compressSelfieFile(file: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      return await compressSelfie(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}
