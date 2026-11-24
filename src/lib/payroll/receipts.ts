/**
 * Remittance receipts (slice 5.6): the bucket, the limits and the file checks the browser and the
 * server share. Isomorphic. The checks are the contract documents' (slice 2.6): PDF, PNG or JPEG
 * by its magic bytes, 10 MB or less. The browser checks the name and size first to save a wasted
 * upload; the server checks the uploaded bytes again before the receipt counts.
 */
export {
  DOCUMENT_ACCEPT as RECEIPT_ACCEPT,
  DOCUMENT_TYPES as RECEIPT_TYPES,
  DOCUMENT_TYPE_HINT as RECEIPT_TYPE_HINT,
  MAX_DOCUMENT_BYTES as MAX_RECEIPT_BYTES,
  checkChosenFile as checkChosenReceipt,
  checkUploadedBytes as checkUploadedReceipt,
  extensionOf as receiptExtensionOf,
  type DocumentExt as ReceiptExt,
} from "@/lib/contract-documents";

/** The private bucket for receipts (migration 20261122160000). */
export const PAYROLL_EVIDENCE_BUCKET = "payroll-evidence";

/** The private bucket for payroll files: bank files (5.4) and statutory schedules (5.6). */
export const PAYROLL_FILES_BUCKET = "payroll-files";

/** How long a link to a schedule or a receipt lasts (docs/PHASE_5.md "Bank file and schedules"). */
export const PAYROLL_LINK_SECONDS = 60;
