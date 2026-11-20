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
  {
    path: "/for/freelancers",
    heading: "Invoice your clients and see who has paid.",
    scene: "role-freelancer",
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
    // One scene per screen: the landing's second scene sits far below the hero, in #lira.
    const illustrations = page.locator("main svg[data-illustration]");
    await expect(illustrations).toHaveCount(path === "/" ? 2 : 1);
    await expect(page.locator(`svg[data-illustration="${scene}"]`)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Nothing on the page names a payment provider or shows a price.
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/paystack|flutterwave/i);
    await expect(page.getByRole("link", { name: /^(privacy|terms)/i })).toHaveCount(0);
  });
}

test("the landing says it is open to freelancers, and /for/freelancers fits a phone (slice 3.0)", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.locator("#freelancers");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { level: 2 })).toHaveText(
    "Also open to freelancers and sole proprietors",
  );
  await section.getByRole("link", { name: "For freelancers" }).click();
  await expect(page).toHaveURL(/\/for\/freelancers$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Invoice your clients and see who has paid.",
  );
  const main = page.getByRole("main");
  for (const words of ["contract", "rate card", "WHT", "VAT", "bank statement"]) {
    await expect(main, words).toContainText(words);
  }
  await expect(page.locator("#role-cta")).toHaveText(
    "Bring your client list. Leave with your first invoice.",
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const text = await main.innerText();
  expect(text).not.toMatch(/₦\s?\d|NGN\s?\d/);
});

test("the Lira section says coming soon and fits the page", async ({ page }, testInfo) => {
  await page.goto("/");
  const lira = page.locator("#lira");
  await lira.scrollIntoViewIfNeeded();
  await expect(lira.getByRole("heading", { level: 2 })).toHaveText("Meet Lira");
  await expect(lira.getByText("Coming soon", { exact: true })).toBeVisible();
  await expect(lira.locator('svg[data-illustration="lira-chat"]')).toBeVisible();
  for (const request of [
    "Add these 162 people from my spreadsheet.",
    "Who hasn't clocked in at Lekki today?",
    "Prepare November payroll for my approval.",
    "Which clients are overdue?",
  ]) {
    await expect(lira.locator("q").filter({ hasText: request })).toBeVisible();
  }
  await expect(lira).toContainText("waits for you to confirm");
  await expect(lira).toContainText("It never moves money.");
  const text = await lira.innerText();
  expect(text).not.toMatch(/₦\s?\d|NGN|\b20\d\d\b|\bsms\b|whatsapp/i);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // The section's own width never exceeds the viewport, with the 16px gutter on phones.
  const box = (await lira.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  if (testInfo.project.name === "mobile-390") {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page
      .getByRole("navigation", { name: "Menu" })
      .getByRole("link", { name: "Lira" })
      .click();
  } else {
    await page
      .getByRole("navigation", { name: "Site" })
      .getByRole("link", { name: "Lira" })
      .click();
  }
  await expect(page).toHaveURL(/\/#lira$/);
});

test("manager role pages carry a Lira card; the workers page does not", async ({ page }) => {
  for (const { path } of PAGES.filter((p) => p.path !== "/" && p.path !== "/for/workers")) {
    await page.goto(path);
    const card = page.getByTestId("lira-card");
    await expect(card, path).toBeVisible();
    await expect(card.getByText("Coming soon", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "Meet Lira" })).toHaveAttribute("href", "/#lira");
    expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
  }
  await page.goto("/for/workers");
  await expect(page.getByTestId("lira-card")).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("Lira");
});

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

test("at 360px the header fits with 44px controls, and a role page's back arrow comes before its scene", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "Phone widths only.");
  await page.setViewportSize({ width: 360, height: 780 });
  // /for/workers last: the checks below read its page.
  const ordered = [
    ...PAGES.filter((p) => p.path !== "/for/workers"),
    ...PAGES.filter((p) => p.path === "/for/workers"),
  ];
  for (const { path } of ordered) {
    await page.goto(path);
    expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
  }
  const header = page.getByRole("banner");
  for (const control of [
    header.getByRole("link", { name: "Start setup" }),
    header.getByRole("button", { name: /^Theme: / }),
    header.getByRole("button", { name: "Open menu" }),
  ]) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  // Footer role links are 44px tall touch targets.
  const footerLink = page.getByRole("contentinfo").getByRole("link", { name: "For HR" });
  expect((await footerLink.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  // /for/workers was the last page visited: the scene sits below the copy, as on the landing.
  const back = await page.getByTestId("back-link").boundingBox();
  const scene = await page.locator('svg[data-illustration="role-worker"]').boundingBox();
  expect(back!.y).toBeLessThan(scene!.y);
  // The closing call to action is a button-sized link, like the hero's.
  const ctas = page.getByRole("main").getByRole("link", { name: "Worker sign-in" });
  await expect(ctas).toHaveCount(2);
  expect((await ctas.nth(1).boundingBox())?.height).toBeGreaterThanOrEqual(44);
});
