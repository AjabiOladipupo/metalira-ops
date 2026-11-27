import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { RADIUS_DEFAULT_M, formatArea, formatLatLng } from "@/lib/geofence";
import { loadOfficeSite, type SiteDetail } from "@/server/sites/sites-data";

import { RouteGate } from "../../../_shell/slots";
import { clientsPageContext } from "../../../clients/_components/context";
import { GeofenceEditor } from "../../../clients/_components/geofence-editor";
import {
  AddCheckpointForm,
  CheckpointRow,
  SiteDetailsForm,
} from "../../../clients/_components/site-forms";
import { DetailList, Section, plural } from "../../../people/_components/display";

export const metadata: Metadata = { title: "Office" };

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

/**
 * One of the company's own offices (slice 6.11): Head office or a branch. Its address, geofence
 * and checkpoints are set as a client's site's are (the same forms and actions, owner, admin and
 * ops_manager). Staff mapped here clock in with the no-shift clock-in, checked against this
 * geofence. An office has no contracts, posts or rosters, and their pay is overhead.
 */
async function OfficePage({
  params,
}: {
  params: PageProps<"/app/settings/offices/[siteId]">["params"];
}) {
  const { siteId } = await params;
  const ctx = await clientsPageContext();
  const site = await loadOfficeSite(ctx.supabase, ctx.organisationId, siteId);
  if (!site) notFound();
  const canEdit = ctx.canEdit && site.status === "active";
  const geofence = geofenceText(site);
  const missing = [!site.address && "an address", site.geofence === null && "a geofence"].filter(
    Boolean,
  );
  const back =
    ctx.role === "owner" || ctx.role === "admin"
      ? { href: "/app/settings/company#head-office", label: "Company" }
      : { href: "/app", label: "Home" };

  return (
    <>
      <PageHeader
        back={back}
        eyebrow="Your office"
        title={site.name}
        description={`${geofence ?? "No geofence"} · ${plural(
          site.checkpoints.length,
          "checkpoint",
          "checkpoints",
        )} · staff here are overhead`}
        actions={
          site.status === "archived" ? (
            <Status tone="pending">Archived</Status>
          ) : site.needsDetails ? (
            <Status tone="action">Needs details</Status>
          ) : (
            <Status tone="done">Ready</Status>
          )
        }
      />

      {site.status === "active" && missing.length > 0 ? (
        <p
          className="m-0 rounded-lg border border-line bg-surface px-4 py-3 text-sm"
          data-testid="site-needs-details"
        >
          Add {missing.join(" and ")} before your office staff clock in here.
        </p>
      ) : null}

      <Section id="site-details" title="Details">
        {canEdit ? (
          <SiteDetailsForm mode="edit" office site={site} />
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
            : "The area office staff clock in against. Stand at the office and use your location, or type the coordinates."
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
        description="Points a guard scans on patrol, in round order. Most offices need none."
        actions={
          ctx.canEdit && site.checkpoints.length > 0 ? (
            <Button asChild variant="outline" className="h-11 px-4">
              <Link href={`/app/settings/offices/${site.id}/checkpoints/print`}>
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
        {site.retiredCheckpointCount > 0 ? (
          <p className="m-0 text-xs text-fg-muted">
            {plural(site.retiredCheckpointCount, "retired checkpoint", "retired checkpoints")} kept
            for patrol history.
          </p>
        ) : null}
      </Section>
    </>
  );
}

export default function Page({ params }: PageProps<"/app/settings/offices/[siteId]">) {
  return (
    <RouteGate href="/app/settings/offices/[id]">
      <OfficePage params={params} />
    </RouteGate>
  );
}
