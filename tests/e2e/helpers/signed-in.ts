import { mkdirSync } from "node:fs";
import path from "node:path";

import { test as base, expect } from "@playwright/test";

import { createOwner, signInViaUi, uniqueSuffix, type TestOwner } from "./auth";

/**
 * `test` with a signed-in owner. Each worker signs one owner in through the UI once and reuses
 * the saved cookies, so specs that only need "an owner" stay fast.
 */
export const test = base.extend<
  { owner: TestOwner },
  { ownerSession: { owner: TestOwner; file: string } }
>({
  ownerSession: [
    async ({ browser }, provide, workerInfo) => {
      const owner = await createOwner(
        `owner-w${workerInfo.workerIndex}`,
        `Shell Test Co ${uniqueSuffix()}`,
      );
      const dir = path.join(workerInfo.project.outputDir, ".auth");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `owner-${workerInfo.workerIndex}.json`);

      const page = await browser.newPage({ baseURL: workerInfo.project.use.baseURL });
      await signInViaUi(page, owner.email, owner.password);
      await expect(page).toHaveURL(/\/app$/);
      await page.context().storageState({ path: file });
      await page.close();
      await provide({ owner, file });
    },
    { scope: "worker" },
  ],
  storageState: async ({ ownerSession }, provide) => {
    await provide(ownerSession.file);
  },
  owner: async ({ ownerSession }, provide) => {
    await provide(ownerSession.owner);
  },
});

export { expect };
