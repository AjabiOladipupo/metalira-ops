import http from "node:http";
import https from "node:https";

import { afterEach, describe, expect, it, vi } from "vitest";

import { workerAvatarUri } from "@/lib/avatar";

const ID_A = "0b6f2a5e-8d1c-4f3e-9a7b-1c2d3e4f5a6b";
const ID_B = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

function decode(uri: string): string {
  const [head, body] = uri.split(",", 2);
  expect(head).toMatch(/^data:image\/svg\+xml/);
  return head!.endsWith(";base64")
    ? Buffer.from(body!, "base64").toString()
    : decodeURIComponent(body!);
}

afterEach(() => vi.restoreAllMocks());

describe("worker avatars", () => {
  it("gives the same face for the same worker id", () => {
    const first = workerAvatarUri(ID_A);
    expect(workerAvatarUri(ID_A)).toBe(first);
    expect(workerAvatarUri(ID_B)).not.toBe(first);
  });

  it("draws the same face again from scratch (not only from the cache)", async () => {
    const first = workerAvatarUri(ID_A);
    vi.resetModules();
    const fresh = await import("@/lib/avatar");
    expect(fresh.workerAvatarUri(ID_A)).toBe(first);
  });

  it("is an SVG data URI in black ink on white", () => {
    const svg = decode(workerAvatarUri(ID_B));
    expect(svg).toMatch(/^<svg /);
    // Skin, clothes and background are white; nothing in the default skin or clothing colours.
    expect(svg).not.toMatch(/#(ffdbb4|edb98a|d08b5b|ae5d29|694d3d|e78276|ffcf77|8fa7df)/i);
  });

  it("renders without any network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const httpSpy = vi.spyOn(http, "request");
    const httpsSpy = vi.spyOn(https, "request");
    for (let i = 0; i < 20; i++) workerAvatarUri(`worker-${i}-${ID_A}`);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });
});
