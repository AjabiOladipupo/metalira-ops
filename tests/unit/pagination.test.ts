import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  formatPageRange,
  linkPageSize,
  pageWindow,
  parsePage,
  parsePageSize,
} from "../../src/lib/pagination";

describe("parsePageSize", () => {
  it("accepts only the offered sizes", () => {
    for (const size of PAGE_SIZES) expect(parsePageSize(String(size))).toBe(size);
    expect(parsePageSize(" 50 ")).toBe(50);
  });

  it("rejects anything else", () => {
    for (const value of [undefined, null, "", "0", "10", "500", "25.5", "-25", "abc", "1e2"]) {
      expect(parsePageSize(value)).toBeNull();
    }
  });

  it("defaults to 25", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
  });
});

describe("parsePage", () => {
  it("reads a positive whole number", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage(" 12 ")).toBe(12);
  });

  it("falls back to page 1", () => {
    for (const value of [undefined, null, "", "0", "-2", "1.5", "two", "9999999"]) {
      expect(parsePage(value)).toBe(1);
    }
  });
});

describe("pageWindow", () => {
  it("slices the first page", () => {
    expect(pageWindow(162, 1, 25)).toEqual({
      page: 1,
      pageCount: 7,
      size: 25,
      total: 162,
      from: 0,
      to: 25,
      hasPrevious: false,
      hasNext: true,
    });
  });

  it("stops the last page at the total", () => {
    const last = pageWindow(162, 7, 25);
    expect([last.from, last.to, last.hasPrevious, last.hasNext]).toEqual([150, 162, true, false]);
  });

  it("clamps a page past the end to the last page", () => {
    const window = pageWindow(162, 40, 50);
    expect([window.page, window.pageCount, window.from, window.to]).toEqual([4, 4, 150, 162]);
  });

  it("treats an exact multiple as full pages", () => {
    expect(pageWindow(200, 2, 100)).toMatchObject({ pageCount: 2, from: 100, to: 200 });
    expect(pageWindow(200, 1, 200)).toMatchObject({ pageCount: 1, hasNext: false });
  });

  it("gives an empty list one empty page", () => {
    expect(pageWindow(0, 3, 25)).toMatchObject({
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
      hasPrevious: false,
      hasNext: false,
    });
  });
});

describe("formatPageRange", () => {
  it("reads numbers first with an en dash", () => {
    expect(formatPageRange(pageWindow(162, 1, 25))).toBe("1–25 of 162");
    expect(formatPageRange(pageWindow(162, 7, 25))).toBe("151–162 of 162");
    expect(formatPageRange(pageWindow(1, 1, 25))).toBe("1–1 of 1");
  });

  it("groups thousands", () => {
    expect(formatPageRange(pageWindow(1250, 6, 200))).toBe("1,001–1,200 of 1,250");
  });

  it("handles an empty list", () => {
    expect(formatPageRange(pageWindow(0, 1, 25))).toBe("0 of 0");
  });
});

describe("linkPageSize", () => {
  it("always carries a size from the URL, even the default", () => {
    expect(linkPageSize(25, 25)).toBe(25);
    expect(linkPageSize(100, 100)).toBe(100);
  });

  it("carries a remembered non-default size", () => {
    expect(linkPageSize(null, 50)).toBe(50);
  });

  it("leaves out the default when it is not in the URL", () => {
    expect(linkPageSize(null, 25)).toBeNull();
  });
});
