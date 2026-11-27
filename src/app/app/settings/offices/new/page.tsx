import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";

import { RouteGate } from "../../../_shell/slots";
import { SiteDetailsForm } from "../../../clients/_components/site-forms";

export const metadata: Metadata = { title: "Add a branch office" };

/** A branch beside Head office (slice 6.11): owner, admin and ops_manager. */
export default function Page() {
  return (
    <RouteGate href="/app/settings/offices/new">
      <PageHeader
        back={{ href: "/app/settings/company#head-office", label: "Company" }}
        eyebrow="Your offices"
        title="Add a branch office"
        description="Name the office and where it is. Set its geofence on the next page. Staff mapped to it are overhead, like Head office."
      />
      <SiteDetailsForm mode="create" office />
    </RouteGate>
  );
}
