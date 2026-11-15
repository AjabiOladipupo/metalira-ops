import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  /** Small caps line above the title, e.g. "Friday 30 October" or the nav group. */
  eyebrow?: string;
  /** One line of context, numbers first. */
  description?: string;
  /** Primary action (and at most one secondary) on the right. */
  actions?: React.ReactNode;
  /** Defaults to h1. Use 2 only when showing a header inside another page (e.g. /design-system). */
  headingLevel?: 1 | 2;
  className?: string;
};

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  headingLevel = 1,
  className,
}: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? <span className="type-label text-fg-muted">{eyebrow}</span> : null}
        <Heading className="m-0 type-h1">{title}</Heading>
        {description ? <p className="m-0 type-body-lg text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
