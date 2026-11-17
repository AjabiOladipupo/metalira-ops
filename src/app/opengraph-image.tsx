import { ImageResponse } from "next/og";

// Social card for every page: the logo and the headline, black on white like the brand book.
export const alt = "Metalira Ops. Every shift, accounted for.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0a0a0a";
const MUTED = "#52525b";
const LINE = "#e4e4e7";

/** The dot-roster mark (src/components/logo.tsx), drawn in ink. */
function Mark({ size: px }: { size: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 28 28" fill={INK}>
      <circle cx="5" cy="5" r="3" />
      <circle cx="14" cy="5" r="3" />
      <circle cx="23" cy="5" r="3" />
      <circle cx="5" cy="14" r="3" />
      <rect x="11" y="11" width="17" height="6" rx="3" />
      <circle cx="5" cy="23" r="3" />
      <circle cx="14" cy="23" r="3" />
      <circle cx="23" cy="23" r="3" />
    </svg>
  );
}

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background: "#ffffff",
        color: INK,
        borderBottom: `12px solid ${INK}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <Mark size={64} />
        <div style={{ display: "flex", fontSize: 44, letterSpacing: "-0.01em" }}>
          <span>Metalira</span>
          <span style={{ fontWeight: 700, marginLeft: 12 }}>Ops</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            fontSize: 28,
            color: MUTED,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          For Nigerian businesses that run shift-based teams
        </div>
        <div style={{ fontSize: 92, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.03em" }}>
          Every shift, accounted for.
        </div>
      </div>
      <div
        style={{
          display: "flex",
          paddingTop: 24,
          borderTop: `2px solid ${LINE}`,
          fontSize: 30,
          color: MUTED,
        }}
      >
        Rosters, clock-ins, payroll and client invoices in one record.
      </div>
    </div>,
    size,
  );
}
