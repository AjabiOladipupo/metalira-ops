import { Accent, Bubble, CardStack, Icon, IdCard, LaptopBack, PAPER, Person, Phone } from "./ink";
import type { Scene } from "./types";

/** Scenes used by Phase 1 screens. */
export const APP_SCENES = {
  welcome: {
    viewBox: [160, 160],
    size: "onboarding",
    label: "Two people shaking hands under a speech bubble with an office building",
    draw: (lw) => (
      <>
        <Person x={42} y={156} s={0.88} lw={lw} hair="beard" top="jacket" right="reach" />
        <Person
          x={119}
          y={156}
          s={0.88}
          lw={lw}
          hair="wrap"
          top="blouse"
          bottom="skirt"
          left="reach"
          face="grin"
        />
        <Bubble cx={81} cy={27} r={14} toward={[60, 40]} lw={lw}>
          <Icon.building />
        </Bubble>
      </>
    ),
  },
  "import-people": {
    viewBox: [160, 160],
    size: "empty",
    label: "A person holding a stack of staff cards",
    draw: (lw) => (
      <>
        <Person
          x={74}
          y={157}
          s={0.93}
          lw={lw}
          hair="puff"
          top="shirt"
          left="chest"
          right="chest"
          held={
            <g>
              <g transform="translate(0 -86)">
                <CardStack w={36} h={25} />
              </g>
              <Accent>
                <circle cx={24} cy={-106} r={6} fill={PAPER} />
                <path d="M24 -109 V-103 M21 -106 H27" fill="none" />
              </Accent>
            </g>
          }
        />
      </>
    ),
  },
  "no-approvals": {
    viewBox: [160, 160],
    size: "empty",
    label: "A person at a desk with a laptop and a tick in a speech bubble",
    draw: (lw) => (
      <>
        <Person
          x={66}
          y={158}
          s={0.95}
          lw={lw}
          hair="afro"
          top="polo"
          left="low"
          right="low"
          seated
        />
        <g transform="translate(66 100)">
          <LaptopBack w={44} h={30} />
        </g>
        <path d="M10 100 H150 V107 H10 Z" fill={PAPER} />
        <path d="M20 107 V156 M140 107 V156" fill="none" />
        <path d="M117 100 V88 H130 V100 M130 91 C135 91 135 97 130 97" fill={PAPER} />
        <Bubble cx={126} cy={42} r={15} toward={[86, 36]} lw={lw}>
          <Icon.check />
        </Bubble>
      </>
    ),
  },
  "clock-in": {
    viewBox: [140, 120],
    size: "worker",
    label: "A security guard in uniform waving, with a clock in a speech bubble",
    draw: (lw) => (
      <>
        <Person x={82} y={168} s={1} lw={lw} hair="cap" top="guard" right="wave" face="grin" />
        <Bubble cx={30} cy={38} r={17} toward={[64, 40]} lw={lw}>
          <Icon.clock />
        </Bubble>
      </>
    ),
  },
  "worker-profile": {
    viewBox: [140, 120],
    size: "worker",
    label: "A worker holding up a phone that shows an ID card",
    draw: (lw) => (
      <>
        <Person
          x={50}
          y={168}
          s={1}
          lw={lw}
          hair="braids"
          top="vest"
          left="hip"
          right="reach"
          held={
            <g transform="translate(48 -100)">
              <Phone
                w={30}
                h={48}
                screen={
                  <Accent>
                    <IdCard w={20} h={14} />
                  </Accent>
                }
              />
            </g>
          }
        />
      </>
    ),
  },
} satisfies Record<string, Scene>;
