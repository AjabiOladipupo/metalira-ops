import type { Metadata } from "next";

import { Illustration } from "@/components/illustration";
import {
  Container,
  CtaLink,
  DotList,
  Section,
  SectionHeading,
} from "@/components/marketing/primitives";
import { SampleDashboard } from "@/components/marketing/sample-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Metalira Ops · Every shift, accounted for" },
  description:
    "Rosters, clock-ins, payroll and client invoices in one record for Nigerian businesses that run shift-based teams. See what each site earns after the people who staffed it are paid.",
};

const WORKFORCE = [
  "Employees mapped to departments, line managers, clients and projects",
  "Rosters built against each site's headcount",
  "Clock-in with location and selfie, even offline",
  "Leave, overtime and line-manager approvals",
  "Payroll with 2026 PAYE, pension, NSITF and ITF, plus bank files",
];

const BUSINESS = [
  "Clients, sites and contracts with rate cards",
  "Projects split into phases, sub-jobs, KPIs and review calls",
  "Invoices drafted from approved hours, with 7.5% VAT",
  "Clients pay by transfer into your business bank account",
  "Payments matched from your bank statement, receipts sent automatically",
];

const REVENUE = [
  "Labour cost as a share of billed revenue",
  "Margin per site, client and project",
  "Work done but not yet invoiced",
  "Cash collected against next payroll",
];

const PROMISES = [
  {
    title: "Works on cheap phones",
    body: "Clock-ins save on the phone and send when the network returns.",
  },
  {
    title: "You keep the money",
    body: "Clients pay into your own business bank account. Payroll is a bank file you upload to your own bank. Metalira never holds your money.",
  },
  {
    title: "Proof, not promises",
    body: "Upload PAYE and pension receipts so you can show what was paid.",
  },
  {
    title: "Your data, exportable",
    body: "Download everything at any time. Built for Nigeria's data protection rules.",
  },
];

const STEPS = [
  {
    title: "Add your business",
    body: "Name, logo, TIN, the email invoices go out from, and your business bank account.",
  },
  {
    title: "Import your people",
    body: "Fill our template with staff, line managers, clients and projects. Upload it once.",
  },
  {
    title: "Clock in and approve",
    body: "Staff clock in on their phones; line managers approve hours and leave.",
  },
  {
    title: "Pay and get paid",
    body: "Run payroll to a bank file, send invoices built from approved hours, match payments from your bank statement.",
  },
];

const PILOT = [
  "Workforce Ops, Business Ops and the Revenue Layer",
  "The worker app for every person on your list",
  "Guided setup with your own data",
];

/** Public landing page, built to docs/design/prototype/Landing.dc.html. */
export default function LandingPage() {
  return (
    <>
      <section aria-labelledby="hero-title">
        <Container className="flex flex-col gap-12 pt-12 pb-14 lg:pt-[72px] lg:pb-16">
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:gap-12">
            <div className="flex flex-col gap-5 lg:gap-[22px]">
              <span className="type-label text-fg-muted">
                For Nigerian businesses that run shift-based teams
              </span>
              <h1 id="hero-title" className="m-0 type-mkt-h2 sm:type-mkt-h1 lg:type-display">
                Every shift, accounted for.
              </h1>
              <p className="m-0 max-w-[560px] text-[17px] leading-normal text-fg-muted sm:type-lead">
                Rosters, clock-ins, payroll and client invoices in one record. See what each site
                earns after the people who staffed it are paid.
              </p>
              <div className="flex flex-wrap gap-3">
                <CtaLink href="/sign-up">Set up your business</CtaLink>
                <CtaLink href="#how-it-works" variant="outline">
                  How it works
                </CtaLink>
              </div>
              <p className="m-0 text-sm text-fg-muted">
                Free during the pilot. Import your staff from a spreadsheet.
              </p>
            </div>
            <div className="flex justify-center lg:justify-end">
              <Illustration name="hero-crew" className="w-full max-w-[480px]" />
            </div>
          </div>
          <SampleDashboard />
        </Container>
      </section>

      <Section id="product" tone="surface" aria-labelledby="product-title">
        <SectionHeading
          id="product-title"
          eyebrow="Product"
          title="Two tools. One record of what work earned."
          intro="Use either tool alone. Turn on both and every hour worked is tied to a client, an invoice and a payment."
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article className="flex flex-col gap-3.5 rounded-lg bg-background p-6">
            <h3 className="m-0 font-display text-[25px] leading-tight font-bold">Workforce Ops</h3>
            <DotList items={WORKFORCE} />
          </article>
          <article className="flex flex-col gap-3.5 rounded-lg bg-background p-6">
            <h3 className="m-0 font-display text-[25px] leading-tight font-bold">Business Ops</h3>
            <DotList items={BUSINESS} />
          </article>
          <article className="flex flex-col gap-3.5 rounded-lg bg-foreground p-6 text-background md:col-span-2 xl:col-span-1">
            <h3 className="m-0 font-display text-[25px] leading-tight font-bold">Revenue Layer</h3>
            <p className="m-0 text-[15px] leading-[1.55] opacity-80">
              Turns on when you use both tools.
            </p>
            <DotList items={REVENUE} hollow />
          </article>
        </div>
        <ul className="m-0 grid list-none gap-6 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
          {PROMISES.map((promise) => (
            <li key={promise.title} className="flex flex-col gap-1.5">
              <span className="text-base font-semibold">{promise.title}</span>
              <span className="text-[15px] leading-normal text-fg-muted">{promise.body}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="how-it-works" aria-labelledby="how-title">
        <SectionHeading id="how-title" eyebrow="How it works" title="Running in an afternoon" />
        <ol className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="flex flex-col gap-2.5 rounded-lg border border-line p-[22px]"
            >
              <span aria-hidden="true" className="type-kpi">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-[17px] font-semibold">{step.title}</span>
              <span className="text-[15px] leading-normal text-fg-muted">{step.body}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="pricing" tone="surface" aria-labelledby="pricing-title">
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-12">
          <div className="flex flex-col gap-6">
            <SectionHeading
              id="pricing-title"
              eyebrow="Pricing"
              title="Pay for the workers who clocked in"
              intro="Pricing is per worker who clocked in at least once that month. Free during the pilot."
            />
            <CtaLink href="/sign-up" className="self-start">
              Start setup
            </CtaLink>
          </div>
          <div className="flex flex-col gap-4 rounded-lg bg-background p-6">
            <span className="type-label text-fg-muted">During the pilot</span>
            <DotList items={PILOT} />
          </div>
        </div>
      </Section>

      <Section
        aria-labelledby="final-cta"
        className="lg:flex-row lg:items-center lg:justify-between"
      >
        <h2 id="final-cta" className="m-0 max-w-[640px] type-mkt-h3 lg:type-mkt-h2">
          Bring last month&apos;s staff list. Leave with a payroll and an invoice run.
        </h2>
        <CtaLink href="/sign-up" className="self-start lg:self-auto">
          Set up your business
        </CtaLink>
      </Section>
    </>
  );
}
