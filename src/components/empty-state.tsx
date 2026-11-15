import { cn } from "@/lib/utils";

/** One sentence plus at most one action. */
export function EmptyState({
  message,
  action,
  className,
}: {
  message: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-line px-6 py-12 text-center",
        className,
      )}
    >
      <p className="m-0 max-w-md type-body-lg text-fg-muted">{message}</p>
      {action}
    </div>
  );
}
