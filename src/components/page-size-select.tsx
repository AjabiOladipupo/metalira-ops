"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * "Rows per page" picker. Remembers the choice on this device in a cookie (the server reads it
 * when the URL has no `size`), then opens the server-built link for that size, back on page 1.
 */
export function PageSizeSelect({
  value,
  options,
  cookieName,
  cookiePath = "/",
}: {
  value: number;
  /** Each size and the link that shows it from page 1, keeping the current search and filters. */
  options: { size: number; href: string }[];
  cookieName: string;
  cookiePath?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: string) {
    const option = options.find((o) => String(o.size) === next);
    if (!option) return;
    try {
      document.cookie = `${cookieName}=${option.size}; path=${cookiePath}; max-age=31536000; samesite=lax`;
    } catch {
      // Cookies blocked: the size still travels in the URL.
    }
    startTransition(() => router.push(option.href, { scroll: false }));
  }

  return (
    <div className="flex items-center gap-2" aria-busy={pending || undefined}>
      <span id="page-size-label" className="text-sm whitespace-nowrap text-fg-muted">
        Rows per page
      </span>
      <Select value={String(value)} onValueChange={choose}>
        <SelectTrigger aria-labelledby="page-size-label" className="h-11 min-w-20 tabular-nums">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.size} value={String(o.size)} className="tabular-nums">
              {o.size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
