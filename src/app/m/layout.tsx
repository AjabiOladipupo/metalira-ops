/**
 * Worker app frame, from the Wk* boards: a single phone-width column, white, no sidebar.
 * Phase 1 adds the bottom nav and the PWA manifest.
 */
export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh justify-center bg-background text-foreground">
      <div className="flex w-full max-w-[430px] min-w-0 flex-col">{children}</div>
    </div>
  );
}
