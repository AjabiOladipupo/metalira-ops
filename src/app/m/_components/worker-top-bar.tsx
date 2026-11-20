import { BackLink, type BackTarget } from "@/components/back-link";
import { ThemeButton } from "@/components/theme/theme-button";

import { InboxLink } from "./inbox-link";

/**
 * The top row of a worker screen: the back arrow to its parent and the title, or the logo on
 * signed-out screens, with the theme switcher on the right. Signed-in screens pass `inbox` for
 * the inbox button and its unread dot (slice 3.1).
 */
export function WorkerTopBar({
  back,
  inbox = false,
  children,
}: {
  back?: BackTarget;
  inbox?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2">
      {back ? <BackLink {...back} /> : null}
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      <span className="-mr-2 flex shrink-0 items-center">
        {inbox ? <InboxLink /> : null}
        <ThemeButton />
      </span>
    </div>
  );
}
