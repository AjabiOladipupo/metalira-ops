import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { createServerSupabase } from "@/lib/supabase/server";
import { plural, rosterSummary } from "@/lib/worker-invites";
import { getActiveCompany } from "@/server/identity/company-data";
import { loadInviteRoster } from "@/server/identity/worker-invites";

import { RouteGate } from "../../_shell/slots";
import { InvitesPanel } from "./invites-panel";

export const metadata: Metadata = { title: "Worker invites" };

async function Invites() {
  const company = await getActiveCompany();
  if (!company) redirect("/no-access");
  const supabase = await createServerSupabase();
  const roster = await loadInviteRoster(supabase, company.id);
  const summary = rosterSummary(roster);

  return (
    <>
      <PageHeader
        back={{ href: "/app/people", label: "People" }}
        eyebrow="People"
        title="Worker invites"
        description={`${plural(summary.total, "employee")} · ${summary.signedUp.toLocaleString("en-NG")} signed up · ${summary.invited.toLocaleString("en-NG")} invited · ${summary.notInvited.toLocaleString("en-NG")} not invited`}
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-surface p-5">
        <div className="flex flex-col gap-1">
          <span className="type-label text-fg-muted">Company code</span>
          <span className="font-mono text-2xl font-semibold tracking-[0.2em]">
            {company.companyCode}
          </span>
        </div>
        <p className="m-0 max-w-xl text-sm text-fg-muted">
          Workers sign in on their phone with this code, their staff ID and a 6-digit PIN they set
          from their invite. Workers with an email get the invite by email; print a sheet of QR
          codes for everyone else. A new invite for someone who already signed up resets their PIN.
        </p>
      </div>
      <InvitesPanel workers={roster} />
    </>
  );
}

/** Invite workers to the phone app, by email or on a printed QR sheet (slice 1.9). */
export default function Page() {
  return (
    <RouteGate href="/app/people/invites">
      <Invites />
    </RouteGate>
  );
}
