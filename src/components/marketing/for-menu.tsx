"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { navLinkClass } from "./primitives";

/** Desktop "For" menu: the five role pages. */
export function ForMenu({ roles }: { roles: readonly { href: string; nav: string }[] }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(navLinkClass, "inline-flex items-center gap-1 bg-transparent p-0")}
        >
          For<span className="sr-only"> each role</span>
          <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-48 p-1.5">
        {roles.map((role) => (
          <DropdownMenuItem key={role.href} asChild className="px-2.5 py-2 text-[15px]">
            <Link href={role.href} className="text-foreground no-underline">
              {role.nav}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
