import { BackLink, type BackTarget } from "@/components/back-link";
import { ThemeButton } from "@/components/theme/theme-button";

/**
 * The top row of a worker screen: the back arrow to its parent and the title, or the logo on
 * signed-out screens, with the theme switcher on the right.
 */
export function WorkerTopBar({ back, children }: { back?: BackTarget; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-2">
      {back ? <BackLink {...back} /> : null}
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      <ThemeButton className="-mr-2" />
    </div>
  );
}
