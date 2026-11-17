import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Same-page section links. Absolute so they work from the role pages too. */
export const SECTION_LINKS = [
  { href: "/#product", label: "Product" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#pricing", label: "Pricing" },
] as const;

/** Header text link (prototype `.navl`). */
export const navLinkClass =
  "text-[15px] font-medium text-foreground no-underline transition-colors hover:text-signal";

/** The 1200px column every marketing block sits in, with the 16/24px gutters. */
export function Container({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1200px] px-4 lg:px-6", className)}>{children}</div>
  );
}

/** A full-width band; `surface` gives the grey panel the prototype alternates with white. */
export function Section({
  id,
  tone = "plain",
  className,
  children,
  "aria-labelledby": labelledBy,
}: {
  id?: string;
  tone?: "plain" | "surface";
  className?: string;
  children: React.ReactNode;
  "aria-labelledby"?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("scroll-mt-4", tone === "surface" && "bg-surface")}
    >
      <Container className={cn("flex flex-col gap-8 py-14 lg:py-[72px]", className)}>
        {children}
      </Container>
    </section>
  );
}

/** Eyebrow, heading and an optional intro line. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  intro,
  className,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  intro?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex max-w-[720px] flex-col gap-2.5", className)}>
      {eyebrow ? <span className="type-label text-fg-muted">{eyebrow}</span> : null}
      <h2 id={id} className="m-0 type-mkt-h3 lg:type-mkt-h2">
        {title}
      </h2>
      {intro ? <p className="m-0 text-[17px] leading-[1.55] text-fg-muted">{intro}</p> : null}
    </div>
  );
}

/** Large link button (48px), primary or outline. */
export function CtaLink({
  href,
  variant = "primary",
  className,
  children,
}: {
  href: string;
  variant?: "primary" | "outline";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        buttonVariants({ variant: variant === "primary" ? "default" : "outline" }),
        "h-12 px-[22px] text-[15px] font-semibold no-underline",
        variant === "outline" && "border-foreground",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Checklist with a solid (or hollow, on the inverse panel) dot per line. */
export function DotList({
  items,
  hollow = false,
  className,
}: {
  items: readonly string[];
  hollow?: boolean;
  className?: string;
}) {
  return (
    <ul className={cn("m-0 flex list-none flex-col gap-3.5 p-0", className)}>
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2.5 text-[15px] leading-[1.45]">
          <span
            aria-hidden="true"
            className={cn(
              "mt-[7px] inline-block size-2 shrink-0 rounded-full border-[1.5px]",
              hollow ? "border-current" : "border-current bg-current",
            )}
          />
          {item}
        </li>
      ))}
    </ul>
  );
}
