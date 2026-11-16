import type { CSSProperties, ReactNode } from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { APP_NAME } from "@/lib/app";
import { emailColors, emailFonts, emailLogo, emailMaxWidth } from "./tokens";

const COMPANY_NAME = "Meta Lira Technology LTD";

const styles = {
  body: {
    backgroundColor: emailColors.surface,
    color: emailColors.fg,
    fontFamily: emailFonts.body,
    margin: 0,
    padding: "24px 0",
  },
  container: {
    backgroundColor: emailColors.bg,
    border: `1px solid ${emailColors.line}`,
    borderRadius: 8,
    margin: "0 auto",
    maxWidth: emailMaxWidth,
    padding: "32px 24px",
  },
  logo: { display: "block", border: 0 },
  content: { paddingTop: 24 },
  hr: { borderColor: emailColors.line, borderTopWidth: 1, margin: "32px 0 16px" },
  footer: {
    color: emailColors.fgMuted,
    fontFamily: emailFonts.body,
    fontSize: 13,
    lineHeight: "20px",
    margin: "0 0 4px",
  },
  heading: {
    color: emailColors.fg,
    fontFamily: emailFonts.heading,
    fontSize: 25,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    lineHeight: "30px",
    margin: "0 0 16px",
  },
  text: {
    color: emailColors.fg,
    fontFamily: emailFonts.body,
    fontSize: 15,
    lineHeight: "24px",
    margin: "0 0 16px",
  },
  muted: {
    color: emailColors.fgMuted,
    fontFamily: emailFonts.body,
    fontSize: 14,
    lineHeight: "22px",
    margin: "0 0 16px",
  },
  link: { color: emailColors.signal, textDecoration: "underline" },
  // Matches the app's primary button: fg fill, bg text. Signal stays for links only.
  button: {
    backgroundColor: emailColors.fg,
    borderRadius: 8,
    color: emailColors.bg,
    display: "inline-block",
    fontFamily: emailFonts.body,
    fontSize: 15,
    fontWeight: 600,
    lineHeight: "20px",
    padding: "12px 20px",
    textDecoration: "none",
  },
} satisfies Record<string, CSSProperties>;

export type EmailLayoutProps = {
  /** Absolute base URL of the app, without a trailing slash. Used for the logo. */
  appUrl: string;
  /** Inbox preview line shown after the subject. */
  preview: string;
  /** Why the recipient got this email, shown in the footer. */
  reason: string;
  children: ReactNode;
};

/** Base layout for every outbound email: logo, white card, footer. Light only. */
export function EmailLayout({ appUrl, preview, reason, children }: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Link href={appUrl} data-skip-in-text="true">
            <Img
              src={`${appUrl}${emailLogo.path}`}
              width={emailLogo.width}
              height={emailLogo.height}
              alt={APP_NAME}
              style={styles.logo}
            />
          </Link>
          <Section style={styles.content}>{children}</Section>
          <Hr style={styles.hr} />
          <Text style={styles.footer}>{reason}</Text>
          <Text style={styles.footer}>{COMPANY_NAME}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function EmailHeading({ children }: { children: ReactNode }) {
  return (
    <Heading as="h1" style={styles.heading}>
      {children}
    </Heading>
  );
}

export function EmailText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={muted ? styles.muted : styles.text}>{children}</Text>;
}

export function EmailLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} style={styles.link}>
      {children}
    </Link>
  );
}

export function EmailButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "8px 0 24px" }}>
      <Button href={href} style={styles.button}>
        {children}
      </Button>
    </Section>
  );
}
