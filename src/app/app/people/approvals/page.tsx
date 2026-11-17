import type { Metadata } from "next";
import { after } from "next/server";

import { EmptyState } from "@/components/empty-state";
import { Illustration } from "@/components/illustration";
import { PageHeader } from "@/components/page-header";
import { canAccessHref } from "@/lib/nav";
import { sendAppliedBankChangeNotices } from "@/server/people/bank-change-notices";
import {
  applyDueBankChanges,
  loadBankChangeViewer,
  loadBankChanges,
  type BankChangeView,
  type BankChangeViewer,
} from "@/server/people/bank-changes";
import { peoplePageContext } from "@/server/people/page-context";
import { canSeePii } from "@/server/people/pii-access";

import { RouteGate } from "../../_shell/slots";
import { BankChangeCard } from "../_components/bank-change-card";
import { plural } from "../_components/display";

export const metadata: Metadata = { title: "Bank-detail approvals" };

function Group({
  id,
  title,
  description,
  changes,
  viewer,
}: {
  id: string;
  title: string;
  description: string;
  changes: BankChangeView[];
  viewer: BankChangeViewer;
}) {
  if (changes.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4 border-t border-line pt-6">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="m-0 type-h3">
          {title}
        </h2>
        <p className="m-0 text-sm text-fg-muted">{description}</p>
      </div>
      <div className="flex flex-col gap-3">
        {changes.map((change) => (
          <BankChangeCard key={change.id} change={change} viewer={viewer} showWorker />
        ))}
      </div>
    </section>
  );
}

async function Approvals() {
  const ctx = await peoplePageContext();
  // Changes whose hold has ended take effect before anything is shown (pg_cron does this too).
  await applyDueBankChanges(ctx.supabase, ctx.organisationId);
  after(() => sendAppliedBankChangeNotices(ctx.organisationId));

  const [changes, viewer] = await Promise.all([
    loadBankChanges(ctx.supabase, ctx.organisationId, { limit: 100 }),
    loadBankChangeViewer(
      ctx.supabase,
      ctx.organisationId,
      ctx.userId,
      ctx.role,
      canSeePii(ctx.role, "bank_account"),
    ),
  ]);
  const pending = changes.filter((c) => c.status === "pending");
  const onHold = changes.filter((c) => c.status === "approved");
  const decided = changes
    .filter((c) => c.status !== "pending" && c.status !== "approved")
    .slice(0, 20);

  const title =
    pending.length === 0
      ? "No bank changes waiting"
      : `${plural(pending.length, "bank change", "bank changes")} waiting for approval`;

  return (
    <>
      <div className="flex flex-col gap-4">
        <PageHeader
          // Finance approves bank changes but can't open People: their parent is the dashboard.
          back={
            canAccessHref(ctx.role, "/app/people")
              ? { href: "/app/people", label: "People" }
              : { href: "/app", label: "dashboard" }
          }
          eyebrow="Bank-detail approvals"
          title={title}
          description={`Bank details change only when someone other than the requester approves, then wait 72 hours before payouts use them. ${
            viewer.isApprover
              ? "You can approve requests raised by others."
              : "Owner, HR or finance approve; you can see the requests."
          }`}
        />
      </div>

      {changes.length === 0 ? (
        <EmptyState
          illustration={<Illustration name="no-approvals" decorative />}
          message="No bank changes yet. Changes raised on an employee's page appear here for a second person to approve."
        />
      ) : null}

      <Group
        id="pending"
        title={`Waiting for approval (${pending.length})`}
        description="Check the new account against the employee's own letter or statement before you approve."
        changes={pending}
        viewer={viewer}
      />
      <Group
        id="on-hold"
        title={`On hold (${onHold.length})`}
        description="Approved, and waiting out the 72 hours. Stop a change here if the employee did not ask for it."
        changes={onHold}
        viewer={viewer}
      />
      <Group
        id="decided"
        title="Recent decisions"
        description="The last 20 changes that were applied, rejected, stopped or withdrawn."
        changes={decided}
        viewer={viewer}
      />
    </>
  );
}

export default function Page() {
  return (
    <RouteGate href="/app/people/approvals">
      <Approvals />
    </RouteGate>
  );
}
