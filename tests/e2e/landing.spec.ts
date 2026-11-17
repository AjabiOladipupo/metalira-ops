import { expect, type Page, test } from "@playwright/test";

const PAGES = [
  { path: "/", heading: "Every shift, accounted for.", scene: "hero-crew" },
  { path: "/for/owners", heading: "Know what each site earns after payroll.", scene: "role-owner" },
  { path: "/for/hr", heading: "One record for every worker.", scene: "role-hr" },
  {
    path: "/for/finance",
    heading: "Payroll and invoices from the same approved hours.",
    scene: "role-finance",
  },
  {
    path: "/for/operations",
    heading: "Every post covered, every shift seen.",
    scene: "role-operations",
  },
  {
    path: "/for/workers",
    heading: "Clock in from your phone, even with no data.",
    scene: "role-worker",
  },
] as const;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const { path, heading, scene } of PAGES) {
  test(`${path} renders with its scene and no horizontal scroll`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    const illustrations = page.locator("main svg[data-illustration]");
    await expect(illustrations).toHaveCount(1);
    await expect(page.locator(`svg[data-illustration="${scene}"]`)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Nothing on the page names a payment provider or shows a price.
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/paystack|flutterwave/i);
    await expect(page.getByRole("link", { name: /^(privacy|terms)/i })).toHaveCount(0);
  });
}

test("every Start setup and Set up your business link goes to sign-up", async ({ page }) => {
  for (const { path } of PAGES) {
    await page.goto(path);
    const ctas = page.getByRole("link", { name: /^(start setup|set up your business)$/i });
    const count = await ctas.count();
    expect(count, path).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(ctas.nth(i)).toHaveAttribute("href", "/sign-up");
    }
  }
  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Start setup" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
});

test("the pilot section shows no prices and the header links to it", async ({ page }, testInfo) => {
  await page.goto("/");
  const pilot = page.locator("#pilot");
  await expect(pilot.getByText("Pilot", { exact: true })).toBeVisible();
  await expect(pilot.getByRole("heading", { level: 2 })).toHaveText(
    "Pay for the workers who clocked in",
  );
  await expect(pilot).toContainText("Free during the pilot.");
  expect(await pilot.innerText()).not.toMatch(/₦\s?\d|NGN\s?\d|\d+\s?naira/i);
  await expect(page.locator("#pricing")).toHaveCount(0);

  if (testInfo.project.name === "mobile-390") {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page
      .getByRole("navigation", { name: "Menu" })
      .getByRole("link", { name: "Pilot" })
      .click();
  } else {
    await page
      .getByRole("navigation", { name: "Site" })
      .getByRole("link", { name: "Pilot" })
      .click();
  }
  await expect(page).toHaveURL(/\/#pilot$/);
  await expect(page.getByRole("link", { name: "Pricing" })).toHaveCount(0);
});

test("the workers page sends workers to their employer and to worker sign-in", async ({ page }) => {
  await page.goto("/for/workers");
  await expect(
    page.getByRole("heading", { name: "Ask your employer for an invite" }),
  ).toBeVisible();
  const signIn = page.getByRole("link", { name: "Worker sign-in" });
  await expect(signIn.first()).toHaveAttribute("href", "/m/sign-in");
  await expect(page.getByRole("main").getByRole("link", { name: "Start setup" })).toHaveCount(0);
  await signIn.first().click();
  await expect(page).toHaveURL(/\/m\/sign-in$/);
});

test("the role pages are reachable from the header", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile-390") {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page
      .getByRole("navigation", { name: "Menu" })
      .getByRole("link", { name: "For HR" })
      .click();
  } else {
    await page
      .getByRole("banner")
      .getByRole("button", { name: "For each role", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "For HR" }).click();
  }
  await expect(page).toHaveURL(/\/for\/hr$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One record for every worker.");
});

test("dark mode renders the landing and role pages", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  for (const { path, scene } of [PAGES[0], PAGES[5]]) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveClass(/dark/);
    const colours = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      heading: getComputedStyle(document.querySelector("h1")!).color,
    }));
    expect(colours).toEqual({ body: "rgb(10, 10, 10)", heading: "rgb(250, 250, 250)" });
    await expect(page.locator(`svg[data-illustration="${scene}"]`)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }
});

test("sitemap and robots list the public pages", async ({ request }) => {
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const { path } of PAGES.slice(1)) expect(sitemap).toContain(`${path}</loc>`);
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /app/");
  expect(robots).toContain("Disallow: /m/");
  expect(robots).toContain("Disallow: /design-system");
  expect(robots).toContain("Sitemap: ");
  const og = await request.get("/opengraph-image");
  expect(og.status()).toBe(200);
  expect(og.headers()["content-type"]).toContain("image/png");
});
