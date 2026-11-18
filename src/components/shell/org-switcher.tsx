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
/** The active company's logo, from a short-lived signed URL (private Storage). */
function CompanyLogo({ src }: { src: string }) {
  return (
    // next/image would cache the signed URL past its expiry.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      data-testid="company-logo"
      className="size-6 shrink-0 rounded object-contain"
    />
  );
}

export function OrgSwitcher({
  options,
  activeId,
  switchAction,
  logoUrl = null,
}: {
  options: OrgOption[];
  activeId: string;
  switchAction: (formData: FormData) => Promise<void>;
  /** Signed URL of the active company's logo, or null when it has none. */
  logoUrl?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const active = options.find((o) => o.id === activeId) ?? options[0];
  if (!active) return null;

  if (options.length === 1) {
    return (
      <span className="inline-flex h-10 max-w-full min-w-0 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium">
        {logoUrl ? <CompanyLogo src={logoUrl} /> : null}
        <span data-testid="org-switcher" className="truncate">
          {active.name}
        </span>
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
          className="max-w-full min-w-0"
        >
          {logoUrl ? <CompanyLogo src={logoUrl} /> : null}
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
