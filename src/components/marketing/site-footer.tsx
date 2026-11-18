import Link from "next/link";

import { ThemeToggle } from "@/components/theme/theme-toggle";

import { Container } from "./primitives";
import { ROLES } from "./roles";

/** The role pages, the company line and the theme choice. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <Container className="flex flex-col gap-6 py-8 text-sm text-fg-muted">
        <nav aria-label="Who it is for">
          <ul className="m-0 flex list-none flex-wrap gap-x-6 p-0">
            {ROLES.map((role) => (
              <li key={role.href}>
                <Link href={role.href} className="inline-flex min-h-11 items-center">
                  {role.nav}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span>Metalira Ops is a product of Meta Lira Technology LTD, Lagos.</span>
          <ThemeToggle />
        </div>
      </Container>
    </footer>
  );
}
