/**
 * Email style tokens. Email clients ignore CSS variables and most ignore dark-mode
 * media queries, so emails use the light column of docs/DESIGN_SYSTEM.md as inline hex.
 * A unit test checks these values against the design system table.
 */
export const emailColors = {
  bg: "#FFFFFF",
  surface: "#F4F4F5",
  line: "#E4E4E7",
  fg: "#0A0A0A",
  fgMuted: "#52525B",
  /** Links only. Buttons use fg, like the app's primary button. */
  signal: "#6D4CFF",
} as const;

export const emailFonts = {
  body: "Inter, 'Segoe UI', Helvetica, Arial, sans-serif",
  heading: "'Space Grotesk', Inter, 'Segoe UI', Helvetica, Arial, sans-serif",
} as const;

/** Rendered logo size in px. The PNG is 724x144 (2x), so this keeps it sharp. */
export const emailLogo = { path: "/brand/ops-logo.png", width: 161, height: 32 } as const;

export const emailMaxWidth = 560;
