"use client";

import { useActionState, useState } from "react";

import { Field, FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS, type Role } from "@/lib/roles";
import { isTeamRole, memberRefusal, TEAM_ROLE_HINTS, type TeamRole } from "@/lib/team";
import { lagosDate } from "@/lib/worker-invites";
import type { PendingInvite, TeamMember } from "@/server/identity/team";
import {
  cancelInviteAction,
  changeRoleAction,
  inviteManagerAction,
  removeMemberAction,
  resendInviteAction,
} from "@/server/identity/team-actions";
import type { TeamActionState } from "@/server/identity/team-state";

type Option = { value: TeamRole; label: string };

const ROW =
  "flex flex-col gap-3 border-t border-line py-4 first:border-t-0 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,2fr)] lg:items-center lg:gap-6";

/** One sentence after a change: status when it worked, alert when it did not. */
function Outcome({ state }: { state: TeamActionState }) {
  if (!state) return null;
  if (!state.ok) return <FormAlert message={state.formError ?? "That was not saved."} />;
  return (
    <p role="status" className="m-0 text-sm text-fg-muted">
      {state.message}
    </p>
  );
}

/** The invite link, shown once when the email did not go out, with a copy button. */
function ShareLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium" htmlFor="team-invite-link">
        Invite link
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="team-invite-link"
          readOnly
          value={link}
          data-testid="team-invite-link"
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 min-w-0 flex-[1_1_240px] rounded-lg border border-line bg-background px-3 font-mono text-[13px]"
        />
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-lg"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <p className="m-0 text-xs text-fg-muted">
        Only the person with this email can use it, once, within 7 days.
      </p>
    </div>
  );
}

/** Invite a manager by email with one role. */
export function InviteForm({ options }: { options: Option[] }) {
  const [state, action] = useActionState(inviteManagerAction, null);
  const failed = state && !state.ok ? state : null;
  const [role, setRole] = useState<string>(failed?.values?.role ?? "hr");
  const hint = isTeamRole(role) ? TEAM_ROLE_HINTS[role] : undefined;
  return (
    <form
      key={state?.ok ? state.message : "invite"}
      action={action}
      noValidate
      aria-label="Invite a manager"
      className="flex flex-col gap-4 rounded-xl bg-surface p-4 sm:p-5"
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] items-start gap-4">
        <Field
          label="Work email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="hauwa@company.ng"
          required
          defaultValue={failed?.values?.email ?? ""}
          error={failed?.fieldErrors?.email}
        />
        <SelectField
          label="Role"
          name="role"
          options={options}
          value={role}
          onChange={(e) => setRole(e.currentTarget.value)}
          hint={hint}
          error={failed?.fieldErrors?.role}
        />
      </div>
      <FormAlert message={failed?.formError} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Sending…" className="w-auto px-5">
          Send invite
        </SubmitButton>
        {state?.ok ? (
          <p role="status" className="m-0 text-sm text-fg-muted">
            {state.message}
          </p>
        ) : null}
      </div>
      {state?.ok && state.link ? <ShareLink link={state.link} /> : null}
    </form>
  );
}

function displayName(member: TeamMember): string {
  return member.fullName?.trim() || member.email;
}

/** Change role: a select of the roles the viewer may grant, then Save. */
function ChangeRoleForm({ member, options }: { member: TeamMember; options: Option[] }) {
  const [state, action] = useActionState(changeRoleAction, null);
  const name = displayName(member);
  return (
    <form
      action={action}
      noValidate
      aria-label={`Change role for ${name}`}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Role"
          name="role"
          options={options}
          defaultValue={member.role}
          className="min-w-0 flex-[1_1_180px]"
        />
        <SubmitButton pendingLabel="Saving…" className="w-auto px-4">
          Save role
        </SubmitButton>
      </div>
      <Outcome state={state} />
    </form>
  );
}

/** Remove, with a second click to confirm. */
function RemoveForm({ member }: { member: TeamMember }) {
  const [state, action] = useActionState(removeMemberAction, null);
  const [confirming, setConfirming] = useState(false);
  const name = displayName(member);
  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 self-start rounded-lg"
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
        <Outcome state={state} />
      </div>
    );
  }
  return (
    <form action={action} aria-label={`Remove ${name}`} className="flex flex-col gap-2">
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <p className="m-0 text-sm">Remove {name}? They lose access to this company at once.</p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingLabel="Removing…" className="w-auto px-4">
          Yes, remove
        </SubmitButton>
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-lg"
          onClick={() => setConfirming(false)}
        >
          Keep
        </Button>
      </div>
      <Outcome state={state} />
    </form>
  );
}

/** One manager: who, role, since when, and the changes the viewer may make. */
export function MemberRow({
  member,
  actor,
  options,
}: {
  member: TeamMember;
  actor: { userId: string; role: Role };
  options: Option[];
}) {
  const name = displayName(member);
  const isYou = member.userId === actor.userId;
  const refusal = memberRefusal(actor, member);
  const note =
    refusal === "own_membership"
      ? "You can't change your own role."
      : refusal === "owner_protected"
        ? "The owner can't be removed or changed."
        : refusal === "owner_only"
          ? "Only the owner can change an admin."
          : null;
  return (
    <li aria-label={name} data-testid="team-member" className={ROW}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold">
          {name}
          {isYou ? <span className="font-normal text-fg-muted"> (you)</span> : null}
        </span>
        {member.fullName ? (
          <span className="truncate text-sm text-fg-muted">{member.email}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 text-sm">
        <span data-testid="team-member-role" className="font-medium">
          {ROLE_LABELS[member.role]}
        </span>
        <span className="text-fg-muted">Joined {lagosDate(member.joinedAt)}</span>
      </div>
      {refusal === null ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <ChangeRoleForm member={member} options={options} />
          <RemoveForm member={member} />
        </div>
      ) : (
        <p className="m-0 text-sm text-fg-muted">{note}</p>
      )}
    </li>
  );
}

function ResendForm({ invite }: { invite: PendingInvite }) {
  const [state, action] = useActionState(resendInviteAction, null);
  return (
    <form
      action={action}
      aria-label={`Resend invite to ${invite.email}`}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="inviteId" value={invite.id} />
      <SubmitButton pendingLabel="Sending…" className="w-auto px-4">
        Resend
      </SubmitButton>
      <Outcome state={state} />
      {state?.ok && state.link ? <ShareLink link={state.link} /> : null}
    </form>
  );
}

function CancelForm({ invite }: { invite: PendingInvite }) {
  const [state, action] = useActionState(cancelInviteAction, null);
  return (
    <form
      action={action}
      aria-label={`Cancel invite to ${invite.email}`}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="inviteId" value={invite.id} />
      <Button type="submit" variant="outline" className="h-11 self-start rounded-lg">
        Cancel invite
      </Button>
      <Outcome state={state} />
    </form>
  );
}

/** One pending invite: who, which role, when it was sent and when it runs out. */
export function InviteRow({
  invite,
  expired,
  canManage,
}: {
  invite: PendingInvite;
  /** Worked out on the server, so the server and browser render the same. */
  expired: boolean;
  canManage: boolean;
}) {
  return (
    <li aria-label={invite.email} data-testid="team-invite" className={ROW}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold">{invite.email}</span>
        <span className="text-sm text-fg-muted">
          Sent {lagosDate(invite.sentAt)}
          {invite.invitedBy ? ` by ${invite.invitedBy}` : ""}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium">{ROLE_LABELS[invite.role]}</span>
        {expired ? (
          <Status tone="action">Expired</Status>
        ) : (
          <Status tone="pending">Pending until {lagosDate(invite.expiresAt)}</Status>
        )}
      </div>
      {canManage ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <ResendForm invite={invite} />
          <CancelForm invite={invite} />
        </div>
      ) : (
        <p className="m-0 text-sm text-fg-muted">Only the owner can change an admin invite.</p>
      )}
    </li>
  );
}
