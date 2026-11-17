import Image from "next/image";

import { workerAvatarUri } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * A worker's face in the Open Peeps style, seeded by worker id (server component). An avatar,
 * not an illustration, so it may sit in tables and headers. Black ink on white; inverted in dark
 * mode so it reads as white ink on the dark page. The name is usually beside it, so the image is
 * decorative unless `decorative` is false.
 */
export function WorkerAvatar({
  workerId,
  name,
  size = 32,
  decorative = true,
  className,
}: {
  workerId: string;
  name: string;
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  return (
    <span
      data-worker-avatar={workerId}
      className={cn(
        "inline-flex shrink-0 overflow-hidden rounded-full border border-line",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Image
        src={workerAvatarUri(workerId)}
        alt={decorative ? "" : name}
        aria-hidden={decorative || undefined}
        width={size}
        height={size}
        unoptimized
        className="size-full dark:invert"
      />
    </span>
  );
}
