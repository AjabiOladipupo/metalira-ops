import "server-only";

import { isValidElement, type ReactElement } from "react";
import { Resend } from "resend";
import { z } from "zod";
import { DEFAULT_EMAIL_FROM, isProductionEmailEnv } from "./config";
import { renderEmail } from "./render";

/** Thrown when sending is impossible because configuration is missing (production only). */
export class EmailConfigError extends Error {
  override name = "EmailConfigError";
}

/** Thrown when Resend rejects or fails a send. Never carries the recipient or body. */
export class EmailSendError extends Error {
  override name = "EmailSendError";
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number | null,
  ) {
    super(message);
  }
}

// Resend tag names and values: ASCII letters, numbers, underscores or dashes, at most 256.
const tagPart = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const sendEmailSchema = z.object({
  to: z.email(),
  // No CR, LF or other control characters: the subject can carry user text (an organisation
  // name), so header and log injection must be impossible whatever Resend does.
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\p{Cc}]*$/u, "Subject must not contain control characters"),
  react: z.custom<ReactElement>((value) => isValidElement(value), {
    message: "Expected a React Email element",
  }),
  text: z.string().min(1).optional(),
  replyTo: z.email().optional(),
  tags: z
    .array(z.object({ name: tagPart, value: tagPart }))
    .max(10)
    .optional(),
  /** Resend drops a repeat send with the same key within 24 hours. */
  idempotencyKey: z.string().min(1).max(256).optional(),
});

export type SendEmailInput = z.input<typeof sendEmailSchema>;

export type SendEmailResult =
  { status: "sent"; id: string } | { status: "skipped"; reason: "no_api_key" };

/** "ada@example.com" becomes "a***@example.com". Logs never carry a full address. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

let cached: { key: string; client: Resend } | undefined;

function resendClient(key: string): Resend {
  if (cached?.key !== key) cached = { key, client: new Resend(key) };
  return cached.client;
}

/**
 * Sends one email through Resend. Every outbound message goes through here.
 *
 * Without RESEND_API_KEY it throws EmailConfigError in production and, everywhere else
 * (development, tests, Vercel previews), logs a masked line and returns `skipped`.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const email = sendEmailSchema.parse(input);
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    if (isProductionEmailEnv()) {
      throw new EmailConfigError("RESEND_API_KEY is not set");
    }
    // Log the template tag, never the subject: the subject can carry user-chosen text.
    const type = email.tags?.find((tag) => tag.name === "type")?.value ?? "untagged";
    console.warn(`[email] RESEND_API_KEY not set, skipped: type=${type} to ${maskEmail(email.to)}`);
    return { status: "skipped", reason: "no_api_key" };
  }

  const rendered = await renderEmail(email.react);
  const html = rendered.html;
  const text = email.text ?? rendered.text;
  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM;

  const { data, error } = await resendClient(apiKey).emails.send(
    {
      from,
      to: email.to,
      subject: email.subject,
      html,
      text,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      ...(email.tags ? { tags: email.tags } : {}),
    },
    email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : undefined,
  );

  if (error) {
    throw new EmailSendError(
      `Resend rejected the email: ${error.message}`,
      error.name,
      error.statusCode,
    );
  }
  return { status: "sent", id: data.id };
}
