import { expect, test } from "@playwright/test";

// The Sentry test-error route must not be reachable without SENTRY_TEST_TOKEN.
test.describe("Sentry test-error route", () => {
  test("POST without the token header returns an empty 404", async ({ request }) => {
    const res = await request.post("/api/debug/sentry");
    expect(res.status()).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("POST with a wrong token returns 404", async ({ request }) => {
    const res = await request.post("/api/debug/sentry", {
      headers: { "x-debug-token": "not-the-token-not-the-token" },
    });
    expect(res.status()).toBe(404);
  });

  test("GET returns 404", async ({ request }) => {
    const res = await request.get("/api/debug/sentry");
    expect(res.status()).toBe(404);
  });
});

test("app renders with no Sentry DSN and logs no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every shift, accounted for.");
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});
