import type { ReactElement } from "react";
import { render, toPlainText } from "@react-email/render";

// Keep headings in sentence case (html-to-text upper-cases them by default).
const headingSelectors = ["h1", "h2", "h3"].map((selector) => ({
  selector,
  options: { uppercase: false },
}));

/** Plain-text version of an email's HTML, in the same voice as the HTML. */
export function emailPlainText(html: string): string {
  return toPlainText(html, { selectors: headingSelectors }).trim();
}

/** Renders a React Email element to the HTML and plain text that Resend sends. */
export async function renderEmail(element: ReactElement): Promise<{ html: string; text: string }> {
  const html = await render(element);
  return { html, text: emailPlainText(html) };
}
