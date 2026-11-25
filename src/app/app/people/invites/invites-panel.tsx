"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { useRouter } from "next/navigation";

import { BulkPreviewSheet } from "@/components/bulk-preview-sheet";
import { DataTable, type Column } from "@/components/data-table";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { bulkSummary } from "@/lib/bulk-approve";
import { inviteStatus, lagosDate, plural, type RosterWorker } from "@/lib/worker-invites";
import type { InviteBulkAction, InviteBulkPreview } from "@/server/identity/worker-invite-bulk";
import {
  inviteBulkAction,
  previewInviteBulkAction,
} from "@/server/identity/worker-invite-bulk-actions";
import { createInviteSheet, emailWorkerInvites } from "@/server/identity/worker-invite-actions";
import type { InviteActionState } from "@/server/identity/worker-invite-state";

const ALL = "all";
const NO_SITE = "none";

function SubmitWith({
  action,
  disabled,
  pendingLabel,
  variant = "default",
  children,
}: {
  action: (formData: FormData) => void;
  disabled: boolean;
  pendingLabel: string;
  variant?: "default" | "outline";
  children: React.ReactNode;
}) {
  const { pending, action: running } = useFormStatus();
  const busy = pending && running === action;
  return (
    <Button
      type="submit"
      formAction={action}
      variant={variant}
      disabled={disabled || pending}
      className="h-11 rounded-lg"
    >
      {busy ? pendingLabel : children}
    </Button>
  );
}

function Message({ state }: { state: InviteActionState }) {
  if (!state) return null;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className="m-0 rounded-lg border border-foreground bg-surface px-3 py-2.5 text-sm"
    >
      {state.message}
    </p>
  );
}

function InviteSheet({
  sheet,
  onClose,
}: {
  sheet: Extract<InviteActionState, { kind: "print" }>;
  onClose: () => void;
}) {
  return (
    <section
      aria-labelledby="invite-sheet-title"
      className="invite-sheet flex flex-col gap-4 rounded-xl border border-line bg-background p-4 md:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="invite-sheet-title" className="m-0 type-h3">
            {sheet.companyName} · phone app invites
          </h2>
          <p className="m-0 text-sm text-fg-muted">
            Company code {sheet.companyCode}. Each link works once, until {sheet.expiresOn}.
            Printing a new sheet for the same people replaces these links.
          </p>
        </div>
        <div className="flex gap-2" data-print-hide>
          <Button type="button" onClick={() => window.print()} className="h-10">
            Print
          </Button>
          <Button type="button" variant="outline" onClick={onClose} className="h-10">
            Close
          </Button>
        </div>
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {sheet.cards.map((card) => (
          <li
            key={card.workerId}
            className="invite-card flex gap-3 rounded-lg border border-line p-3"
            data-testid="invite-card"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL made on the server */}
            <img
              src={card.qr}
              alt={`QR code for ${card.name}'s invite link`}
              width={112}
              height={112}
              className="size-28 shrink-0"
            />
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-[15px] font-semibold">{card.name}</span>
              <span>Staff ID {card.staffId}</span>
              <span>Company code {sheet.companyCode}</span>
              {card.siteName ? <span className="text-fg-muted">{card.siteName}</span> : null}
              <span
                className="font-mono text-[11px] break-all text-fg-muted"
                data-testid="invite-url"
              >
                {card.url}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-fg-muted">
        Scan the code with the phone camera, or type the link. Then choose a 6-digit PIN.
      </p>
    </section>
  );
}

function invitePlan(value: InviteBulkPreview) {
  const verb = value.action === "resend" ? "emailed" : "cancelled";
  return {
    passing: value.done.map((w) => ({
      id: w.workerId,
      title: w.name ?? "Unnamed",
      detail: w.staffId ? `Staff ID ${w.staffId}` : undefined,
    })),
    skipped: value.skipped.map((w) => ({
      id: w.workerId,
      title: w.name ?? "Unnamed",
      detail: w.staffId ? `Staff ID ${w.staffId}` : undefined,
      reason: w.reason,
    })),
    summary: bulkSummary(
      value.done.length,
      value.skipped.map((w) => w.reason),
      { verb },
    ),
    digest: value.selection.digest,
    act: value.selection.act,
  };
}

/**
 * "Resend" and "Cancel invite" for the chosen workers (slice U.2): a preview of who is emailed
 * or cancelled and who is skipped and why, then the confirm. Resends follow the shared email
 * caps; anyone past them is skipped and listed.
 */
function InviteBulkButtons({ ids, onDone }: { ids: string[]; onDone: (message: string) => void }) {
  const sheet = (action: InviteBulkAction) => (
    <BulkPreviewSheet
      key={action}
      trigger={action === "resend" ? "Resend invites" : "Cancel invites"}
      title={action === "resend" ? "Resend invites" : "Cancel invites"}
      description={
        action === "resend"
          ? "Emails a fresh invite link to each chosen worker whose invite wasn't used; the old link stops working. Up to 500 at a time, within today's email limits."
          : "Cancels each chosen worker's open invite, so its link stops working. Up to 500 at a time."
      }
      confirmLabel={(n) =>
        `${action === "resend" ? "Resend" : "Cancel"} ${n} ${n === 1 ? "invite" : "invites"}`
      }
      pendingLabel={action === "resend" ? "Sending…" : "Cancelling…"}
      preview={() => previewInviteBulkAction({ action, workerIds: ids })}
      confirm={(signed) => inviteBulkAction({ action, workerIds: ids, ...signed })}
      plan={invitePlan}
      onDone={onDone}
    />
  );
  return (
    <>
      {sheet("resend")}
      {sheet("cancel")}
    </>
  );
}

/**
 * Pick workers (by site, or everyone not signed up), then email their invites or print a QR
 * sheet. The sheet shows only after the server has created the invites; the links are never
 * stored anywhere else.
 */
export function InvitesPanel({ workers }: { workers: RosterWorker[] }) {
  const [emailState, emailAction] = useActionState(emailWorkerInvites, null);
  const [printState, printAction] = useActionState(createInviteSheet, null);
  const [site, setSite] = useState(ALL);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [closedSheet, setClosedSheet] = useState<InviteActionState>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const router = useRouter();

  const now = useMemo(() => new Date(), []);
  const sites = useMemo(() => {
    const names = new Map<string, string>();
    for (const w of workers) if (w.siteId && w.siteName) names.set(w.siteId, w.siteName);
    return [...names].sort((a, b) => a[1].localeCompare(b[1]));
  }, [workers]);

  const visible = useMemo(
    () =>
      workers.filter((w) =>
        site === ALL ? true : site === NO_SITE ? w.siteId === null : w.siteId === site,
      ),
    [workers, site],
  );

  const chosen = workers.filter((w) => selected.has(w.id));
  const chosenWithEmail = chosen.filter((w) => w.hasEmail).length;
  const chosenSignedUp = chosen.filter((w) => w.pinSetAt).length;
  const allVisibleChosen = visible.length > 0 && visible.every((w) => selected.has(w.id));

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function chooseVisible(predicate: (w: RosterWorker) => boolean) {
    setSelected(new Set(visible.filter(predicate).map((w) => w.id)));
  }

  const columns: Column<RosterWorker>[] = [
    {
      key: "select",
      header: "",
      className: "w-10",
      cell: (w) => (
        // A 44px hit area around the box, for thumbs.
        <label className="-mx-2 -my-2.5 flex size-11 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            aria-label={`Choose ${w.firstName} ${w.lastName}`}
            checked={selected.has(w.id)}
            onChange={(event) => toggle(w.id, event.target.checked)}
            className="size-[18px] cursor-pointer accent-[var(--fg)]"
          />
        </label>
      ),
    },
    {
      key: "employee",
      header: "Employee",
      cell: (w) => (
        <span className="flex flex-col">
          <span className="font-medium">
            {w.firstName} {w.lastName}
          </span>
          <span className="text-xs text-fg-muted">{w.staffId}</span>
        </span>
      ),
    },
    { key: "site", header: "Site", cell: (w) => w.siteName ?? "No site" },
    { key: "email", header: "Email", cell: (w) => (w.hasEmail ? "Yes" : "No") },
    {
      key: "status",
      header: "Phone app",
      cell: (w) => {
        const status = inviteStatus(w, now);
        return (
          <span className="flex flex-col gap-0.5">
            <Status tone={status.tone}>{status.label}</Status>
            {status.kind === "signed_up" && w.lastSignInAt ? (
              <span className="text-xs text-fg-muted">Last in {lagosDate(w.lastSignInAt)}</span>
            ) : null}
            {status.kind === "invited" && w.openInvite ? (
              <span className="text-xs text-fg-muted">
                Until {lagosDate(w.openInvite.expiresAt)}
              </span>
            ) : null}
          </span>
        );
      },
    },
  ];

  const sheet =
    printState?.ok && printState.kind === "print" && printState !== closedSheet ? printState : null;
  const noneChosen = chosen.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {sheet ? <InviteSheet sheet={sheet} onClose={() => setClosedSheet(printState)} /> : null}

      <form className="flex flex-col gap-4">
        {chosen.map((w) => (
          <input key={w.id} type="hidden" name="workerId" value={w.id} />
        ))}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-col gap-1.5 text-[13px] font-medium">
            Site
            <select
              value={site}
              onChange={(event) => setSite(event.target.value)}
              className="h-11 rounded-lg border border-line bg-background px-3 text-[15px] font-normal"
            >
              <option value={ALL}>All sites</option>
              {sites.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              <option value={NO_SITE}>No site yet</option>
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-lg"
            onClick={() => chooseVisible((w) => !w.pinSetAt)}
          >
            Choose everyone not signed up
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11 rounded-lg"
            onClick={() => (allVisibleChosen ? setSelected(new Set()) : chooseVisible(() => true))}
          >
            {allVisibleChosen ? "Clear choice" : "Choose all shown"}
          </Button>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
          <p className="m-0 text-sm" aria-live="polite">
            {noneChosen
              ? "Choose the employees to invite."
              : `${plural(chosen.length, "employee")} chosen · ${chosenWithEmail.toLocaleString("en-NG")} with email`}
            {chosenSignedUp > 0
              ? `. ${plural(chosenSignedUp, "employee")} already signed up: a new invite resets their PIN when they use it.`
              : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <SubmitWith
              action={emailAction}
              disabled={chosenWithEmail === 0}
              pendingLabel="Sending…"
            >
              Email invites
              {chosenWithEmail > 0 ? ` (${chosenWithEmail.toLocaleString("en-NG")})` : ""}
            </SubmitWith>
            <SubmitWith
              action={printAction}
              disabled={noneChosen}
              pendingLabel="Preparing…"
              variant="outline"
            >
              Print invite sheet{noneChosen ? "" : ` (${chosen.length.toLocaleString("en-NG")})`}
            </SubmitWith>
            {noneChosen ? null : (
              <InviteBulkButtons
                ids={chosen.map((w) => w.id)}
                onDone={(message) => {
                  setBulkNotice(message);
                  setSelected(new Set());
                  router.refresh();
                }}
              />
            )}
          </div>
          <p role="status" className="m-0 text-sm font-medium empty:hidden">
            {bulkNotice ?? ""}
          </p>
          <Message state={emailState} />
          {printState && !printState.ok ? <Message state={printState} /> : null}
        </div>
      </form>

      <DataTable
        caption="Employees and their phone app sign-in"
        columns={columns}
        rows={visible}
        getRowId={(w) => w.id}
        selectedIds={[...selected]}
        empty={
          <p className="m-0 px-4 py-8 text-center text-sm text-fg-muted">
            No employees here yet. Add or import employees first.
          </p>
        }
      />
    </div>
  );
}
