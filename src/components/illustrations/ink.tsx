/**
 * Drawing kit for the black-ink scenes (DESIGN_SYSTEM.md "Illustrations"). Every scene is drawn
 * from these parts so the people share one hand: loose single-weight outlines, flat black hair
 * and trousers, white (`var(--bg)`) everywhere else, and one optional accent in `var(--signal)`.
 *
 * Colour rules, enforced by tests/unit/illustrations.test.tsx:
 * - lines and solid fills use `currentColor` (the SVG sets `text-foreground`, so they invert in
 *   dark mode);
 * - "white" areas use `var(--bg)`, never a hex value;
 * - the one accent is wrapped in <Accent>, the only place `var(--signal)` appears.
 *
 * Line weight: `lw` is the stroke width in the coordinates it is drawn in, worked out by
 * <Illustration> so lines look 2.25px at display size. A part drawn inside a scaled group gets
 * `lw / scale`. Arms and legs are "tubes": a wide ink stroke under a narrower paper stroke, which
 * leaves an outline of exactly `lw` on each side.
 */

export const INK = "currentColor";
export const PAPER = "var(--bg)";

type Pt = readonly [number, number];

/** The one accent per scene. Children draw in `currentColor`, which this group sets to signal. */
export function Accent({ children }: { children: React.ReactNode }) {
  return (
    <g data-accent="" style={{ color: "var(--signal)" }}>
      {children}
    </g>
  );
}

/** An outlined stroke: `w` wide inside, `lw` of ink each side. `solid` fills it with ink. */
export function Tube({
  d,
  w,
  lw,
  solid = false,
}: {
  d: string;
  w: number;
  lw: number;
  solid?: boolean;
}) {
  return (
    <g fill="none">
      <path d={d} stroke={INK} strokeWidth={w + 2 * lw} />
      {solid ? null : <path d={d} stroke={PAPER} strokeWidth={w} />}
    </g>
  );
}

/** A closed outlined shape filled with paper (default) or ink. */
export function Shape({ d, ink = false }: { d: string; ink?: boolean }) {
  return <path d={d} fill={ink ? INK : PAPER} />;
}

/** A plain ink line (inherits the stroke width of its group unless `w` is given). */
export function Line({ d, w }: { d: string; w?: number }) {
  return <path d={d} fill="none" strokeWidth={w} />;
}

export function Dot({ x, y, r }: { x: number; y: number; r: number }) {
  return <circle cx={x} cy={y} r={r} fill={INK} stroke="none" />;
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export type Hair =
  | "short" // close crop
  | "beard" // close crop and a full beard
  | "afro"
  | "puff" // afro puff on top
  | "braids"
  | "wrap" // headwrap tied at the top
  | "cap" // security guard's peaked cap
  | "helmet"; // rider's helmet

export type Top =
  | "shirt"
  | "polo"
  | "guard" // shirt, tie, epaulettes
  | "apron" // cleaner's bib apron over a shirt
  | "vest" // hi-vis vest with reflective bands
  | "jacket"
  | "blouse"; // long patterned top

export type Face = "smile" | "grin" | "calm";

/**
 * Arm poses for the viewer's right arm, from the shoulder, in person coordinates (feet at 0,
 * head top at -150). The left arm uses the same pose mirrored.
 */
const ARMS = {
  down: { d: "M17 -104 C23 -94 25 -80 24 -67", hand: [24, -63] },
  wave: { d: "M17 -104 C27 -106 32 -116 33 -128", hand: [34, -133] },
  chest: { d: "M17 -104 C25 -94 22 -84 11 -82", hand: [8, -82] },
  low: { d: "M17 -104 C24 -92 22 -78 12 -72", hand: [9, -71] },
  point: { d: "M17 -104 C28 -104 38 -110 45 -118", hand: [48, -121] },
  reach: { d: "M17 -104 C24 -92 30 -86 40 -84", hand: [44, -84] },
  thumb: { d: "M17 -104 C26 -94 31 -88 30 -100", hand: [30, -104], thumb: "M30.5 -108 L31 -114" },
  hip: { d: "M17 -104 L28 -88 L20 -74", hand: [19, -72] },
  face: { d: "M17 -104 C27 -94 26 -88 16 -100", hand: [13, -103] },
} as const satisfies Record<string, { d: string; hand: Pt; thumb?: string }>;

export type ArmPose = keyof typeof ARMS;

/** Where a pose puts the hand, in person coordinates. `side` is "left" or "right" as seen. */
export function handAt(pose: ArmPose, side: "left" | "right"): Pt {
  const [hx, hy] = ARMS[pose].hand;
  return side === "right" ? [hx, hy] : [-hx, hy];
}

function Arm({ pose, lw }: { pose: ArmPose; lw: number }) {
  return <Tube d={ARMS[pose].d} w={9} lw={lw} />;
}

function Hand({ pose, lw }: { pose: ArmPose; lw: number }) {
  const arm: { hand: Pt; thumb?: string } = ARMS[pose];
  const [hx, hy] = arm.hand;
  return (
    <g>
      <circle cx={hx} cy={hy} r={4.6} fill={PAPER} />
      {arm.thumb ? <Tube d={arm.thumb} w={3.2} lw={lw} /> : null}
    </g>
  );
}

/** A head centred on 0,0 (face 24 wide, 29 tall). */
export function Head({
  hair,
  face = "smile",
  glasses = false,
  lw,
}: {
  hair: Hair;
  face?: Face;
  glasses?: boolean;
  lw: number;
}) {
  const bearded = hair === "beard";
  const mouthInk = bearded ? PAPER : INK;
  return (
    <g>
      {/* Hair that sits behind the face */}
      {hair === "afro" ? <ellipse cx={0} cy={-6} rx={19} ry={17.5} fill={INK} /> : null}
      {hair === "braids" ? (
        <g>
          <Tube d="M-10 -8 C-14 2 -15 12 -14 22" w={4.5} lw={lw} solid />
          <Tube d="M10 -8 C14 2 15 12 14 22" w={4.5} lw={lw} solid />
          <path
            d="M-10 -8 C-14 2 -15 12 -14 22 M10 -8 C14 2 15 12 14 22"
            fill="none"
            stroke={PAPER}
            strokeWidth={lw * 0.9}
            strokeDasharray={`${lw * 0.6} ${lw * 2.4}`}
          />
        </g>
      ) : null}
      {hair === "puff" ? <circle cx={0} cy={-20} r={8.5} fill={INK} /> : null}

      {/* Ears and face */}
      <path d="M-11.5 -3 C-16 -4 -16 4 -11 4.5" fill={PAPER} />
      <path d="M11.5 -3 C16 -4 16 4 11 4.5" fill={PAPER} />
      <ellipse cx={0} cy={0} rx={12} ry={14.5} fill={PAPER} />

      {/* Hair and headwear on top */}
      {hair === "short" || hair === "beard" || hair === "puff" || hair === "braids" ? (
        <path
          d="M-12.3 -1 C-13.5 -12 -8 -17.5 0 -17.5 C8 -17.5 13.5 -12 12.3 -1 C11 -7 8 -10 3 -10 L-3 -10 C-8 -10 -11 -7 -12.3 -1 Z"
          fill={INK}
        />
      ) : null}
      {hair === "braids" ? (
        <path
          d="M-6 -11 C-8 -14 -7 -16 -4 -17 M0 -10.5 V-17 M6 -11 C8 -14 7 -16 4 -17"
          fill="none"
          stroke={PAPER}
          strokeWidth={lw * 0.8}
        />
      ) : null}
      {hair === "afro" ? (
        <path d="M-12 -2 C-10 -9 -5 -11 0 -11 C5 -11 10 -9 12 -2 L12 -14 L-12 -14 Z" fill={INK} />
      ) : null}
      {hair === "wrap" ? (
        <g>
          <path d="M3 -19 C6 -29 15 -27 11 -18 Z" fill={INK} />
          <path d="M-2 -19 C-8 -27 -15 -22 -9 -16 Z" fill={INK} />
          <path
            d="M-13.2 -1 C-16 -15 -8 -22 0 -22 C8 -22 16 -15 13.2 -1 C8 -8 -8 -8 -13.2 -1 Z"
            fill={INK}
          />
          <path d="M-9 -10 C-4 -14.5 4 -14.5 9 -10" fill="none" stroke={PAPER} />
        </g>
      ) : null}
      {hair === "cap" ? (
        <g>
          <path d="M-13 -5 C-14 -20 -6 -25 1 -24.5 C9 -24 14 -18 13 -5 Z" fill={INK} />
          <path d="M-13.5 -5 C-6 1 6 1 13.5 -5 C6 -2 -6 -2 -13.5 -5 Z" fill={INK} />
          <circle cx={0} cy={-14} r={2.8} fill={PAPER} stroke="none" />
        </g>
      ) : null}
      {hair === "helmet" ? (
        <g>
          <path
            d="M-15 3 C-17 -17 -8 -25.5 0 -25.5 C8 -25.5 17 -17 15 3 L12.5 3 C12.5 -5 8 -9.5 0 -9.5 C-8 -9.5 -12.5 -5 -12.5 3 Z"
            fill={PAPER}
          />
          <path d="M-12.5 -8 C-7 -13 7 -13 12.5 -8 L12.5 -5 C7 -10 -7 -10 -12.5 -5 Z" fill={INK} />
          <Line d="M0 -25.5 L0 -12.5" w={lw * 2.2} />
          <Line d="M-12.5 3 C-10 11 -5 14 0 14.5" />
        </g>
      ) : null}
      {bearded ? (
        <path
          d="M-12 0 C-11.5 12 -6 17 0 17 C6 17 11.5 12 12 0 C9.5 7 5 9 0 9 C-5 9 -9.5 7 -12 0 Z"
          fill={INK}
        />
      ) : null}

      {/* Features */}
      <path d="M-7.5 -5.5 C-6 -7 -4 -7 -2.5 -6" fill="none" />
      <path d="M7.5 -5.5 C6 -7 4 -7 2.5 -6" fill="none" />
      <Dot x={-4.6} y={-1.2} r={1.5} />
      <Dot x={4.6} y={-1.2} r={1.5} />
      <path d="M-2.4 5.2 C-1 6.4 1 6.4 2.4 5.2" fill="none" />
      {face === "grin" ? (
        <path d="M-5 9 C-2 13.5 2 13.5 5 9 Z" fill={mouthInk} stroke={mouthInk} />
      ) : face === "calm" ? (
        <path d="M-3 10.5 C-1 11.5 1 11.5 3 10.5" fill="none" stroke={mouthInk} />
      ) : (
        <path d="M-4.5 9.5 C-2 12.5 2 12.5 4.5 9.5" fill="none" stroke={mouthInk} />
      )}
      {glasses ? (
        <g fill="none">
          <circle cx={-4.8} cy={-1.2} r={4} />
          <circle cx={4.8} cy={-1.2} r={4} />
          <path d="M-0.8 -1.5 L0.8 -1.5" />
        </g>
      ) : null}
    </g>
  );
}

const TORSO =
  "M-19 -109 C-23 -100 -22.5 -80 -19.5 -62 L19.5 -62 C22.5 -80 23 -100 19 -109 C12 -113.5 -12 -113.5 -19 -109 Z";
const LONG_TORSO =
  "M-19 -109 C-23 -100 -23 -74 -22 -48 L22 -48 C23 -74 23 -100 19 -109 C12 -113.5 -12 -113.5 -19 -109 Z";

function Collar() {
  return (
    <path d="M-7.5 -111 L-9 -104.5 L-2 -106 L0 -102.5 L2 -106 L9 -104.5 L7.5 -111" fill={PAPER} />
  );
}

function TopDetails({ top, lw }: { top: Top; lw: number }) {
  switch (top) {
    case "shirt":
      return (
        <g>
          <Line d="M0 -103 L0 -63" />
          <Collar />
          <Dot x={-2.4} y={-94} r={0.9} />
          <Dot x={-2.4} y={-84} r={0.9} />
        </g>
      );
    case "polo":
      return (
        <g>
          <Line d="M0 -103 L0 -93" />
          <Collar />
          <Dot x={-2.4} y={-97} r={0.9} />
        </g>
      );
    case "guard":
      return (
        <g>
          <Line d="M0 -103 L0 -63" />
          <path d="M-2.2 -104 L2.2 -104 L3.6 -84 L0 -79.5 L-3.6 -84 Z" fill={INK} />
          <Collar />
          <Line d="M-18 -108.5 L-10 -111" w={lw * 2.4} />
          <Line d="M18 -108.5 L10 -111" w={lw * 2.4} />
          <path d="M6 -99 L15 -99 L15 -91 L6 -91 Z" fill="none" />
          <path d="M-6 -99 L-15 -99 L-15 -91 L-6 -91 Z" fill="none" />
          <Line d="M-20 -66 L20 -66" w={lw * 2.2} />
        </g>
      );
    case "apron":
      return (
        <g>
          <Collar />
          <Line d="M-10 -104 L-7 -111" />
          <Line d="M10 -104 L7 -111" />
          <path
            d="M-10 -104 L10 -104 L11 -88 C17 -82 18.5 -70 17.5 -42 L-17.5 -42 C-18.5 -70 -17 -82 -11 -88 Z"
            fill={PAPER}
          />
          <Line d="M-11 -88 L11 -88" />
          <path d="M-7 -70 L7 -70 L7 -60 L-7 -60 Z" fill="none" />
          <path
            d="M-18 -88 C-22 -85 -24 -82 -22 -79 M-18 -88 C-21 -89 -25 -88 -25 -85"
            fill="none"
          />
        </g>
      );
    case "vest":
      return (
        <g>
          <Collar />
          <path
            d="M-19 -108.5 L-7.5 -111 L-3.5 -63 L-19.6 -62 C-22.5 -80 -22.8 -99 -19 -108.5 Z"
            fill={PAPER}
          />
          <path
            d="M19 -108.5 L7.5 -111 L3.5 -63 L19.6 -62 C22.5 -80 22.8 -99 19 -108.5 Z"
            fill={PAPER}
          />
          <path d="M-21.6 -93 L-5.9 -94 L-5.5 -88.5 L-21.6 -87.5 Z" fill={INK} />
          <path d="M-21.3 -79 L-4.8 -80 L-4.4 -74.5 L-20.9 -73.5 Z" fill={INK} />
          <path d="M21.6 -93 L5.9 -94 L5.5 -88.5 L21.6 -87.5 Z" fill={INK} />
          <path d="M21.3 -79 L4.8 -80 L4.4 -74.5 L20.9 -73.5 Z" fill={INK} />
        </g>
      );
    case "jacket":
      return (
        <g>
          <path d="M-7.5 -111 L0 -96 L7.5 -111 Z" fill={PAPER} />
          <path d="M-1.6 -104 L1.6 -104 L2.6 -90 L0 -86 L-2.6 -90 Z" fill={INK} />
          <path d="M-8 -111 L-12.5 -101 L-7.5 -100 L-1 -84 L-1 -62" fill="none" />
          <path d="M8 -111 L12.5 -101 L7.5 -100 L1 -84 L1 -62" fill="none" />
          <Dot x={-4} y={-76} r={1.2} />
          <path d="M-16 -80 L-9 -80" fill="none" />
        </g>
      );
    case "blouse":
      return (
        <g>
          <path d="M-8.5 -110.5 C-5 -104 5 -104 8.5 -110.5" fill="none" />
          <circle cx={-11} cy={-96} r={2.4} fill="none" />
          <circle cx={9} cy={-88} r={2.4} fill="none" />
          <circle cx={-6} cy={-74} r={2.4} fill="none" />
          <circle cx={13} cy={-63} r={2.4} fill="none" />
          <circle cx={-14} cy={-58} r={2.4} fill="none" />
          <Dot x={2} y={-97} r={1.1} />
          <Dot x={-12} y={-83} r={1.1} />
          <Dot x={6} y={-72} r={1.1} />
          <Dot x={-2} y={-58} r={1.1} />
          <Dot x={15} y={-79} r={1.1} />
        </g>
      );
  }
}

const TROUSERS = "M-17.5 -64 L17.5 -64 L16 -7 L3 -7 L0.6 -46 L-0.6 -46 L-3 -7 L-16 -7 Z";
const SHOES = [
  "M-16.5 -7 L-3 -7 C-1.5 -4 -1.5 -2 -2 0 L-21 0 C-22 -4 -20 -6.5 -16.5 -7 Z",
  "M16.5 -7 L3 -7 C1.5 -4 1.5 -2 2 0 L21 0 C22 -4 20 -6.5 16.5 -7 Z",
];

export type PersonProps = {
  /** Feet position in scene coordinates. */
  x: number;
  y: number;
  /** Scale: 1 is 150 units tall. */
  s?: number;
  lw: number;
  hair: Hair;
  top: Top;
  bottom?: "trousers" | "skirt";
  left?: ArmPose;
  right?: ArmPose;
  face?: Face;
  glasses?: boolean;
  /** Seated behind something: no legs (the scene draws the desk over the hips). */
  seated?: boolean;
  /** Drawn first, behind the body (a mop handle, a bag). Person coordinates. */
  behind?: React.ReactNode;
  /** Drawn over the arms and under the hands (whatever the hands hold). Person coordinates. */
  held?: React.ReactNode;
};

/** A standing (or seated) person. Person coordinates: feet at 0,0, head top at about -150. */
export function Person({
  x,
  y,
  s = 1,
  lw,
  hair,
  top,
  bottom = "trousers",
  left = "down",
  right = "down",
  face,
  glasses,
  seated = false,
  behind,
  held,
}: PersonProps) {
  const l = lw / s;
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} strokeWidth={l}>
      {behind}
      {seated ? null : bottom === "skirt" ? (
        <g>
          <Tube d="M-7 -30 L-8 -8" w={7} lw={l} />
          <Tube d="M7 -30 L8 -8" w={7} lw={l} />
          <path d="M-18 -64 L18 -64 L21.5 -28 L-21.5 -28 Z" fill={INK} />
        </g>
      ) : (
        <path d={TROUSERS} fill={INK} />
      )}
      {seated ? null : SHOES.map((d) => <path key={d} d={d} fill={PAPER} />)}
      <Tube d="M0 -121 L0 -106" w={8.5} lw={l} />
      <path d={top === "blouse" || top === "apron" ? LONG_TORSO : TORSO} fill={PAPER} />
      <TopDetails top={top} lw={l} />
      <g transform="translate(0 -133)">
        <Head hair={hair} face={face} glasses={glasses} lw={l} />
      </g>
      <g transform="scale(-1 1)">
        <Arm pose={left} lw={l} />
      </g>
      <Arm pose={right} lw={l} />
      {held}
      <g transform="scale(-1 1)">
        <Hand pose={left} lw={l} />
      </g>
      <Hand pose={right} lw={l} />
    </g>
  );
}

// ---------------------------------------------------------------------------------------------
// Speech bubbles and their icons
// ---------------------------------------------------------------------------------------------

/**
 * A round speech bubble at `cx, cy` with a tail pointing toward `toward` (scene coordinates).
 * The icon is drawn in a 24 x 24 box centred on the bubble and scaled to fit.
 */
export function Bubble({
  cx,
  cy,
  r,
  toward,
  lw,
  accent = true,
  children,
}: {
  cx: number;
  cy: number;
  r: number;
  toward: Pt;
  lw: number;
  accent?: boolean;
  children: React.ReactNode;
}) {
  const angle = Math.atan2(toward[1] - cy, toward[0] - cx);
  const gap = 0.32;
  const at = (a: number, rad: number) =>
    `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
  const d = `M${at(angle + gap, r)} A${r} ${r} 0 1 1 ${at(angle - gap, r)} L${at(angle, r * 1.5)} Z`;
  const k = r / 13;
  const icon = (
    <g transform={`translate(${cx} ${cy}) scale(${k})`} strokeWidth={lw / k} fill="none">
      {children}
    </g>
  );
  return (
    <g>
      <path d={d} fill={PAPER} strokeWidth={lw} />
      {accent ? <Accent>{icon}</Accent> : icon}
    </g>
  );
}

/** Bubble icons, drawn in a 24 x 24 box centred on 0,0 in the current colour. */
export const Icon = {
  building: () => (
    <g>
      <path d="M-6.5 8 V-7 H6.5 V8" fill={PAPER} />
      <path d="M-9 8 H9" />
      <path d="M-3 -3.5 H-1.5 M1.5 -3.5 H3 M-3 0.5 H-1.5 M1.5 0.5 H3" />
      <path d="M-1.8 8 V4.5 H1.8 V8" />
    </g>
  ),
  check: () => <path d="M-6 0.5 L-1.8 4.8 L6.5 -4.5" />,
  clock: () => (
    <g>
      <circle cx={0} cy={0} r={7.5} />
      <path d="M0 -4.2 V0 L3.2 2.2" />
    </g>
  ),
  thumb: () => (
    <g>
      <path d="M-7.5 -1 H-4 V7.5 H-7.5 Z" />
      <path d="M-4 -1 L-0.5 -7.5 C1.5 -8.5 3 -7 2.5 -4.5 L2 -2 H6.5 C8 -2 8.5 -0.5 8 1 L6.5 6.5 C6 7.3 5.5 7.5 4.5 7.5 H-4" />
    </g>
  ),
  calendar: () => (
    <g>
      <path d="M-7.5 -5.5 H7.5 V7.5 H-7.5 Z" />
      <path d="M-7.5 -1 H7.5 M-3.5 -8 V-4 M3.5 -8 V-4" />
      <path d="M-3.5 3 H-3 M0 3 H0.5 M3.5 3 H4" />
    </g>
  ),
  cloudOff: () => (
    <g>
      <path d="M-5 5.5 C-9 5.5 -9.5 -0.5 -5.5 -1 C-5 -6 2 -7.5 4 -2.5 C7.5 -3 9 1 7 3.5 C6.3 4.8 5.3 5.5 4 5.5 Z" />
      <path d="M-8 -7.5 L8 8" />
    </g>
  ),
  sun: () => (
    <g>
      <circle cx={0} cy={0} r={3.6} />
      <path d="M0 -8.5 V-6.5 M0 6.5 V8.5 M-8.5 0 H-6.5 M6.5 0 H8.5 M-6 -6 L-4.6 -4.6 M4.6 4.6 L6 6 M-6 6 L-4.6 4.6 M4.6 -4.6 L6 -6" />
    </g>
  ),
  naira: () => (
    <g>
      <path d="M-4.5 7 V-7 L4.5 7 V-7" />
      <path d="M-7.5 -1.5 H7.5 M-7.5 2 H7.5" />
    </g>
  ),
  pin: () => (
    <g>
      <path d="M0 8.5 C-5 3 -6.5 0 -6.5 -2.5 A6.5 6.5 0 0 1 6.5 -2.5 C6.5 0 5 3 0 8.5 Z" />
      <circle cx={0} cy={-2.5} r={2.2} />
    </g>
  ),
  heart: () => (
    <path d="M0 7 C-4 4 -8 1 -8 -3 C-8 -6 -5.5 -7.5 -3.5 -7.5 C-2 -7.5 -0.8 -6.7 0 -5.5 C0.8 -6.7 2 -7.5 3.5 -7.5 C5.5 -7.5 8 -6 8 -3 C8 1 4 4 0 7 Z" />
  ),
};

// ---------------------------------------------------------------------------------------------
// Props (things people hold or stand beside). All drawn around 0,0; place with a <g transform>.
// ---------------------------------------------------------------------------------------------

/** A profile card: a small face and two lines. */
export function ProfileCard({ w = 30, h = 21 }: { w?: number; h?: number }) {
  const x = -w / 2;
  const y = -h / 2;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={2.5} fill={PAPER} />
      <circle cx={x + w * 0.27} cy={y + h * 0.4} r={h * 0.16} fill="none" />
      <path
        d={`M${x + w * 0.12} ${y + h * 0.84} C${x + w * 0.15} ${y + h * 0.62} ${x + w * 0.39} ${y + h * 0.62} ${x + w * 0.42} ${y + h * 0.84}`}
        fill="none"
      />
      <path
        d={`M${x + w * 0.54} ${y + h * 0.36} H${x + w * 0.86} M${x + w * 0.54} ${y + h * 0.6} H${x + w * 0.76}`}
        fill="none"
      />
    </g>
  );
}

/** Three profile cards fanned into a stack. */
export function CardStack({ w = 30, h = 21 }: { w?: number; h?: number }) {
  return (
    <g>
      <g transform="translate(4 -7) rotate(8)">
        <ProfileCard w={w} h={h} />
      </g>
      <g transform="translate(2 -3.5) rotate(3)">
        <ProfileCard w={w} h={h} />
      </g>
      <ProfileCard w={w} h={h} />
    </g>
  );
}

export function Clipboard({
  w = 22,
  h = 28,
  checks = true,
}: {
  w?: number;
  h?: number;
  checks?: boolean;
}) {
  const x = -w / 2;
  const y = -h / 2;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={2} fill={PAPER} />
      <rect x={-w * 0.22} y={y - 2.5} width={w * 0.44} height={5} rx={1.5} fill={INK} />
      {checks ? (
        <g fill="none">
          <path d={`M${x + 4} ${y + 9} l1.6 1.6 l3 -3.2 M${x + 11} ${y + 9} H${x + w - 4}`} />
          <path d={`M${x + 4} ${y + 16} l1.6 1.6 l3 -3.2 M${x + 11} ${y + 16} H${x + w - 5}`} />
          <path d={`M${x + 11} ${y + 23} H${x + w - 4}`} />
        </g>
      ) : (
        <path
          d={`M${x + 4} ${y + 10} H${x + w - 4} M${x + 4} ${y + 16} H${x + w - 6} M${x + 4} ${y + 22} H${x + w - 4}`}
          fill="none"
        />
      )}
    </g>
  );
}

/** A phone, ink body with a paper screen. `screen` draws inside the screen (centred on 0,0). */
export function Phone({
  w = 13,
  h = 22,
  screen,
}: {
  w?: number;
  h?: number;
  screen?: React.ReactNode;
}) {
  return (
    <g>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={2.6} fill={INK} />
      <rect
        x={-w / 2 + 1.8}
        y={-h / 2 + 2.6}
        width={w - 3.6}
        height={h - 5.6}
        rx={1}
        fill={PAPER}
        stroke="none"
      />
      {screen}
    </g>
  );
}

/** A small ID card (photo square and two lines), centred on 0,0. */
export function IdCard({ w = 18, h = 12 }: { w?: number; h?: number }) {
  const x = -w / 2;
  const y = -h / 2;
  return (
    <g fill="none">
      <rect x={x} y={y} width={w} height={h} rx={1.5} fill={PAPER} />
      <circle cx={x + w * 0.28} cy={y + h * 0.42} r={h * 0.17} />
      <path
        d={`M${x + w * 0.12} ${y + h * 0.86} C${x + w * 0.16} ${y + h * 0.62} ${x + w * 0.4} ${y + h * 0.62} ${x + w * 0.44} ${y + h * 0.86}`}
      />
      <path
        d={`M${x + w * 0.56} ${y + h * 0.38} H${x + w * 0.86} M${x + w * 0.56} ${y + h * 0.64} H${x + w * 0.78}`}
      />
    </g>
  );
}

/** A naira note. */
export function NairaNote({ w = 28, h = 15 }: { w?: number; h?: number }) {
  const k = h / 26;
  const n = (v: number) => (v * k).toFixed(2);
  return (
    <g>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={1.5} fill={PAPER} />
      <circle cx={0} cy={0} r={h * 0.32} fill="none" />
      <path
        d={`M${n(-3)} ${n(5)} V${n(-5)} L${n(3)} ${n(5)} V${n(-5)} M${n(-5)} ${n(-1)} H${n(5)} M${n(-5)} ${n(1.8)} H${n(5)}`}
        fill="none"
      />
      <path d={`M${-w / 2 + 3} ${-h / 2 + 3} h2 M${w / 2 - 5} ${h / 2 - 3} h2`} fill="none" />
    </g>
  );
}

export function Envelope({ w = 28, h = 19 }: { w?: number; h?: number }) {
  return (
    <g>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={1.5} fill={PAPER} />
      <path d={`M${-w / 2} ${-h / 2 + 1} L0 ${h * 0.12} L${w / 2} ${-h / 2 + 1}`} fill="none" />
    </g>
  );
}

/** A receipt or slip with a torn zig-zag foot and a few lines. */
export function Slip({
  w = 22,
  h = 30,
  naira = false,
}: {
  w?: number;
  h?: number;
  naira?: boolean;
}) {
  const x = -w / 2;
  const y = -h / 2;
  const teeth = 5;
  const step = w / teeth;
  let foot = "";
  for (let i = 0; i < teeth; i++) {
    foot += ` L${(x + w - step * (i + 0.5)).toFixed(2)} ${y + h - 2.5} L${(x + w - step * (i + 1)).toFixed(2)} ${y + h}`;
  }
  return (
    <g>
      <path d={`M${x} ${y} H${x + w} V${y + h}${foot} Z`} fill={PAPER} />
      <path
        d={`M${x + 4} ${y + 6} H${x + w - 4} M${x + 4} ${y + 11} H${x + w - 8} M${x + 4} ${y + 16} H${x + w - 6}`}
        fill="none"
      />
      {naira ? <path d={`M${x + 4} ${y + 23} H${x + w - 4}`} fill="none" /> : null}
    </g>
  );
}

export function Suitcase({ w = 26, h = 20 }: { w?: number; h?: number }) {
  return (
    <g>
      <path d={`M${-w * 0.2} ${-h / 2} V${-h / 2 - 5} H${w * 0.2} V${-h / 2}`} fill="none" />
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={3} fill={PAPER} />
      <path d={`M${-w * 0.28} ${-h / 2} V${h / 2} M${w * 0.28} ${-h / 2} V${h / 2}`} fill="none" />
    </g>
  );
}

/** A laptop seen from behind the screen, on a desk line at y = 0. */
export function LaptopBack({ w = 34, h = 24 }: { w?: number; h?: number }) {
  return (
    <g>
      <path d={`M${-w / 2} 0 L${-w / 2 + 3} ${-h} H${w / 2 - 3} L${w / 2} 0 Z`} fill={PAPER} />
      <circle cx={0} cy={-h / 2} r={2.4} fill="none" />
    </g>
  );
}

/** A calculator: screen and a grid of keys. */
export function Calculator({ w = 18, h = 24 }: { w?: number; h?: number }) {
  const x = -w / 2;
  const y = -h / 2;
  const keys: React.ReactNode[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      keys.push(
        <Dot
          key={`${r}-${c}`}
          x={x + w * (0.25 + c * 0.25)}
          y={y + h * (0.5 + r * 0.17)}
          r={1.3}
        />,
      );
    }
  }
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={2.5} fill={PAPER} />
      <rect x={x + 3} y={y + 3} width={w - 6} height={h * 0.22} rx={1} fill="none" />
      {keys}
    </g>
  );
}

/** A map pin, tip at 0,0. */
export function MapPin({ h = 40, lw }: { h?: number; lw: number }) {
  const k = h / 40;
  return (
    <g transform={`scale(${k})`} strokeWidth={lw / k}>
      <path
        d="M0 0 C-10 -12 -14 -19 -14 -26 A14 14 0 0 1 14 -26 C14 -19 10 -12 0 0 Z"
        fill={PAPER}
      />
      <circle cx={0} cy={-26} r={5.5} fill="none" />
    </g>
  );
}
