"use client";

import { ChevronDown } from "lucide-react";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface OrgOption {
  id: string;
  name: string;
  roleLabel: string;
}

/**
 * The company the manager is working in. Lists manager memberships only (workers use /m).
 * With one company it is a plain label; with more, choosing one calls the server action, which
 * re-checks the membership before setting the httpOnly cookie.
 */
export function OrgSwitcher({
  options,
  activeId,
  switchAction,
}: {
  options: OrgOption[];
  activeId: string;
  switchAction: (formData: FormData) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const active = options.find((o) => o.id === activeId) ?? options[0];
  if (!active) return null;

  if (options.length === 1) {
    return (
      <span
        data-testid="org-switcher"
        className="inline-flex h-10 max-w-[50vw] min-w-0 items-center rounded-md border border-line px-4 text-sm font-medium sm:max-w-none"
      >
        <span className="truncate">{active.name}</span>
      </span>
    );
  }

  function choose(id: string) {
    if (id === active?.id) return;
    const formData = new FormData();
    formData.set("organisationId", id);
    startTransition(() => switchAction(formData));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          data-testid="org-switcher"
          aria-label={`Company: ${active.name}. Switch company`}
          disabled={pending}
          className="max-w-[50vw] min-w-0 sm:max-w-none"
        >
          <span className="truncate">{active.name}</span>
          <ChevronDown strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Companies</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={active.id} onValueChange={choose}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id} className="py-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{option.name}</span>
                <span className="text-xs text-fg-muted">{option.roleLabel}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
