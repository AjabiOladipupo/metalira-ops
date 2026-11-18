import { BackLink, type BackTarget } from "@/components/back-link";
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
  /** Back arrow to the logical parent page, above the title. None on the dashboard. */
  back?: BackTarget;
  className?: string;
};

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  headingLevel = 1,
  back,
  className,
}: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      {/* Grows beside the actions and wraps its own text, so a long description does not push
          the actions onto their own row on desktop. */}
      <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1.5">
        {back ? <BackLink {...back} className="-mt-2" /> : null}
        {eyebrow ? <span className="type-label text-fg-muted">{eyebrow}</span> : null}
        <Heading className="m-0 type-h1">{title}</Heading>
        {description ? <p className="m-0 type-body-lg text-fg-muted">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
