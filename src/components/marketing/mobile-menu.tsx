"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { SECTION_LINKS } from "./primitives";

const itemClass =
  "flex min-h-11 items-center rounded-md px-2 text-base font-medium text-foreground no-underline hover:bg-surface";

/**
 * Compact menu for phones and tablets: one button that opens a panel under the header with the
 * page sections, the role pages and sign-in. Closes on a link, on Escape and on resize to desktop.
 */
export function MobileMenu({
  roles,
  className,
}: {
  roles: readonly { href: string; nav: string }[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => {
      if (desktop.matches) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onResize);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex size-11 items-center justify-center rounded-lg border border-line bg-background text-foreground hover:bg-surface"
      >
        {open ? (
          <X className="size-5" strokeWidth={1.75} aria-hidden />
        ) : (
          <Menu className="size-5" strokeWidth={1.75} aria-hidden />
        )}
      </button>
      <nav
        id={panelId}
        aria-label="Menu"
        hidden={!open}
        className="absolute inset-x-0 top-full z-40 border-b border-line bg-background"
      >
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-4 lg:px-6">
          <ul className="m-0 flex list-none flex-col p-0">
            {SECTION_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={itemClass} onClick={close}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1 border-t border-line pt-4">
            <span className="px-2 type-label text-fg-muted">Who it is for</span>
            <ul className="m-0 flex list-none flex-col p-0">
              {roles.map((role) => (
                <li key={role.href}>
                  <Link href={role.href} className={itemClass} onClick={close}>
                    {role.nav}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-line pt-4">
            <Link href="/sign-in" className={itemClass} onClick={close}>
              Sign in
            </Link>
          </div>
        </div>
      </nav>
    </div>
  );
}
