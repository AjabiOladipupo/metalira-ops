/** Slice 2.2: the origin printed in checkpoint QR codes never comes from a request header. */
import { describe, expect, it } from "vitest";

import { PRODUCTION_ORIGIN, checkpointOrigin, validOrigin } from "@/server/sites/origin";

describe("checkpoint QR origin", () => {
  it("uses the configured app URL in production, else the production app", () => {
    expect(
      checkpointOrigin({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://ops.metaliratech.com/app",
        VERCEL_URL: "metalira-ops-abc.vercel.app",
      }),
    ).toBe("https://ops.metaliratech.com");
    expect(checkpointOrigin({ VERCEL_ENV: "production", VERCEL_URL: "x.vercel.app" })).toBe(
      PRODUCTION_ORIGIN,
    );
    // An invalid or plain-http configured URL is ignored.
    expect(
      checkpointOrigin({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://evil.example" }),
    ).toBe(PRODUCTION_ORIGIN);
    expect(checkpointOrigin({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "not a url" })).toBe(
      PRODUCTION_ORIGIN,
    );
    // A production build run outside Vercel is treated as production.
    expect(checkpointOrigin({ NODE_ENV: "production" })).toBe(PRODUCTION_ORIGIN);
  });

  it("uses the preview deployment's own URL on a preview", () => {
    expect(
      checkpointOrigin({
        VERCEL_ENV: "preview",
        VERCEL_URL: "metalira-ops-git-slice-22.vercel.app",
        NEXT_PUBLIC_APP_URL: "https://ops.metaliratech.com",
      }),
    ).toBe("https://metalira-ops-git-slice-22.vercel.app");
    expect(checkpointOrigin({ VERCEL_ENV: "preview" })).toBe(PRODUCTION_ORIGIN);
  });

  it("uses localhost in development", () => {
    expect(checkpointOrigin({ NODE_ENV: "development", PORT: "3720" })).toBe(
      "http://localhost:3720",
    );
    expect(checkpointOrigin({ VERCEL_ENV: "development" })).toBe("http://localhost:3000");
    expect(
      checkpointOrigin({ NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:4000" }),
    ).toBe("http://127.0.0.1:4000");
  });

  it("accepts https anywhere and http only on this machine", () => {
    expect(validOrigin("https://ops.metaliratech.com/x?y=1")).toBe("https://ops.metaliratech.com");
    expect(validOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(validOrigin("http://ops.metaliratech.com")).toBeNull();
    expect(validOrigin("https://user:pw@ops.metaliratech.com")).toBeNull();
    expect(validOrigin("javascript:alert(1)")).toBeNull();
    expect(validOrigin(undefined)).toBeNull();
  });
});
