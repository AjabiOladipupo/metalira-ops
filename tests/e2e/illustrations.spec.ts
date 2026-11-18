import { expect, test } from "@playwright/test";

// Later phases add scenes, so check the floor and that both panels match, not an exact count.
const MIN_SCENES = 23;

for (const scheme of ["light", "dark"] as const) {
  test(`illustration gallery renders with the system set to ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/design-system");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Design system");
    if (scheme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);

    const sceneCount = await page
      .getByTestId("illustrations-light")
      .locator("svg[data-illustration]")
      .count();
    expect(sceneCount).toBeGreaterThanOrEqual(MIN_SCENES);

    for (const mode of ["light", "dark"] as const) {
      const scenes = page.getByTestId(`illustrations-${mode}`).locator("svg[data-illustration]");
      await expect(scenes).toHaveCount(sceneCount);
      await expect(scenes.first()).toBeVisible();
      await expect(
        page.getByTestId(`illustrations-${mode}`).getByRole("img", { name: /security guard/ }),
      ).not.toHaveCount(0);

      const avatars = page.getByTestId(`avatars-${mode}`).locator("img");
      await expect(avatars).toHaveCount(3);
      await expect(avatars.first()).toBeVisible();
    }

    // Every scene fits its column: nothing wider than the page.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("scenes invert in the dark panel", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/design-system");
  const colours = (mode: string) =>
    page
      .getByTestId(`illustrations-${mode}`)
      .locator('svg[data-illustration="welcome"]')
      .evaluate((svg) => {
        const paper = svg.querySelector('[fill="var(--bg)"]');
        return {
          ink: getComputedStyle(svg).color,
          paper: paper ? getComputedStyle(paper).fill : null,
        };
      });
  expect(await colours("light")).toEqual({ ink: "rgb(10, 10, 10)", paper: "rgb(255, 255, 255)" });
  expect(await colours("dark")).toEqual({ ink: "rgb(250, 250, 250)", paper: "rgb(10, 10, 10)" });
});
