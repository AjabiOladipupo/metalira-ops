/**
 * Manual email check. Not part of the app bundle.
 *
 *   Send the test email (needs RESEND_API_KEY; without it the send is skipped with a log):
 *     pnpm exec tsx --env-file-if-exists=.env.local scripts/send-test-email.ts you@example.com
 *
 *   Send the welcome-owner email instead:
 *     pnpm exec tsx --env-file-if-exists=.env.local scripts/send-test-email.ts you@example.com --welcome
 *
 *   Write both templates as HTML files to look at in a browser (sends nothing):
 *     pnpm exec tsx scripts/send-test-email.ts --preview out/email-preview
 *
 * Until the sending domain is verified in Resend, Resend only delivers to the address
 * that owns the Resend account.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { render } from "@react-email/render";
import { emailAppUrl } from "../src/server/email/config";
import { TestEmail } from "../src/server/email/templates/test-email";
import { WelcomeOwnerEmail } from "../src/server/email/templates/welcome-owner";

const SAMPLE = {
  ownerName: "Ada Okafor",
  organisationName: "Coastline Facility Services",
  // Fixed so repeated script runs share one Resend idempotency key.
  organisationId: "00000000-0000-4000-8000-000000000001",
};

/**
 * `server-only` throws outside a React Server Components bundle. This script runs on the
 * server by definition, so stub the module before loading the send code.
 */
function allowServerOnly() {
  const require = createRequire(join(process.cwd(), "package.json"));
  const id = require.resolve("server-only");
  require.cache[id] = { id, filename: id, loaded: true, exports: {} } as NodeJS.Module;
}

async function writePreviews(dir: string) {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const appUrl = emailAppUrl();
  const files = {
    "test-email.html": createElement(TestEmail, { appUrl, sentAt: new Date() }),
    "welcome-owner.html": createElement(WelcomeOwnerEmail, { ...SAMPLE, appUrl }),
  };
  for (const [name, element] of Object.entries(files)) {
    writeFileSync(join(out, name), await render(element, { pretty: true }));
    console.log(`Wrote ${join(out, name)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const previewAt = args.indexOf("--preview");
  if (previewAt !== -1) {
    await writePreviews(args[previewAt + 1] ?? "out/email-preview");
    return;
  }

  const to = args.find((arg) => !arg.startsWith("--"));
  if (!to) {
    console.error("Usage: scripts/send-test-email.ts <to> [--welcome] | --preview <dir>");
    process.exitCode = 1;
    return;
  }

  allowServerOnly();
  const { sendTestEmail, sendWelcomeOwnerEmail } = await import("../src/server/email");
  const result = args.includes("--welcome")
    ? await sendWelcomeOwnerEmail({ to, ...SAMPLE })
    : await sendTestEmail(to);
  console.log(
    result.status === "sent" ? `Sent, Resend id ${result.id}` : `Skipped (${result.reason})`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
