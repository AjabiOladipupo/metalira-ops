import { cn } from "@/lib/utils";

/**
 * The dot-roster mark: a 3×3 roster where the middle-right cell stretches into a bar.
 * Drawn in currentColor so it follows fg in light and dark. Never recolour it.
 */
export function LogoMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
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

/** Horizontal lockup: mark plus "Metalira Ops", product word in bold. */
export function Logo({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-foreground", className)}>
      <LogoMark size={size} />
      <span
        className="font-display font-medium tracking-[-0.01em]"
        style={{ fontSize: Math.round(size * 0.7) }}
      >
        Metalira <b className="font-bold">Ops</b>
      </span>
    </span>
  );
}
