import Link from "next/link";

import { Status } from "@/components/status";
import { formatDateTime } from "@/lib/dates";
import {
  PIN_HOLD_AFTER_LOCKOUTS,
  PIN_HOLD_WINDOW_HOURS,
  PIN_LOCK_MINUTES,
  PIN_MAX_ATTEMPTS,
  signInState,
  type SignInCredential,
} from "@/lib/pin-lockout";

import { DetailList } from "./display";
import { UnlockSignInButton } from "./staff-id-forms";

/**
 * "Phone sign-in" on a worker's page (slice 1.11, owner decision 18): whether they have a PIN,
 * the lock after 5 wrong PINs, the hold after 3 lockouts in 24 hours, and what the viewer can do
 * about it. Shown to owner, admin, hr and the worker's line manager.
 */
export function SignInPanel({
  workerId,
  credential,
  canUnlock,
  canSendInvite,
  now,
}: {
  workerId: string;
  credential: SignInCredential | null;
  /** The viewer may try an unlock (the database decides for line managers). */
  canUnlock: boolean;
  /** Owner, admin or hr: may send a new invite, which sets a new PIN. */
  canSendInvite: boolean;
  now: Date;
}) {
  const state = signInState(credential, now);
  const inviteLink = canSendInvite ? (
    <Link href="/app/people/invites" className="text-sm">
      Send a new invite
    </Link>
  ) : null;

  if (state.kind === "no_login" || !credential) {
    return (
      <div className="flex flex-col gap-3" data-testid="sign-in-status" data-state="no_login">
        <p className="m-0 text-sm text-fg-muted">
          No PIN set yet. They sign in on their phone once they open their invite and set one.
        </p>
        {inviteLink}
      </div>
    );
  }

  const details = [
    { label: "PIN set", value: formatDateTime(credential.pinSetAt) },
    {
      label: "Last sign-in",
      value: credential.lastSignInAt ? formatDateTime(credential.lastSignInAt) : "Not yet",
    },
  ];

  if (state.kind === "held") {
    return (
      <div className="flex flex-col gap-3" data-testid="sign-in-status" data-state="held">
        <Status tone="action" className="font-semibold">
          Locked until a new PIN
        </Status>
        <p className="m-0 text-sm">
          Sign-in locked {PIN_HOLD_AFTER_LOCKOUTS} times in {PIN_HOLD_WINDOW_HOURS} hours, so it
          stays locked until they set a new PIN from a new invite. Nobody can unlock it.
        </p>
        <DetailList items={[...details, { label: "Held since", value: formatDateTime(state.since) }]} />
        {inviteLink ?? (
          <p className="m-0 text-sm text-fg-muted">Ask HR to send them a new invite.</p>
        )}
      </div>
    );
  }

  if (state.kind === "locked") {
    return (
      <div className="flex flex-col gap-3" data-testid="sign-in-status" data-state="locked">
        <Status tone="action" className="font-semibold">
          Locked until {formatDateTime(state.until)}
        </Status>
        <p className="m-0 text-sm">
          {PIN_MAX_ATTEMPTS} wrong PINs in a row lock sign-in for {PIN_LOCK_MINUTES} minutes. If
          you know it was them, unlock it now. The {PIN_HOLD_AFTER_LOCKOUTS}rd lock in{" "}
          {PIN_HOLD_WINDOW_HOURS} hours can only be lifted with a new PIN.
        </p>
        <DetailList items={details} />
        {canUnlock ? <UnlockSignInButton workerId={workerId} /> : null}
        {inviteLink}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="sign-in-status" data-state="open">
      <Status tone="done">Signed up</Status>
      <DetailList
        items={[
          ...details,
          ...(state.failedAttempts > 0
            ? [{ label: "Wrong PINs since last sign-in", value: String(state.failedAttempts) }]
            : []),
        ]}
      />
    </div>
  );
}
