import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { checkpointOrigin } from "@/server/sites/origin";
import { loadCheckpointSheet, loadOfficeSite } from "@/server/sites/sites-data";

import { RouteGate } from "../../../../../_shell/slots";
import { PrintButton } from "../../../../../clients/[clientId]/sites/[siteId]/checkpoints/print/print-button";
import { clientsPageContext } from "../../../../../clients/_components/context";

export const metadata: Metadata = { title: "Checkpoint QR sheet" };

/** An office's checkpoint QR sheet (slice 6.11), as a client's site's. */
async function OfficeCheckpointSheet({
  params,
}: {
  params: PageProps<"/app/settings/offices/[siteId]/checkpoints/print">["params"];
}) {
  const { siteId } = await params;
  const ctx = await clientsPageContext();
  const site = await loadOfficeSite(ctx.supabase, ctx.organisationId, siteId);
  if (!site) notFound();
  const cards = await loadCheckpointSheet(
    ctx.supabase,
    ctx.organisationId,
    site.id,
    checkpointOrigin(process.env),
  );
  const back = `/app/settings/offices/${site.id}`;

  return (
    <>
      <PageHeader
        back={{ href: back, label: site.name }}
        eyebrow="Your office"
        title="Checkpoint QR sheet"
        description={`${cards.length.toLocaleString("en-NG")} ${
          cards.length === 1 ? "code" : "codes"
        } for ${site.name}. Post each one at its place; a new code for a checkpoint makes its old printout stop working.`}
        actions={cards.length > 0 ? <PrintButton /> : null}
      />
      {cards.length === 0 ? (
        <EmptyState
          message="No checkpoints to print yet. Add them on the office page."
          action={
            <Button asChild variant="outline" className="h-11 px-4">
              <Link href={back}>Back to {site.name}</Link>
            </Button>
          }
        />
      ) : (
        <section
          aria-label="QR codes"
          className="checkpoint-sheet flex flex-col gap-4 rounded-xl border border-line bg-background p-4 md:p-6"
        >
          <h2 className="m-0 type-h3">{site.name}</h2>
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <li
                key={card.id}
                className="checkpoint-card flex flex-col items-center gap-2 rounded-lg border border-line p-4 text-center"
                data-testid="checkpoint-card"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- data: URL made on the server */}
                <img
                  src={card.qr}
                  alt={`QR code for checkpoint ${card.name}`}
                  width={176}
                  height={176}
                  className="size-44"
                  data-testid="checkpoint-qr"
                />
                <span className="text-[15px] font-semibold">
                  {card.position}. {card.name}
                </span>
                <span className="text-xs text-fg-muted">Scan with the Metalira app on patrol.</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function Page({
  params,
}: PageProps<"/app/settings/offices/[siteId]/checkpoints/print">) {
  return (
    <RouteGate href="/app/settings/offices/[id]/checkpoints/print">
      <OfficeCheckpointSheet params={params} />
    </RouteGate>
  );
}
