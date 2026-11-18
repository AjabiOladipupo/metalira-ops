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

/**
 * A wet mop, handle top at 0,0, standing `h` tall: a short head bar with a tangle of strands
 * hanging from it in loops to the floor. Person coordinates of whoever holds it.
 */
function Mop({ h }: { h: number }) {
  const bar = h - 17;
  const top = bar + 3.5;
  // The tangle: straight sides, a bottom edge of five loops lying on the floor.
  const tangle = `M-8 ${top} C-10 ${top + 5} -11 ${h - 5} -11.5 ${h - 1.5} C-10 ${h + 1} -7.5 ${h + 1} -6.8 ${h - 1.5} C-5.6 ${h + 1} -2.6 ${h + 1} -2.2 ${h - 1.5} C-1 ${h + 1} 2 ${h + 1} 2.4 ${h - 1.5} C3.6 ${h + 1} 6.4 ${h + 1} 7 ${h - 1.5} C8 ${h + 1} 10.6 ${h + 1} 11.5 ${h - 1.5} C11 ${h - 5} 10 ${top + 5} 8 ${top} Z`;
  const strands = `M-4.5 ${top} C-5.5 ${top + 4} -4 ${top + 8} -6.8 ${h - 1.5} M0 ${top} C1 ${top + 4} -1.5 ${top + 8} -0.2 ${h - 1.5} M4.5 ${top} C3.5 ${top + 4} 6 ${top + 8} 4.8 ${h - 1.5}`;
  return (
    <g>
      <path d={`M0 0 L0 ${bar}`} fill="none" />
      <path d={tangle} fill={PAPER} />
      <path d={strands} fill="none" />
      <rect x={-9} y={bar} width={18} height={3.5} rx={1.5} fill={PAPER} />
    </g>
  );
}

/**
 * A taped parcel seen from a little above: front face centred on 0,0, the top face behind it
 * with a tape cross, a tape strip down the front and a label.
 */
function Parcel({ w = 34, h = 24 }: { w?: number; h?: number }) {
  const x = w / 2;
  const t = -h / 2;
  return (
    <g>
      <path d={`M${-x} ${t} L${-x + 4} ${t - 7} H${x - 4} L${x} ${t} Z`} fill={PAPER} />
      <path d={`M0 ${t - 7} V${t} M${-x + 2} ${t - 3.5} H${x - 2}`} fill="none" />
      <rect x={-x} y={t} width={w} height={h} rx={1} fill={PAPER} />
      <path d={`M0 ${t} V${t + 8}`} fill="none" />
      <path d={`M${x - 13} ${h / 2 - 9} H${x - 4} V${h / 2 - 4} H${x - 13} Z`} fill="none" />
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
          build="wide"
          stance="apart"
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
          build="slim"
          stance="lean-right"
          turn={1}
          left="down"
          right="down"
          held={
            <g transform="translate(16 -112) rotate(-8)">
              <Mop h={113} />
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
          build="tall"
          turn={-1}
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
          build="short"
          stance="lean-left"
          left="carry"
          right="carry"
          held={
            <g transform="translate(-2.5 -66) rotate(4)">
              <Parcel w={38} h={22} />
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
          build="wide"
          stance="lean-left"
          turn={1}
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
          build="tall"
          left="hold"
          right="hold"
          held={
            <g>
              <g transform="translate(0 -84)">
                <CardStack w={34} h={24} />
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
          build="short"
          stance="apart"
          turn={1}
          left="chest"
          right="point"
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
          build="wide"
          stance="lean-left"
          turn={1}
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
  "lira-chat": {
    viewBox: [200, 160],
    size: "empty",
    label:
      "A manager typing on a phone, her chat message beside her and a reply card with a confirm button",
    draw: (lw) => (
      <>
        {/* Her message: a rounded bubble with two lines of text, its tail toward her. */}
        <path
          d="M118 14 H178 C183 14 186 17 186 22 V36 C186 41 183 44 178 44 H122 L106 52 L113 42 C110.5 40.5 110 38.5 110 36 V22 C110 17 113 14 118 14 Z"
          fill={PAPER}
        />
        <path d="M120 25 H176 M120 33 H158" fill="none" />
        {/* The reply: what will change, a cancel button and the confirm button (the accent). */}
        <rect x={100} y={60} width={90} height={62} rx={6} fill={PAPER} />
        <path d="M110 72 H146" fill="none" />
        <path d="M110 82 l1.6 1.6 l3 -3.2 M120 82 H178" fill="none" />
        <path d="M110 92 l1.6 1.6 l3 -3.2 M120 92 H168" fill="none" />
        <rect x={150} y={102} width={30} height={12} rx={3} fill="none" />
        <path d="M159 108 H171" fill="none" />
        <Accent>
          <rect x={108} y={102} width={36} height={12} rx={3} fill={PAPER} />
          <path d="M121 108.2 L124.5 111.6 L131 104.8" fill="none" />
        </Accent>
        <Person
          x={58}
          y={157}
          s={0.93}
          lw={lw}
          hair="braids"
          top="jacket"
          stance="lean-left"
          turn={1}
          left="chest"
          right="chest"
          held={
            <g transform="translate(-3 -99) rotate(-6)">
              <Phone w={19} h={31} />
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
          build="slim"
          stance="lean-right"
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
