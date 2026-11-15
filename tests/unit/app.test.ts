import { describe, expect, it } from "vitest";
import { APP_NAME } from "@/lib/app";

describe("app", () => {
  it("resolves the @/ alias and exposes the product name", () => {
    expect(APP_NAME).toBe("Metalira Ops");
  });
});
