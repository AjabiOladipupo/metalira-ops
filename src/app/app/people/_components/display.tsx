import { cn } from "@/lib/utils";

/** Muted "Not set" for an empty value in a table or detail list. */
export function NotSet({ children = "Not set" }: { children?: React.ReactNode }) {
  return <span className="text-fg-muted">{children}</span>;
}

/** "1 employee", "162 employees". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-NG")} ${n === 1 ? one : many}`;
}

/** A titled block on the employee pages, separated by a rule as on company settings. */
export function Section({
  id,
  title,
  description,
  actions,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn("flex min-w-0 flex-col gap-4 border-t border-line pt-6", className)}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="m-0 type-h3">
            {title}
          </h2>
          {description ? <p className="m-0 text-sm text-fg-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export interface Detail {
  label: string;
  value: React.ReactNode;
  testId?: string;
}

/** Label and value pairs in a responsive grid. Empty values read "Not set". */
export function DetailList({ items }: { items: Detail[] }) {
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-x-6 gap-y-4">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-muted">{item.label}</dt>
          <dd className="m-0 text-[15px] break-words" data-testid={item.testId}>
            {item.value === null || item.value === undefined || item.value === "" ? (
              <NotSet />
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
