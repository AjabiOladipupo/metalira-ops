import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { RADIUS_DEFAULT_M, formatArea, formatLatLng } from "@/lib/geofence";
import { loadSite, type SiteDetail } from "@/server/sites/sites-data";

import { RouteGate } from "../../../../_shell/slots";
import { DetailList, Section, plural } from "../../../../people/_components/display";
import { clientsPageContext } from "../../../_components/context";
import { GeofenceEditor } from "../../../_components/geofence-editor";
import {
  AddCheckpointForm,
  CheckpointRow,
  SiteDetailsForm,
  SiteStatusForm,
} from "../../../_components/site-forms";

export const metadata: Metadata = { title: "Site" };

function geofenceText(site: SiteDetail): string | null {
  if (site.geofence === null) return null;
  const area = site.areaM2 === null ? "" : ` · ${formatArea(site.areaM2)}`;
  if (site.geofence === "outline") {
    return `Drawn outline · ${plural(site.outline?.length ?? 0, "corner", "corners")}${area}`;
  }
  return `${site.radiusM.toLocaleString("en-NG")} m circle around ${
    site.centre ? formatLatLng(site.centre) : "the pin"
  }${area}`;
}

function SiteStatusChip({ site }: { site: SiteDetail }) {
  if (site.status === "archived") return <Status tone="pending">Archived</Status>;
  if (site.needsDetails) return <Status tone="action">Needs details</Status>;
  return <Status tone="done">Ready</Status>;
}

async function SitePage({
  params,
}: {
  params: PageProps<"/app/clients/[clientId]/sites/[siteId]">["params"];
}) {
  const { clientId, siteId } = await params;
  const ctx = await clientsPageContext();
  const site = await loadSite(ctx.supabase, ctx.organisationId, clientId, siteId);
  if (!site) notFound();
  const canEdit = ctx.canEdit && site.status === "active";
  const geofence = geofenceText(site);
  const missing = [!site.address && "an address", site.geofence === null && "a geofence"].filter(
    Boolean,
  );

  return (
    <>
      <PageHeader
        back={{ href: `/app/clients/${site.clientId}?tab=sites`, label: site.clientName }}
        eyebrow={site.clientName}
        title={site.name}
        description={`${geofence ?? "No geofence"} · ${plural(
          site.checkpoints.length,
          "checkpoint",
          "checkpoints",
        )}`}
        actions={<SiteStatusChip site={site} />}
      />

      {site.status === "active" && missing.length > 0 ? (
        <p
          className="m-0 rounded-lg border border-line bg-surface px-4 py-3 text-sm"
          data-testid="site-needs-details"
        >
          Add {missing.join(" and ")} before your people clock in here.
        </p>
      ) : null}

      <Section id="site-details" title="Details">
        {canEdit ? (
          <SiteDetailsForm mode="edit" clientId={site.clientId} site={site} />
        ) : (
          <DetailList
            items={[
              {
                label: "Address",
                value: site.address ? (
                  <span className="whitespace-pre-line">{site.address}</span>
                ) : null,
              },
              { label: "State", value: site.state },
              { label: "Landmark", value: site.landmark },
            ]}
          />
        )}
      </Section>

      <Section
        id="geofence"
        title="Geofence"
        description={
          geofence
            ? `${geofence}. Set ${site.geofenceSetAt ? formatDateTime(site.geofenceSetAt) : ""}.`
            : "The area clock-in is checked against. Stand at the site and use your location, or type the coordinates."
        }
      >
        {canEdit ? (
          <GeofenceEditor
            siteId={site.id}
            initial={{
              mode: site.geofence === "outline" ? "outline" : "circle",
              centre: site.centre,
              radiusM: site.radiusM || RADIUS_DEFAULT_M,
              outline: site.outline,
            }}
          />
        ) : geofence ? null : (
          <p className="m-0 text-sm text-fg-muted">No geofence yet.</p>
        )}
      </Section>

      <Section
        id="checkpoints"
        title="QR checkpoints"
        description="Points a guard scans on patrol, in round order. Print the sheet and post each code at its place."
        actions={
          ctx.canEdit && site.checkpoints.length > 0 ? (
            <Button asChild variant="outline" className="h-11 px-4">
              <Link href={`/app/clients/${site.clientId}/sites/${site.id}/checkpoints/print`}>
                Print QR sheet
              </Link>
            </Button>
          ) : null
        }
      >
        {site.checkpoints.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">No checkpoints yet.</p>
        ) : canEdit ? (
          <ol className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {site.checkpoints.map((c, i) => (
              <CheckpointRow
                key={c.id}
                checkpoint={c}
                isFirst={i === 0}
                isLast={i === site.checkpoints.length - 1}
                rotatedLabel={
                  c.qrRotatedAt ? `Code renewed ${formatDateTime(c.qrRotatedAt)}` : null
                }
              />
            ))}
          </ol>
        ) : (
          <ol className="m-0 flex flex-col gap-1 pl-5 text-[15px]">
            {site.checkpoints.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ol>
        )}
        {canEdit ? <AddCheckpointForm siteId={site.id} /> : null}
        {ctx.canEdit && site.checkpoints.length > 0 ? (
          <Link
            href={`/app/attendance/patrols?site=${site.id}`}
            className="text-sm"
            data-testid="patrol-history-link"
          >
            Patrol history: who scanned each checkpoint, by day
          </Link>
        ) : null}
        {site.retiredCheckpointCount > 0 ? (
          <p className="m-0 text-xs text-fg-muted">
            {plural(site.retiredCheckpointCount, "retired checkpoint", "retired checkpoints")} kept
            for patrol history.
          </p>
        ) : null}
      </Section>

      {ctx.canEdit && site.clientStatus === "active" ? (
        <Section
          id="site-status"
          title={site.status === "active" ? "Archive" : "Archived"}
          description={
            site.status === "active"
              ? "Archived sites leave pickers but keep their checkpoints, mapping and history. You can restore them."
              : "This site is archived. Restore it to work there again."
          }
        >
          <SiteStatusForm siteId={site.id} status={site.status} />
        </Section>
      ) : null}
    </>
  );
}

export default function Page({ params }: PageProps<"/app/clients/[clientId]/sites/[siteId]">) {
  return (
    <RouteGate href="/app/clients/[id]/sites/[id]">
      <SitePage params={params} />
    </RouteGate>
  );
}
