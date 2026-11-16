import { expect, test } from "@playwright/test";

test("landing page links to sign-up and sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Metalira Ops");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create an account");
});

test("the app sends signed-out visitors to sign-in", async ({ page }) => {
  await page.goto("/app/people");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fpeople$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
});
