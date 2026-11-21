import { describe, expect, it } from "vitest";

import {
  MAX_SELFIE_BYTES,
  scaledSize,
  selfiePath,
  selfieProblem,
  sniffSelfie,
} from "@/lib/punches/image-bytes";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const riffWave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);

describe("selfie bytes", () => {
  it("knows JPEG and WebP by their magic bytes", () => {
    expect(sniffSelfie(jpeg)).toBe("jpg");
    expect(sniffSelfie(webp)).toBe("webp");
  });

  it("refuses anything else, whatever it is called", () => {
    expect(sniffSelfie(png)).toBeNull();
    expect(sniffSelfie(riffWave)).toBeNull();
    expect(sniffSelfie(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(sniffSelfie(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("refuses empty and oversized files", () => {
    expect(selfieProblem(new Uint8Array())).toBe("empty");
    const big = new Uint8Array(MAX_SELFIE_BYTES + 1);
    big.set(jpeg);
    expect(selfieProblem(big)).toBe("too_big");
    const max = new Uint8Array(MAX_SELFIE_BYTES);
    max.set(jpeg);
    expect(selfieProblem(max)).toBeNull();
    expect(selfieProblem(png)).toBe("not_image");
  });

  it("scales the longer side to 480 px and never up", () => {
    expect(scaledSize(1280, 960)).toEqual({ width: 480, height: 360 });
    expect(scaledSize(720, 1280)).toEqual({ width: 270, height: 480 });
    expect(scaledSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(scaledSize(0, 100)).toEqual({ width: 0, height: 0 });
  });

  it("puts a selfie at {organisation}/{yyyy-mm UTC}/{punch}.{ext}", () => {
    expect(
      selfiePath({
        organisationId: "o",
        punchId: "p",
        createdAt: "2026-11-30T23:30:00Z",
        ext: "webp",
      }),
    ).toBe("o/2026-11/p.webp");
  });
});
