"use client";

import { useActionState, useState } from "react";

import { FormAlert, SelectField, SubmitButton } from "@/components/form";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { describeOwnerChange, type OwnerChangeKind } from "@/lib/owners";
import { ROLE_LABELS, type Role } from "@/lib/roles";
import { TEAM_ROLES } from "@/lib/team";
import { lagosDate } from "@/lib/worker-invites";
import { decideOwnerChangeAction, requestOwnerChangeAction } from "@/server/identity/team-actions";
import type { TeamActionState } from "@/server/identity/team-state";

/**
 * Owner changes on Settings → Team (slice 1.13): make a manager an owner, remove or change an
 * owner, step down, and the requests waiting for a second owner. The database enforces every
 * rule; these only show what the viewer may try.
 */

const ROLE_CHOICES = TEAM_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

function Outcome({ state }: { state: TeamActionState }) {
  if (!state) return null;
  if (!state.ok) return <FormAlert message={state.formError ?? "That was not saved."} />;
  return (
    <p role="status" className="m-0 text-sm text-fg-muted">
      {state.message}
    </p>
  );
}

function approvalNote(needsApproval: boolean): string | null {
  return needsApproval ? "Another owner approves this before it happens." : null;
}

/** "Make owner" on a manager's row (owners only). */
export function MakeOwnerForm({
  membershipId,
  name,
  needsApproval,
}: {
  membershipId: string;
  name: string;
  needsApproval: boolean;
}) {
  const [state, action] = useActionState(requestOwnerChangeAction, null);
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 self-start rounded-lg"
          onClick={() => setConfirming(true)}
        >
          Make owner
        </Button>
        <Outcome state={state} />
      </div>
    );
  }
  return (
    <form action={action} aria-label={`Make ${name} an owner`} className="flex flex-col gap-2">
      <input type="hidden" name="kind" value="add" />
      <input type="hidden" name="membershipId" value={membershipId} />
      <p className="m-0 text-sm">
        Make {name} an owner? Owners can do everything, including changing the owners.{" "}
        {approvalNote(needsApproval)}
      </p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingLabel="Saving…" className="w-auto px-4">
          {needsApproval ? "Ask to make owner" : "Yes, make owner"}
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

/** On another owner's row: change them to a manager role, or remove them (with approval). */
export function OtherOwnerForms({ membershipId, name }: { membershipId: string; name: string }) {
  const [demoteState, demote] = useActionState(requestOwnerChangeAction, null);
  const [removeState, remove] = useActionState(requestOwnerChangeAction, null);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
      <form
        action={demote}
        noValidate
        aria-label={`Change ${name} from owner`}
        className="flex flex-col gap-2"
      >
        <input type="hidden" name="kind" value="demote" />
        <input type="hidden" name="membershipId" value={membershipId} />
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Change to"
            name="newRole"
            options={ROLE_CHOICES}
            defaultValue="admin"
            className="min-w-0 flex-[1_1_180px]"
          />
          <SubmitButton pendingLabel="Sending…" className="w-auto px-4">
            Ask to change
          </SubmitButton>
        </div>
        <Outcome state={demoteState} />
      </form>
      <form action={remove} aria-label={`Remove ${name} as owner`} className="flex flex-col gap-2">
        <input type="hidden" name="kind" value="remove" />
        <input type="hidden" name="membershipId" value={membershipId} />
        <SubmitButton pendingLabel="Sending…" className="w-auto self-start px-4">
          Ask to remove
        </SubmitButton>
        <Outcome state={removeState} />
      </form>
    </div>
  );
}

/** On the viewer's own row, when they are an owner: step down to a manager role. */
export function StepDownForm({
  membershipId,
  otherOwners,
}: {
  membershipId: string;
  otherOwners: number;
}) {
  const [state, action] = useActionState(requestOwnerChangeAction, null);
  if (otherOwners < 1) {
    return (
      <p className="m-0 text-sm text-fg-muted">
        You are the only owner. To hand over, make someone else an owner, then step down.
      </p>
    );
  }
  return (
    <form
      action={action}
      noValidate
      aria-label="Step down as owner"
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="kind" value="demote" />
      <input type="hidden" name="membershipId" value={membershipId} />
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Step down to"
          name="newRole"
          options={ROLE_CHOICES}
          defaultValue="admin"
          className="min-w-0 flex-[1_1_180px]"
        />
        <SubmitButton pendingLabel="Sending…" className="w-auto px-4">
          Ask to step down
        </SubmitButton>
      </div>
      <p className="m-0 text-xs text-fg-muted">Another owner approves this before it happens.</p>
      <Outcome state={state} />
    </form>
  );
}

export interface OwnerChangeView {
  id: string;
  kind: OwnerChangeKind;
  requestedBy: string;
  requesterName: string | null;
  targetUserId: string | null;
  targetName: string | null;
  inviteEmail: string | null;
  newRole: Role | null;
  createdAt: string;
  /** What the viewer may do. */
  canDecide: boolean;
  canWithdraw: boolean;
}

function DecideForm({ change }: { change: OwnerChangeView }) {
  const [state, action] = useActionState(decideOwnerChangeAction, null);
  return (
    <form action={action} className="flex flex-col gap-2" aria-label="Decide owner change">
      <input type="hidden" name="changeId" value={change.id} />
      <div className="flex flex-wrap gap-2">
        {change.canDecide ? (
          <>
            <Button type="submit" name="decision" value="approve" className="h-11 rounded-lg px-4">
              Approve
            </Button>
            <Button
              type="submit"
              name="decision"
              value="reject"
              variant="outline"
              className="h-11 rounded-lg"
            >
              Reject
            </Button>
          </>
        ) : null}
        {change.canWithdraw ? (
          <Button
            type="submit"
            name="decision"
            value="cancel"
            variant="outline"
            className="h-11 rounded-lg"
          >
            Withdraw
          </Button>
        ) : null}
      </div>
      <Outcome state={state} />
    </form>
  );
}

/** The owner changes waiting for a second owner. */
export function PendingOwnerChanges({ changes }: { changes: OwnerChangeView[] }) {
  if (changes.length === 0) return null;
  return (
    <section aria-labelledby="team-owner-changes" className="flex flex-col gap-3">
      <h2 id="team-owner-changes" className="m-0 type-h3">
        Owner changes waiting for approval
      </h2>
      <ul className="m-0 flex list-none flex-col p-0">
        {changes.map((c) => {
          const summary = describeOwnerChange({
            kind: c.kind,
            targetName: c.targetName,
            inviteEmail: c.inviteEmail,
            newRoleLabel: c.newRole ? ROLE_LABELS[c.newRole] : null,
            requesterName: c.requesterName,
            selfDemotion: c.kind === "demote" && c.targetUserId === c.requestedBy,
          });
          return (
            <li
              key={c.id}
              aria-label={summary}
              data-testid="owner-change"
              className="flex flex-col gap-3 border-t border-line py-4 first:border-t-0 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)] lg:items-center lg:gap-6"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px] font-semibold">{summary}</span>
                <span className="text-sm text-fg-muted">
                  Asked by {c.requesterName ?? "an owner"} on {lagosDate(c.createdAt)}
                </span>
                <Status tone="pending">
                  {c.canDecide ? "Waiting for your approval" : "Waiting for another owner"}
                </Status>
              </div>
              {c.canDecide || c.canWithdraw ? (
                <DecideForm change={c} />
              ) : (
                <p className="m-0 text-sm text-fg-muted">
                  A different owner from the one who asked approves or rejects it.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
