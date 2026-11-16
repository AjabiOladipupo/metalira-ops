import { expect, test } from "@playwright/test";

test("worker sign-in: labelled fields, a numeric 6-digit PIN, phone-sized inputs", async ({
  page,
}) => {
  await page.goto("/m/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await expect(page.getByLabel("Company code")).toBeVisible();
  await expect(page.getByLabel("Staff ID")).toBeVisible();
  // English only for now: no language picker (owner decision 16).
  await expect(page.getByLabel("Language")).toHaveCount(0);

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
});

test("worker sign-in asks for a 6-digit PIN before checking anything", async ({ page }) => {
  await page.goto("/m/sign-in");
  await page.getByLabel("Company code").fill("K7PQ2M");
  await page.getByLabel("Staff ID").fill("MO-0114");
  await page.getByLabel("PIN").fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Enter your 6-digit PIN.")).toBeVisible();
  await expect(page).toHaveURL(/\/m\/sign-in$/);
});

test("worker pages need a session", async ({ page }) => {
  await page.goto("/m");
  await expect(page).toHaveURL(/\/m\/sign-in$/);
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
