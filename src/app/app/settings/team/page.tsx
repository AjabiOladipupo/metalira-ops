import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { needsSecondOwner, ownerChangeChoices } from "@/lib/owners";
import { ROLE_LABELS } from "@/lib/roles";
import { inviteState, isTeamRole, roleOptions } from "@/lib/team";
import { requireAppAccess } from "@/server/identity/session";
import { createServerSupabase } from "@/lib/supabase/server";
import { loadPendingOwnerChanges } from "@/server/identity/owners";
import { loadTeam } from "@/server/identity/team";
import { plural } from "@/lib/worker-invites";

import { RouteGate } from "../../_shell/slots";
import {
  MakeOwnerForm,
  OtherOwnerForms,
  PendingOwnerChanges,
  StepDownForm,
  type OwnerChangeView,
} from "./owner-forms";
import { InviteForm, InviteRow, MemberRow } from "./team-forms";

export const metadata: Metadata = { title: "Team" };

const HREF = "/app/settings/team";

/** Managers, pending invites, owner changes and the invite form. Owners and admins. */
async function TeamSettings() {
  const session = await requireAppAccess(HREF);
  const { organisationId, role } = session.active;
  const supabase = await createServerSupabase();
  const [team, pendingOwners] = await Promise.all([
    loadTeam(supabase, organisationId),
    loadPendingOwnerChanges(supabase, organisationId),
  ]);
  const isOwner = role === "owner";
  // Owners may also invite someone as an owner (slice 1.13).
  const options = [
    ...roleOptions(role),
    ...(isOwner ? [{ value: "owner" as const, label: ROLE_LABELS.owner }] : []),
  ];
  const actor = { userId: session.user.id, role };
  const now = new Date();
  const ownerCount = team.members.filter((m) => m.role === "owner").length;
  const ownerChanges: OwnerChangeView[] = pendingOwners.map((c) => ({
    ...c,
    ...(() => {
      const choices = ownerChangeChoices(actor, c);
      return { canDecide: choices.decide, canWithdraw: choices.withdraw };
    })(),
  }));

  return (
    <>
      <PageHeader
        back={{ href: "/app/settings", label: "Settings" }}
        eyebrow="Settings"
        title="Team"
        description={`${plural(team.members.length, "manager")} · ${plural(team.invites.length, "pending invite")} · workers sign in on their phones and are managed in People.`}
      />
      <InviteForm options={options} />

      <PendingOwnerChanges changes={ownerChanges} />

      <section aria-labelledby="team-managers" className="flex flex-col gap-3">
        <h2 id="team-managers" className="m-0 type-h3">
          Managers
        </h2>
        <ul className="m-0 flex list-none flex-col p-0">
          {team.members.map((m) => {
            const name = m.fullName?.trim() || m.email;
            let ownerActions: React.ReactNode = null;
            if (isOwner && m.role === "owner") {
              ownerActions =
                m.userId === actor.userId ? (
                  <StepDownForm membershipId={m.membershipId} otherOwners={ownerCount - 1} />
                ) : (
                  <OtherOwnerForms membershipId={m.membershipId} name={name} />
                );
            } else if (isOwner && isTeamRole(m.role) && m.userId !== actor.userId) {
              ownerActions = (
                <MakeOwnerForm
                  membershipId={m.membershipId}
                  name={name}
                  needsApproval={needsSecondOwner("add", ownerCount)}
                />
              );
            }
            return (
              <MemberRow
                key={m.membershipId}
                member={m}
                actor={actor}
                options={options}
                ownerActions={ownerActions}
              />
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="team-invites" className="flex flex-col gap-3">
        <h2 id="team-invites" className="m-0 type-h3">
          Pending invites
        </h2>
        {team.invites.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            No invites waiting. Invite a manager above; the link works for 7 days.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {team.invites.map((i) => (
              <InviteRow
                key={i.id}
                invite={i}
                expired={
                  inviteState(
                    { acceptedAt: null, revokedAt: null, expiresAt: i.expiresAt },
                    now,
                  ) === "expired"
                }
                canManage={isOwner || (i.role !== "admin" && i.role !== "owner")}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href={HREF}>
      <TeamSettings />
    </RouteGate>
  );
}
