import {
  Accent,
  Bubble,
  Clipboard,
  Envelope,
  Icon,
  INK,
  LaptopBack,
  MapPin,
  PAPER,
  Person,
  Phone,
  Slip,
  Suitcase,
} from "./ink";
import type { Scene } from "./types";

/** A folded paper map lying flat, centred on 0,0. */
export function FoldedMap() {
  return (
    <g>
      <path d="M-28 8 L-12 -2 L6 4 L28 -6 L30 10 L12 20 L-6 14 L-26 24 Z" fill={PAPER} />
      <path d="M-12 -2 L-6 14 M6 4 L12 20" fill="none" />
    </g>
  );
}

/** Scenes for empty states and onboarding in later phases (drawn now, wired as phases ship). */
export const LATER_SCENES = {
  "no-clients": {
    viewBox: [160, 160],
    size: "empty",
    label: "A person pointing at a map pin",
    draw: (lw) => (
      <>
        <Person x={48} y={157} s={0.9} lw={lw} hair="short" top="polo" left="hip" right="point" />
        <g transform="translate(124 124)">
          <FoldedMap />
        </g>
        <g transform="translate(124 126)">
          <MapPin h={58} lw={lw} />
        </g>
        <Accent>
          <circle cx={124} cy={88} r={4.2} fill={INK} stroke="none" />
        </Accent>
      </>
    ),
  },
  "roster-empty": {
    viewBox: [160, 160],
    size: "empty",
    label: "A person with a clipboard, and a calendar in a speech bubble",
    draw: (lw) => (
      <>
        <Person
          x={66}
          y={157}
          s={0.93}
          lw={lw}
          hair="wrap"
          top="shirt"
          left="chest"
          right="low"
          held={
            <g transform="translate(-1 -90) rotate(-6)">
              <Clipboard w={26} h={34} />
            </g>
          }
        />
        <Bubble cx={126} cy={40} r={16} toward={[88, 34]} lw={lw}>
          <Icon.calendar />
        </Bubble>
      </>
    ),
  },
  "all-covered": {
    viewBox: [160, 160],
    size: "empty",
    label: "A guard, a cleaner and a rider standing together, with a thumbs up in a speech bubble",
    draw: (lw) => (
      <>
        <Person x={30} y={157} s={0.62} lw={lw} hair="cap" top="guard" left="down" right="down" />
        <Person x={130} y={157} s={0.62} lw={lw} hair="helmet" top="vest" left="down" right="hip" />
        <Person
          x={80}
          y={157}
          s={0.64}
          lw={lw}
          hair="wrap"
          top="apron"
          left="down"
          right="thumb"
          face="grin"
        />
        <Bubble cx={118} cy={34} r={14} toward={[92, 58]} lw={lw}>
          <Icon.thumb />
        </Bubble>
      </>
    ),
  },
  offline: {
    viewBox: [160, 160],
    size: "empty",
    label: "A person looking at a phone, and a crossed-out cloud in a speech bubble",
    draw: (lw) => (
      <>
        <Person
          x={66}
          y={157}
          s={0.93}
          lw={lw}
          hair="beard"
          top="shirt"
          left="chest"
          right="chest"
          face="calm"
          held={
            <g transform="translate(0 -90)">
              <Phone w={16} h={26} />
            </g>
          }
        />
        <Bubble cx={126} cy={40} r={16} toward={[88, 34]} lw={lw}>
          <Icon.cloudOff />
        </Bubble>
      </>
    ),
  },
  "leave-empty": {
    viewBox: [160, 160],
    size: "empty",
    label: "A person carrying a suitcase, and a sun in a speech bubble",
    draw: (lw) => (
      <>
        <Person
          x={66}
          y={157}
          s={0.93}
          lw={lw}
          hair="puff"
          top="polo"
          left="wave"
          right="down"
          face="grin"
          held={
            <g transform="translate(26 -44)">
              <Suitcase w={30} h={24} />
            </g>
          }
        />
        <Bubble cx={128} cy={38} r={16} toward={[88, 36]} lw={lw}>
          <Icon.sun />
        </Bubble>
      </>
    ),
  },
  "payroll-ready": {
    viewBox: [160, 160],
    size: "empty",
    label: "A finance officer at a laptop, and a naira sign in a speech bubble",
    draw: (lw) => (
      <>
        <Person
          x={96}
          y={158}
          s={0.95}
          lw={lw}
          hair="short"
          top="jacket"
          glasses
          left="low"
          right="low"
          seated
        />
        <g transform="translate(96 100)">
          <LaptopBack w={44} h={30} />
        </g>
        <path d="M10 100 H150 V107 H10 Z" fill={PAPER} />
        <path d="M20 107 V156 M140 107 V156" fill="none" />
        <path d="M24 100 V95 H44 V100 M27 95 V90 H41 V95" fill={PAPER} />
        <Bubble cx={36} cy={42} r={16} toward={[76, 36]} lw={lw}>
          <Icon.naira />
        </Bubble>
      </>
    ),
  },
  "payslip-empty": {
    viewBox: [140, 120],
    size: "worker",
    label: "A worker in a hi-vis vest reading a payslip",
    draw: (lw) => (
      <>
        <Person
          x={70}
          y={168}
          s={1}
          lw={lw}
          hair="short"
          top="vest"
          left="chest"
          right="chest"
          face="calm"
          held={
            <g transform="translate(0 -97)">
              <Slip w={28} h={36} />
              <Accent>
                <path d="M-4 5 L-1.5 7.5 L4 2" fill="none" />
              </Accent>
            </g>
          }
        />
      </>
    ),
  },
  "no-invoices": {
    viewBox: [160, 160],
    size: "empty",
    label: "A person holding out an envelope",
    draw: (lw) => (
      <>
        <Person
          x={64}
          y={157}
          s={0.93}
          lw={lw}
          hair="braids"
          top="blouse"
          bottom="skirt"
          left="hip"
          right="reach"
          held={
            <g transform="translate(52 -90)">
              <Envelope w={32} h={22} />
              <Accent>
                <circle cx={0} cy={2.6} r={3} fill={INK} stroke="none" />
              </Accent>
            </g>
          }
        />
      </>
    ),
  },
  "all-collected": {
    viewBox: [160, 160],
    size: "empty",
    label: "A person holding up a receipt, and a tick in a speech bubble",
    draw: (lw) => (
      <>
        <Person
          x={72}
          y={157}
          s={0.93}
          lw={lw}
          hair="beard"
          top="polo"
          left="hip"
          right="reach"
          face="grin"
          held={
            <g transform="translate(46 -100)">
              <Slip w={24} h={32} />
            </g>
          }
        />
        <Bubble cx={28} cy={40} r={16} toward={[60, 34]} lw={lw}>
          <Icon.check />
        </Bubble>
      </>
    ),
  },
  "no-projects": {
    viewBox: [160, 160],
    size: "empty",
    label: "Two people planning at a whiteboard",
    draw: (lw) => (
      <>
        <path d="M66 86 L60 156 M96 86 L102 156" fill="none" />
        <rect x={50} y={28} width={62} height={58} rx={2} fill={PAPER} />
        <path d="M58 40 H72 V50 H58 Z M88 58 H102 V68 H88 Z" fill="none" />
        <path d="M72 45 C80 45 82 50 82 56 M80 53 L82 57 L85 53" fill="none" />
        <path d="M58 64 H76 M58 72 H70" fill="none" />
        <Accent>
          <rect x={86} y={36} width={16} height={12} rx={1} fill={INK} stroke="none" />
        </Accent>
        <Person x={26} y={157} s={0.8} lw={lw} hair="afro" top="shirt" left="down" right="point" />
        <Person
          x={136}
          y={157}
          s={0.8}
          lw={lw}
          hair="wrap"
          top="jacket"
          left="reach"
          right="hip"
          face="grin"
        />
      </>
    ),
  },
} satisfies Record<string, Scene>;
