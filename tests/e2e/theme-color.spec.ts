import { expect, test, type Page } from "@playwright/test";

import { THEME_STORAGE_KEY } from "../../src/components/theme/theme";
import { OWNED_THEME_COLOR_ATTR } from "../../src/components/theme/theme-script";

// The phone is in light mode; the worker chose Dark in the app.
test.use({ colorScheme: "light" });

type MetaInfo = { owned: boolean; media: string | null; content: string | null };

function themeColorMetas(page: Page): Promise<MetaInfo[]> {
  return page.evaluate(
    (attr) =>
      [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({
        owned: m.hasAttribute(attr),
        media: m.getAttribute("media"),
        content: m.getAttribute("content"),
      })),
    OWNED_THEME_COLOR_ATTR,
  );
}

/** One owned tag, first, in the chosen colour; React's own tags untouched and not duplicated. */
function expectOwnedFirst(metas: MetaInfo[], reactTags: number) {
  // Lower case on purpose (see ownedColour): React must not adopt it as the worker app's tag.
  expect(metas[0]).toEqual({ owned: true, media: null, content: "#0a0a0a" });
  expect(metas.filter((m) => m.owned)).toHaveLength(1);
  const fromReact = metas.filter((m) => !m.owned);
  expect(fromReact).toHaveLength(reactTags);
  // Distinct media: no duplicates left behind by hydration.
  expect(new Set(fromReact.map((m) => m.media)).size).toBe(fromReact.length);
}

test("the status bar colour follows Dark chosen in the app on a light phone", async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      localStorage.setItem(key, "dark");
    } catch {
      // Storage blocked: nothing to set.
    }
  }, THEME_STORAGE_KEY);

  await page.goto("/m/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  // After hydration: the owned tag, then the worker app's light and dark tags, unchanged.
  let metas = await themeColorMetas(page);
  expectOwnedFirst(metas, 2);
  expect(metas.filter((m) => !m.owned).map((m) => m.content)).toEqual(["#FFFFFF", "#0A0A0A"]);

  // Client navigation out of the worker app: its tags go, the owned one stays and still wins.
  await page.getByTestId("back-link").click();
  await expect(page).toHaveURL(/\/for\/workers$/);
  await page.waitForLoadState("networkidle");
  metas = await themeColorMetas(page);
  expectOwnedFirst(metas, 0);

  // And back in: no duplicates.
  await page.goBack();
  await expect(page).toHaveURL(/\/m\/sign-in$/);
  await page.waitForLoadState("networkidle");
  await expect(async () => expectOwnedFirst(await themeColorMetas(page), 2)).toPass({
    timeout: 5_000,
  });
});
