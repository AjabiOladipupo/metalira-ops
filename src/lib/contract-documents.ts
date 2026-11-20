/**
 * Contract documents (slice 2.6): the kinds, the limits and the checks the browser and the
 * server share. Isomorphic: imports nothing from src/server/. The browser checks first to save a
 * wasted upload; the server checks again from the file's own bytes before the document counts.
 */

/** The private Storage bucket (migration 20261119145000). */
export const CONTRACT_DOCS_BUCKET = "contract-docs";

/** The bucket's own limit is the same, so Storage refuses anything bigger too. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** How long a link to open a document lasts. */
export const SIGNED_URL_SECONDS = 60;

export const DOCUMENT_KINDS = [
  "signed_contract",
  "sla",
  "amendment",
  "purchase_order",
  "insurance",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  signed_contract: "Signed contract",
  sla: "SLA",
  amendment: "Amendment",
  purchase_order: "Purchase order",
  insurance: "Insurance",
  other: "Other",
};

export const DOCUMENT_TYPES = {
  pdf: { mime: "application/pdf", label: "PDF" },
  png: { mime: "image/png", label: "PNG" },
  jpg: { mime: "image/jpeg", label: "JPEG" },
} as const;
export type DocumentExt = keyof typeof DOCUMENT_TYPES;

/** For the file picker's `accept`. */
export const DOCUMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

export const DOCUMENT_TYPE_HINT = "PDF, PNG or JPEG, 10 MB or less.";

/** The type a file name claims, from its extension (`.jpeg` counts as jpg), or null. */
export function extensionOf(fileName: string): DocumentExt | null {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(fileName.trim());
  const ext = match?.[1]?.toLowerCase();
  if (ext === "pdf" || ext === "png" || ext === "jpg") return ext;
  if (ext === "jpeg") return "jpg";
  return null;
}

/**
 * The type a file really is, from its first bytes (magic numbers), or null when it is none of
 * the allowed ones. PDF starts `%PDF-`, PNG with its 8-byte signature, JPEG with FF D8 FF.
 */
export function sniffDocumentType(bytes: Uint8Array): DocumentExt | null {
  const starts = (sig: readonly number[]) =>
    bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpg";
  return null;
}

const MAX_NAME = 120;

/**
 * A file name safe to store, show and offer as a download name: the last path segment only,
 * without control characters, quotes, angle brackets or characters Windows refuses, spaces
 * collapsed, no leading dots, at most 120 characters with the extension kept. Falls back to
 * `document.<ext>` when nothing is left.
 */
export function sanitiseFileName(raw: string, ext: DocumentExt): string {
  const lastSegment = raw.split(/[\\/]/).pop() ?? "";
  let name = lastSegment
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}<>"\\/:*?|]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // Keep the real extension at the end, whatever the name said, and never a hidden name.
  name = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!name) name = "document";
  const suffix = `.${ext}`;
  if (name.length + suffix.length > MAX_NAME) {
    name = name.slice(0, MAX_NAME - suffix.length).trim();
  }
  return `${name}${suffix}`;
}

/** A title from a file name when the person leaves it blank: "Coastline signed contract". */
export function titleFromFileName(fileName: string): string {
  const base = fileName
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/[\p{Cc}<>]/gu, "")
    .replace(/(:\/\/|www\.)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (base || "Document").slice(0, 200).trim();
}

/** "2.4 MB", "830 KB", "512 bytes". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type FileCheck =
  { ok: true; ext: DocumentExt; mime: string } | { ok: false; message: string };

/** The browser's first check of a chosen file: its extension and size. */
export function checkChosenFile(file: { name: string; size: number }): FileCheck {
  const ext = extensionOf(file.name);
  if (!ext) return { ok: false, message: `Upload a PDF, PNG or JPEG file.` };
  if (file.size <= 0) return { ok: false, message: "The file is empty. Choose another." };
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, message: "The file is larger than 10 MB. Upload a smaller copy." };
  }
  return { ok: true, ext, mime: DOCUMENT_TYPES[ext].mime };
}

/** The server's check of the uploaded bytes against what the row says the file is. */
export function checkUploadedBytes(bytes: Uint8Array, expected: DocumentExt): FileCheck {
  if (bytes.length === 0) return { ok: false, message: "The file is empty. Choose another." };
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, message: "The file is larger than 10 MB. Upload a smaller copy." };
  }
  const actual = sniffDocumentType(bytes);
  if (!actual) {
    return {
      ok: false,
      message: "That file isn't a PDF, PNG or JPEG, whatever its name says. Choose another.",
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      message: `That file is a ${DOCUMENT_TYPES[actual].label}, not a ${DOCUMENT_TYPES[expected].label}. Rename it or choose another.`,
    };
  }
  return { ok: true, ext: actual, mime: DOCUMENT_TYPES[actual].mime };
}
