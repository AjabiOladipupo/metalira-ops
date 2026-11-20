/**
 * Slice 2.6: the checks contract documents rely on. The type comes from the file's own first
 * bytes (magic numbers), never its name or the browser's MIME type; names are cleaned before
 * they are stored or offered as a download name; size and type limits; the compact summary.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_BYTES,
  checkChosenFile,
  checkUploadedBytes,
  extensionOf,
  formatFileSize,
  sanitiseFileName,
  sniffDocumentType,
  titleFromFileName,
} from "@/lib/contract-documents";
import {
  removeContractDocumentSchema,
  startContractDocumentSchema,
} from "@/server/business/contract-documents";
import { summariseContractDocuments } from "@/server/business/contract-documents-data";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

const PDF = text("%PDF-1.7\n%âãÏÓ\n1 0 obj");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46);

describe("sniffDocumentType", () => {
  it("knows PDF, PNG and JPEG by their first bytes", () => {
    expect(sniffDocumentType(PDF)).toBe("pdf");
    expect(sniffDocumentType(PNG)).toBe("png");
    expect(sniffDocumentType(JPEG)).toBe("jpg");
  });

  it("refuses everything else, however it is named", () => {
    expect(sniffDocumentType(text("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffDocumentType(text("<?xml version='1.0'?><svg/>"))).toBeNull();
    // DOCX and every other zip.
    expect(sniffDocumentType(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0))).toBeNull();
    // Windows executable.
    expect(sniffDocumentType(bytes(0x4d, 0x5a, 0x90, 0))).toBeNull();
    // GIF.
    expect(sniffDocumentType(text("GIF89a"))).toBeNull();
    expect(sniffDocumentType(new Uint8Array())).toBeNull();
  });

  it("needs the whole signature, not a prefix of it", () => {
    expect(sniffDocumentType(text("%PDF"))).toBeNull();
    expect(sniffDocumentType(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(sniffDocumentType(bytes(0xff, 0xd8))).toBeNull();
    // A PDF marker later in the file doesn't count.
    expect(sniffDocumentType(text(" %PDF-1.7"))).toBeNull();
  });
});

describe("checkUploadedBytes", () => {
  it("accepts a file whose bytes match its name", () => {
    expect(checkUploadedBytes(PDF, "pdf")).toEqual({
      ok: true,
      ext: "pdf",
      mime: "application/pdf",
    });
    expect(checkUploadedBytes(JPEG, "jpg")).toEqual({ ok: true, ext: "jpg", mime: "image/jpeg" });
  });

  it("refuses a renamed file", () => {
    const html = checkUploadedBytes(text("<html>"), "pdf");
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.message).toMatch(/isn't a PDF, PNG or JPEG/);
    const png = checkUploadedBytes(PNG, "pdf");
    expect(png.ok).toBe(false);
    if (!png.ok)
      expect(png.message).toBe("That file is a PNG, not a PDF. Rename it or choose another.");
  });

  it("refuses empty and oversized files", () => {
    expect(checkUploadedBytes(new Uint8Array(), "pdf").ok).toBe(false);
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(PDF);
    expect(checkUploadedBytes(big, "pdf").ok).toBe(false);
    const limit = new Uint8Array(MAX_DOCUMENT_BYTES);
    limit.set(PDF);
    expect(checkUploadedBytes(limit, "pdf").ok).toBe(true);
  });
});

describe("checkChosenFile", () => {
  it("allows PDF, PNG and JPEG up to 10 MB", () => {
    expect(checkChosenFile({ name: "contract.PDF", size: 1 })).toEqual({
      ok: true,
      ext: "pdf",
      mime: "application/pdf",
    });
    expect(checkChosenFile({ name: "scan.jpeg", size: MAX_DOCUMENT_BYTES })).toMatchObject({
      ok: true,
      ext: "jpg",
    });
  });

  it("refuses other types, empty files and files over 10 MB", () => {
    expect(checkChosenFile({ name: "contract.docx", size: 10 }).ok).toBe(false);
    expect(checkChosenFile({ name: "contract.pdf.exe", size: 10 }).ok).toBe(false);
    expect(checkChosenFile({ name: "contract", size: 10 }).ok).toBe(false);
    expect(checkChosenFile({ name: "contract.pdf", size: 0 }).ok).toBe(false);
    expect(checkChosenFile({ name: "contract.pdf", size: MAX_DOCUMENT_BYTES + 1 }).ok).toBe(false);
  });
});

describe("extensionOf", () => {
  it("reads the last extension only", () => {
    expect(extensionOf("a.pdf")).toBe("pdf");
    expect(extensionOf("a.JPG")).toBe("jpg");
    expect(extensionOf("a.exe.pdf")).toBe("pdf");
    expect(extensionOf("a.pdf.html")).toBeNull();
    expect(extensionOf("pdf")).toBeNull();
  });
});

describe("sanitiseFileName", () => {
  it("keeps an ordinary name", () => {
    expect(sanitiseFileName("Coastline contract (signed).pdf", "pdf")).toBe(
      "Coastline contract (signed).pdf",
    );
  });

  it("drops paths, control characters and characters that break headers or file systems", () => {
    expect(sanitiseFileName("C:\\Users\\ada\\Desktop\\contract.pdf", "pdf")).toBe("contract.pdf");
    expect(sanitiseFileName("../../etc/passwd.pdf", "pdf")).toBe("passwd.pdf");
    expect(sanitiseFileName('con"tract<script>\r\n.pdf', "pdf")).toBe("contractscript.pdf");
    expect(sanitiseFileName("a:b*c?d|e.pdf", "pdf")).toBe("abcde.pdf");
    expect(sanitiseFileName("bill\u202Efdp.exe", "pdf")).toBe("billfdp.pdf");
  });

  it("puts the real extension on, whatever the name said", () => {
    expect(sanitiseFileName("scan.jpeg", "jpg")).toBe("scan.jpg");
    expect(sanitiseFileName("report.pdf", "png")).toBe("report.png");
  });

  it("never leaves a hidden or empty name", () => {
    expect(sanitiseFileName("...pdf", "pdf")).toBe("document.pdf");
    expect(sanitiseFileName(".htaccess.pdf", "pdf")).toBe("htaccess.pdf");
    expect(sanitiseFileName("   .pdf", "pdf")).toBe("document.pdf");
  });

  it("caps the length at 120 characters, extension kept", () => {
    const name = sanitiseFileName(`${"a".repeat(300)}.pdf`, "pdf");
    expect(name).toHaveLength(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("meets the database's file name check", () => {
    const dbCheck = (n: string) =>
      n === n.trim() &&
      n.length >= 1 &&
      n.length <= 120 &&
      !/[\x01-\x1f\x7f-\x9f<>"\\/:*?|]/.test(n) &&
      !n.startsWith(".");
    for (const raw of ["a.pdf", '"<>.pdf', "x".repeat(500), "  \t lead.pdf", "...", "/\\"]) {
      expect(dbCheck(sanitiseFileName(raw, "pdf")), raw).toBe(true);
    }
  });
});

describe("titleFromFileName", () => {
  it("turns a file name into a readable title", () => {
    expect(titleFromFileName("coastline_signed-contract.pdf")).toBe("coastline signed contract");
    expect(titleFromFileName(".pdf")).toBe("Document");
    expect(titleFromFileName("see www.example.com.pdf")).not.toMatch(/www\./);
  });
});

describe("formatFileSize", () => {
  it("shows bytes, KB and MB", () => {
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(512)).toBe("512 bytes");
    expect(formatFileSize(850_000)).toBe("830 KB");
    expect(formatFileSize(2_500_000)).toBe("2.4 MB");
  });
});

describe("schemas", () => {
  const contractId = "6f1d3f38-8a3c-4c43-9a8c-1d7f0b3c2a11";

  it("takes a start with a blank title", () => {
    const parsed = startContractDocumentSchema.parse({
      contractId,
      kind: "signed_contract",
      title: "",
      fileName: "contract.pdf",
      size: "2048",
    });
    expect(parsed).toMatchObject({ title: "", size: 2048 });
  });

  it("refuses an unknown kind, a type outside the list, a web address and an oversized file", () => {
    const base = { contractId, kind: "sla", title: "SLA", fileName: "sla.pdf", size: 10 };
    expect(startContractDocumentSchema.safeParse({ ...base, kind: "invoice" }).success).toBe(false);
    expect(startContractDocumentSchema.safeParse({ ...base, fileName: "sla.docx" }).success).toBe(
      false,
    );
    expect(
      startContractDocumentSchema.safeParse({ ...base, title: "See https://evil.test" }).success,
    ).toBe(false);
    expect(
      startContractDocumentSchema.safeParse({ ...base, size: MAX_DOCUMENT_BYTES + 1 }).success,
    ).toBe(false);
    expect(startContractDocumentSchema.safeParse({ ...base, size: 0 }).success).toBe(false);
  });

  it("needs a reason to remove", () => {
    const documentId = contractId;
    expect(removeContractDocumentSchema.safeParse({ documentId, reason: "  " }).success).toBe(
      false,
    );
    expect(
      removeContractDocumentSchema.safeParse({ documentId, reason: "Unsigned draft" }).success,
    ).toBe(true);
  });
});

describe("summariseContractDocuments", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  it("counts documents by kind and finds contracts with no signed contract", () => {
    const summary = summariseContractDocuments(
      {
        contracts: [
          { id: "c1", reference: "CTR-0001", status: "active" },
          { id: "c2", reference: "CTR-0002", status: "active" },
          { id: "c3", reference: "CTR-0003", status: "draft" },
          { id: "c4", reference: "CTR-0004", status: "ended" },
        ],
        documents: [
          { contractId: "c1", kind: "signed_contract", status: "active", removedAt: null },
          { contractId: "c1", kind: "sla", status: "active", removedAt: null },
          // A removed signed contract doesn't count as on file.
          {
            contractId: "c2",
            kind: "signed_contract",
            status: "removed",
            removedAt: "2026-11-10T09:00:00Z",
          },
          {
            contractId: "c3",
            kind: "insurance",
            status: "removed",
            removedAt: "2026-09-01T09:00:00Z",
          },
        ],
      },
      now,
    );
    expect(summary).toEqual({
      active: 2,
      byKind: { signed_contract: 1, sla: 1 },
      removedLast30Days: 1,
      activeWithoutSignedContract: 1,
      activeWithoutSignedContractRefs: ["CTR-0002"],
      draftWithoutSignedContract: 1,
    });
  });
});
