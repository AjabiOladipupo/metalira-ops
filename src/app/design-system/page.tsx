import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Illustration, ILLUSTRATION_NAMES, SCENES } from "@/components/illustration";
import { ILLUSTRATION_SIZES } from "@/components/illustrations/types";
import { KpiTile } from "@/components/kpi-tile";
import { Logo, LogoMark } from "@/components/logo";
import { PageHeader } from "@/components/page-header";
import { Status, type StatusTone } from "@/components/status";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkerAvatar } from "@/components/worker-avatar";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Design system" };

type Mode = "light" | "dark";

const TOKENS: { name: string; light: string; dark: string; use: string }[] = [
  { name: "bg", light: "#FFFFFF", dark: "#0A0A0A", use: "Page" },
  { name: "surface", light: "#F4F4F5", dark: "#18181B", use: "Cards, sidebar, table header" },
  { name: "line", light: "#E4E4E7", dark: "#27272A", use: "Borders, dividers" },
  { name: "fg", light: "#0A0A0A", dark: "#FAFAFA", use: "Text" },
  { name: "fg-muted", light: "#52525B", dark: "#A1A1AA", use: "Secondary text, labels" },
  { name: "signal", light: "#6D4CFF", dark: "#9B85FF", use: "Links, focus, selected, active nav" },
];

const TYPE: { cls: string; name: string; spec: string; sample: string }[] = [
  {
    cls: "type-h1",
    name: "h1",
    spec: "Space Grotesk 700 · 34px",
    sample: "Every shift, accounted for.",
  },
  {
    cls: "type-kpi",
    name: "KPI value",
    spec: "Space Grotesk 700 · 31px · tabular",
    sample: "₦14.30m",
  },
  {
    cls: "type-h2",
    name: "h2",
    spec: "Space Grotesk 500 · 25px",
    sample: "Margin by site, lowest first",
  },
  { cls: "type-h3", name: "h3", spec: "Space Grotesk 500 · 20px", sample: "Apapa Warehouse 3" },
  {
    cls: "type-body-lg",
    name: "body-lg",
    spec: "Inter 400 · 15px",
    sample: "118 staff on shift · 4 open shifts",
  },
  {
    cls: "type-body",
    name: "body",
    spec: "Inter 400 · 14px",
    sample: "Labour cost is provisional until payroll is approved.",
  },
  { cls: "type-caption", name: "caption", spec: "Inter 400 · 13px", sample: "5 late · 2 no-show" },
  {
    cls: "type-label",
    name: "label",
    spec: "Space Grotesk 500 · 12px · caps",
    sample: "Needs attention now",
  },
];

const STATUSES: { tone: StatusTone; word: string }[] = [
  { tone: "pending", word: "Draft" },
  { tone: "pending", word: "Pending" },
  { tone: "done", word: "Approved" },
  { tone: "done", word: "Paid" },
  { tone: "partial", word: "Part paid" },
  { tone: "action", word: "Overdue" },
  { tone: "action", word: "Flagged" },
];

type SiteRow = {
  id: string;
  site: string;
  client: string;
  billed: string;
  labour: string;
  margin: string;
  status: { tone: StatusTone; word: string };
};

const SITES: SiteRow[] = [
  {
    id: "apapa",
    site: "Apapa Warehouse 3",
    client: "Coastline Logistics",
    billed: "₦2,400,000",
    labour: "₦2,316,000",
    margin: "−1.8%",
    status: { tone: "action", word: "Loss" },
  },
  {
    id: "lekki",
    site: "Lekki Estate Gate B",
    client: "Greenfield Estates",
    billed: "₦2,850,000",
    labour: "₦2,194,500",
    margin: "18.2%",
    status: { tone: "partial", word: "Watch" },
  },
  {
    id: "ikeja",
    site: "Ikeja City Mall",
    client: "Ikeja Retail Ltd",
    billed: "₦4,200,000",
    labour: "₦2,520,000",
    margin: "34.5%",
    status: { tone: "done", word: "Healthy" },
  },
  {
    id: "vi",
    site: "VI Tower",
    client: "Marina Holdings",
    billed: "₦3,100,000",
    labour: "₦1,705,000",
    margin: "39.1%",
    status: { tone: "done", word: "Healthy" },
  },
];

const COLUMNS: Column<SiteRow>[] = [
  { key: "site", header: "Site", cell: (r) => <span className="font-semibold">{r.site}</span> },
  {
    key: "client",
    header: "Client",
    cell: (r) => <span className="text-fg-muted">{r.client}</span>,
  },
  { key: "billed", header: "Billed", kind: "money", cell: (r) => r.billed },
  { key: "labour", header: "Labour cost", kind: "money", cell: (r) => r.labour },
  {
    key: "margin",
    header: "Margin",
    kind: "number",
    cell: (r) => <span className="font-semibold">{r.margin}</span>,
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => <Status tone={r.status.tone}>{r.status.word}</Status>,
  },
];

const AVATAR_SAMPLES = [
  { id: "7f1c2d9e-0001-4a51-9c11-3d5e7a1b0001", name: "Musa Ibrahim" },
  { id: "7f1c2d9e-0002-4a51-9c11-3d5e7a1b0002", name: "Ngozi Okafor" },
  { id: "7f1c2d9e-0003-4a51-9c11-3d5e7a1b0003", name: "Tunde Bakare" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 type-label text-fg-muted">{title}</h2>
      {children}
    </section>
  );
}

function Gallery({ mode }: { mode: Mode }) {
  return (
    <div
      className={cn(
        mode,
        "flex min-w-0 flex-col gap-8 rounded-lg border border-line bg-background p-4 text-foreground sm:p-6",
      )}
      data-testid={`gallery-${mode}`}
    >
      <h2 className="m-0 type-h2">{mode === "light" ? "Light" : "Dark"}</h2>

      <Section title="Colour">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {TOKENS.map((t) => (
            <div key={t.name} className="flex flex-col gap-2">
              <div
                className="h-14 rounded-md border border-line"
                style={{ background: `var(--${t.name})` }}
              />
              <div className="flex flex-col">
                <span className="text-sm font-semibold">{t.name}</span>
                <span className="type-caption text-fg-muted tabular-nums">{t[mode]}</span>
                <span className="type-caption text-fg-muted">{t.use}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <div className="flex flex-col gap-4">
          {TYPE.map((t) => (
            <div key={t.name} className="flex flex-col gap-1">
              <span className="type-caption text-fg-muted">
                {t.name} · {t.spec}
              </span>
              <span className={cn(t.cls, "break-words")}>{t.sample}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Logo">
        <div className="flex flex-wrap items-center gap-6">
          <Logo />
          <LogoMark size={32} />
          <LogoMark size={16} />
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>
            <Plus strokeWidth={1.75} />
            Publish roster
          </Button>
          <Button variant="outline">Export</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="link">Open site P&amp;L</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="flex flex-wrap items-center gap-3">
          <Input aria-label="Staff ID" placeholder="Staff ID" className="max-w-56" />
          <Select defaultValue="all">
            <SelectTrigger aria-label={`Site (${mode})`} className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              <SelectItem value="apapa">Apapa Warehouse 3</SelectItem>
              <SelectItem value="lekki">Lekki Estate Gate B</SelectItem>
            </SelectContent>
          </Select>
          <Link href="/app">A text link</Link>
        </div>
      </Section>

      <Section title="Status">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {STATUSES.map((s) => (
            <Status key={s.word} tone={s.tone}>
              {s.word}
            </Status>
          ))}
        </div>
      </Section>

      <Section title="KPI tiles">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          <KpiTile label="Uncovered shifts" value="4" note="Today and tomorrow" />
          <KpiTile label="Unbilled work" value="₦3.42m" note="3 clients · oldest 12 days" />
          <KpiTile variant="filled" label="Gross margin" value="₦3.93m" note="27.5% of billed" />
        </div>
      </Section>

      <Section title="Page header">
        <PageHeader
          headingLevel={2}
          eyebrow="Friday 30 October"
          title="Every shift, accounted for."
          description="118 staff on shift · 4 open shifts · 23 timesheets waiting"
          actions={<Button>Publish roster</Button>}
        />
      </Section>

      <Section title="Data table">
        <DataTable
          caption="Margin by site"
          columns={COLUMNS}
          rows={SITES}
          getRowId={(r) => r.id}
          selectedIds={["lekki"]}
        />
      </Section>

      <Section title="Empty state">
        <EmptyState
          message="No shifts yet. Publish a roster to start tracking attendance."
          action={<Button>Publish roster</Button>}
        />
      </Section>

      <Section title="Illustrations">
        <p className="m-0 max-w-2xl type-body text-fg-muted">
          {ILLUSTRATION_NAMES.length} scenes, each at the size of its slot. Lines in fg, paper in
          bg, one accent in signal at most.
        </p>
        <div
          className="flex flex-wrap items-end gap-x-6 gap-y-8"
          data-testid={`illustrations-${mode}`}
        >
          {ILLUSTRATION_NAMES.map((name) => (
            <figure key={name} className="m-0 flex max-w-full min-w-0 flex-col gap-2">
              <Illustration name={name} />
              <figcaption className="type-caption text-fg-muted">
                {name} · {ILLUSTRATION_SIZES[SCENES[name].size]}px
              </figcaption>
            </figure>
          ))}
        </div>
      </Section>

      <Section title="Worker avatars">
        <div className="flex flex-wrap items-center gap-4" data-testid={`avatars-${mode}`}>
          {AVATAR_SAMPLES.map((sample) => (
            <span key={sample.id} className="flex items-center gap-2 text-sm">
              <WorkerAvatar workerId={sample.id} name={sample.name} size={40} />
              {sample.name}
            </span>
          ))}
        </div>
      </Section>
    </div>
  );
}

export default function DesignSystemPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-7 lg:px-8">
      <PageHeader
        eyebrow="Metalira Ops"
        title="Design system"
        description="Tokens and components from docs/DESIGN_SYSTEM.md, shown in light and dark."
        actions={<ThemeToggle />}
      />
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
        <Gallery mode="light" />
        <Gallery mode="dark" />
      </div>
    </main>
  );
}
