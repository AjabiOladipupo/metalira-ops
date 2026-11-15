import { expect, test } from "@playwright/test";

test("landing page links into the app", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Metalira Ops");
  await page.getByRole("link", { name: "Open the app" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
});
