import { cn } from "@/lib/utils";

import { APP_SCENES } from "./illustrations/app";
import { LANDING_SCENES } from "./illustrations/landing";
import { LATER_SCENES } from "./illustrations/later";
import { ILLUSTRATION_SIZES, type IllustrationSize, type Scene } from "./illustrations/types";

/**
 * Black-ink scenes (DESIGN_SYSTEM.md "Illustrations"). Each scene is an inline SVG component so
 * `currentColor` and `var(--bg)` follow the theme: lines and solid fills invert in dark mode, and
 * the "white" areas take the page background. The slot table in DESIGN_SYSTEM.md lists where each
 * name goes and at what size.
 */
export const SCENES = {
  ...APP_SCENES,
  ...LATER_SCENES,
  ...LANDING_SCENES,
} satisfies Record<string, Scene>;

export type IllustrationName = keyof typeof SCENES;

export const ILLUSTRATION_NAMES = Object.keys(SCENES) as IllustrationName[];

/** Lines look this wide (px) at display size. */
const DISPLAY_LINE = 2.25;

export function Illustration({
  name,
  size,
  decorative = false,
  label,
  className,
}: {
  name: IllustrationName;
  /** Slot size; defaults to the size the scene was drawn for. */
  size?: IllustrationSize;
  /** True when the copy beside it already says what it shows (`alt=""`). */
  decorative?: boolean;
  /** Overrides the scene's own description. */
  label?: string;
  className?: string;
}) {
  const scene: Scene = SCENES[name];
  const [vw, vh] = scene.viewBox;
  const height = ILLUSTRATION_SIZES[size ?? scene.size];
  const width = Math.round((height * vw) / vh);
  const lw = (DISPLAY_LINE * vh) / height;
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": label ?? scene.label } as const);
  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      width={width}
      height={height}
      {...a11y}
      data-illustration={name}
      className={cn("h-auto max-w-full shrink-0 text-foreground", className)}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={lw}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {scene.draw(lw)}
      </g>
    </svg>
  );
}
