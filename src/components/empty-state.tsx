import { cn } from "@/lib/utils";

/** One sentence plus at most one action, with an optional illustration above (one per screen). */
export function EmptyState({
  message,
  action,
  illustration,
  className,
}: {
  message: string;
  action?: React.ReactNode;
  illustration?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-line px-6 py-12 text-center",
        className,
      )}
    >
      {illustration}
      <p className="m-0 max-w-md type-body-lg text-fg-muted">{message}</p>
      {action}
    </div>
  );
}
