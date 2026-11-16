import { cn } from "@/lib/utils";

/**
 * Illustration slots (DESIGN_SYSTEM.md "Illustrations"). Each name reserves its place and size
 * on the screen it belongs to. The commissioned black-ink scenes are not drawn yet, so a slot
 * shows a simple line drawing in `currentColor` (it inverts in dark mode) until the artwork is
 * added under `public/illustrations/` and wired in here.
 */
export type IllustrationName = "import-people";

const SIZES = { empty: 160, onboarding: 240, worker: 96 } as const;

function ImportPeople() {
  // A stack of cards: the staff list waiting to come in.
  return (
    <g fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinejoin="round">
      <rect x={44} y={58} width={84} height={56} rx={6} />
      <rect x={36} y={50} width={84} height={56} rx={6} fill="var(--bg)" />
      <rect x={28} y={42} width={84} height={56} rx={6} fill="var(--bg)" />
      <circle cx={50} cy={64} r={8} />
      <path d="M38 88c2-8 7-12 12-12s10 4 12 12" strokeLinecap="round" />
      <path d="M72 60h28M72 70h20M72 80h24" strokeLinecap="round" />
      <circle cx={124} cy={36} r={12} fill="var(--signal)" stroke="none" />
      <path d="M124 30v12M118 36h12" stroke="var(--bg)" strokeLinecap="round" />
    </g>
  );
}

const SCENES: Record<IllustrationName, () => React.ReactNode> = {
  "import-people": ImportPeople,
};

export function Illustration({
  name,
  size = "empty",
  className,
}: {
  name: IllustrationName;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const Scene = SCENES[name];
  const px = SIZES[size];
  return (
    <svg
      viewBox="0 0 160 160"
      width={px}
      height={px}
      aria-hidden="true"
      data-illustration={name}
      className={cn("shrink-0 text-foreground", className)}
    >
      <Scene />
    </svg>
  );
}
