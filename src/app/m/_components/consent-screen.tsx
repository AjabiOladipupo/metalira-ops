"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CONSENT_NOTICES, type ConsentKind } from "@/lib/messages/consent";
import { workerMessages } from "@/lib/messages/worker";
import { acceptConsentAction, withdrawConsentAction } from "@/server/workforce/consent-actions";

const copy = workerMessages.consent;

/** One notice's state, as the page read it ("14 Nov 2026" dates already formatted). */
export interface ConsentCardState {
  kind: ConsentKind;
  /** The day the open consent was given, or null when there is none. */
  agreedOn: string | null;
  /** The day the last consent was withdrawn, when the latest one is withdrawn. */
  withdrawnOn: string | null;
}

function PendingButton({
  children,
  pending: pendingLabel,
  variant,
}: {
  children: string;
  pending: string;
  variant: "default" | "outline";
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      aria-disabled={pending}
      className="h-[52px] w-full rounded-xl text-base"
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}

function ConsentCard({ state }: { state: ConsentCardState }) {
  const notice = CONSENT_NOTICES[state.kind];
  const agreed = state.agreedOn !== null;
  const [result, action] = useActionState(
    agreed ? withdrawConsentAction : acceptConsentAction,
    null,
  );
  const headingId = `consent-${state.kind}`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid={`consent-${state.kind}`}
      data-agreed={agreed ? "yes" : "no"}
      className="flex flex-col gap-3 rounded-xl border border-line px-4 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="m-0 font-display text-lg font-bold">
          {notice.title}
        </h2>
        {agreed ? (
          <Status tone="done" className="whitespace-normal">
            {copy.agreedOn(state.agreedOn!)}
          </Status>
        ) : (
          <Status tone="pending" className="whitespace-normal">
            {state.withdrawnOn ? copy.withdrawnOn(state.withdrawnOn) : copy.notAgreed}
          </Status>
        )}
      </div>
      {notice.body.map((paragraph) => (
        <p key={paragraph} className="m-0 text-[15px]">
          {paragraph}
        </p>
      ))}
      <form action={action} className="flex flex-col gap-2 pt-1">
        <input type="hidden" name="kind" value={state.kind} />
        {agreed ? (
          <PendingButton variant="outline" pending={copy.withdrawPending}>
            {copy.withdraw}
          </PendingButton>
        ) : (
          <>
            <p className="m-0 text-sm text-fg-muted">{notice.agree}.</p>
            <PendingButton variant="default" pending={copy.agreePending}>
              {copy.agree}
            </PendingButton>
          </>
        )}
        <p role="status" className="m-0 min-h-5 text-sm text-fg-muted">
          {result?.message ?? null}
        </p>
      </form>
    </section>
  );
}

/**
 * The location and selfie notices with "I agree" or "Withdraw" (slice 3.1). Shown from Me ->
 * Location and selfie, and by slice 3.5 before a worker's first clock-in. Declining is a real
 * choice: the supervisor clocks the worker in instead (owner decision, 20 Nov 2026).
 */
export function ConsentScreen({ consents }: { consents: readonly ConsentCardState[] }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[15px]">{copy.intro}</p>
      {consents.map((state) => (
        // A new key when the state flips, so the form's last message resets.
        <ConsentCard key={`${state.kind}-${state.agreedOn ?? "no"}`} state={state} />
      ))}
      <p className="m-0 rounded-xl bg-surface px-4 py-3 text-[15px]" data-testid="consent-decline">
        {copy.declineNote}
      </p>
    </div>
  );
}
