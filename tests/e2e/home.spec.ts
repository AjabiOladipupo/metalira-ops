import { expect, test } from "@playwright/test";

test("landing page links to sign-in and sign-up", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every shift, accounted for.");

  // Sign in sits in the header on desktop and in the menu on phones.
  if (testInfo.project.name === "mobile-390") {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page
      .getByRole("navigation", { name: "Menu" })
      .getByRole("link", { name: "Sign in" })
      .click();
  } else {
    await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  }
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
