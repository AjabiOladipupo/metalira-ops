import { describe, expect, it } from "vitest";
import { emailAppUrl, isProductionEmailEnv, PRODUCTION_APP_URL } from "@/server/email/config";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("emailAppUrl", () => {
  it("falls back to the production URL", () => {
    expect(PRODUCTION_APP_URL).toBe("https://ops.metaliratech.com");
    expect(emailAppUrl(env({}))).toBe(PRODUCTION_APP_URL);
    expect(emailAppUrl(env({ NEXT_PUBLIC_APP_URL: "  " }))).toBe(PRODUCTION_APP_URL);
  });

  it("ignores a value that is not an absolute http(s) URL", () => {
    expect(emailAppUrl(env({ NEXT_PUBLIC_APP_URL: "ops.example.com" }))).toBe(PRODUCTION_APP_URL);
  });

  it("uses NEXT_PUBLIC_APP_URL without trailing slashes", () => {
    expect(emailAppUrl(env({ NEXT_PUBLIC_APP_URL: "http://localhost:3000/" }))).toBe(
      "http://localhost:3000",
    );
  });
});

describe("isProductionEmailEnv", () => {
  it.each([
    [{ VERCEL_ENV: "production" }, true],
    [{ VERCEL_ENV: "preview", NODE_ENV: "production" }, false],
    [{ VERCEL_ENV: "development" }, false],
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "test" }, false],
  ])("%o is production: %s", (vars, expected) => {
    expect(isProductionEmailEnv(env(vars))).toBe(expected);
  });
});
