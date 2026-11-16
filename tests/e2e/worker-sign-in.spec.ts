import { expect, test } from "@playwright/test";

test("worker sign-in is design only: labelled fields, numeric PIN, no network call", async ({
  page,
}) => {
  await page.goto("/m/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await expect(page.getByLabel("Company code")).toBeVisible();
  await expect(page.getByLabel("Staff ID")).toBeVisible();

  const pin = page.getByLabel("PIN");
  await expect(pin).toHaveAttribute("type", "password");
  await expect(pin).toHaveAttribute("inputmode", "numeric");
  await expect(pin).toHaveAttribute("maxlength", "6");

  const box = await page.getByLabel("Staff ID").boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(52);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await page.getByLabel("Company code").fill("ADEBAYO");
  await page.getByLabel("Staff ID").fill("MO-0114");
  await pin.fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toContainText("Phone sign-in arrives with worker invites");
  await expect(page).toHaveURL(/\/m\/sign-in$/);
  expect(posts).toEqual([]);
});

test("sign-in and sign-up have no horizontal scroll", async ({ page }) => {
  for (const path of ["/sign-in", "/sign-up", "/check-email?sent=signup", "/no-access"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
