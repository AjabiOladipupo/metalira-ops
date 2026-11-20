import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../rls/helpers/supabase";
import {
  NEEDS_SUPABASE,
  addMembership,
  createAccount,
  createOwner,
  signInViaUi,
  supabaseReady,
  uniqueSuffix,
} from "./helpers/auth";

test.skip(!supabaseReady, NEEDS_SUPABASE);

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);

/**
 * Slice 2.6 (390px and 1440px through the Playwright projects): an ops manager uploads the signed
 * Coastline contract as a PDF, opens it through a 60-second signed link, and removes it with a
 * reason, after which the link no longer opens it. A file renamed to .pdf is refused from its
 * bytes. hr can't open the document.
 */
test("ops_manager uploads a signed contract PDF, opens it by signed URL and removes it", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = adminClient();
  const suffix = uniqueSuffix();
  const owner = await createOwner("documents-owner", `Kola Guarding ${suffix}`);
  const ops = await createAccount("documents-ops", "Obinna Okafor");
  const hr = await createAccount("documents-hr", "Hauwa Bello");
  await addMembership(owner.orgId, ops.userId, "ops_manager");
  await addMembership(owner.orgId, hr.userId, "hr");
  const { data: clientId, error } = await admin.rpc("create_client", {
    p_organisation_id: owner.orgId,
    p_name: "Coastline Logistics",
    p_contact_email: "accounts@coastline.example",
    p_site_name: "Apapa Warehouse 3",
  });
  expect(error).toBeNull();
  const contract = await admin
    .from("contracts")
    .insert({
      organisation_id: owner.orgId,
      client_id: clientId!,
      reference: "",
      name: "Coastline guarding",
      type: "manned_post",
      start_date: "2026-12-01",
    } as never)
    .select("id")
    .single();
  expect(contract.error).toBeNull();
  const contractId = contract.data!.id;
  const contractPath = `/app/clients/${clientId}/contracts/${contractId}`;

  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, ops.email, ops.password);
  await expect(page).toHaveURL(/\/app$/, { timeout: 15_000 });

  await page.goto(contractPath);
  await page.getByRole("link", { name: "Documents" }).click();
  await expect(page).toHaveURL(/\?tab=documents$/);
  await expect(page.getByText("No documents yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Coastline Logistics" })).toBeVisible();
  const form = page.getByRole("form", { name: "Upload a document" });
  await expect(form.getByRole("combobox", { name: "Kind" })).toHaveValue("signed_contract");
  await expectNoHorizontalScroll(page);

  // A web page renamed to .pdf is refused from its bytes, whatever its name says.
  await form.getByLabel("File").setInputFiles({
    name: "contract.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("<html><body>not a pdf</body></html>"),
  });
  await form.getByRole("button", { name: "Upload" }).click();
  await expect(form.getByText(/isn't a PDF, PNG or JPEG/)).toBeVisible({ timeout: 15_000 });

  // The signed contract.
  await form.getByRole("textbox", { name: "Title" }).fill("Coastline guarding contract, signed");
  await form.getByLabel("File").setInputFiles({
    name: "Coastline contract (signed).pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  await form.getByRole("button", { name: "Upload" }).click();
  const documents = page.getByRole("list", { name: "Documents" });
  await expect(documents.getByTestId("contract-document")).toHaveCount(1, { timeout: 15_000 });
  await expect(documents).toContainText("Signed contract");
  await expect(documents).toContainText("Coastline guarding contract, signed");
  await expect(documents).toContainText("Coastline contract (signed).pdf");
  await expect(documents).toContainText("by Obinna Okafor");
  await expect(page.getByTestId("documents-count")).toHaveText("1 document on file");
  await expectNoHorizontalScroll(page);

  // Open: a redirect to a short-lived signed URL for the file itself.
  const open = documents.getByRole("link", { name: "Open Coastline guarding contract, signed" });
  await expect(open).toHaveAttribute("target", "_blank");
  const href = (await open.getAttribute("href"))!;
  const redirect = await page.request.get(href, { maxRedirects: 0 });
  expect(redirect.status()).toBe(303);
  const location = redirect.headers()["location"] ?? "";
  expect(location).toContain("/storage/v1/object/sign/contract-docs/");
  expect(location).toContain("token=");
  const file = await page.request.get(location);
  expect(file.ok()).toBe(true);
  expect(
    Buffer.from(await file.body())
      .subarray(0, 5)
      .toString(),
  ).toBe("%PDF-");

  // hr can't open it.
  const hrContext = await browser.newContext();
  const hrPage = await hrContext.newPage();
  await signInViaUi(hrPage, hr.email, hr.password);
  await expect(hrPage).toHaveURL(/\/app$/, { timeout: 15_000 });
  const refused = await hrPage.request.get(href, { maxRedirects: 0 });
  expect(refused.status()).toBe(403);
  await hrContext.close();

  // Remove, with a reason.
  await documents
    .getByRole("button", { name: "Remove Coastline guarding contract, signed" })
    .click();
  const removeForm = page.getByRole("form", { name: "Remove Coastline guarding contract, signed" });
  await removeForm.getByRole("button", { name: "Remove document" }).click();
  await expect(removeForm.getByText("Say why the document is being removed")).toBeVisible();
  await removeForm
    .getByRole("textbox", { name: "Why is it being removed?" })
    .fill("Wrong version uploaded");
  await removeForm.getByRole("button", { name: "Remove document" }).click();

  const removed = page.getByRole("list", { name: "Removed documents" });
  await expect(removed).toContainText("Wrong version uploaded", { timeout: 15_000 });
  await expect(removed).toContainText("by Obinna Okafor");
  await expect(page.getByText("No documents yet.")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The old link and the old route no longer open it.
  const gone = await page.request.get(href, { maxRedirects: 0 });
  expect(gone.status()).toBe(410);
  const stale = await page.request.get(location);
  expect(stale.ok()).toBe(true); // A link already handed out lives out its 60 seconds.

  const { data: audit } = await admin
    .from("audit_log")
    .select("action, actor_id, channel, reason")
    .eq("organisation_id", owner.orgId)
    .in("action", ["contract_document.uploaded", "contract_document.removed"])
    .order("at");
  expect((audit ?? []).map((r) => r.action)).toEqual([
    "contract_document.uploaded",
    "contract_document.removed",
  ]);
  expect((audit ?? []).every((r) => r.actor_id === ops.userId && r.channel === "web")).toBe(true);
  expect(audit?.[1]?.reason).toBe("Wrong version uploaded");
});
