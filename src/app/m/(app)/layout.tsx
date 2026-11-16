import { BottomNav } from "../_components/bottom-nav";

/**
 * Signed-in worker screens (slice 1.10): the page above, the bottom nav below. Sign-in and
 * invite links sit outside this group, so they have no nav. Each page checks the worker
 * session itself, inside its own Suspense boundary.
 */
export default function WorkerAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="flex flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
      <BottomNav />
    </>
  );
}
