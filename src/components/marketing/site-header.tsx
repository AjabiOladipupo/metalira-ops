import Link from "next/link";

import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

import { ForMenu } from "./for-menu";
import { MobileMenu } from "./mobile-menu";
import { CtaLink, navLinkClass, SECTION_LINKS } from "./primitives";
import { ROLES } from "./roles";

const roleLinks = ROLES.map(({ href, nav }) => ({ href, nav }));

/**
 * Landing header (docs/design/prototype/Landing.dc.html): logo, section links, the "For" menu,
 * Sign in and Start setup. Below 1024px the links fold into the menu button.
 */
export function SiteHeader() {
  return (
    <header className="relative border-b border-line bg-background">
      <div className="mx-auto flex max-w-[1200px] items-center gap-6 px-4 py-4 lg:px-6">
        <Link href="/" aria-label="Metalira Ops home" className="shrink-0 no-underline">
          <Logo size={28} />
        </Link>
        <nav aria-label="Site" className="hidden flex-1 items-center gap-6 lg:flex">
          {SECTION_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={navLinkClass}>
              {link.label}
            </Link>
          ))}
          <ForMenu roles={roleLinks} />
        </nav>
        <div className="ml-auto flex items-center gap-3 lg:ml-0 lg:gap-6">
          <Link href="/sign-in" className={cn(navLinkClass, "hidden lg:inline")}>
            Sign in
          </Link>
          <CtaLink href="/sign-up" className="h-10 px-4">
            Start setup
          </CtaLink>
          <MobileMenu roles={roleLinks} className="lg:hidden" />
        </div>
      </div>
    </header>
  );
}
