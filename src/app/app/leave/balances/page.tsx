import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { loadBalances, type BalanceRow } from "@/server/people/leave-data";
import { loadLeaveSetup } from "@/server/people/leave-setup-data";
import { canEditLeaveSetup } from "@/server/people/leave-setup";
import { peoplePageContext } from "@/server/people/page-context";

import { RouteGate } from "../../_shell/slots";
import { AdjustBalanceForm } from "../_components/leave-decision-forms";

export const metadata: Metadata = { title: "Leave balances" };

interface Person {
  id: string;
  name: string;
  staffId: string;
}

interface Row {
  person: Person;
  balances: Map<string, BalanceRow>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function BalancesPage({
  searchParams,
}: {
  searchParams: PageProps<"/app/leave/balances">["searchParams"];
}) {
  const [ctx, query] = await Promise.all([peoplePageContext(), searchParams]);
  const year = Number(ctx.today.slice(0, 4));
  const canAdjust = canEditLeaveSetup(ctx.role);

  // Names: HR roles read workers; line managers read their reportees (slice 4.0).
  let people: Person[];
  if (ctx.role === "line_manager") {
    const { data, error } = await ctx.supabase.rpc("my_reportees", {
      p_organisation_id: ctx.organisationId,
    });
    if (error) throw new Error(`Could not load your reportees (${error.code})`);
    people = (data ?? [])
      .filter((w) => w.status === "active")
      .map((w) => ({ id: w.id, name: `${w.first_name} ${w.last_name}`, staffId: w.staff_id }));
  } else {
    const { data, error } = await ctx.supabase
      .from("workers")
      .select("id, first_name, last_name, staff_id")
      .eq("organisation_id", ctx.organisationId)
      .eq("status", "active")
      .order("last_name")
      .limit(500);
    if (error) throw new Error(`Could not load people (${error.code})`);
    people = data.map((w) => ({ id: w.id, name: `${w.first_name} ${w.last_name}`, staffId: w.staff_id }));
  }

  const [setup, balances] = await Promise.all([
    loadLeaveSetup(ctx.supabase, ctx.organisationId),
    people.length > 0
      ? loadBalances(ctx.supabase, ctx.organisationId, year, people.map((p) => p.id))
      : Promise.resolve([]),
  ]);
  const types = setup.types.filter((t) => t.status === "active");
  const rows: Row[] = people.map((person) => ({
    person,
    balances: new Map(
      balances.filter((b) => b.workerId === person.id).map((b) => [b.leaveTypeId, b]),
    ),
  }));

  const selected = first(query.worker);
  const adjusting =
    canAdjust && selected && UUID.test(selected) ? people.find((p) => p.id === selected) : undefined;

  const columns: Column<Row>[] = [
    {
      key: "person",
      header: "Employee",
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{r.person.name}</span>
          <span className="text-xs text-fg-muted">{r.person.staffId}</span>
        </span>
      ),
    },
    ...types.map(
      (t): Column<Row> => ({
        key: t.id,
        header: t.name,
        kind: "number",
        cell: (r) => {
          const b = r.balances.get(t.id);
          if (!b) return "—";
          const entitled = b.granted + b.carried + b.adjusted;
          return (
            <span className="flex flex-col items-end gap-0.5">
              <span className="font-semibold">
                {b.balance} <span className="font-normal text-fg-muted">of {entitled}</span>
              </span>
              {b.pending > 0 ? <span className="text-xs text-fg-muted">{b.pending} waiting</span> : null}
            </span>
          );
        },
      }),
    ),
    ...(canAdjust
      ? [
          {
            key: "adjust",
            header: "",
            cell: (r: Row) => (
              <Link
                href={`/app/leave/balances?worker=${r.person.id}`}
                aria-label={`Adjust ${r.person.name}'s balance`}
                className="font-medium text-signal no-underline hover:underline"
              >
                Adjust
              </Link>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        back={{ href: "/app/leave", label: "Leave" }}
        title="Leave balances"
        description={`${people.length} ${people.length === 1 ? "person" : "people"} · ${year} · days left of the year's days`}
      />
      {adjusting ? (
        <section aria-labelledby="adjust" className="flex flex-col gap-3 rounded-xl border border-foreground p-5">
          <h2 id="adjust" className="m-0 type-h3">
            Adjust {adjusting.name}&apos;s {year} balance
          </h2>
          <p className="m-0 text-sm text-fg-muted">
            Kept in the ledger with your reason. A balance can&apos;t go below 0.
          </p>
          <AdjustBalanceForm
            workerId={adjusting.id}
            year={year}
            types={types.map((t) => ({ id: t.id, name: t.name }))}
          />
        </section>
      ) : null}
      {rows.length === 0 || types.length === 0 ? (
        <p className="m-0 rounded-xl border border-line p-5 text-sm text-fg-muted">
          {types.length === 0 ? "No leave types yet. HR sets them in Settings > Leave." : "No one to show yet."}
        </p>
      ) : (
        <DataTable caption="Leave balances" columns={columns} rows={rows} getRowId={(r) => r.person.id} />
      )}
      <p className="m-0 text-[13px] text-fg-muted">
        Each year&apos;s days come from the leave type in force on 1 January, prorated for joiners. A
        change to the days later in the year counts from its own date.
      </p>
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/app/leave/balances">) {
  return (
    <RouteGate href="/app/leave/balances">
      <BalancesPage searchParams={searchParams} />
    </RouteGate>
  );
}
