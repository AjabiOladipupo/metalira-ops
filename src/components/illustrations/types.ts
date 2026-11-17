/** Display heights in px (DESIGN_SYSTEM.md "Illustrations"). Width follows each scene's viewBox. */
export const ILLUSTRATION_SIZES = {
  worker: 96,
  empty: 160,
  onboarding: 240,
  hero: 320,
} as const;

export type IllustrationSize = keyof typeof ILLUSTRATION_SIZES;

export type Scene = {
  /** Width and height of the drawing's coordinate box. */
  viewBox: readonly [number, number];
  /** The size of the slot the scene was drawn for (its default). */
  size: IllustrationSize;
  /** What the picture shows, for screen readers when it is not decorative. */
  label: string;
  /** Draws the scene. `lw` is the line width in viewBox units for the chosen display size. */
  draw: (lw: number) => React.ReactNode;
};
