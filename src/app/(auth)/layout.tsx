import Link from "next/link";

import { Logo } from "@/components/logo";
import { ThemeButton } from "@/components/theme/theme-button";

const TOOLS = [
  { name: "Workforce Ops", body: "Rosters, clock-in, timesheets, leave and payroll." },
  { name: "Business Ops", body: "Clients, contracts, invoices and collections." },
  { name: "Revenue Layer", body: "Labour, contribution and true margin on every shift." },
];

/**
 * Split layout from the Setup board: grey aside with the logo, white main with the form.
 * The aside wraps above the form on small screens and keeps only the logo there. The theme
 * switcher sits top right; each page puts its own back arrow above its heading.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-wrap bg-background text-foreground">
      <ThemeButton className="absolute top-3 right-3 sm:top-4 sm:right-4" />
      <aside className="flex flex-[1_1_260px] flex-col gap-6 bg-surface px-4 py-6 sm:px-5 lg:max-w-[420px] lg:px-8 lg:py-10">
        <Link
          href="/"
          aria-label="Metalira Ops home"
          className="self-start text-foreground no-underline"
        >
          <Logo />
        </Link>
        <div className="hidden flex-col gap-1 sm:flex">
          <span className="type-label text-fg-muted">For service companies</span>
          <span className="font-display text-[22px] leading-tight font-bold">
            Every shift, accounted for.
          </span>
        </div>
        <ul className="m-0 hidden list-none flex-col gap-4 p-0 sm:flex">
          {TOOLS.map((tool) => (
            <li key={tool.name} className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{tool.name}</span>
              <span className="text-[13px] text-fg-muted">{tool.body}</span>
            </li>
          ))}
        </ul>
        <p className="m-0 mt-auto hidden text-[13px] text-fg-muted sm:block">
          Clients pay into accounts you own. Metalira never holds the money.
        </p>
      </aside>
      <main className="flex min-w-0 flex-[999_1_640px] flex-col px-4 pt-8 pb-14 sm:px-12 sm:pt-10 lg:justify-center">
        <div className="flex w-full max-w-[440px] flex-col gap-6 xl:has-[[data-auth-wide]]:max-w-[720px]">
          {children}
        </div>
      </main>
    </div>
  );
}
