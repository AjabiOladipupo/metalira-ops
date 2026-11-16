import "server-only";

import { inflateRawSync } from "node:zlib";

/**
 * Zip-bomb guard for `.xlsx` uploads. An `.xlsx` file is a zip archive; a few kilobytes of
 * deflated XML can expand to gigabytes. Before the spreadsheet parser sees the file, this walks
 * the archive and inflates every entry with Node's own zlib under a hard output cap, so the real
 * (not the declared) expanded size is checked.
 *
 * It also requires the local entries to sit back to back from byte 0 up to the central
 * directory, exactly as the central directory lists them, so a streaming unzipper can't find an
 * entry this check didn't see.
 */

export interface ZipLimits {
  maxEntries: number;
  maxExpandedBytes: number;
}

export type ZipCheck =
  | { ok: true; expandedBytes: number }
  | { ok: false; reason: "not_zip" | "unsupported" | "too_large" };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;

interface Entry {
  method: number;
  flags: number;
  compressedSize: number;
  localOffset: number;
}

function findEndOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of up to 65,535 bytes.
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

export function checkZipArchive(bytes: Uint8Array, limits: ZipLimits): ZipCheck {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22) return { ok: false, reason: "not_zip" };
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) return { ok: false, reason: "not_zip" };

  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  // Zip64 markers: an import file never needs them.
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return { ok: false, reason: "unsupported" };
  }
  if (entryCount === 0 || entryCount > limits.maxEntries) {
    return { ok: false, reason: entryCount === 0 ? "not_zip" : "too_large" };
  }
  if (centralOffset + centralSize > eocd) return { ok: false, reason: "not_zip" };

  const entries: Entry[] = [];
  let cursor = centralOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      return { ok: false, reason: "not_zip" };
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags & 0x1) return { ok: false, reason: "unsupported" }; // encrypted
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return { ok: false, reason: "unsupported" };
    }
    entries.push({ method, flags, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  entries.sort((a, b) => a.localOffset - b.localOffset);
  let expected = 0;
  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.localOffset !== expected) return { ok: false, reason: "not_zip" };
    const local = entry.localOffset;
    if (local + 30 > centralOffset || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
      return { ok: false, reason: "not_zip" };
    }
    const dataStart =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > centralOffset) return { ok: false, reason: "not_zip" };

    const remaining = limits.maxExpandedBytes - expandedBytes;
    if (entry.method === 0) {
      expandedBytes += entry.compressedSize;
    } else if (entry.method === 8) {
      try {
        const out = inflateRawSync(bytes.subarray(dataStart, dataEnd), {
          maxOutputLength: Math.max(1, remaining + 1),
        });
        expandedBytes += out.byteLength;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE") return { ok: false, reason: "too_large" };
        return { ok: false, reason: "not_zip" };
      }
    } else {
      return { ok: false, reason: "unsupported" };
    }
    if (expandedBytes > limits.maxExpandedBytes) return { ok: false, reason: "too_large" };

    expected = dataEnd;
    if (entry.flags & 0x8) {
      // Optional data descriptor: [signature] crc32, compressed size, uncompressed size.
      const hasSignature =
        expected + 4 <= centralOffset && view.getUint32(expected, true) === DESCRIPTOR_SIGNATURE;
      expected += hasSignature ? 16 : 12;
    }
  }
  if (expected !== centralOffset) return { ok: false, reason: "not_zip" };
  return { ok: true, expandedBytes };
}
