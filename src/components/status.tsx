import { cn } from "@/lib/utils";

/**
 * Status is always a word plus a dot, never colour alone and never red or green.
 * - done: solid fg (Approved, Paid)
 * - pending: hollow ring (Draft, Pending)
 * - partial: half-filled (Part paid)
 * - action: signal violet, needs your action (Overdue, Flagged)
 */
export type StatusTone = "done" | "pending" | "partial" | "action";

const DOT: Record<StatusTone, string> = {
  done: "border-foreground bg-foreground",
  pending: "border-foreground bg-transparent",
  partial: "border-foreground bg-[linear-gradient(90deg,var(--fg)_50%,transparent_50%)]",
  action: "border-signal bg-signal",
};

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full border-[1.5px]",
        DOT[tone],
        className,
      )}
    />
  );
}

export function Status({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-sm whitespace-nowrap",
        tone === "action" ? "font-semibold" : "font-normal",
        className,
      )}
    >
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}
