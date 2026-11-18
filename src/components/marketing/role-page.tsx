import type { Metadata } from "next";

import { BackLink } from "@/components/back-link";
import { Illustration } from "@/components/illustration";

import { Container, CtaLink, DotList, Section, SectionHeading } from "./primitives";
import { roleBySlug, type RoleSlug } from "./roles";

export function roleMetadata(slug: RoleSlug): Metadata {
  const role = roleBySlug(slug);
  return {
    title: role.title,
    description: role.description,
    alternates: { canonical: role.href },
  };
}

/**
 * A role page (/for/*): hero with the role's scene, three problem-to-outcome blocks, what the
 * role does in the product, and a closing call to action. Workers get an invite note instead of
 * Start setup, because only employers set up a business.
 */
export function RolePage({ slug }: { slug: RoleSlug }) {
  const role = roleBySlug(slug);
  const isWorker = slug === "workers";

  return (
    <>
      <section aria-labelledby="role-title">
        <Container className="grid items-center gap-8 pt-12 pb-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16 lg:pt-[72px] lg:pb-16">
          <div className="flex flex-col gap-5">
            <BackLink href="/" label="home" className="-my-3" />
            <span className="type-label text-fg-muted">{role.eyebrow}</span>
            <h1 id="role-title" className="m-0 max-w-[760px] type-mkt-h2 lg:type-mkt-h1">
              {role.headline}
            </h1>
            <p className="m-0 max-w-[600px] text-[17px] leading-normal text-fg-muted sm:type-lead">
              {role.subline}
            </p>
            <div className="flex flex-wrap gap-3">
              {isWorker ? (
                <CtaLink href="/m/sign-in">Worker sign-in</CtaLink>
              ) : (
                <>
                  <CtaLink href="/sign-up">Start setup</CtaLink>
                  <CtaLink href="/#how-it-works" variant="outline">
                    How it works
                  </CtaLink>
                </>
              )}
            </div>
          </div>
          {/* After the copy on phones, as on the landing hero, so the back arrow stays on top. */}
          <div>
            <Illustration name={role.illustration} />
          </div>
        </Container>
      </section>

      <Section tone="surface" aria-labelledby="changes-title">
        <SectionHeading
          id="changes-title"
          eyebrow="What changes"
          title="From the problem to the fix"
        />
        <ul className="m-0 grid list-none gap-4 p-0 lg:grid-cols-3">
          {role.blocks.map((block) => (
            <li key={block.problem} className="flex flex-col gap-4 rounded-lg bg-background p-6">
              <div className="flex flex-col gap-1.5">
                <span className="type-label text-fg-muted">Today</span>
                <p className="m-0 text-[15px] leading-normal text-fg-muted">{block.problem}</p>
              </div>
              <div className="flex flex-col gap-1.5 border-t border-line pt-4">
                <span className="type-label">With Metalira Ops</span>
                <p className="m-0 text-base leading-normal font-medium">{block.outcome}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section aria-labelledby="tasks-title">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
          <SectionHeading id="tasks-title" eyebrow="Your day" title="What you do in Metalira Ops" />
          <DotList items={role.tasks} className="text-base" />
        </div>
      </Section>

      <Section
        tone="surface"
        aria-labelledby="role-cta"
        className="lg:flex-row lg:items-center lg:justify-between"
      >
        {isWorker ? (
          <>
            <div className="flex max-w-[640px] flex-col gap-3">
              <h2 id="role-cta" className="m-0 type-mkt-h3 lg:type-mkt-h2">
                Ask your employer for an invite
              </h2>
              <p className="m-0 text-[17px] leading-normal text-fg-muted">
                Your employer adds you to Metalira Ops and gives you an invite. Once you have set
                your PIN, sign in with your company code, staff ID and PIN.
              </p>
            </div>
            <CtaLink href="/m/sign-in" className="self-start lg:self-auto">
              Worker sign-in
            </CtaLink>
          </>
        ) : (
          <>
            <h2 id="role-cta" className="m-0 max-w-[640px] type-mkt-h3 lg:type-mkt-h2">
              Bring last month&apos;s staff list. Leave with a payroll and an invoice run.
            </h2>
            <CtaLink href="/sign-up" className="self-start lg:self-auto">
              Start setup
            </CtaLink>
          </>
        )}
      </Section>
    </>
  );
}
