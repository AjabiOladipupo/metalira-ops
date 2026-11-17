import {
  Accent,
  Bubble,
  Calculator,
  CardStack,
  Clipboard,
  Icon,
  INK,
  MapPin,
  NairaNote,
  PAPER,
  Person,
  Phone,
} from "./ink";
import { FoldedMap } from "./later";
import type { Scene } from "./types";

/** A mop, handle top at 0,0, standing `h` tall. Person coordinates of whoever holds it. */
function Mop({ h }: { h: number }) {
  return (
    <g>
      <path d={`M0 0 L0 ${h - 12}`} fill="none" />
      <path
        d={`M-3 ${h - 13} H3 L9 ${h} H-9 Z M-5 ${h - 7} L-6 ${h} M0 ${h - 7} V${h} M5 ${h - 7} L6 ${h}`}
        fill={PAPER}
      />
    </g>
  );
}

/** A taped parcel, centred on 0,0. */
function Parcel({ w = 34, h = 24 }: { w?: number; h?: number }) {
  return (
    <g>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={1.5} fill={PAPER} />
      <path d={`M-4 ${-h / 2} V${-h / 2 + 8} M4 ${-h / 2} V${-h / 2 + 8}`} fill="none" />
      <path d={`M${w / 2 - 12} ${h / 2 - 5} H${w / 2 - 4}`} fill="none" />
    </g>
  );
}

/** Scenes for the public landing pages. */
export const LANDING_SCENES = {
  "hero-crew": {
    viewBox: [480, 320],
    size: "hero",
    label:
      "A crew at work: a security guard in a cap, a cleaner in an apron with a mop, a supervisor with a clipboard and a rider in a helmet carrying a parcel",
    draw: (lw) => (
      <>
        <Person
          x={64}
          y={314}
          s={1.66}
          lw={lw}
          hair="cap"
          top="guard"
          left="down"
          right="wave"
          face="grin"
        />
        <Person
          x={180}
          y={314}
          s={1.66}
          lw={lw}
          hair="wrap"
          top="apron"
          left="down"
          right="down"
          held={
            <g transform="translate(25 -112)">
              <Mop h={112} />
            </g>
          }
        />
        <Person
          x={300}
          y={314}
          s={1.66}
          lw={lw}
          hair="short"
          top="polo"
          glasses
          left="chest"
          right="low"
          held={
            <g transform="translate(-2 -90) rotate(-5)">
              <Clipboard w={26} h={34} />
            </g>
          }
        />
        <Person
          x={414}
          y={314}
          s={1.66}
          lw={lw}
          hair="helmet"
          top="vest"
          left="low"
          right="low"
          held={
            <g transform="translate(0 -66)">
              <Parcel w={36} h={24} />
            </g>
          }
        />
        <Bubble cx={244} cy={62} r={22} toward={[280, 80]} lw={lw}>
          <Icon.check />
        </Bubble>
      </>
    ),
  },
  "role-owner": {
    viewBox: [200, 160],
    size: "empty",
    label: "A manager pointing at a chart that rises",
    draw: (lw) => (
      <>
        <path d="M146 98 L140 156 M146 98 L152 156" fill="none" />
        <rect x={102} y={26} width={88} height={72} rx={2} fill={PAPER} />
        <path d="M112 88 H180" fill="none" />
        <path d="M118 88 V72 M134 88 V64 M150 88 V56" fill="none" strokeWidth={lw * 3} />
        <Accent>
          <path d="M166 88 V42" fill="none" strokeWidth={lw * 3} />
        </Accent>
        <path d="M114 62 L132 50 L146 54 L172 34 M164 34 H172 V42" fill="none" />
        <Person
          x={54}
          y={157}
          s={0.9}
          lw={lw}
          hair="short"
          top="jacket"
          glasses
          left="hip"
          right="point"
        />
      </>
    ),
  },
  "role-hr": {
    viewBox: [200, 160],
    size: "empty",
    label: "An HR officer holding a stack of staff profile cards",
    draw: (lw) => (
      <>
        <g transform="translate(38 52) rotate(-10)">
          <CardStack w={30} h={21} />
        </g>
        <g transform="translate(164 60) rotate(8)">
          <CardStack w={30} h={21} />
        </g>
        <Person
          x={100}
          y={157}
          s={0.93}
          lw={lw}
          hair="afro"
          top="blouse"
          bottom="skirt"
          left="chest"
          right="chest"
          face="grin"
          held={
            <g>
              <g transform="translate(0 -86)">
                <CardStack w={36} h={25} />
              </g>
              <Accent>
                <circle cx={24} cy={-106} r={6} fill={PAPER} />
                <path d="M21 -106 L23 -104 L27 -108.5" fill="none" />
              </Accent>
            </g>
          }
        />
      </>
    ),
  },
  "role-finance": {
    viewBox: [200, 160],
    size: "empty",
    label: "A finance officer with a calculator in one hand and a naira note in the other",
    draw: (lw) => (
      <>
        <Person
          x={92}
          y={157}
          s={0.93}
          lw={lw}
          hair="wrap"
          top="jacket"
          left="chest"
          right="point"
          face="grin"
          held={
            <g>
              <g transform="translate(-6 -88)">
                <Calculator w={20} h={27} />
              </g>
              <g transform="translate(54 -130) rotate(-14)">
                <Accent>
                  <NairaNote w={32} h={17} />
                </Accent>
              </g>
            </g>
          }
        />
      </>
    ),
  },
  "role-operations": {
    viewBox: [200, 160],
    size: "empty",
    label: "A supervisor with a clipboard pointing at a map pin",
    draw: (lw) => (
      <>
        <g transform="translate(160 124)">
          <FoldedMap />
        </g>
        <g transform="translate(160 126)">
          <MapPin h={58} lw={lw} />
        </g>
        <Accent>
          <circle cx={160} cy={88} r={4.2} fill={INK} stroke="none" />
        </Accent>
        <Person
          x={74}
          y={157}
          s={0.93}
          lw={lw}
          hair="beard"
          top="vest"
          left="chest"
          right="point"
          held={
            <g transform="translate(-4 -88) rotate(-8)">
              <Clipboard w={24} h={32} />
            </g>
          }
        />
      </>
    ),
  },
  "role-worker": {
    viewBox: [200, 160],
    size: "empty",
    label: "A worker in a hi-vis vest tapping a phone, and a clock in a speech bubble",
    draw: (lw) => (
      <>
        <Person
          x={88}
          y={157}
          s={0.93}
          lw={lw}
          hair="puff"
          top="vest"
          left="chest"
          right="chest"
          held={
            <g transform="translate(-3 -99) rotate(-6)">
              <Phone w={19} h={31} />
            </g>
          }
        />
        <Bubble cx={150} cy={40} r={16} toward={[110, 36]} lw={lw}>
          <Icon.clock />
        </Bubble>
      </>
    ),
  },
} satisfies Record<string, Scene>;
