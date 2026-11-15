import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "@/lib/crypto/constant-time";

describe("constantTimeEqual", () => {
  it("is true for equal strings", () => {
    expect(constantTimeEqual("s3cret-hash", "s3cret-hash")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("₦ unicode ✓", "₦ unicode ✓")).toBe(true);
  });

  it("is false for unequal, different-length or empty-vs-nonempty strings", () => {
    expect(constantTimeEqual("s3cret-hash", "s3cret-hasH")).toBe(false);
    expect(constantTimeEqual("short", "a much longer value")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("x", "")).toBe(false);
  });

  it("does not throw on a length mismatch", () => {
    expect(() => constantTimeEqual("a", "ab")).not.toThrow();
  });
});
