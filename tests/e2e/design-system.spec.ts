import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`design system renders with the system set to ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/design-system");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Design system");

    if (scheme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);

    for (const mode of ["light", "dark"]) {
      const gallery = page.getByTestId(`gallery-${mode}`);
      await expect(gallery).toBeVisible();
      await expect(gallery.getByText("Part paid")).toBeVisible();
      await expect(gallery.getByRole("table", { name: "Margin by site" })).toBeVisible();
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("dark panel uses the dark tokens", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/design-system");
  const bg = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg("gallery-light")).toBe("rgb(255, 255, 255)");
  expect(await bg("gallery-dark")).toBe("rgb(10, 10, 10)");
});

test("money columns are right-aligned with tabular figures", async ({ page }) => {
  await page.goto("/design-system");
  const cell = page.getByTestId("gallery-light").getByRole("cell", { name: "₦2,400,000" });
  const style = await cell.evaluate((el) => {
    const s = getComputedStyle(el);
    return { align: s.textAlign, numeric: s.fontVariantNumeric };
  });
  expect(style.align).toBe("right");
  expect(style.numeric).toContain("tabular-nums");
});
