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
 * Looseness: every body outline goes through `sketch()`, which moves points by a seeded wobble,
 * bows long straight lines and applies the person's build, stance and tilt, so people in a group
 * read as individuals rather than copies of one template.
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
// Hand-drawn looseness
// ---------------------------------------------------------------------------------------------

/** A repeatable random number in [-1, 1) for a seed and an index (integer maths only). */
export function jitter(seed: number, i: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

const TOKENS = /[MLCHVZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g;
const ARITY: Record<string, number> = { M: 2, L: 2, C: 6, H: 1, V: 1, Z: 0 };
const f2 = (n: number) => n.toFixed(2);

/**
 * Redraws an absolute path (M, L, C, H, V, Z) by hand: every point goes through `map` (a body's
 * build and stance), then moves up to `amp` units from a seed, and straight lines longer than 8
 * units bow slightly, so no two people share the same exact outline.
 */
export function sketch(
  d: string,
  map: (x: number, y: number) => Pt,
  seed: number,
  amp = 0.8,
): string {
  const tokens = d.match(TOKENS) ?? [];
  let i = 0;
  let n = 0;
  let cmd = "M";
  let cur: Pt = [0, 0];
  let curOut: Pt = [0, 0];
  let out = "";
  const take = () => Number(tokens[i++]);
  const point = (x: number, y: number): Pt => {
    const [mx, my] = map(x, y);
    const k = n++;
    return [mx + jitter(seed, 2 * k) * amp, my + jitter(seed, 2 * k + 1) * amp];
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t in ARITY) {
      cmd = t;
      i++;
      if (cmd === "Z") {
        out += " Z";
        continue;
      }
    } else if (cmd === "Z") {
      throw new Error(`sketch: numbers after Z in "${d}"`);
    }
    if (cmd === "M") {
      cur = [take(), take()];
      curOut = point(...cur);
      out += ` M${f2(curOut[0])} ${f2(curOut[1])}`;
      cmd = "L";
    } else if (cmd === "C") {
      const p1 = point(take(), take());
      const p2 = point(take(), take());
      cur = [take(), take()];
      curOut = point(...cur);
      out += ` C${f2(p1[0])} ${f2(p1[1])} ${f2(p2[0])} ${f2(p2[1])} ${f2(curOut[0])} ${f2(curOut[1])}`;
    } else {
      cur = cmd === "H" ? [take(), cur[1]] : cmd === "V" ? [cur[0], take()] : [take(), take()];
      const to = point(...cur);
      const dx = to[0] - curOut[0];
      const dy = to[1] - curOut[1];
      const len = Math.hypot(dx, dy);
      if (len > 8) {
        const bow = jitter(seed, 5000 + n) * Math.min(len * 0.04, 1.6);
        const px = (-dy / len) * bow;
        const py = (dx / len) * bow;
        out += ` C${f2(curOut[0] + dx / 3 + px)} ${f2(curOut[1] + dy / 3 + py)} ${f2(curOut[0] + (2 * dx) / 3 + px * 0.6)} ${f2(curOut[1] + (2 * dy) / 3 + py * 0.6)} ${f2(to[0])} ${f2(to[1])}`;
      } else {
        out += ` L${f2(to[0])} ${f2(to[1])}`;
      }
      curOut = to;
    }
  }
  return out.trim();
}

const SAME = (x: number, y: number): Pt => [x, y];

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
  | "helmet"; // dispatch rider's open-face helmet, visor up

export type Top =
  | "shirt"
  | "polo"
  | "guard" // shirt, tie, epaulettes
  | "apron" // cleaner's bib apron over a shirt
  | "vest" // hi-vis vest with reflective bands
  | "jacket"
  | "blouse"; // long patterned top

export type Face = "smile" | "grin" | "calm";

/** -1 turned three-quarters to the viewer's left, 0 facing out, 1 turned to the viewer's right. */
export type Turn = -1 | 0 | 1;

/** Body width and height relative to the regular build. The head stays the same size. */
const BUILDS = {
  regular: [1, 1],
  slim: [0.86, 1.03],
  wide: [1.2, 0.98],
  tall: [0.93, 1.08],
  short: [1.06, 0.93],
} as const satisfies Record<string, readonly [number, number]>;

export type Build = keyof typeof BUILDS;

/**
 * Where the feet go (added to each foot's x) and how high the crotch sits. A lean puts the weight
 * on one leg: that hip rises and slides over the standing foot, the other leg steps out.
 */
const STANCES = {
  together: { l: 0, r: 0, crotch: -46, hip: 0, tilt: 0 },
  apart: { l: -6, r: 6, crotch: -43, hip: 0, tilt: 0 },
  "lean-left": { l: -1, r: 10, crotch: -44, hip: -2.5, tilt: 0.07 },
  "lean-right": { l: -10, r: 1, crotch: -44, hip: 2.5, tilt: -0.07 },
} as const;

export type Stance = keyof typeof STANCES;

/**
 * Arm poses for the viewer's right arm, from the shoulder, in person coordinates (feet at 0,
 * head top at -150). The left arm uses the same pose mirrored.
 */
const ARMS = {
  down: { d: "M17 -104 C23 -94 25 -80 24 -67", hand: [24, -63] },
  wave: { d: "M17 -104 C27 -106 32 -116 33 -128", hand: [34, -133] },
  chest: { d: "M17 -104 C25 -94 22 -84 11 -82", hand: [8, -82] },
  low: { d: "M17 -104 C24 -92 22 -78 12 -72", hand: [9, -71] },
  /** Both hands on the bottom corners of something held in front of the chest. */
  hold: { d: "M17 -104 C25 -94 26 -82 18 -73", hand: [16, -72] },
  carry: { d: "M17 -104 C25 -92 27 -72 21 -58", hand: [19.5, -55.5] },
  point: { d: "M17 -104 C28 -104 38 -110 45 -118", hand: [48, -121] },
  reach: { d: "M17 -104 C24 -92 30 -86 40 -84", hand: [44, -84] },
  thumb: { d: "M17 -104 C26 -94 31 -88 30 -100", hand: [30, -104], thumb: "M30.5 -108 L31 -114" },
  hip: { d: "M17 -104 L28 -88 L20 -74", hand: [19, -72] },
  face: { d: "M17 -104 C27 -94 26 -88 16 -100", hand: [13, -103] },
} as const satisfies Record<string, { d: string; hand: Pt; thumb?: string }>;

export type ArmPose = keyof typeof ARMS;

/** An ellipse as four curves, so it can be redrawn by hand. */
function ovalPath(rx: number, ry: number): string {
  const k = 0.5523;
  return `M0 ${-ry} C${k * rx} ${-ry} ${rx} ${-k * ry} ${rx} 0 C${rx} ${k * ry} ${k * rx} ${ry} 0 ${ry} C${-k * rx} ${ry} ${-rx} ${k * ry} ${-rx} 0 C${-rx} ${-k * ry} ${-k * rx} ${-ry} 0 ${-ry} Z`;
}

/** Heaviest line (in head units) at which a grin still reads as an open mouth. */
export const GRIN_MAX_LINE = 1.9;

/** A head centred on 0,0 (face about 24 wide, 29 tall). */
export function Head({
  hair,
  face = "smile",
  glasses = false,
  turn = 0,
  seed = 1,
  lw,
}: {
  hair: Hair;
  face?: Face;
  glasses?: boolean;
  turn?: Turn;
  seed?: number;
  lw: number;
}) {
  const bearded = hair === "beard";
  const mouthInk = bearded ? PAPER : INK;
  // Each face is a slightly different oval, and a turned face moves its features to one side.
  const rx = 12 + jitter(seed, 901) * 0.5;
  const ry = 14.5 + jitter(seed, 902) * 0.6;
  const fx = turn * 3;
  const eye = turn === 0 ? 4.6 : 3.8;
  const chin = (x: number, y: number): Pt => [x + (y > 0 ? (turn * 1.6 * y) / ry : 0), y];
  // A grin is 10 units wide and under 5 tall. Once the line is heavy for the face (a person drawn
  // small, as in the 160px scenes), its outline and teeth close into a dark blob, so it is drawn
  // as an open smile instead.
  const grin = face === "grin" && lw <= GRIN_MAX_LINE;
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
      {hair === "puff" ? <circle cx={-turn * 2} cy={-20} r={8.5} fill={INK} /> : null}

      {/* Ears (a turned head hides the far one) and face */}
      {turn === 1 ? null : (
        <path d={sketch("M-11.5 -3 C-16 -4 -16 4 -11 4.5", SAME, seed + 1, 0.4)} fill={PAPER} />
      )}
      {turn === -1 ? null : (
        <path d={sketch("M11.5 -3 C16 -4 16 4 11 4.5", SAME, seed + 2, 0.4)} fill={PAPER} />
      )}
      <path d={sketch(ovalPath(rx, ry), chin, seed + 3, 0.5)} fill={PAPER} />

      {/* Hair and headwear on top */}
      {hair === "short" || hair === "beard" || hair === "puff" || hair === "braids" ? (
        <path
          d={sketch(
            "M-12.3 -1 C-13.5 -12 -8 -17.5 0 -17.5 C8 -17.5 13.5 -12 12.3 -1 C11 -7 8 -10 3 -10 L-3 -10 C-8 -10 -11 -7 -12.3 -1 Z",
            (x, y) => [x + (y > -12 ? fx * 0.3 : 0), y],
            seed + 4,
            0.4,
          )}
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
          {/* A snug wrap tied off centre at the front-top: one twisted knot, a long end flaring
              up and out to one side and a short end lying back over the crown */}
          <path d="M6 -25 C9.5 -31.5 15.5 -33.5 18.5 -30.5 C15 -29.5 12 -27 9 -22 Z" fill={INK} />
          <path d="M3 -25 C0.5 -29 -3.5 -30 -6 -28 C-3 -27.5 -0.5 -25.5 1.5 -22.5 Z" fill={INK} />
          <path
            d={sketch(
              "M-13.2 -1 C-16 -16 -9 -23.5 0 -23.5 C9 -23.5 16 -16 13.2 -1 C8 -8 -8 -8 -13.2 -1 Z",
              SAME,
              seed + 5,
              0.4,
            )}
            fill={INK}
          />
          <circle cx={4.5} cy={-24.5} r={3.6} fill={INK} />
          <path d="M1 -21.5 C2.5 -19.6 6.5 -19.6 8 -21.5" fill="none" stroke={PAPER} />
          <path d="M0.5 -19 C-3.5 -17.5 -8 -14.5 -10.5 -9.5" fill="none" stroke={PAPER} />
          <path d="M-9 -10 C-4 -14.5 4 -14.5 9 -10" fill="none" stroke={PAPER} />
        </g>
      ) : null}
      {hair === "cap" ? (
        <g>
          <path
            d={sketch("M-13 -5 C-14 -20 -6 -25 1 -24.5 C9 -24 14 -18 13 -5 Z", SAME, seed + 6, 0.4)}
            fill={INK}
          />
          <path d="M-13.5 -5 C-6 1 6 1 13.5 -5 C6 -2 -6 -2 -13.5 -5 Z" fill={INK} />
          <circle cx={fx * 0.7} cy={-14} r={2.8} fill={PAPER} stroke="none" />
        </g>
      ) : null}
      {hair === "helmet" ? (
        <g>
          {/* Shell over the ears and down to the jaw, with an open face window */}
          <path
            d={sketch(
              "M-16 10 C-20 -12 -11 -27 0 -27 C11 -27 20 -12 16 10 C14 11.5 12 11.5 10.6 10 C11.4 2 11.2 -5 10.2 -9 C6 -12 -6 -12 -10.2 -9 C-11.2 -5 -11.4 2 -10.6 10 C-12 11.5 -14 11.5 -16 10 Z",
              SAME,
              seed + 7,
              0.4,
            )}
            fill={PAPER}
          />
          {/* Tinted visor, flipped up */}
          <path d="M-15.5 -8 C-15 -18 15 -18 15.5 -8 C9 -13.5 -9 -13.5 -15.5 -8 Z" fill={INK} />
          <circle cx={-15.3} cy={-4} r={1.9} fill={PAPER} />
          <circle cx={15.3} cy={-4} r={1.9} fill={PAPER} />
          {/* Chin strap */}
          <path d="M-13.5 8.5 C-10 16.5 10 16.5 13.5 8.5" fill="none" />
        </g>
      ) : null}
      {bearded ? (
        <path
          d="M-12 0 C-11.5 12 -6 17 0 17 C6 17 11.5 12 12 0 C9.5 7 5 9 0 9 C-5 9 -9.5 7 -12 0 Z"
          fill={INK}
        />
      ) : null}

      {/* Features */}
      <g transform={fx ? `translate(${fx} 0)` : undefined}>
        <path
          d={`M${-eye - 2.9} -5.5 C${-eye - 1.4} -7 ${-eye + 0.6} -7 ${-eye + 2.1} -6`}
          fill="none"
        />
        <path
          d={`M${eye + 2.9} -5.5 C${eye + 1.4} -7 ${eye - 0.6} -7 ${eye - 2.1} -6`}
          fill="none"
        />
        <Dot x={-eye} y={-1.2} r={1.5} />
        <Dot x={eye} y={-1.2} r={1.5} />
        {turn === 0 ? (
          <path d="M-2.4 5.2 C-1 6.4 1 6.4 2.4 5.2" fill="none" />
        ) : (
          <path
            d={`M${turn * 0.6} -2 C${turn * 3.6} 3 ${turn * 3.8} 5.4 ${turn * 0.4} 5.8`}
            fill="none"
          />
        )}
        {grin ? (
          // An open mouth drawn as an outline, never a solid shape: in dark mode a filled mouth
          // would turn into a bright white grin on a dark face.
          <g>
            <path d="M-5 9 C-2 13.8 2 13.8 5 9 Z" fill={PAPER} stroke={bearded ? PAPER : INK} />
            <path d="M-3.4 10.4 H3.4" fill="none" stroke={INK} strokeWidth={lw * 0.7} />
          </g>
        ) : face === "calm" ? (
          <path d="M-3 10.5 C-1 11.5 1 11.5 3 10.5" fill="none" stroke={mouthInk} />
        ) : (
          <path d="M-4.5 9.5 C-2 12.5 2 12.5 4.5 9.5" fill="none" stroke={mouthInk} />
        )}
        {glasses ? (
          <g fill="none">
            <circle cx={-eye - 0.2} cy={-1.2} r={4} />
            <circle cx={eye + 0.2} cy={-1.2} r={4} />
            <path d={`M${-eye + 3.8} -1.5 L${eye - 3.8} -1.5`} />
          </g>
        ) : null}
      </g>
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
          {/* Print: short slanted strokes scattered unevenly, so no two marks pair up as eyes */}
          <path
            d="M-14 -99 l3 -3 M4 -100 l3 -3 M-6 -92 l3 -3 M12 -91 l3 -3 M-16 -84 l3 -3 M1 -84 l3 -3 M15 -76 l3 -3 M-18 -64 l3 -3 M14 -55 l3 -3"
            fill="none"
          />
        </g>
      );
  }
}

/** A shoe centred on `xc`, toe pointing `dir` (-1 left, 1 right), sole on y = 0. */
function shoe(xc: number, dir: number): string {
  const x = (v: number) => xc + dir * v;
  return `M${x(5)} -7 L${x(-8.5)} -7 C${x(-10)} -4 ${x(-10)} -2 ${x(-9.5)} 0 L${x(9.5)} 0 C${x(10.5)} -4 ${x(8.5)} -6.5 ${x(5)} -7 Z`;
}

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
  /** Body shape: give each person in a group a different one. */
  build?: Build;
  stance?: Stance;
  /** Head and chest turned three-quarters to one side. */
  turn?: Turn;
  /** Seeds the hand-drawn wobble; defaults to one worked out from the position. */
  seed?: number;
  /** Seated behind something: no legs (the scene draws the desk over the hips). */
  seated?: boolean;
  /** Drawn first, behind the body (a mop handle, a bag). Person coordinates. */
  behind?: React.ReactNode;
  /** Drawn over the arms and under the hands (whatever the hands hold). Person coordinates. */
  held?: React.ReactNode;
};

/**
 * A standing (or seated) person. Person coordinates: feet at 0,0, head top at about -150.
 * Every outline is redrawn by `sketch` through the person's build and stance, with a wobble from
 * the seed, and the shoulders and hips tilt a little, so no two people are the same drawing.
 */
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
  build = "regular",
  stance = "together",
  turn = 0,
  seed: seedProp,
  seated = false,
  behind,
  held,
}: PersonProps) {
  const l = lw / s;
  const seed = seedProp ?? Math.round(x * 31 + y * 17);
  const [bw, bh] = BUILDS[build];
  const st = STANCES[stance];
  // Shoulder and hip tilt: the stance sets it, the seed adds a little.
  const tilt = st.tilt + jitter(seed, 777) * 0.035;
  const hx = st.hip;
  const amp = 1.1;

  /** Upper body: build, hip shift and tilt. */
  const upper = (px: number, py: number): Pt => [bw * px + hx, bh * py + tilt * px];
  const upperL = (px: number, py: number): Pt => upper(-px, py);
  /** Legs: full build and tilt at the hips, easing to level feet on the ground. */
  const footW = 1 + (bw - 1) * 0.5;
  const legs = (px: number, py: number): Pt => {
    if (py > -7) return [px * footW, py];
    const k = Math.min(1, (-py - 7) / 57);
    return [
      px * (footW + (bw - footW) * k) + hx * k,
      -7 + ((py + 7) * (64 * bh - 7)) / 57 + tilt * px * k,
    ];
  };

  const trousers = `M-17.5 -64 L17.5 -64 L${16 + st.r} -7 L${3 + st.r} -7 L0.6 ${st.crotch} L-0.6 ${st.crotch} L${-3 + st.l} -7 L${-16 + st.l} -7 Z`;
  const feet: [number, number][] = [
    [-11.5 + st.l, turn || -1],
    [11.5 + st.r, turn || 1],
  ];

  // Shirt details follow the body; a turned chest moves them toward the turn.
  const sc = turn ? 0.88 : 1;
  const ox = turn * 3.5;
  const details = `matrix(${f2(bw * sc)} ${(tilt * sc).toFixed(4)} 0 ${f2(bh)} ${f2(bw * ox + hx)} ${(tilt * ox).toFixed(3)})`;

  const [neckX, neckY] = upper(0, -133);
  const headTilt = jitter(seed, 778) * 4 - turn * 2;

  const arm = (pose: ArmPose, map: (px: number, py: number) => Pt, k: number) => (
    <Tube d={sketch(ARMS[pose].d, map, seed + k, amp)} w={9} lw={l} />
  );
  const hand = (pose: ArmPose, mirror: boolean) => {
    const a: { hand: Pt; thumb?: string } = ARMS[pose];
    const map = mirror ? upperL : upper;
    const [hxp, hyp] = map(a.hand[0], a.hand[1]);
    return (
      <g>
        <circle cx={hxp} cy={hyp} r={4.6} fill={PAPER} />
        {a.thumb ? <Tube d={sketch(a.thumb, map, seed + 40, 0)} w={3.2} lw={l} /> : null}
      </g>
    );
  };

  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} strokeWidth={l}>
      {behind}
      {seated ? null : bottom === "skirt" ? (
        <g>
          <Tube
            d={sketch(`M${-7 + st.l * 0.6} -30 L${-8 + st.l} -8`, legs, seed + 10, 0.4)}
            w={7}
            lw={l}
          />
          <Tube
            d={sketch(`M${7 + st.r * 0.6} -30 L${8 + st.r} -8`, legs, seed + 11, 0.4)}
            w={7}
            lw={l}
          />
          <path
            d={sketch("M-18 -64 L18 -64 L21.5 -28 L-21.5 -28 Z", legs, seed + 12, amp)}
            fill={INK}
          />
        </g>
      ) : (
        <path d={sketch(trousers, legs, seed + 13, amp)} fill={INK} />
      )}
      {seated
        ? null
        : feet.map(([fxp, dir], i) => (
            <path key={fxp} d={sketch(shoe(fxp, dir), legs, seed + 20 + i, 0.5)} fill={PAPER} />
          ))}
      <Tube d={sketch("M0 -121 L0 -106", upper, seed + 30, 0.3)} w={8.5} lw={l} />
      <path
        d={sketch(top === "blouse" || top === "apron" ? LONG_TORSO : TORSO, upper, seed + 31, amp)}
        fill={PAPER}
      />
      <g transform={details}>
        <TopDetails top={top} lw={l} />
      </g>
      <g transform={`translate(${f2(neckX)} ${f2(neckY)}) rotate(${headTilt.toFixed(2)})`}>
        <Head hair={hair} face={face} glasses={glasses} turn={turn} seed={seed} lw={l} />
      </g>
      {arm(left, upperL, 32)}
      {arm(right, upper, 33)}
      {held}
      {hand(left, true)}
      {hand(right, false)}
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
