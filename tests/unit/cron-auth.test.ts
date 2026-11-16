import { describe, expect, it } from "vitest";

import { checkCronRequest } from "@/server/cron/auth";

describe("checkCronRequest", () => {
  const env = { CRON_SECRET: "s3cret-value" } as unknown as NodeJS.ProcessEnv;

  it("accepts Vercel Cron's bearer token", () => {
    expect(checkCronRequest("Bearer s3cret-value", env)).toBe("ok");
  });

  it("refuses a missing, wrong or differently shaped token", () => {
    expect(checkCronRequest(null, env)).toBe("unauthorised");
    expect(checkCronRequest("Bearer wrong", env)).toBe("unauthorised");
    expect(checkCronRequest("s3cret-value", env)).toBe("unauthorised");
    expect(checkCronRequest("Bearer s3cret-value ", env)).toBe("unauthorised");
  });

  it("fails closed when CRON_SECRET is not set", () => {
    expect(checkCronRequest("Bearer ", {} as unknown as NodeJS.ProcessEnv)).toBe("not_configured");
    expect(checkCronRequest("Bearer x", { CRON_SECRET: " " } as unknown as NodeJS.ProcessEnv)).toBe(
      "not_configured",
    );
  });
});
